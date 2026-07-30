import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOTTO_CYCLE_CRON,
  historyBefore,
  lastCycleBoundary,
  nextCycleAt,
  shouldRunCycle,
} from "./cycle.ts";
import { SEED_SPEC, estimateHit3Rate, generateSets, makeRng, normalizeSpec } from "./strategy.ts";
import type { LottoDraw, LottoState } from "../../shared/lotto.ts";
import {
  LOTTO_BASELINE_PER_ROUND,
  countMatches,
  setScore,
  winningNumbers,
} from "../../shared/lotto.ts";

const draw = (round: number): LottoDraw => ({
  round,
  drawDate: "2020-01-01",
  numbers: [1, 2, 3, 4, 5, 6],
  bonus: 7,
});

/** 상태 기본값 — 테스트마다 필요한 필드만 덮어쓴다. */
const state = (patch: Partial<LottoState> = {}): LottoState => ({
  run: 1,
  lastCycleAt: null,
  lastScoredRound: null,
  lastEvolvedRound: null,
  lastError: null,
  retryAt: null,
  updatedAt: "2026-07-30T00:00:00.000Z",
  ...patch,
});

test("historyBefore 는 대상 회차와 그 이후를 절대 포함하지 않는다", () => {
  // 이 한 줄이 실험 전체의 유효성을 지탱한다. 미래가 새면 점수는 예뻐지고 의미는 사라진다.
  const draws = [1, 2, 3, 4, 5].map(draw);
  assert.deepEqual(historyBefore(draws, 3).map((d) => d.round), [1, 2]);
  assert.deepEqual(historyBefore(draws, 1).map((d) => d.round), []);
  assert.deepEqual(historyBefore(draws, 6).map((d) => d.round), [1, 2, 3, 4, 5]);
});

test("historyBefore 는 회차가 끊겨 있어도 경계를 지킨다", () => {
  const draws = [1, 2, 7, 8].map(draw); // 3~6 결손
  assert.deepEqual(historyBefore(draws, 7).map((d) => d.round), [1, 2]);
  assert.deepEqual(historyBefore(draws, 5).map((d) => d.round), [1, 2]);
});

// ── 주간 스케줄 경계 ──
//
// cron 은 맥이 자고 있으면 통째로 사라진다. 그래서 '놓친 실행'을 시각 계산으로 판정하는데,
// 그 계산이 하루라도 어긋나면 사이클이 매 30분 점검마다 다시 돌거나(중복) 다음 주까지
// 안 돌아온다(누락). 요일·시각 경계가 이 파일에서 못박히는 이유다.
// ⚠️ 로컬 시각 기준이므로 테스트도 반드시 로컬 생성자(new Date(y, m, d, h))를 쓴다.

test("cron 식과 경계 계산이 같은 시각(일요일 10:00)을 가리킨다", () => {
  assert.equal(LOTTO_CYCLE_CRON, "0 10 * * 0");
});

test("직전 경계는 지나간 가장 최근의 일요일 10:00 이다", () => {
  // 2026-07-30 은 목요일 → 직전 경계는 7/26(일) 10:00
  const thu = lastCycleBoundary(new Date(2026, 6, 30, 12, 34));
  assert.equal(thu.getDay(), 0);
  assert.equal(thu.getDate(), 26);
  assert.equal(thu.getHours(), 10);

  // 일요일 09:00 은 **아직 그 주 경계 전**이라 한 주 전이 직전 경계다.
  const sunEarly = lastCycleBoundary(new Date(2026, 7, 2, 9, 59));
  assert.equal(sunEarly.getDate(), 26);
  assert.equal(sunEarly.getMonth(), 6);

  // 정각은 경계에 포함된다.
  const sunSharp = lastCycleBoundary(new Date(2026, 7, 2, 10, 0));
  assert.equal(sunSharp.getDate(), 2);
  assert.equal(sunSharp.getMonth(), 7);
});

test("다음 실행 예정은 항상 미래의 일요일 10:00 이다", () => {
  for (const now of [
    new Date(2026, 6, 30, 12, 0), // 목
    new Date(2026, 7, 2, 9, 59), // 일 09:59
    new Date(2026, 7, 2, 10, 1), // 일 10:01
  ]) {
    const next = nextCycleAt(now);
    assert.equal(next.getDay(), 0);
    assert.equal(next.getHours(), 10);
    assert.ok(next.getTime() > now.getTime(), `${next.toString()} 가 미래가 아니다`);
  }
});

test("경계를 지난 뒤 아직 안 돌았으면 보충하고, 이미 돌았으면 다시 돌지 않는다", () => {
  const now = new Date(2026, 7, 2, 11, 0); // 일요일 11:00 (경계 = 같은 날 10:00)
  const before = new Date(2026, 6, 26, 10, 5).toISOString();
  const after = new Date(2026, 7, 2, 10, 2).toISOString();

  assert.equal(shouldRunCycle(now, state({ lastCycleAt: before }), true), true);
  assert.equal(shouldRunCycle(now, state({ lastCycleAt: after }), true), false);
  // 한 번도 안 돈 상태
  assert.equal(shouldRunCycle(now, state(), true), true);
});

test("다음 회차 번호가 비어 있으면 일요일이 아니어도 즉시 돈다", () => {
  // 배포 직후·DB 신규 생성 직후가 이 상태다. 다음 일요일까지 빈 화면을 두지 않는다.
  const now = new Date(2026, 6, 30, 12, 0);
  const justRan = state({ lastCycleAt: new Date(2026, 6, 30, 11, 0).toISOString() });
  assert.equal(shouldRunCycle(now, justRan, true), false);
  assert.equal(shouldRunCycle(now, justRan, false), true);
});

test("예약된 재시도 시각이 지나면 돈다 (토큰 한도·수집 실패 복구)", () => {
  const now = new Date(2026, 6, 30, 12, 0);
  const justRan = { lastCycleAt: new Date(2026, 6, 30, 8, 0).toISOString() };
  assert.equal(
    shouldRunCycle(now, state({ ...justRan, retryAt: new Date(2026, 6, 30, 16, 0).toISOString() }), true),
    false
  );
  assert.equal(
    shouldRunCycle(now, state({ ...justRan, retryAt: new Date(2026, 6, 30, 11, 0).toISOString() }), true),
    true
  );
});

/** 균등 무작위 추첨 회차를 만든다(시드 고정 — 테스트가 흔들리지 않게). */
function syntheticDraws(n: number, seed: number): LottoDraw[] {
  const rng = makeRng(seed);
  const out: LottoDraw[] = [];
  for (let r = 1; r <= n; r++) {
    const pool = Array.from({ length: 45 }, (_, i) => i + 1);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const picked = pool.slice(0, 7);
    out.push({
      round: r,
      drawDate: "2020-01-01",
      numbers: picked.slice(0, 6).sort((a, b) => a - b),
      bonus: picked[6],
    });
  }
  return out;
}

/** walk-forward 시뮬레이션 — 실험 러너와 동일한 순서로 점수를 낸다. */
function simulate(spec: typeof SEED_SPEC, draws: LottoDraw[]) {
  const scores: number[] = [];
  for (let i = 0; i < draws.length; i++) {
    const sets = generateSets(spec, draws.slice(0, i), draws[i].round, 1);
    const w = winningNumbers(draws[i]);
    scores.push(sets.reduce((s, set) => s + setScore(countMatches(set, w)), 0));
  }
  const mean = scores.reduce((a, x) => a + x, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((a, x) => a + (x - mean) ** 2, 0) / scores.length);
  return { mean, sd, se: sd / Math.sqrt(scores.length) };
}

/**
 * 이 실험의 **핵심 불변식**: 균등 무작위 추첨에서는 어떤 전략을 쓰든 회차당 기대점수가
 * 기준선과 같다. 전략이 바꿀 수 있는 것은 분산뿐이다.
 *
 * 이 테스트가 깨지는 경우는 둘 중 하나다 — 채점이 잘못됐거나, 예측이 미래를 봤거나.
 * 둘 다 조용한 실패라 사람 눈으로는 절대 못 잡는다. (실데이터 1234회차 실측에서도
 * 모든 전략이 |z| < 1.5 안에 들어왔다: 2026-07-29.)
 */
test("어떤 전략도 무작위 기준선을 유의하게 넘지 못한다 (평균은 고정, 분산만 바뀐다)", () => {
  const draws = syntheticDraws(400, 20260729);

  const cases = [
    ["시드(무작위)", SEED_SPEC],
    ["hot 편향", normalizeSpec({ ...SEED_SPEC, explore: 0, weights: { hot: 3 }, temperature: 0.4 })],
    ["fullCover", normalizeSpec({ ...SEED_SPEC, design: { ...SEED_SPEC.design, fullCover: true } })],
  ] as const;

  for (const [name, spec] of cases) {
    const { mean, se } = simulate(spec, draws);
    const z = (mean - LOTTO_BASELINE_PER_ROUND) / se;
    assert.ok(Math.abs(z) < 4, `${name}: 평균 ${mean.toFixed(2)} (z=${z.toFixed(2)}) — 기준선에서 벗어났다`);
  }
});

test("세트를 겹치지 않게 깔면 점수 분산이 줄어든다 (점수 축에서 유일하게 움직이는 것)", () => {
  const draws = syntheticDraws(300, 777);
  const independent = simulate(SEED_SPEC, draws);
  const covered = simulate(
    normalizeSpec({ ...SEED_SPEC, design: { ...SEED_SPEC.design, fullCover: true } }),
    draws
  );
  assert.ok(
    covered.sd < independent.sd,
    `fullCover sd=${covered.sd.toFixed(2)} 가 independent sd=${independent.sd.toFixed(2)} 보다 작아야 한다`
  );
});

/**
 * **목표 지표가 실제로 움직인다**는 것을 못박는다.
 *
 * 점수(위 테스트들)는 어떤 전략을 써도 기대값이 같지만, 3+ 적중 회차 비율은 다르다 —
 * 같은 총 적중량을 몇 개의 회차에 흩뿌리느냐가 디자인에 달려 있기 때문이다.
 * 이 테스트가 깨지면 목표 지표가 최적화 불가능해진 것이고, 그러면 실험의 전제가 무너진다.
 */
test("전 번호 커버 + 낮은 세트간 중복이 3+ 적중 회차 비율을 실제로 올린다", () => {
  const spread = estimateHit3Rate(
    generateSets(
      normalizeSpec({ ...SEED_SPEC, design: { fullCover: true, maxSetOverlap: 1, searchSteps: 0 } }),
      [],
      1,
      1
    )
  );
  // 10세트를 좁은 풀에 몰아넣으면 적중이 같은 회차에 겹쳐 낭비된다.
  const clumped = estimateHit3Rate([
    [1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 7], [1, 2, 3, 4, 5, 8], [1, 2, 3, 4, 5, 9],
    [1, 2, 3, 4, 5, 10], [1, 2, 3, 4, 6, 7], [1, 2, 3, 4, 6, 8], [1, 2, 3, 4, 6, 9],
    [1, 2, 3, 4, 6, 10], [1, 2, 3, 4, 7, 8],
  ]);
  assert.ok(spread > clumped + 0.1, `spread=${spread.toFixed(3)} vs clumped=${clumped.toFixed(3)}`);
  // 무작위 기준선(33.4%) 근처 이상이어야 한다 — 아래로 떨어지면 디자인이 역효과를 낸 것이다.
  assert.ok(spread > 0.33, `spread=${spread.toFixed(3)} 가 무작위 기준선보다 낮다`);
});

test("국소탐색을 켜면 목적함수가 나빠지지 않는다", () => {
  const base = normalizeSpec({ ...SEED_SPEC, design: { fullCover: false, maxSetOverlap: 6, searchSteps: 0 } });
  const tuned = normalizeSpec({ ...SEED_SPEC, design: { fullCover: false, maxSetOverlap: 6, searchSteps: 12 } });
  const before = estimateHit3Rate(generateSets(base, [], 1, 1));
  const after = estimateHit3Rate(generateSets(tuned, [], 1, 1));
  assert.ok(after >= before, `탐색 후 ${after.toFixed(4)} < 탐색 전 ${before.toFixed(4)}`);
});
