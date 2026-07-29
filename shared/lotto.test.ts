import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOTTO_BASELINE_PER_ROUND,
  LOTTO_BASELINE_PER_SET,
  LOTTO_SET_COUNT,
  countMatches,
  matchProbabilities,
  roundScore,
  setScore,
  winningNumbers,
} from "./lotto.ts";

const draw = { round: 1, drawDate: "2002-12-07", numbers: [10, 23, 29, 33, 37, 40], bonus: 16 };

test("보너스는 당첨번호로 인정된다 — 대조 대상은 7개", () => {
  assert.deepEqual(winningNumbers(draw).sort((a, b) => a - b), [10, 16, 23, 29, 33, 37, 40]);
});

test("적중 수 계산은 보너스를 포함한다", () => {
  // 16(보너스)과 23(본번호) 두 개 적중
  assert.equal(countMatches([1, 2, 3, 4, 16, 23], winningNumbers(draw)), 2);
  assert.equal(countMatches([1, 2, 3, 4, 5, 6], winningNumbers(draw)), 0);
});

test("세트 점수: 적중 수만큼 +, 0개면 -6", () => {
  assert.equal(setScore(0), -6);
  assert.equal(setScore(1), 1);
  assert.equal(setScore(6), 6);
});

test("회차 점수는 10세트 합계", () => {
  assert.equal(roundScore([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), -60);
  assert.equal(roundScore([6, 6, 6, 6, 6, 6, 6, 6, 6, 6]), 60);
  assert.equal(roundScore([1, 0, 2, 0, 0, 0, 0, 0, 0, 0]), 1 - 6 + 2 - 6 * 7);
});

test("적중 수 분포는 확률의 합이 1인 초기하분포", () => {
  const p = matchProbabilities();
  assert.equal(p.length, 7);
  assert.ok(Math.abs(p.reduce((s, x) => s + x, 0) - 1) < 1e-9);
  // 0적중 확률 = C(38,6)/C(45,6) = 2760681/8145060
  assert.ok(Math.abs(p[0] - 2760681 / 8145060) < 1e-9);
});

test("무작위 기준선은 회차당 약 -11.00점", () => {
  // 이 값이 흔들리면 차트의 판정선이 흔들린다 — 규칙 변경 시 반드시 여기서 잡힌다.
  // E[적중] - 6·P(0적중) = 42/45 - 6·(2760681/8145060) = -1.1003025…
  assert.ok(Math.abs(LOTTO_BASELINE_PER_SET - -1.1003025) < 1e-6, `${LOTTO_BASELINE_PER_SET}`);
  assert.ok(Math.abs(LOTTO_BASELINE_PER_ROUND - -11.003025) < 1e-5, `${LOTTO_BASELINE_PER_ROUND}`);
  assert.equal(LOTTO_BASELINE_PER_ROUND, LOTTO_BASELINE_PER_SET * LOTTO_SET_COUNT);
});
