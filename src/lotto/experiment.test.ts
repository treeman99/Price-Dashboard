import { test } from "node:test";
import assert from "node:assert/strict";
import { historyBefore, shouldEvolve } from "./experiment.ts";
import { SEED_SPEC, estimateHit3Rate, generateSets, makeRng, normalizeSpec } from "./strategy.ts";
import type { LottoDraw } from "../../shared/lotto.ts";
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

/**
 * **실험 반복 회귀 테스트.**
 *
 * 개정 시점을 `strategy.fromRound` 로 재던 시절, 반복(run 2)에서 직전 바퀴의 세대를 물려받으면
 * fromRound 가 1201 인데 새 커서는 1이라 `1 - 1201 >= 50` 이 영원히 거짓이었다.
 * 결과: 2바퀴째가 **진화 0회로 136ms 만에 완주**했다(2026-07-29 실측). 사용자 눈에는
 * "반복을 누르면 바로 종료로 간다"로 보였다. 기준을 '이번 바퀴에서 이 세대가 시작한 회차'로
 * 바꾼 것이 수정이고, 아래가 그 계약이다.
 */
test("세대 개정은 '이번 바퀴에서 세대가 시작한 회차' 기준으로 50회차마다 발화한다", () => {
  // 옛 방식이 만들던 상태 — 물려받은 fromRound(1201)를 그대로 쓰면 발화하지 않는다.
  assert.equal(shouldEvolve(1, 1201), false);
  assert.equal(shouldEvolve(1234, 1201), false);

  // 이번 바퀴 시작(1) 기준이면 51회차에서 정상 발화한다.
  assert.equal(shouldEvolve(50, 1), false);
  assert.equal(shouldEvolve(51, 1), true);

  // 세대가 51에서 시작했으면 101에서 다음 개정.
  assert.equal(shouldEvolve(100, 51), false);
  assert.equal(shouldEvolve(101, 51), true);
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
