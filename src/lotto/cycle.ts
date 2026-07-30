import { log } from "../util/log.ts";
import { drawRange, getDraw, listDraws, syncDraws } from "./draws.ts";
import { generateSets } from "./strategy.ts";
import {
  LOTTO_AGENT_RECENT,
  LOTTO_AGENT_WINDOW,
  isLottoUsageLimit,
  runLottoEvolveAgent,
} from "./agent.ts";
import {
  assertSetShape,
  clearUpcoming,
  ensureSeedStrategy,
  getLottoState,
  getUpcoming,
  insertPrediction,
  insertStrategy,
  lastScored,
  latestStrategy,
  recentResultsWithDraw,
  recentStrategies,
  saveUpcoming,
  setLottoState,
  summarize,
  summarizeMatches,
} from "./store.ts";
import type { LottoDraw, LottoSnapshot, LottoState, LottoStrategy } from "../../shared/lotto.ts";
import { LOTTO_RECENT_LIMIT, countMatches, winningNumbers } from "../../shared/lotto.ts";

/**
 * **주간 자동 사이클** — 로또 탭의 유일한 동작이다.
 *
 * 매주 일요일 10:00(스케줄러 cron)에 이 순서로 돈다:
 *
 *   1. 동행복권에서 새 추첨 결과를 수집한다
 *   2. **지난주에 미리 못박아 둔 추천 번호**를 그 결과로 채점한다
 *   3. 채점 결과를 에이전트에 전달해 전략을 갱신한다
 *   4. 다음 회차 번호를 뽑아 **추첨 전에** 저장한다(다음 주에 이것이 2번의 대상이 된다)
 *
 * ## 4번이 이 파일의 존재 이유다
 * 전에는 화면을 열 때마다 '다음 회차 추천 번호'를 새로 생성했다. 그러면 다음 주에 채점할
 * 대상이 요청마다 달라져 "추천했던 번호와 실제 추첨 결과를 비교"라는 말이 성립하지 않는다.
 * 지금은 한 번 뽑아 DB(`lotto_upcoming`)에 못박고, 그 뒤로는 **절대 덮어쓰지 않는다.**
 *
 * ## 무엇이 없어졌는가 (2026-07-30)
 * 반복 학습(전 회차를 몇 바퀴씩 다시 도는 것)을 사용자가 과잉 정합성 때문에 중단했다.
 * 그래서 [실험 시작]/[일시정지]/[회차 동기화]/[초기화]/[실험 반복] 과 상태 머신
 * (idle/running/paused/done)이 전부 사라졌다 — 시작·정지할 것이 없고, 동기화는 사이클의
 * 1번이며, 지울 것은 애초에 없다. 남은 실행 지점은 cron 하나뿐이다.
 */

/** 사이클이 도는 요일·시각(로컬). cron 식과 아래 경계 계산이 **같은 상수**를 보게 묶어 둔다. */
export const LOTTO_CYCLE_WEEKDAY = 0; // 0 = 일요일
export const LOTTO_CYCLE_HOUR = 10;
export const LOTTO_CYCLE_CRON = `0 ${LOTTO_CYCLE_HOUR} * * ${LOTTO_CYCLE_WEEKDAY}`;
export const LOTTO_CYCLE_LABEL = "일요일 10:00";

/**
 * 실패(수집 오류·토큰 한도) 후 재시도까지 기다리는 시간.
 * 다음 주까지 미루면 그 주의 전략 갱신이 통째로 사라지므로 짧게 되돌아온다.
 */
export const LOTTO_RETRY_WAIT_MS = 4 * 60 * 60 * 1000;

let cycling = false;

export function isCycleRunning(): boolean {
  return cycling;
}

/**
 * 직전 사이클 시각(로컬 일요일 10:00) 경계.
 *
 * '놓친 실행'을 판정하는 기준선이다. 맥이 일요일 10시에 자고 있었으면 cron 은 통째로
 * 사라지므로(다른 탭의 catch-up 과 같은 문제), 깨어난 뒤 이 경계를 지났는데 그 이후로 사이클을
 * 돈 적이 없으면 즉시 보충한다.
 */
export function lastCycleBoundary(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setHours(LOTTO_CYCLE_HOUR, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - LOTTO_CYCLE_WEEKDAY + 7) % 7));
  // 오늘이 그 요일이지만 아직 시각 전이면 한 주 전이 직전 경계다.
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 7);
  return d;
}

/** 다음 자동 실행 예정 시각. 화면이 "다음 갱신"으로 보여준다. */
export function nextCycleAt(now: Date = new Date()): Date {
  const d = lastCycleBoundary(now);
  d.setDate(d.getDate() + 7);
  return d;
}

/**
 * 지금 사이클을 돌아야 하는지. 세 가지 경우다.
 *
 * `hasUpcoming` 이 첫 조건인 이유: 다음 회차 추천 번호가 비어 있으면 화면의 주인공이 없다.
 * 배포 직후나 DB 를 새로 만든 직후가 그 상태이므로, 다음 일요일까지 빈 화면을 두지 않고 즉시
 * 한 번 돈다(새로 채점할 것이 없으면 에이전트를 부르지 않으므로 수집 + 번호 추출로 끝난다).
 */
export function shouldRunCycle(now: Date, state: LottoState, hasUpcoming: boolean): boolean {
  if (!hasUpcoming) return true;
  if (state.retryAt && new Date(state.retryAt).getTime() <= now.getTime()) return true;
  if (!state.lastCycleAt) return true;
  return new Date(state.lastCycleAt).getTime() < lastCycleBoundary(now).getTime();
}

export interface CycleResult {
  /** 이번 사이클에서 새로 채점한 회차. 채점 대상이 없었으면 null */
  scoredRound: number | null;
  /** 에이전트가 만든 새 세대. 갱신하지 않았으면 null */
  newVersion: number | null;
  /** 못박은(또는 이미 못박혀 있던) 다음 회차 */
  upcomingRound: number | null;
  /** 토큰 한도로 전략 갱신을 미뤘는지 */
  usageLimited: boolean;
  error: string | null;
  reason: string;
}

/**
 * 주간 사이클 1회. **예외를 밖으로 던지지 않는다** — 호출자가 cron 콜백이라 받아 줄 곳이
 * 없으므로 여기서 끝내고 상태 파일에 남긴다.
 */
export async function runWeeklyCycle(trigger: string): Promise<CycleResult> {
  if (cycling) {
    log.warn(`로또 주간 사이클이 이미 진행 중 → ${trigger} 건너뜀`);
    return {
      scoredRound: null,
      newVersion: null,
      upcomingRound: null,
      usageLimited: false,
      error: null,
      reason: "already-running",
    };
  }
  cycling = true;
  const startedAt = Date.now();

  let scoredRound: number | null = null;
  let newVersion: number | null = null;
  let upcomingRound: number | null = null;
  let usageLimited = false;
  let error: string | null = null;
  let retry = false;
  let reason = "ok";

  try {
    log.info(`로또 주간 사이클 시작 [${trigger}]`);

    // 1) 새 추첨 결과 수집. 실패해도 멈추지 않는다 — 이미 가진 회차로 채점·추출은 되고,
    //    '새 회차가 없다'로 자연히 흘러간다. 대신 4시간 뒤 재시도를 예약한다.
    try {
      const r = await syncDraws();
      if (r.added > 0) log.info(`로또 회차 신규 ${r.added}건 확보 — 최신 ${r.latest}회차`);
    } catch (e) {
      error = `회차 수집 실패: ${(e as Error).message}`;
      retry = true;
      reason = "sync-failed";
      log.error(`로또 ${error}`);
    }

    const range = drawRange();
    if (range.latest === null) {
      throw new Error("회차 데이터가 없습니다 — 동행복권 수집이 한 번도 성공하지 않았습니다.");
    }

    const run = getLottoState().run;

    // 2) 지난주에 못박아 둔 추천 번호를 채점한다.
    scoredRound = scorePendingPicks();

    const last = lastScored(run);
    if (last && range.latest > last.round) {
      // 추천 번호를 미리 못박아 두지 않은 회차는 채점 대상이 아니다 — 결과를 보고 나서 번호를
      // 고르면 그건 예측이 아니다. 사이클이 몇 주 누락됐을 때만 나온다.
      log.warn(
        `로또 ${last.round + 1}~${range.latest}회차는 추천 번호가 미리 확정돼 있지 않아 채점하지 않습니다(사이클 누락).`
      );
    }

    // 3) 채점 결과를 에이전트에 반영한다. **아직 반영되지 않은 회차가 있을 때만** 부른다 —
    //    새 정보 없이 부르면 토큰만 태우고, 매주 무언가를 바꾸게 만들어 과잉 정합성을 부른다.
    let strategy = ensureSeedStrategy(run, range.latest + 1);
    const state = getLottoState();
    if (last && (state.lastEvolvedRound === null || state.lastEvolvedRound < last.round)) {
      // 새 세대가 적용될 회차: 이미 못박은 번호가 있으면 그 **다음** 회차부터다.
      // (못박은 번호를 나중에 바꾸지 않는다는 규칙 — writeUpcomingPicks 주석 참고.)
      const pendingRound = getUpcoming()?.round ?? null;
      const from = (pendingRound ?? range.latest) + 1;
      const r = await evolve(run, from, strategy, last.round);
      if (r.strategy) {
        strategy = r.strategy;
        newVersion = r.strategy.version;
      }
      if (r.usageLimited) {
        usageLimited = true;
        retry = true;
        reason = "usage-limit";
        error = "토큰 한도 소진 — 전략 갱신을 미뤘습니다(번호는 직전 세대로 확정했습니다).";
      } else {
        // 한도가 아닌 실패까지 재시도 대상으로 두면 4시간마다 같은 실패를 반복한다. 그 주의
        // 갱신 한 번을 포기하고, 다음 주에 누적된 결과로 다시 부른다.
        setLottoState({ lastEvolvedRound: last.round });
        if (r.error) {
          error = `전략 갱신 실패(직전 사양 유지): ${r.error}`;
          reason = "evolve-failed";
        }
      }
    }

    // 4) 다음 회차 번호를 뽑아 못박는다. 3번이 실패했어도 **반드시** 한다 — 한도 소진 때문에
    //    그 주의 번호가 비면 사용자가 볼 것이 없어진다.
    upcomingRound = writeUpcomingPicks(run, strategy, range.latest + 1);

    setLottoState({
      lastCycleAt: new Date().toISOString(),
      lastScoredRound: scoredRound ?? getLottoState().lastScoredRound,
      lastError: error,
      retryAt: retry ? new Date(Date.now() + LOTTO_RETRY_WAIT_MS).toISOString() : null,
    });

    log.info(
      `로또 주간 사이클 완료 [${trigger}] — 채점 ${scoredRound ?? "없음"} / 세대 v${strategy.version}${
        newVersion ? " (갱신)" : ""
      } / 다음 ${upcomingRound}회차 (${Date.now() - startedAt}ms)`
    );
    return { scoredRound, newVersion, upcomingRound, usageLimited, error, reason };
  } catch (e) {
    const err = e as Error;
    error = err.message;
    log.error(`로또 주간 사이클 오류 [${trigger}]: ${err.message}`);
    setLottoState({
      lastCycleAt: new Date().toISOString(),
      lastError: error,
      retryAt: new Date(Date.now() + LOTTO_RETRY_WAIT_MS).toISOString(),
    });
    return { scoredRound, newVersion, upcomingRound, usageLimited, error, reason: "error" };
  } finally {
    cycling = false;
  }
}

/** 놓친 사이클 보충. 기동 직후와 30분마다 스케줄러가 부른다. */
export async function catchUpWeeklyCycle(): Promise<void> {
  if (cycling) return;
  if (!shouldRunCycle(new Date(), getLottoState(), getUpcoming() !== null)) return;
  await runWeeklyCycle("catchup");
}

/**
 * 못박아 둔 추천 번호를 실제 당첨번호와 대조해 채점한다(사이클 2단계).
 *
 * @returns 채점한 회차. 아직 추첨 전이거나 못박은 번호가 없으면 null(둘 다 정상 경로다).
 */
export function scorePendingPicks(): number | null {
  const pending = getUpcoming();
  if (!pending) return null;

  const draw = getDraw(pending.round);
  if (!draw) return null; // 아직 추첨 전

  const last = lastScored(pending.run);
  if (last && pending.round <= last.round) {
    // 같은 회차를 두 번 채점하면 누적 점수가 어긋난다. 레코드만 정리하고 넘어간다.
    log.warn(`로또 ${pending.round}회차는 이미 채점돼 있습니다 — 추천 번호 레코드만 정리합니다.`);
    clearUpcoming();
    return null;
  }

  assertSetShape(pending.sets);
  const winning = winningNumbers(draw);
  const matches = pending.sets.map((s) => countMatches(s, winning));
  const { score } = summarizeMatches(matches);
  const cumScore = (last?.cumScore ?? 0) + score;

  insertPrediction(pending.run, {
    round: pending.round,
    drawDate: draw.drawDate,
    version: pending.version,
    sets: pending.sets,
    matches,
    score,
    cumScore,
  });
  clearUpcoming();

  const best = Math.max(0, ...matches);
  log.info(
    `로또 ${pending.round}회차 채점 — 최고적중 ${best}개, 회차점수 ${score} (v${pending.version}, 당첨 ${draw.numbers.join(",")}+${draw.bonus})`
  );
  return pending.round;
}

/**
 * 다음 회차 번호를 뽑아 저장한다.
 *
 * ⚠️ **이미 같은 회차로 못박혀 있으면 절대 덮어쓰지 않는다.** 사용자가 화면에서 이미 본 번호가
 * 조용히 바뀌면 다음 주의 '비교'는 사후에 고른 번호와의 비교가 되어 의미를 잃는다. 그 사이
 * 전략이 갱신됐더라도 새 세대는 그 다음 회차부터 적용된다(runWeeklyCycle 3번의 `from`).
 */
export function writeUpcomingPicks(run: number, strategy: LottoStrategy, round: number): number {
  const existing = getUpcoming();
  if (existing && existing.round === round) return existing.round;

  const draws = listDraws();
  // 미래 차단을 여기서도 그대로 지킨다. round = 최신+1 이라 사실상 전 이력이지만, 이 한 줄이
  // 있어야 회차가 어긋난 상황(수집 실패로 최신이 뒤처진 경우 등)에서도 규칙이 깨지지 않는다.
  const sets = generateSets(strategy.spec, historyBefore(draws, round), round, strategy.version);
  assertSetShape(sets);
  saveUpcoming(run, {
    round,
    sets,
    version: strategy.version,
    createdAt: new Date().toISOString(),
  });
  log.info(`로또 ${round}회차 추천 번호 확정 — v${strategy.version}`);
  return round;
}

/**
 * 전략 갱신 1회.
 *
 * 실패를 던지지 않고 분류해 돌려준다 — 호출부가 '한도라서 미룸'(재시도)과 '그냥 실패'(포기)를
 * 다르게 처리해야 하고, 어느 쪽이든 **번호 추출은 계속돼야** 하기 때문이다.
 */
async function evolve(
  run: number,
  fromRound: number,
  current: LottoStrategy,
  scoredThrough: number
): Promise<{ strategy: LottoStrategy | null; usageLimited: boolean; error?: string }> {
  const recent = recentResultsWithDraw(run, LOTTO_AGENT_RECENT);
  try {
    const proposal = await runLottoEvolveAgent({
      nextRound: fromRound,
      current,
      // recentResultsWithDraw 는 오래된 순이라 마지막이 방금 채점한 회차다.
      latest: recent.length > 0 ? recent[recent.length - 1] : null,
      recent,
      overall: summarize(run),
      window: summarize(run, Math.max(1, scoredThrough - LOTTO_AGENT_WINDOW + 1)),
      history: recentStrategies(6),
    });
    const next = insertStrategy({
      run,
      fromRound,
      spec: proposal.spec,
      rationale: proposal.rationale,
      hypothesis: proposal.hypothesis,
      author: "agent",
      model: proposal.model,
    });
    log.info(
      `로또 전략 v${next.version} 채택 (${fromRound}회차부터) — 변경: ${
        proposal.changed.join(", ") || "(없음 — 사양 유지)"
      }`
    );
    return { strategy: next, usageLimited: false };
  } catch (e) {
    const err = e as Error;
    if (isLottoUsageLimit(err)) {
      log.warn(`로또 전략 갱신 토큰 한도 소진 — 4시간 뒤 재시도 (${err.message})`);
      return { strategy: null, usageLimited: true };
    }
    log.error(`로또 전략 갱신 실패 → 직전 사양(v${current.version}) 유지: ${err.message}`);
    return { strategy: null, usageLimited: false, error: err.message };
  }
}

/**
 * cursor 회차 **이전**의 이력.
 *
 * 회차가 1부터 빠짐없이 이어진다는 전제를 두지 않고 매번 필터링한다 — 전제를 두면 수집이
 * 한 페이지 실패했을 때 엉뚱한 구간이 이력으로 들어가고, 그 사실이 드러나지 않는다.
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

/** 로또 탭이 받아 가는 전체 스냅샷. 차트가 없어져 1200점을 실을 이유도 없어졌다. */
export function getSnapshot(): LottoSnapshot {
  const state = getLottoState();
  const range = drawRange();
  const strategy = latestStrategy();
  const pending = getUpcoming();
  return {
    upcoming: pending
      ? {
          round: pending.round,
          sets: pending.sets,
          version: pending.version,
          createdAt: pending.createdAt,
        }
      : null,
    // 저장소는 오래된 순으로 준다(에이전트 프롬프트가 그 순서를 쓴다) → 화면용으로 뒤집는다.
    recentResults: recentResultsWithDraw(state.run, LOTTO_RECENT_LIMIT).reverse(),
    latestDraw: range.latest,
    version: strategy?.version ?? null,
    state,
    busy: cycling,
    nextCycleAt: nextCycleAt().toISOString(),
  };
}
