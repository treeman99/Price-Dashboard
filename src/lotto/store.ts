import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.ts";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { SEED_SPEC, normalizeSpec } from "./strategy.ts";
import type {
  LottoGenerationStat,
  LottoRecentRound,
  LottoRoundResult,
  LottoScorePoint,
  LottoState,
  LottoStrategy,
  LottoStrategySpec,
} from "../../shared/lotto.ts";
import {
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
  fromRound: number;
  spec: LottoStrategySpec;
  rationale?: string;
  hypothesis?: string;
  author: "seed" | "agent";
  model?: string;
}

/** 다음 세대를 추가하고 그 행을 돌려준다. version 은 자동으로 +1 된다. */
export function insertStrategy(input: InsertStrategyInput): LottoStrategy {
  const prev = latestStrategy();
  const version = (prev?.version ?? 0) + 1;
  const createdAt = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO lotto_strategies (version, from_round, spec_json, rationale, hypothesis, author, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      version,
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
    fromRound: input.fromRound,
    spec: input.spec,
    rationale: input.rationale ?? "",
    hypothesis: input.hypothesis ?? "",
    author: input.author,
    model: input.model ?? "",
    createdAt,
  };
}

/** 세대가 하나도 없으면 무작위 시드 세대를 만든다. 실험 시작의 유일한 진입점. */
export function ensureSeedStrategy(fromRound: number): LottoStrategy {
  const existing = latestStrategy();
  if (existing) return existing;
  return insertStrategy({
    fromRound,
    spec: SEED_SPEC,
    author: "seed",
    hypothesis: "무작위 추출. 이후 모든 세대가 넘어야 할 출발선.",
    rationale: "실험의 기준점. 특징을 전혀 쓰지 않는다(explore=1).",
  });
}

// ── 회차 채점 결과 ──

interface PredictionRow {
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

export function insertPrediction(r: LottoRoundResult): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO lotto_predictions (round, version, sets_json, matches_json, score, cum_score, scored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      r.round,
      r.version,
      JSON.stringify(r.sets),
      JSON.stringify(r.matches),
      r.score,
      r.cumScore,
      new Date().toISOString()
    );
}

/** 채점을 마친 마지막 회차와 그 누적 점수. 실험 재개 시 커서를 여기서 복원한다. */
export function lastScored(): { round: number; cumScore: number } | null {
  const row = db()
    .prepare(`SELECT round, cum_score FROM lotto_predictions ORDER BY round DESC LIMIT 1`)
    .get() as unknown as { round: number; cum_score: number } | undefined;
  return row ? { round: row.round, cumScore: row.cum_score } : null;
}

export function countScored(): number {
  const row = db().prepare(`SELECT COUNT(*) AS n FROM lotto_predictions`).get() as unknown as {
    n: number;
  };
  return Number(row?.n ?? 0);
}

/** 최근 n회차(오래된 순). 에이전트 프롬프트와 화면의 '최근 회차' 표가 함께 쓴다. */
export function recentResults(n: number): LottoRoundResult[] {
  const rows = db()
    .prepare(`${SELECT_RESULT} ORDER BY p.round DESC LIMIT ?`)
    .all(n) as unknown as PredictionJoinRow[];
  return rows.map(toResult).reverse();
}

/**
 * 최근 n회차 + 그 회차 당첨번호(오래된 순).
 * 화면이 "어느 번호가 맞았는지"를 칠하려면 예측과 정답이 한자리에 있어야 한다.
 */
export function recentResultsWithDraw(n: number): LottoRecentRound[] {
  const rows = db()
    .prepare(
      `SELECT p.*, d.draw_date, d.n1, d.n2, d.n3, d.n4, d.n5, d.n6, d.bonus
       FROM lotto_predictions p JOIN lotto_draws d ON d.round = p.round
       ORDER BY p.round DESC LIMIT ?`
    )
    .all(n) as unknown as Array<
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

/** 특정 세대의 결과 전체. */
export function resultsForVersion(version: number): LottoRoundResult[] {
  const rows = db()
    .prepare(`${SELECT_RESULT} WHERE p.version = ? ORDER BY p.round ASC`)
    .all(version) as unknown as PredictionJoinRow[];
  return rows.map(toResult);
}

/**
 * 차트용 점 목록.
 *
 * ⚠️ 여기서 세트 JSON 을 파싱하지 않는 것이 중요하다. 1200행 × 10세트를 매 조회마다
 * 파싱하면 스냅샷 하나가 수 MB 로 부풀어 브라우저가 버벅인다. 점수만 읽는다.
 */
export function scorePoints(): LottoScorePoint[] {
  const rows = db()
    .prepare(
      `SELECT p.round, p.version, p.score, p.cum_score, d.draw_date
       FROM lotto_predictions p JOIN lotto_draws d ON d.round = p.round
       ORDER BY p.round ASC`
    )
    .all() as unknown as Array<{
    round: number;
    version: number;
    score: number;
    cum_score: number;
    draw_date: string;
  }>;

  const out: LottoScorePoint[] = [];
  let windowSum = 0;
  for (let i = 0; i < rows.length; i++) {
    windowSum += rows[i].score;
    if (i >= LOTTO_MOVING_AVG_WINDOW) windowSum -= rows[i - LOTTO_MOVING_AVG_WINDOW].score;
    const span = Math.min(i + 1, LOTTO_MOVING_AVG_WINDOW);
    out.push({
      round: rows[i].round,
      drawDate: rows[i].draw_date,
      score: rows[i].score,
      cumScore: rows[i].cum_score,
      movingAvg: windowSum / span,
      version: rows[i].version,
    });
  }
  return out;
}

/**
 * 세대별 성적 요약. 에이전트 프롬프트와 화면이 **같은 함수**를 쓴다 —
 * 두 곳이 각자 집계하면 사용자가 보는 표와 모델이 보는 표가 갈라진다.
 */
export function generationStats(): LottoGenerationStat[] {
  const rows = db()
    .prepare(
      `SELECT version,
              MIN(round) AS from_round,
              MAX(round) AS to_round,
              COUNT(*)   AS rounds,
              SUM(score) AS total_score,
              MAX(score) AS best_score,
              MIN(score) AS worst_score
       FROM lotto_predictions GROUP BY version ORDER BY version ASC`
    )
    .all() as unknown as Array<{
    version: number;
    from_round: number;
    to_round: number;
    rounds: number;
    total_score: number;
    best_score: number;
    worst_score: number;
  }>;

  return rows.map((r) => {
    // 적중 개수 집계는 SQL 로 못 한다(JSON 배열이라). 세대당 한 번만 도는 경로라 부담 없다.
    const detail = db()
      .prepare(`SELECT matches_json FROM lotto_predictions WHERE version = ?`)
      .all(r.version) as unknown as Array<{ matches_json: string }>;

    let totalMatches = 0;
    let zeroSets = 0;
    let sets = 0;
    for (const d of detail) {
      let arr: number[];
      try {
        arr = JSON.parse(d.matches_json) as number[];
      } catch {
        continue;
      }
      for (const m of arr) {
        sets += 1;
        totalMatches += m;
        if (m === 0) zeroSets += 1;
      }
    }

    return {
      version: r.version,
      fromRound: r.from_round,
      toRound: r.to_round,
      rounds: r.rounds,
      totalScore: r.total_score,
      avgScore: r.rounds > 0 ? r.total_score / r.rounds : 0,
      bestScore: r.best_score,
      worstScore: r.worst_score,
      avgMatches: sets > 0 ? totalMatches / sets : 0,
      zeroSetRate: sets > 0 ? zeroSets / sets : 0,
    };
  });
}

/** 채점 결과와 전략 세대를 통째로 지운다(회차 원본은 남긴다 — 다시 받을 이유가 없다). */
export function resetExperiment(): void {
  db().exec(`DELETE FROM lotto_predictions; DELETE FROM lotto_strategies;`);
}

// ── 실험 상태 ──
//
// 커서(다음 회차)를 여기 저장하지 않는 것이 설계의 핵심이다. 커서는 항상
// `lastScored().round + 1` 로 **유도**한다. 상태 파일과 DB 가 갈라질 수 있는 값을 두면,
// 서버가 채점 직후 죽었을 때 회차 하나를 건너뛰거나 두 번 채점하게 된다.

const STATE_PATH = path.join(path.dirname(config.dbPath), "lotto-state.json");

const DEFAULT_STATE: LottoState = {
  status: "idle",
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
