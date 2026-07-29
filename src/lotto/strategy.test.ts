import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEED_SPEC,
  buildFeatures,
  generateSets,
  normalizeSpec,
  numberProbabilities,
  passesFilters,
} from "./strategy.ts";
import type { LottoDraw } from "../../shared/lotto.ts";
import { LOTTO_PICK, LOTTO_SET_COUNT, winningNumbers } from "../../shared/lotto.ts";

/** 결정론 테스트용 가짜 이력. 특정 번호가 편중되게 만들어 특징이 살아나는지 본다. */
function fakeHistory(n: number): LottoDraw[] {
  const out: LottoDraw[] = [];
  for (let r = 1; r <= n; r++) {
    // 1,2,3 은 자주 / 43,44,45 는 드물게 나오도록 구성
    const base = r % 3 === 0 ? [1, 2, 3, 11, 22, 33] : [1, 2, 4, 12, 23, 34];
    out.push({ round: r, drawDate: `2020-01-${String((r % 28) + 1).padStart(2, "0")}`, numbers: base, bonus: 45 });
  }
  return out;
}

test("normalizeSpec 은 쓰레기 입력을 실행 가능한 사양으로 접는다", () => {
  const spec = normalizeSpec({
    weights: { hot: "abc", cold: 999, overall: null, gap: NaN, decay: -999, pair: 2 },
    windowSize: 0,
    halfLife: -5,
    temperature: 0,
    explore: 5,
    design: { fullCover: "yes", maxSetOverlap: 99, searchSteps: -5 },
    filters: { sumMin: 1000, sumMax: -3, oddMin: 9, oddMax: -1, maxConsecutive: 0, maxPerDecade: 99 },
    쓸데없는필드: true,
  });

  assert.equal(spec.weights.hot, 0); // 숫자 아님 → 0
  assert.equal(spec.weights.cold, 5); // 상한
  assert.equal(spec.weights.decay, -5); // 하한
  assert.equal(spec.weights.pair, 2);
  assert.equal(spec.windowSize, 5);
  assert.equal(spec.halfLife, 1);
  assert.equal(spec.temperature, 0.05);
  assert.equal(spec.explore, 1);
  assert.equal(spec.design.fullCover, false);
  assert.equal(spec.design.maxSetOverlap, 6);
  assert.equal(spec.design.searchSteps, 0);
  assert.equal(spec.filters.sumMin, 255);
  assert.equal(spec.filters.sumMax, 255); // sumMin 이상으로 강제
  assert.equal(spec.filters.oddMin, 6);
  assert.equal(spec.filters.oddMax, 6);
  assert.equal(spec.filters.maxConsecutive, 1);
  assert.equal(spec.filters.maxPerDecade, 6);
  assert.equal(spec.filters.excludeLastDraw, false);
  assert.ok(!("쓸데없는필드" in spec));
});

test("같은 (회차, 세대, 이력) 이면 항상 같은 10세트가 나온다", () => {
  const history = fakeHistory(60);
  const a = generateSets(SEED_SPEC, history, 61, 1);
  const b = generateSets(SEED_SPEC, history, 61, 1);
  assert.deepEqual(a, b);
});

test("회차나 세대가 바뀌면 다른 세트가 나온다", () => {
  const history = fakeHistory(60);
  const base = generateSets(SEED_SPEC, history, 61, 1);
  assert.notDeepEqual(base, generateSets(SEED_SPEC, history, 62, 1));
  assert.notDeepEqual(base, generateSets(SEED_SPEC, history, 61, 2));
});

test("세 가지 coverage 모두 10세트 × 중복 없는 6번호를 낸다", () => {
  const history = fakeHistory(80);
  const modes = [
    { label: "independent", design: { fullCover: false, maxSetOverlap: 6, searchSteps: 0 } },
    { label: "low-overlap", design: { fullCover: false, maxSetOverlap: 1, searchSteps: 0 } },
    { label: "full-cover", design: { fullCover: true, maxSetOverlap: 6, searchSteps: 0 } },
  ] as const;
  for (const { label: coverage, design } of modes) {
    const sets = generateSets({ ...SEED_SPEC, design }, history, 81, 1);
    assert.equal(sets.length, LOTTO_SET_COUNT, coverage);
    for (const s of sets) {
      assert.equal(s.length, LOTTO_PICK, coverage);
      assert.equal(new Set(s).size, LOTTO_PICK, `${coverage} 세트 내 중복`);
      assert.ok(s.every((n) => n >= 1 && n <= 45), coverage);
      assert.deepEqual([...s].sort((x, y) => x - y), s, `${coverage} 정렬`);
    }
    // 세트끼리도 겹치지 않아야 한다(같은 운명을 두 번 사지 않는다)
    assert.equal(new Set(sets.map((s) => s.join(","))).size, LOTTO_SET_COUNT, coverage);
  }
});

test("fullCover 는 45개 번호를 전부 최소 1회 덮는다", () => {
  const history = fakeHistory(80);
  const sets = generateSets(
    { ...SEED_SPEC, design: { ...SEED_SPEC.design, fullCover: true } },
    history,
    81,
    1
  );
  const covered = new Set(sets.flat());
  assert.equal(covered.size, 45);
});

test("excludeLastDraw 는 직전 회차 번호를 후보에서 뺀다", () => {
  const history = fakeHistory(40);
  const banned = new Set(winningNumbers(history[history.length - 1]));
  const sets = generateSets(
    { ...SEED_SPEC, filters: { ...SEED_SPEC.filters, excludeLastDraw: true } },
    history,
    41,
    1
  );
  for (const s of sets) {
    for (const n of s) assert.ok(!banned.has(n), `제외됐어야 할 번호 ${n}`);
  }
});

test("excludeLastDraw 는 fullCover 와 함께 쓰면 무시된다(45개를 덮어야 하므로)", () => {
  const history = fakeHistory(40);
  const sets = generateSets(
    {
      ...SEED_SPEC,
      design: { ...SEED_SPEC.design, fullCover: true },
      filters: { ...SEED_SPEC.filters, excludeLastDraw: true },
    },
    history,
    41,
    1
  );
  assert.equal(new Set(sets.flat()).size, 45);
});

test("필터는 실제로 후보를 거른다", () => {
  const spec = { ...SEED_SPEC, filters: { ...SEED_SPEC.filters, oddMin: 6, oddMax: 6 } };
  assert.equal(passesFilters([1, 3, 5, 7, 9, 11], spec), true);
  assert.equal(passesFilters([1, 3, 5, 7, 9, 12], spec), false);

  const consec = { ...SEED_SPEC, filters: { ...SEED_SPEC.filters, maxConsecutive: 2 } };
  assert.equal(passesFilters([1, 2, 10, 20, 30, 40], consec), true);
  assert.equal(passesFilters([1, 2, 3, 20, 30, 40], consec), false);

  const decade = { ...SEED_SPEC, filters: { ...SEED_SPEC.filters, maxPerDecade: 2 } };
  assert.equal(passesFilters([1, 2, 11, 12, 21, 22], decade), true);
  assert.equal(passesFilters([1, 2, 3, 11, 21, 31], decade), false);

  const sum = { ...SEED_SPEC, filters: { ...SEED_SPEC.filters, sumMin: 100, sumMax: 150 } };
  assert.equal(passesFilters([10, 20, 30, 15, 25, 20], sum), true); // 합 120
  assert.equal(passesFilters([1, 2, 3, 4, 5, 6], sum), false); // 합 21
});

test("이력이 비면(1회차) 특징이 전부 0 이고 확률은 균등하다", () => {
  const features = buildFeatures([], SEED_SPEC);
  assert.ok(features.hot.every((v) => v === 0));
  assert.ok(features.gap.every((v) => v === 0));
  const p = numberProbabilities(features, SEED_SPEC);
  assert.ok(p.every((v) => Math.abs(v - 1 / 45) < 1e-12));
});

test("explore=1 이면 계수가 무엇이든 균등분포다(시드 세대의 정의)", () => {
  const history = fakeHistory(100);
  const spec = {
    ...SEED_SPEC,
    explore: 1,
    weights: { hot: 5, cold: -5, overall: 3, gap: -2, decay: 4, pair: 1 },
  };
  const p = numberProbabilities(buildFeatures(history, spec), spec);
  assert.ok(p.every((v) => Math.abs(v - 1 / 45) < 1e-12));
});

test("hot 계수를 올리면 자주 나온 번호의 확률이 실제로 커진다", () => {
  const history = fakeHistory(100); // 1,2 가 매 회차 등장
  const spec = { ...SEED_SPEC, explore: 0, weights: { ...SEED_SPEC.weights, hot: 3 } };
  const p = numberProbabilities(buildFeatures(history, spec), spec);
  assert.ok(p[0] > 1 / 45, "번호 1의 확률이 균등보다 커야 한다");
  assert.ok(p[0] > p[44 - 1], "자주 나온 1이 드문 44보다 커야 한다");
  assert.ok(Math.abs(p.reduce((s, v) => s + v, 0) - 1) < 1e-9);
});

test("cold 는 hot 의 부호 반전이다", () => {
  const history = fakeHistory(50);
  const f = buildFeatures(history, SEED_SPEC);
  for (let i = 0; i < 45; i++) assert.ok(Math.abs(f.cold[i] + f.hot[i]) < 1e-12);
});

test("gap 특징은 오래 안 나온 번호에서 커진다", () => {
  const history = fakeHistory(50); // 1,2 는 매번, 40번대는 45(보너스)만
  const f = buildFeatures(history, SEED_SPEC);
  assert.ok(f.gap[0] < f.gap[39], "번호 1의 gap 이 번호 40보다 작아야 한다");
});
