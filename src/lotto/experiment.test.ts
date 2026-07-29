import { test } from "node:test";
import assert from "node:assert/strict";
import { historyBefore } from "./experiment.ts";
import { SEED_SPEC, generateSets, makeRng, normalizeSpec } from "./strategy.ts";
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
    ["max-coverage", normalizeSpec({ ...SEED_SPEC, coverage: "max-coverage" })],
  ] as const;

  for (const [name, spec] of cases) {
    const { mean, se } = simulate(spec, draws);
    const z = (mean - LOTTO_BASELINE_PER_ROUND) / se;
    assert.ok(Math.abs(z) < 4, `${name}: 평균 ${mean.toFixed(2)} (z=${z.toFixed(2)}) — 기준선에서 벗어났다`);
  }
});

test("세트를 겹치지 않게 깔면 분산이 줄어든다 (전략이 실제로 바꿀 수 있는 유일한 것)", () => {
  const draws = syntheticDraws(300, 777);
  const independent = simulate(SEED_SPEC, draws);
  const covered = simulate(normalizeSpec({ ...SEED_SPEC, coverage: "max-coverage" }), draws);
  assert.ok(
    covered.sd < independent.sd,
    `max-coverage sd=${covered.sd.toFixed(2)} 가 independent sd=${independent.sd.toFixed(2)} 보다 작아야 한다`
  );
});
