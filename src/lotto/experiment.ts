import { log } from "../util/log.ts";
import { drawRange, isSyncingDraws, listDraws, syncDraws } from "./draws.ts";
import { generateSets } from "./strategy.ts";
import { isLottoUsageLimit, runLottoEvolveAgent } from "./agent.ts";
import {
  assertSetShape,
  countScored,
  ensureSeedStrategy,
  generationStartRound,
  generationStats,
  getLottoState,
  insertPrediction,
  insertStrategy,
  lastScored,
  latestStrategy,
  listStrategies,
  listRuns,
  recentResults,
  recentResultsWithDraw,
  resetExperiment,
  runStats,
  resetLottoState,
  scorePoints,
  setLottoState,
  summarizeMatches,
} from "./store.ts";
import type { LottoDraw, LottoSnapshot, LottoState, LottoStrategy } from "../../shared/lotto.ts";
import {
  LOTTO_BASELINE_PER_ROUND,
  LOTTO_EVOLVE_EVERY,
  LOTTO_HIT3_CEILING,
  LOTTO_HIT3_RANDOM,
  LOTTO_RECENT_LIMIT,
  countMatches,
  winningNumbers,
} from "../../shared/lotto.ts";

/**
 * 실험 러너 — 가장 오래된 회차부터 최신 회차까지 **한 회차씩** 걸으며 채점한다.
 *
 * ## 미래 정보 차단
 * r회차를 예측할 때 넘기는 이력은 `draws.filter(d => d.round < r)` 뿐이다. 이 한 줄이
 * 실험 전체의 유효성을 지탱한다 — 전체 이력을 넘기면 점수는 예쁘게 나오지만 아무 의미가 없다.
 *
 * ## 토큰 한도
 * 토큰을 쓰는 곳은 50회차마다 도는 진화 에이전트뿐이다. 한도로 실패하면 **그 자리에서 멈추고**
 * 4시간 뒤 시각을 상태 파일에 적는다. 스케줄러가 30분마다 그 시각을 확인해 자동으로 재개한다
 * (서버가 그사이 재시작돼도 파일에 남아 있으므로 복구된다).
 */

/** 토큰 한도로 멈췄을 때 기다리는 시간. */
export const USAGE_LIMIT_WAIT_MS = 4 * 60 * 60 * 1000;

/**
 * 이벤트 루프를 양보하는 주기(회차).
 *
 * 채점 자체는 순수 계산이라 1200회차가 몇 초면 끝나지만, 그동안 동기 루프가 이어지면
 * API 가 응답하지 않아 화면이 "진행 중"에서 얼어붙은 것처럼 보인다. 진행 상황을 보여 주는 것이
 * 이 탭의 존재 이유라 주기적으로 양보한다.
 */
const YIELD_EVERY = 25;

let running = false;
/** 사용자가 누른 일시정지. 루프가 다음 회차 경계에서 확인한다. */
let pauseRequested = false;

export function isExperimentRunning(): boolean {
  return running;
}

/**
 * 전 회차를 한 바퀴 다 돌았는지.
 *
 * 완주하면 **실험뿐 아니라 주간 회차 동기화까지 멈춘다**(2026-07-29 사용자 지시:
 * "전체 회차를 1번 다 돌면 모든 동작을 멈추고 알려라"). 다음 동작 — 처음부터 반복할지,
 * 주 1회 새 회차만 실험할지 — 을 사용자가 정하기 전에 조건이 바뀌면 안 되기 때문이다.
 * 스케줄러가 이 값을 게이트로 쓴다.
 */
export function isExperimentDone(): boolean {
  return getLottoState().status === "done";
}

/** 다음에 예측할 회차. 커서는 저장하지 않고 항상 채점 결과에서 유도한다. */
export function nextRoundToPredict(run = getLottoState().run): number | null {
  const range = drawRange();
  if (range.first === null) return null;
  const last = lastScored(run);
  return last ? last.round + 1 : range.first;
}

/**
 * 세대를 개정할 차례인지.
 *
 * 조건을 "채점 수 % 50" 이 아니라 "현재 세대가 몇 회차를 소화했는가"로 잡은 이유:
 * 중간에 실험을 초기화하거나 회차가 끊겼을 때도 세대 길이가 일정하게 유지된다.
 *
 * ⚠️ 그 '몇 회차'를 **이번 바퀴 기준으로** 세어야 한다. `current.fromRound` 로 재면
 * 반복에서 물려받은 세대의 시작 회차가 직전 바퀴의 값(예: 1201)이라 새 커서(1)보다 커져
 * 조건이 영원히 거짓이 되고, 진화가 0회인 채로 바퀴가 끝난다(store.generationStartRound 주석).
 * DB 에서 유도하므로 일시정지·재시작 후에도 정확하다.
 */
export function shouldEvolve(cursor: number, generationStart: number): boolean {
  return cursor - generationStart >= LOTTO_EVOLVE_EVERY;
}

/** 현재 세대가 **이번 바퀴에서** 시작한 회차. 아직 한 회차도 안 돌았으면 지금 커서가 시작이다. */
function generationStartFor(run: number, cursor: number, current: LottoStrategy): number {
  return generationStartRound(run, current.version) ?? cursor;
}

/**
 * 다음 세대를 만든다. 실패해도 **반드시 세대를 하나 추가한다**(사양은 그대로).
 *
 * 세대를 추가하지 않고 돌아가면 `shouldEvolve` 가 계속 참이라 매 회차 에이전트를 부르게 된다 —
 * 한도 소진이 아닌 일시적 오류 하나로 1000회 호출이 나가는 구조가 된다. 사양을 유지한 채
 * 세대만 넘기면 타임라인에 "여기서 개정에 실패했다"는 사실도 함께 남는다.
 *
 * @returns 한도 소진이면 null (호출부가 실험을 멈춘다)
 */
async function evolve(
  run: number,
  cursor: number,
  current: LottoStrategy
): Promise<LottoStrategy | null> {
  const ctx = {
    run,
    nextRound: cursor,
    scoredRounds: countScored(run),
    current,
    generations: generationStats(),
    runs: runStats(run),
    recent: recentResults(run, LOTTO_EVOLVE_EVERY),
  };

  try {
    const proposal = await runLottoEvolveAgent(ctx);
    const next = insertStrategy({
      run,
      fromRound: cursor,
      spec: proposal.spec,
      rationale: proposal.rationale,
      hypothesis: proposal.hypothesis,
      author: "agent",
      model: proposal.model,
    });
    log.info(
      `로또 전략 v${next.version} 채택 (${cursor}회차부터) — 변경: ${
        proposal.changed.join(", ") || "(미기재)"
      }`
    );
    return next;
  } catch (e) {
    const err = e as Error;
    if (isLottoUsageLimit(err)) {
      log.warn(`로또 진화 에이전트 토큰 한도 소진 — 4시간 뒤 재개 (${err.message})`);
      return null;
    }
    log.error(`로또 진화 에이전트 실패 → 직전 사양 유지하고 세대만 넘김: ${err.message}`);
    return insertStrategy({
      run,
      fromRound: cursor,
      spec: current.spec,
      author: "agent",
      model: "",
      hypothesis: current.hypothesis,
      rationale: `개정 실패로 v${current.version} 사양을 그대로 승계. 원인: ${err.message.slice(0, 500)}`,
    });
  }
}

export interface RunResult {
  scored: number;
  status: LottoState["status"];
  reason: string;
}

/**
 * 실험을 진행한다. 다음 중 하나가 될 때까지 회차를 계속 건다:
 * 최신 회차 도달(done) / 사용자 일시정지 / 토큰 한도(4시간 대기) / 데이터 결손(error).
 */
export async function runExperiment(trigger: string): Promise<RunResult> {
  if (running) {
    log.warn(`로또 실험이 이미 진행 중 → ${trigger} 건너뜀`);
    return { scored: 0, status: "running", reason: "already-running" };
  }
  running = true;
  pauseRequested = false;

  let scored = 0;
  try {
    // 동기화가 도는 중에 시작하면 이력이 반쯤 찬 상태를 스냅샷으로 떠 선두 결손을 만든다.
    // 프론트의 busy 는 클라이언트 로컬 상태라 새로고침 한 번이면 풀린다 — 서버가 막아야 한다.
    if (isSyncingDraws()) {
      const state = setLottoState({
        status: "paused",
        pauseReason: "error",
        resumeAt: null,
        lastError: "회차 동기화가 진행 중입니다. 완료된 뒤 시작하세요.",
      });
      return { scored, status: state.status, reason: "syncing" };
    }

    const draws = listDraws();
    if (draws.length === 0) {
      const state = setLottoState({
        status: "paused",
        pauseReason: "error",
        resumeAt: null,
        lastError: "회차 데이터가 없습니다. '회차 동기화'를 먼저 실행하세요.",
      });
      return { scored, status: state.status, reason: "no-draws" };
    }

    // ⚠️ **선두 결손 가드.** 커서는 채점 기록이 없을 때 '가진 회차 중 가장 작은 것'에서
    // 출발하는데, 백필이 끝나기 전(또는 앞쪽 페이지가 실패해)에 시작하면 그 값이 1이 아니다.
    // 그러면 앞 회차를 통째로 건너뛴 채 끝까지 달리고 "1~최신 완주" 라고 보고한다 —
    // 중간 결손은 아래에서 잡히지만 선두 결손은 커서가 그 뒤에서 출발해 어떤 가드에도 안 걸린다.
    // 사양이 '가장 오래된 회차부터'이므로 이건 조용히 넘어갈 수 없는 위반이다.
    const range = drawRange();
    if (range.first !== 1) {
      const state = setLottoState({
        status: "paused",
        pauseReason: "error",
        resumeAt: null,
        lastError: `1회차 데이터가 없습니다(현재 최소 ${range.first}회차). '회차 동기화'를 완료한 뒤 시작하세요.`,
      });
      log.error(`로또 실험 중단 — 선두 결손(최소 회차 ${range.first})`);
      return { scored, status: state.status, reason: "prefix-gap" };
    }

    const byRound = new Map(draws.map((d) => [d.round, d]));
    const latest = draws[draws.length - 1].round;

    const run = getLottoState().run;
    let cursor = nextRoundToPredict(run);
    if (cursor === null) return { scored, status: "idle", reason: "no-draws" };

    let cum = lastScored(run)?.cumScore ?? 0;
    let strategy = ensureSeedStrategy(run, cursor);

    setLottoState({
      status: "running",
      pauseReason: null,
      resumeAt: null,
      lastError: null,
      startedAt: getLottoState().startedAt ?? new Date().toISOString(),
    });
    log.info(`로또 실험 시작 [${trigger}] — ${run}번째 바퀴, ${cursor}회차부터 ${latest}회차까지`);

    while (cursor <= latest) {
      if (pauseRequested) {
        const state = setLottoState({ status: "paused", pauseReason: "manual", resumeAt: null });
        log.info(`로또 실험 일시정지 (${cursor}회차 대기) — 채점 ${scored}건`);
        return { scored, status: state.status, reason: "paused-by-user" };
      }

      // 세대 개정. 실패해도 세대는 넘어가고, 한도 소진일 때만 여기서 멈춘다.
      if (shouldEvolve(cursor, generationStartFor(run, cursor, strategy))) {
        const next = await evolve(run, cursor, strategy);
        if (!next) {
          // ⚠️ 에이전트 호출은 최대 10분 await 한다. 그동안 사용자가 일시정지를 눌렀다면
          // **그 의사가 한도 소진보다 우선**이다. 이 검사가 없으면 사용자가 세운 실험이
          // 'usage-limit' 으로 기록돼 4시간 뒤 스케줄러가 되살린다 — checkLottoResume 주석이
          // 선언한 "사용자가 세운 것은 시스템이 되살리지 않는다" 불변식을 깨는 유일한 구멍이었다.
          if (pauseRequested) {
            const state = setLottoState({
              status: "paused",
              pauseReason: "manual",
              resumeAt: null,
              lastError: "토큰 한도 소진 중 사용자가 일시정지함 — 자동 재개하지 않습니다.",
            });
            log.info(`로또 실험 일시정지(수동, 한도 소진과 동시) — ${cursor}회차 대기`);
            return { scored, status: state.status, reason: "paused-by-user" };
          }
          const resumeAt = new Date(Date.now() + USAGE_LIMIT_WAIT_MS).toISOString();
          const state = setLottoState({
            status: "paused",
            pauseReason: "usage-limit",
            resumeAt,
            lastError: "토큰 한도 소진",
          });
          log.warn(`로또 실험 일시정지 — ${resumeAt} 에 자동 재개 (${cursor}회차 대기)`);
          return { scored, status: state.status, reason: "usage-limit" };
        }
        strategy = next;
      }

      const draw = byRound.get(cursor);
      if (!draw) {
        // 회차가 비어 있으면 건너뛰지 않는다 — 건너뛰면 누적 점수가 조용히 어긋난다.
        const state = setLottoState({
          status: "paused",
          pauseReason: "error",
          resumeAt: null,
          lastError: `${cursor}회차 데이터가 없습니다. '회차 동기화' 후 다시 시작하세요.`,
        });
        log.error(`로또 실험 중단 — ${cursor}회차 데이터 결손`);
        return { scored, status: state.status, reason: "missing-draw" };
      }

      // ⚠️ 미래 차단: cursor 미만의 회차만 넘긴다.
      const history = historyBefore(draws, cursor);
      const sets = generateSets(strategy.spec, history, cursor, strategy.version);
      assertSetShape(sets);

      const winning = winningNumbers(draw);
      const matches = sets.map((s) => countMatches(s, winning));
      const { score } = summarizeMatches(matches);
      cum += score;

      insertPrediction(run, {
        round: cursor,
        drawDate: draw.drawDate,
        version: strategy.version,
        sets,
        matches,
        score,
        cumScore: cum,
      });

      scored += 1;
      cursor += 1;

      if (scored % YIELD_EVERY === 0) {
        await new Promise((r) => setImmediate(r));
      }
    }

    const state = setLottoState({
      status: "done",
      pauseReason: null,
      resumeAt: null,
      lastError: null,
      finishedAt: new Date().toISOString(),
      doneAcknowledged: false,
    });
    log.info(
      `로또 실험 완주 — ${run}번째 바퀴 ${latest}회차까지 채점 완료(이번 실행 ${scored}건, 누적 점수 ${cum})`
    );
    return { scored, status: state.status, reason: "done" };
  } catch (e) {
    const err = e as Error;
    const state = setLottoState({
      status: "paused",
      pauseReason: "error",
      resumeAt: null,
      lastError: err.message,
    });
    log.error(`로또 실험 오류: ${err.message}`);
    return { scored, status: state.status, reason: "error" };
  } finally {
    running = false;
    pauseRequested = false;
  }
}

/**
 * cursor 회차 **이전**의 이력.
 *
 * 회차가 1부터 빠짐없이 이어진다는 전제를 두지 않고 매번 필터링한다 — 전제를 두면
 * 동기화가 한 페이지 실패했을 때 엉뚱한 구간이 이력으로 들어가고, 그 사실이 드러나지 않는다.
 * 1200회차 × 필터는 무시할 수 있는 비용이다.
 */
export function historyBefore(draws: LottoDraw[], cursor: number): LottoDraw[] {
  // draws 는 회차 오름차순이므로 첫 번째 위반 지점까지만 자르면 된다.
  let end = draws.length;
  for (let i = 0; i < draws.length; i++) {
    if (draws[i].round >= cursor) {
      end = i;
      break;
    }
  }
  return draws.slice(0, end);
}

// ── 외부 조작 ──

/** 수동 시작/재개. 이미 돌고 있으면 아무것도 하지 않는다. */
export async function startExperiment(trigger = "manual"): Promise<RunResult> {
  if (running) return { scored: 0, status: "running", reason: "already-running" };
  return runExperiment(trigger);
}

/** 일시정지 요청. 루프가 다음 회차 경계에서 멈춘다(진행 중인 에이전트 호출은 끝까지 간다). */
export function pauseExperiment(): LottoState {
  if (running) {
    pauseRequested = true;
    return getLottoState();
  }
  return setLottoState({ status: "paused", pauseReason: "manual", resumeAt: null });
}

/** 완주 배너 확인. */
export function acknowledgeDone(): LottoState {
  return setLottoState({ doneAcknowledged: true });
}

/**
 * **실험 반복** — 초기화 없이 전 회차를 한 바퀴 더 돈다(2026-07-29 사용자 요청).
 *
 * 초기화(resetAll)와 무엇이 다른가:
 *   초기화 — 채점 기록과 전략 세대를 **지우고** v1 무작위 출발선부터 다시.
 *   반복   — 아무것도 지우지 않고 run 만 +1. 전략은 직전 바퀴가 도달한 세대에서 **이어서**
 *            진화하고, 지난 바퀴의 기록은 그대로 남아 반복 간 비교(runs 표)의 근거가 된다.
 *
 * 완주한 상태에서만 의미가 있다 — 진행 중이거나 남은 회차가 있으면 그냥 이어서 돌면 된다.
 */
export function repeatExperiment(): { ok: boolean; error?: string; state: LottoState } {
  if (running) {
    return { ok: false, error: "실험이 진행 중입니다.", state: getLottoState() };
  }
  const state = getLottoState();
  const range = drawRange();
  if (state.status !== "done") {
    return {
      ok: false,
      error: "완주한 뒤에만 반복할 수 있습니다. 진행 중이거나 남은 회차가 있으면 [실험 시작]을 쓰세요.",
      state,
    };
  }
  if (range.first === null) {
    return { ok: false, error: "회차 데이터가 없습니다.", state };
  }
  const next = setLottoState({
    run: state.run + 1,
    status: "idle",
    pauseReason: null,
    resumeAt: null,
    lastError: null,
    finishedAt: null,
    doneAcknowledged: false,
  });
  log.info(`로또 실험 반복 준비 — ${next.run}번째 바퀴 (전략 세대는 이어서 진화)`);
  return { ok: true, state: next };
}

/** 채점 결과·전략을 전부 지우고 처음부터. 회차 원본은 남긴다. */
export function resetAll(): LottoState {
  if (running) pauseRequested = true;
  resetExperiment();
  return resetLottoState();
}

/**
 * 토큰 한도로 멈춘 실험의 자동 재개. 스케줄러가 30분마다 부른다.
 *
 * ⚠️ `manual`/`error` 로 멈춘 것은 되살리지 않는다. 사용자가 세운 것을 시스템이 다시
 *    켜면 정지 버튼이 의미를 잃고, 데이터 결손은 시간이 지난다고 낫지 않는다.
 */
/**
 * **잔류 running 정합화.** 기동 직후와 30분 점검마다 부른다.
 *
 * 상태 파일의 `running` 은 루프가 끝날 때만 내려간다. 그런데 실험은 수십 분 돌고(진화 호출 25회)
 * 이 프로젝트의 표준 배포는 launchd 재시작이라, **실행 중 프로세스가 죽는 일이 정상 경로에 있다.**
 * 그러면 파일에는 running 이 남고 메모리 플래그는 false 가 되어, 아무것도 돌지 않는데 화면은
 * '진행중' 을 띄운 채 [실험 시작] 버튼을 잠그고 3초마다 영원히 폴링한다. checkLottoResume 은
 * usage-limit 만 되살리므로 여기에 개입하지 않는다.
 *
 * 자동으로 이어 돌리지 않고 **paused 로 강등만** 하는 이유: 실험 시작은 사용자가 누르는 것이라는
 * 게 확정 사양이다(토큰 소비 시점을 직접 통제하려는 선택). 대신 왜 멈췄는지를 남겨 다음 클릭이
 * 정확히 이어지게 한다.
 */
export function reconcileLottoState(): void {
  if (running) return;
  const state = getLottoState();
  if (state.status !== "running") return;
  setLottoState({
    status: "paused",
    pauseReason: "error",
    resumeAt: null,
    lastError: "서버가 재시작되어 실험이 중단됐습니다. [실험 시작]을 누르면 멈춘 회차부터 이어집니다.",
  });
  log.warn("로또 실험: 잔류 running 상태 감지 → paused 로 강등(서버 재시작 중단)");
}

export async function checkLottoResume(): Promise<void> {
  if (running) return;
  const state = getLottoState();
  if (state.status !== "paused" || state.pauseReason !== "usage-limit") return;
  if (!state.resumeAt) return;
  if (Date.now() < new Date(state.resumeAt).getTime()) return;
  log.info("로또 실험 자동 재개 — 토큰 한도 대기 종료");
  await runExperiment("usage-limit-resume");
}

/** 회차 동기화. 새 회차가 들어오면 진행 중이 아닐 때만 로그로 알린다. */
export async function syncLottoDraws(force = false) {
  const r = await syncDraws({ force });
  return r;
}

// ── 조회 ──

/**
 * 아직 추첨되지 않은 다음 회차의 추천 번호.
 * 완주했을 때만 의미가 있어(그 전에는 실험이 계속 굴러간다) 호출부에서 조건을 건다.
 */
function upcomingPicks(): { round: number; sets: number[][] } | null {
  const strategy = latestStrategy();
  const range = drawRange();
  if (!strategy || range.latest === null) return null;
  const round = range.latest + 1;
  const draws = listDraws();
  return { round, sets: generateSets(strategy.spec, draws, round, strategy.version) };
}

export function getSnapshot(): LottoSnapshot {
  const state = getLottoState();
  const run = state.run;
  const range = drawRange();
  const last = lastScored(run);
  const scoredThrough = last?.round ?? null;
  const total = countScored(run);
  const cumScore = last?.cumScore ?? 0;
  const next = nextRoundToPredict(run);
  const remaining =
    range.latest !== null && next !== null ? Math.max(0, range.latest - next + 1) : 0;

  const points = scorePoints(run);
  const hit3Rounds = points.reduce((n, p) => n + (p.hit3 ? 1 : 0), 0);

  return {
    state,
    scoredThrough,
    firstDraw: range.first,
    latestDraw: range.latest,
    nextRound: remaining > 0 ? next : null,
    remaining,
    totalScored: total,
    cumScore,
    avgScore: total > 0 ? cumScore / total : null,
    baselinePerRound: LOTTO_BASELINE_PER_ROUND,
    hit3Rate: total > 0 ? hit3Rounds / total : null,
    hit3Rounds,
    hit3Random: LOTTO_HIT3_RANDOM,
    hit3Ceiling: LOTTO_HIT3_CEILING,
    strategies: listStrategies(),
    generations: generationStats(),
    runs: runStats(run),
    points,
    recentResults: recentResultsWithDraw(run, LOTTO_RECENT_LIMIT),
    upcoming: remaining === 0 && total > 0 ? upcomingPicks() : null,
  };
}

/** 폴링용 경량 상태. 스냅샷은 1200점이라 3초마다 보낼 수 없다. */
export function getStatus() {
  const state = getLottoState();
  const run = state.run;
  const range = drawRange();
  const last = lastScored(run);
  const next = nextRoundToPredict(run);
  const remaining =
    range.latest !== null && next !== null ? Math.max(0, range.latest - next + 1) : 0;
  return {
    status: state.status,
    run,
    totalRuns: listRuns().length,
    pauseReason: state.pauseReason,
    resumeAt: state.resumeAt,
    lastError: state.lastError,
    doneAcknowledged: state.doneAcknowledged,
    scoredThrough: last?.round ?? null,
    latestDraw: range.latest,
    nextRound: remaining > 0 ? next : null,
    remaining,
    cumScore: last?.cumScore ?? 0,
  };
}
