import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.ts";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { SEED_SPEC, normalizeSpec } from "./strategy.ts";
import type {
  LottoRecentRound,
  LottoRoundResult,
  LottoState,
  LottoStrategy,
  LottoStrategySpec,
  LottoSummary,
  LottoUpcoming,
} from "../../shared/lotto.ts";
import { LOTTO_SET_COUNT, setScore, weightedHitScore } from "../../shared/lotto.ts";

/**
 * 로또 예측의 저장소.
 *
 * SQL 을 `src/db/repo.ts` 에 넣지 않고 여기 모은 이유: 이 네 표는 로또 전용이고 다른 탭이
 * 절대 읽지 않는다. repo.ts 는 이미 1300줄이 넘어, 이것 때문에 공용 파일을 더 키우면 다음
 * 사람이 '가격/증시 저장소'를 읽을 때 상관없는 코드를 먼저 지나야 한다.
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

/**
 * 최근 n개 세대(**최신이 앞**). 에이전트 프롬프트의 '이미 시도한 전략' 표가 쓴다.
 *
 * 전체를 싣지 않는 이유: 백테스트 시절에 쌓인 세대가 169개다. 전부 프롬프트에 넣으면 토큰만
 * 태우고, 오래된 세대는 지금 사양과 너무 멀어 '반복하지 마라'의 근거로도 쓸모가 없다.
 */
export function recentStrategies(n: number): LottoStrategy[] {
  const rows = db()
    .prepare(`SELECT * FROM lotto_strategies ORDER BY version DESC LIMIT ?`)
    .all(n) as unknown as StrategyRow[];
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
 * 세대가 하나도 없으면 무작위 시드 세대를 만든다(빈 DB 로 처음 기동한 경우).
 * 이미 세대가 있으면 **최신 세대를 그대로 쓴다** — 지금까지 쌓인 진화를 버릴 이유가 없다.
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
    rationale: "기준점. 특징을 전혀 쓰지 않는다(explore=1).",
  });
}

// ── 회차 채점 결과 ──
//
// 모든 조회는 **반복(run) 스코프**다. 반복 기능은 없어졌지만 과거 백테스트가 1~1234회차를
// 8바퀴 돌아 같은 회차 번호가 8번씩 들어 있다 — run 을 빼먹은 질의는 그 8바퀴를 섞어
// 누적 점수와 적중률을 조용히 망가뜨린다.

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

/** 최근 n회차(오래된 순). */
export function recentResults(run: number, n: number): LottoRoundResult[] {
  const rows = db()
    .prepare(`${SELECT_RESULT} WHERE p.run = ? ORDER BY p.round DESC LIMIT ?`)
    .all(run, n) as unknown as PredictionJoinRow[];
  return rows.map(toResult).reverse();
}

/**
 * 최근 n회차 + 그 회차 당첨번호(**오래된 순**). 화면과 에이전트 프롬프트가 함께 쓴다.
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

/** 여러 행의 적중 통계를 한 번에 집계한다. */
function aggregate(rows: Array<{ matches_json: string; score: number }>) {
  let totalMatches = 0;
  let zeroSets = 0;
  let sets = 0;
  let hit3Rounds = 0;
  let hit4Rounds = 0;
  let hit5Rounds = 0;
  let hit3Sets = 0;
  let bestMatch = 0;
  let totalScore = 0;
  let weightedTotal = 0;
  for (const r of rows) {
    totalScore += r.score;
    let arr: number[];
    try {
      arr = JSON.parse(r.matches_json) as number[];
    } catch {
      continue;
    }
    let any3 = false;
    let roundBest = 0;
    for (const m of arr) {
      if (m > roundBest) roundBest = m;
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
    if (roundBest >= 4) hit4Rounds += 1;
    if (roundBest >= 5) hit5Rounds += 1;
    weightedTotal += weightedHitScore(roundBest);
  }
  const n = rows.length;
  return {
    rounds: n,
    totalScore,
    avgScore: n > 0 ? totalScore / n : 0,
    avgMatches: sets > 0 ? totalMatches / sets : 0,
    zeroSetRate: sets > 0 ? zeroSets / sets : 0,
    hit3Rounds,
    hit4Rounds,
    hit5Rounds,
    hit3Sets,
    hit3Rate: n > 0 ? hit3Rounds / n : 0,
    weightedRate: n > 0 ? weightedTotal / n : 0,
    bestMatch,
  };
}

/**
 * 이 반복의 채점 기록 요약. `sinceRound` 를 주면 그 회차 **이상**만 집계한다.
 *
 * 화면이 아니라 **에이전트 프롬프트**를 위한 함수다. 두 벌(전체·최근)을 같은 함수로 내는 것이
 * 중요하다 — 각자 집계하면 모델이 보는 두 숫자의 정의가 갈라지고, 그러면 모델이 "최근이
 * 좋아졌다"를 잘못 읽는다.
 */
export function summarize(run: number, sinceRound = 0): LottoSummary {
  const rows = db()
    .prepare(
      `SELECT p.score, p.matches_json FROM lotto_predictions p
       WHERE p.run = ? AND p.round >= ? ORDER BY p.round ASC`
    )
    .all(run, sinceRound) as unknown as Array<{ score: number; matches_json: string }>;
  const agg = aggregate(rows);
  return {
    rounds: agg.rounds,
    avgScore: agg.avgScore,
    avgMatches: agg.avgMatches,
    hit3Rounds: agg.hit3Rounds,
    hit4Rounds: agg.hit4Rounds,
    hit5Rounds: agg.hit5Rounds,
    hit3Sets: agg.hit3Sets,
    hit3Rate: agg.hit3Rate,
    weightedRate: agg.weightedRate,
    bestMatch: agg.bestMatch,
  };
}

// ── 다음 회차 추천 번호(추첨 전) ──
//
// **항상 0행 또는 1행.** 추첨 전에 한 번 뽑아 못박고, 그 회차가 추첨되면 채점한 뒤 지운다.
// 저장하지 않고 매번 생성하면 다음 주에 채점할 대상이 요청마다 달라져 "추천했던 번호와
// 실제 추첨 결과 비교"가 성립하지 않는다(schema.sql 의 lotto_upcoming 주석 참고).

/** 저장해 둔 추천 번호. 없으면 null. */
export function getUpcoming(): (LottoUpcoming & { run: number }) | null {
  const row = db()
    .prepare(`SELECT * FROM lotto_upcoming ORDER BY round DESC LIMIT 1`)
    .get() as unknown as
    | { round: number; run: number; version: number; sets_json: string; created_at: string }
    | undefined;
  if (!row) return null;
  let sets: number[][];
  try {
    sets = JSON.parse(row.sets_json) as number[][];
  } catch {
    log.warn(`로또 추천 번호(${row.round}회차) 파싱 실패 → 폐기하고 다시 뽑는다`);
    clearUpcoming();
    return null;
  }
  return {
    round: row.round,
    run: row.run,
    version: row.version,
    sets,
    createdAt: row.created_at,
  };
}

/** 추천 번호를 못박는다. 항상 1행만 남긴다(이전 행은 지운다). */
export function saveUpcoming(run: number, u: LottoUpcoming): void {
  const conn = db();
  conn.exec("DELETE FROM lotto_upcoming");
  conn
    .prepare(
      `INSERT INTO lotto_upcoming (round, run, version, sets_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(u.round, run, u.version, JSON.stringify(u.sets), u.createdAt);
}

export function clearUpcoming(): void {
  db().exec("DELETE FROM lotto_upcoming");
}

// ── 주간 사이클 상태 ──
//
// 커서(다음 회차)를 여기 저장하지 않는 것이 설계의 핵심이다. 커서는 항상
// `lastScored().round + 1` 로 **유도**한다. 상태 파일과 DB 가 갈라질 수 있는 값을 두면,
// 서버가 채점 직후 죽었을 때 회차 하나를 건너뛰거나 두 번 채점하게 된다.

const STATE_PATH = path.join(path.dirname(config.dbPath), "lotto-state.json");

const DEFAULT_STATE: LottoState = {
  run: 1,
  lastCycleAt: null,
  lastScoredRound: null,
  lastEvolvedRound: null,
  lastError: null,
  retryAt: null,
  updatedAt: new Date(0).toISOString(),
};

/**
 * 상태 파일 읽기.
 *
 * ⚠️ 스프레드(`...raw`)를 쓰지 않고 필드를 하나씩 집는다. 백테스트 시절의 파일에는
 * status/pauseReason/startedAt/doneAcknowledged 같은 죽은 키가 남아 있는데, 스프레드로
 * 받으면 그것들이 계속 파일에 되쓰여 다음 사람이 "아직 상태 머신이 있는 줄" 알게 된다.
 * 반면 `run` 은 **반드시 이어받아야 한다** — 그 값이 과거 8바퀴 중 어느 기록을 이어 쓸지
 * 결정하고, 1 로 되돌아가면 13년 전 회차부터 다시 채점하려 든다.
 */
export function getLottoState(): LottoState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Partial<LottoState>;
    const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
    const num = (v: unknown): number | null => (Number.isInteger(v) ? (v as number) : null);
    return {
      run: Number.isInteger(raw.run) && (raw.run as number) >= 1 ? (raw.run as number) : 1,
      lastCycleAt: str(raw.lastCycleAt),
      lastScoredRound: num(raw.lastScoredRound),
      lastEvolvedRound: num(raw.lastEvolvedRound),
      lastError: str(raw.lastError),
      retryAt: str(raw.retryAt),
      updatedAt: str(raw.updatedAt) ?? DEFAULT_STATE.updatedAt,
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
