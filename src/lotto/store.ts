import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.ts";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { SEED_SPEC, clearDesignCache, normalizeSpec } from "./strategy.ts";
import type {
  LottoGenerationStat,
  LottoRecentRound,
  LottoRoundResult,
  LottoRunStat,
  LottoScorePoint,
  LottoState,
  LottoStrategy,
  LottoStrategySpec,
} from "../../shared/lotto.ts";
import {
  LOTTO_HIT3_WINDOW,
  LOTTO_MOVING_AVG_WINDOW,
  LOTTO_SET_COUNT,
  setScore,
} from "../../shared/lotto.ts";

/**
 * 로또 실험의 저장소.
 *
 * SQL 을 `src/db/repo.ts` 에 넣지 않고 여기 모은 이유: 이 세 표는 실험 기록 전용이고
 * 다른 탭이 절대 읽지 않는다. repo.ts 는 이미 1300줄이 넘어, 실험 하나 때문에 공용 파일을
 * 더 키우면 다음 사람이 '가격/증시 저장소'를 읽을 때 상관없는 코드를 먼저 지나야 한다.
 */

// ── 전략 세대 ──

interface StrategyRow {
  version: number;
  run: number;
  from_round: number;
  spec_json: string;
  rationale: string;
  hypothesis: string;
  author: string;
  model: string;
  created_at: string;
}

function toStrategy(r: StrategyRow): LottoStrategy {
  let spec: LottoStrategySpec;
  try {
    // 저장된 사양도 다시 정규화한다. 노브 범위를 나중에 좁히면 옛 행이 범위 밖일 수 있는데,
    // 그때 엔진이 이상한 분포로 조용히 도는 것보다 현재 규칙으로 접히는 편이 낫다.
    spec = normalizeSpec(JSON.parse(r.spec_json));
  } catch {
    log.warn(`로또 전략 v${r.version} 사양 파싱 실패 → 시드 사양으로 대체`);
    spec = SEED_SPEC;
  }
  return {
    version: r.version,
    run: r.run ?? 1,
    fromRound: r.from_round,
    spec,
    rationale: r.rationale ?? "",
    hypothesis: r.hypothesis ?? "",
    author: r.author === "agent" ? "agent" : "seed",
    model: r.model ?? "",
    createdAt: r.created_at,
  };
}

export function listStrategies(): LottoStrategy[] {
  const rows = db()
    .prepare(`SELECT * FROM lotto_strategies ORDER BY version ASC`)
    .all() as unknown as StrategyRow[];
  return rows.map(toStrategy);
}

/** 가장 최근 세대. 없으면 null(= 아직 실험이 시작되지 않았다). */
export function latestStrategy(): LottoStrategy | null {
  const row = db()
    .prepare(`SELECT * FROM lotto_strategies ORDER BY version DESC LIMIT 1`)
    .get() as unknown as StrategyRow | undefined;
  return row ? toStrategy(row) : null;
}

export interface InsertStrategyInput {
  run: number;
  fromRound: number;
  spec: LottoStrategySpec;
  rationale?: string;
  hypothesis?: string;
  author: "seed" | "agent";
  model?: string;
}

/** 다음 세대를 추가하고 그 행을 돌려준다. version 은 **반복을 넘어서도** 자동으로 +1 된다. */
export function insertStrategy(input: InsertStrategyInput): LottoStrategy {
  const prev = latestStrategy();
  const version = (prev?.version ?? 0) + 1;
  const createdAt = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO lotto_strategies (version, run, from_round, spec_json, rationale, hypothesis, author, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      version,
      input.run,
      input.fromRound,
      JSON.stringify(input.spec),
      input.rationale ?? "",
      input.hypothesis ?? "",
      input.author,
      input.model ?? "",
      createdAt
    );
  return {
    version,
    run: input.run,
    fromRound: input.fromRound,
    spec: input.spec,
    rationale: input.rationale ?? "",
    hypothesis: input.hypothesis ?? "",
    author: input.author,
    model: input.model ?? "",
    createdAt,
  };
}

/**
 * 세대가 하나도 없으면 무작위 시드 세대를 만든다. 실험 시작의 유일한 진입점.
 *
 * ⚠️ 반복(run 2 이상)에서는 **새 시드를 만들지 않는다.** 반복은 초기화가 아니라 이어 도는
 *    것이므로, 직전 반복이 도달한 전략에서 그대로 출발해야 반복 간 비교가 의미를 갖는다.
 */
export function ensureSeedStrategy(run: number, fromRound: number): LottoStrategy {
  const existing = latestStrategy();
  if (existing) return existing;
  return insertStrategy({
    run,
    fromRound,
    spec: SEED_SPEC,
    author: "seed",
    hypothesis: "무작위 추출. 이후 모든 세대가 넘어야 할 출발선.",
    rationale: "실험의 기준점. 특징을 전혀 쓰지 않는다(explore=1).",
  });
}

// ── 회차 채점 결과 ──
//
// 모든 조회는 **반복(run) 스코프**다. '실험 반복'을 누르면 같은 회차 번호가 다시 채점되므로,
// run 을 빼먹은 질의는 두 바퀴의 기록을 섞어 누적 점수와 적중률을 조용히 망가뜨린다.

interface PredictionRow {
  run: number;
  round: number;
  version: number;
  sets_json: string;
  matches_json: string;
  score: number;
  cum_score: number;
}

/** draw_date 는 lotto_draws 조인으로 채운다(예측 표에 중복 저장하지 않는다). */
interface PredictionJoinRow extends PredictionRow {
  draw_date: string;
}

function toResult(r: PredictionJoinRow): LottoRoundResult {
  return {
    round: r.round,
    drawDate: r.draw_date,
    version: r.version,
    sets: JSON.parse(r.sets_json) as number[][],
    matches: JSON.parse(r.matches_json) as number[],
    score: r.score,
    cumScore: r.cum_score,
  };
}

const SELECT_RESULT = `
  SELECT p.*, d.draw_date
  FROM lotto_predictions p
  JOIN lotto_draws d ON d.round = p.round
`;

export function insertPrediction(run: number, r: LottoRoundResult): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO lotto_predictions (run, round, version, sets_json, matches_json, score, cum_score, scored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      run,
      r.round,
      r.version,
      JSON.stringify(r.sets),
      JSON.stringify(r.matches),
      r.score,
      r.cumScore,
      new Date().toISOString()
    );
}

/** 이 반복에서 채점을 마친 마지막 회차와 그 누적 점수. 재개 시 커서를 여기서 복원한다. */
export function lastScored(run: number): { round: number; cumScore: number } | null {
  const row = db()
    .prepare(
      `SELECT round, cum_score FROM lotto_predictions WHERE run = ? ORDER BY round DESC LIMIT 1`
    )
    .get(run) as unknown as { round: number; cum_score: number } | undefined;
  return row ? { round: row.round, cumScore: row.cum_score } : null;
}

export function countScored(run: number): number {
  const row = db()
    .prepare(`SELECT COUNT(*) AS n FROM lotto_predictions WHERE run = ?`)
    .get(run) as unknown as { n: number };
  return Number(row?.n ?? 0);
}

/**
 * **이번 바퀴에서** 이 세대가 처음 적용된 회차. 아직 한 회차도 안 돌았으면 null.
 *
 * 세대 개정 시점을 `strategy.fromRound` 로 재면 안 된다는 것이 여기 있는 이유다:
 * fromRound 는 그 세대가 만들어진 **바퀴**의 회차 번호라, 반복(run 2 이상)에서 직전 바퀴의
 * 세대를 물려받으면 값이 새 커서보다 한참 크다(실측: v25.fromRound=1201 vs 커서 1).
 * 그러면 `커서 - fromRound >= 50` 이 영원히 거짓이 되어 **진화가 한 번도 일어나지 않고**
 * 1234회차가 통째로 한 세대로 끝난다(2026-07-29 실측: 136ms 만에 완주, 개정 0회).
 */
export function generationStartRound(run: number, version: number): number | null {
  const row = db()
    .prepare(`SELECT MIN(round) AS lo FROM lotto_predictions WHERE run = ? AND version = ?`)
    .get(run, version) as unknown as { lo: number | null } | undefined;
  return row?.lo ?? null;
}

/** DB 에 기록이 있는 반복 번호들(오름차순). */
export function listRuns(): number[] {
  const rows = db()
    .prepare(`SELECT DISTINCT run FROM lotto_predictions ORDER BY run ASC`)
    .all() as unknown as Array<{ run: number }>;
  return rows.map((r) => r.run);
}

/** 최근 n회차(오래된 순). 에이전트 프롬프트와 화면의 '최근 회차' 표가 함께 쓴다. */
export function recentResults(run: number, n: number): LottoRoundResult[] {
  const rows = db()
    .prepare(`${SELECT_RESULT} WHERE p.run = ? ORDER BY p.round DESC LIMIT ?`)
    .all(run, n) as unknown as PredictionJoinRow[];
  return rows.map(toResult).reverse();
}

/**
 * 최근 n회차 + 그 회차 당첨번호(오래된 순).
 * 화면이 "어느 번호가 맞았는지"를 칠하려면 예측과 정답이 한자리에 있어야 한다.
 */
export function recentResultsWithDraw(run: number, n: number): LottoRecentRound[] {
  const rows = db()
    .prepare(
      `SELECT p.*, d.draw_date, d.n1, d.n2, d.n3, d.n4, d.n5, d.n6, d.bonus
       FROM lotto_predictions p JOIN lotto_draws d ON d.round = p.round
       WHERE p.run = ? ORDER BY p.round DESC LIMIT ?`
    )
    .all(run, n) as unknown as Array<
    PredictionJoinRow & {
      n1: number;
      n2: number;
      n3: number;
      n4: number;
      n5: number;
      n6: number;
      bonus: number;
    }
  >;
  return rows
    .map((r) => ({
      ...toResult(r),
      drawNumbers: [r.n1, r.n2, r.n3, r.n4, r.n5, r.n6],
      drawBonus: r.bonus,
    }))
    .reverse();
}

/** 적중 배열에서 목표 지표(3+ 여부)와 최대 적중을 뽑는다. 한 곳에만 둔다. */
function hit3Of(matchesJson: string): { hit3: boolean; best: number; sets3: number } {
  let arr: number[];
  try {
    arr = JSON.parse(matchesJson) as number[];
  } catch {
    return { hit3: false, best: 0, sets3: 0 };
  }
  let best = 0;
  let sets3 = 0;
  for (const m of arr) {
    if (m > best) best = m;
    if (m >= 3) sets3 += 1;
  }
  return { hit3: sets3 > 0, best, sets3 };
}

/**
 * 차트용 점 목록(현재 반복).
 *
 * ⚠️ 세트 JSON 은 파싱하지 않는다 — 1200행 × 10세트를 매 조회마다 파싱하면 스냅샷이 수 MB 로
 * 부푼다. 반면 matches_json 은 정수 10개짜리라 파싱해도 무시할 수 있고, 목표 지표(3+ 여부)가
 * 여기서 나오므로 컬럼을 새로 만들지 않고 그대로 계산한다.
 */
export function scorePoints(run: number): LottoScorePoint[] {
  const rows = db()
    .prepare(
      `SELECT p.round, p.version, p.score, p.cum_score, p.matches_json, d.draw_date
       FROM lotto_predictions p JOIN lotto_draws d ON d.round = p.round
       WHERE p.run = ? ORDER BY p.round ASC`
    )
    .all(run) as unknown as Array<{
    round: number;
    version: number;
    score: number;
    cum_score: number;
    matches_json: string;
    draw_date: string;
  }>;

  const out: LottoScorePoint[] = [];
  let windowSum = 0;
  let hitWindow = 0;
  let hitTotal = 0;
  const hits: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const { hit3, best } = hit3Of(rows[i].matches_json);
    hits.push(hit3 ? 1 : 0);

    windowSum += rows[i].score;
    if (i >= LOTTO_MOVING_AVG_WINDOW) windowSum -= rows[i - LOTTO_MOVING_AVG_WINDOW].score;
    const span = Math.min(i + 1, LOTTO_MOVING_AVG_WINDOW);

    hitWindow += hits[i];
    if (i >= LOTTO_HIT3_WINDOW) hitWindow -= hits[i - LOTTO_HIT3_WINDOW];
    const hitSpan = Math.min(i + 1, LOTTO_HIT3_WINDOW);

    hitTotal += hits[i];

    out.push({
      round: rows[i].round,
      drawDate: rows[i].draw_date,
      score: rows[i].score,
      cumScore: rows[i].cum_score,
      movingAvg: windowSum / span,
      version: rows[i].version,
      hit3,
      hit3Rate: hitWindow / hitSpan,
      cumHit3Rate: hitTotal / (i + 1),
      bestMatch: best,
    });
  }
  return out;
}

/** 여러 행의 적중 통계를 한 번에 집계한다(세대 요약과 반복 요약이 공유). */
function aggregate(rows: Array<{ matches_json: string; score: number }>) {
  let totalMatches = 0;
  let zeroSets = 0;
  let sets = 0;
  let hit3Rounds = 0;
  let hit3Sets = 0;
  let bestMatch = 0;
  let totalScore = 0;
  for (const r of rows) {
    totalScore += r.score;
    let arr: number[];
    try {
      arr = JSON.parse(r.matches_json) as number[];
    } catch {
      continue;
    }
    let any3 = false;
    for (const m of arr) {
      sets += 1;
      totalMatches += m;
      if (m === 0) zeroSets += 1;
      if (m >= 3) {
        hit3Sets += 1;
        any3 = true;
      }
      if (m > bestMatch) bestMatch = m;
    }
    if (any3) hit3Rounds += 1;
  }
  const n = rows.length;
  return {
    rounds: n,
    totalScore,
    avgScore: n > 0 ? totalScore / n : 0,
    avgMatches: sets > 0 ? totalMatches / sets : 0,
    zeroSetRate: sets > 0 ? zeroSets / sets : 0,
    hit3Rounds,
    hit3Sets,
    hit3Rate: n > 0 ? hit3Rounds / n : 0,
    bestMatch,
  };
}

/**
 * 세대별 성적 요약. 에이전트 프롬프트와 화면이 **같은 함수**를 쓴다 —
 * 두 곳이 각자 집계하면 사용자가 보는 표와 모델이 보는 표가 갈라진다.
 *
 * 세대(version)는 반복을 넘어서도 계속 증가하므로 run 으로 나누지 않는다.
 */
export function generationStats(): LottoGenerationStat[] {
  const rows = db()
    .prepare(
      `SELECT p.version, p.round, p.score, p.matches_json
       FROM lotto_predictions p ORDER BY p.version ASC, p.round ASC`
    )
    .all() as unknown as Array<{
    version: number;
    round: number;
    score: number;
    matches_json: string;
  }>;

  const byVersion = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byVersion.get(r.version) ?? [];
    list.push(r);
    byVersion.set(r.version, list);
  }

  return [...byVersion.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([version, list]) => {
      const agg = aggregate(list);
      const roundsList = list.map((r) => r.round);
      return {
        version,
        fromRound: Math.min(...roundsList),
        toRound: Math.max(...roundsList),
        rounds: agg.rounds,
        totalScore: agg.totalScore,
        avgScore: agg.avgScore,
        bestScore: Math.max(...list.map((r) => r.score)),
        worstScore: Math.min(...list.map((r) => r.score)),
        avgMatches: agg.avgMatches,
        zeroSetRate: agg.zeroSetRate,
        hit3Rate: agg.hit3Rate,
        hit3Rounds: agg.hit3Rounds,
        hit3Sets: agg.hit3Sets,
        bestMatch: agg.bestMatch,
      };
    });
}

/**
 * 반복별 요약. **이 실험의 결론이 읽히는 표**다 — 두 번째 바퀴가 첫 번째보다 나은가.
 * 세대별 표는 표본이 50회차뿐이라 3%p 차이를 못 보지만, 반복은 1234회차라 볼 수 있다.
 */
export function runStats(currentRun: number): LottoRunStat[] {
  const rows = db()
    .prepare(
      `SELECT p.run, p.round, p.version, p.score, p.matches_json
       FROM lotto_predictions p ORDER BY p.run ASC, p.round ASC`
    )
    .all() as unknown as Array<{
    run: number;
    round: number;
    version: number;
    score: number;
    matches_json: string;
  }>;

  const byRun = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byRun.get(r.run) ?? [];
    list.push(r);
    byRun.set(r.run, list);
  }

  return [...byRun.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([run, list]) => {
      const agg = aggregate(list);
      const roundsList = list.map((r) => r.round);
      const versions = list.map((r) => r.version);
      return {
        run,
        fromRound: Math.min(...roundsList),
        toRound: Math.max(...roundsList),
        rounds: agg.rounds,
        firstVersion: Math.min(...versions),
        lastVersion: Math.max(...versions),
        hit3Rate: agg.hit3Rate,
        hit3Rounds: agg.hit3Rounds,
        avgScore: agg.avgScore,
        avgMatches: agg.avgMatches,
        bestMatch: agg.bestMatch,
        // ⚠️ '현재 바퀴인가'만으로는 부족하다. 완주해도 state.run 은 그대로라 진행중으로 남는다
        // (실측: 진행률은 1234/1234 인데 표는 '진행중'). 완주(done)면 끝난 것이다.
        // paused 는 진행중이 맞다 — 재개하면 이어서 돌기 때문이다.
        inProgress: run === currentRun && getLottoState().status !== "done",
      };
    });
}

/** 채점 결과와 전략 세대를 통째로 지운다(회차 원본은 남긴다 — 다시 받을 이유가 없다). */
export function resetExperiment(): void {
  db().exec(`DELETE FROM lotto_predictions; DELETE FROM lotto_strategies;`);
  // 디자인 캐시는 version 을 키로 쓴다. 안 지우면 초기화 후 다시 만들어진 v1 이 옛 디자인을
  // 물려받아, '무작위 출발선'이어야 할 세대가 최적화된 디자인으로 시작한다.
  clearDesignCache();
}

// ── 실험 상태 ──
//
// 커서(다음 회차)를 여기 저장하지 않는 것이 설계의 핵심이다. 커서는 항상
// `lastScored().round + 1` 로 **유도**한다. 상태 파일과 DB 가 갈라질 수 있는 값을 두면,
// 서버가 채점 직후 죽었을 때 회차 하나를 건너뛰거나 두 번 채점하게 된다.

const STATE_PATH = path.join(path.dirname(config.dbPath), "lotto-state.json");

const DEFAULT_STATE: LottoState = {
  status: "idle",
  run: 1,
  pauseReason: null,
  resumeAt: null,
  lastError: null,
  startedAt: null,
  finishedAt: null,
  doneAcknowledged: false,
  updatedAt: new Date(0).toISOString(),
};

export function getLottoState(): LottoState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Partial<LottoState>;
    const status =
      raw.status === "running" || raw.status === "paused" || raw.status === "done"
        ? raw.status
        : "idle";
    return {
      ...DEFAULT_STATE,
      ...raw,
      status,
      // run 이 깨지면 두 바퀴의 기록이 섞인다. 정수 1 이상만 허용한다.
      run: Number.isInteger(raw.run) && (raw.run as number) >= 1 ? (raw.run as number) : 1,
      pauseReason:
        raw.pauseReason === "usage-limit" ||
        raw.pauseReason === "manual" ||
        raw.pauseReason === "error"
          ? raw.pauseReason
          : null,
      doneAcknowledged: raw.doneAcknowledged === true,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function setLottoState(patch: Partial<LottoState>): LottoState {
  const next: LottoState = {
    ...getLottoState(),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
  return next;
}

export function resetLottoState(): LottoState {
  return setLottoState({ ...DEFAULT_STATE, updatedAt: new Date().toISOString() });
}

/** 한 회차 결과에서 세트당 평균 적중과 0적중 세트 수를 뽑는다(로그·요약용). */
export function summarizeMatches(matches: number[]): {
  total: number;
  zero: number;
  score: number;
} {
  const total = matches.reduce((s, m) => s + m, 0);
  const zero = matches.filter((m) => m === 0).length;
  const score = matches.reduce((s, m) => s + setScore(m), 0);
  return { total, zero, score };
}

/** 세트 수가 규약(10)과 다르면 저장 전에 잡는다 — 조용히 어긋나면 점수 비교가 무의미해진다. */
export function assertSetShape(sets: number[][]): void {
  if (sets.length !== LOTTO_SET_COUNT) {
    throw new Error(`세트 수가 ${LOTTO_SET_COUNT}개가 아님: ${sets.length}`);
  }
}
