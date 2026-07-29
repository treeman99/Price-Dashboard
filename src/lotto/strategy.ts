import type { LottoDraw, LottoStrategySpec } from "../../shared/lotto.ts";
import {
  LOTTO_MAX_NUMBER,
  LOTTO_PICK,
  LOTTO_SET_COUNT,
  winningNumbers,
} from "../../shared/lotto.ts";

/**
 * 전략 엔진 — **선언형 사양(LottoStrategySpec)을 10세트로 바꾸는 유일한 지점**.
 *
 * ## 왜 코드가 아니라 사양인가
 * "에이전트가 알고리즘을 발전시킨다"의 가장 곧은 구현은 에이전트가 JS 를 써서 서버가 eval 하는
 * 것이다. 그건 하면 안 된다 — 모델 출력이 곧 서버 실행 코드가 되고, 프롬프트 한 줄이 파일을
 * 지울 수 있다. 대신 에이전트는 **노브 값만** 제안하고(normalizeSpec 이 범위를 강제한다),
 * 해석은 전부 이 파일이 한다. 표현력은 노브를 늘려 확장한다.
 *
 * ## 재현성
 * 같은 (회차, 세대, 과거이력) 이면 항상 같은 10세트가 나온다. 시드 RNG 를 쓰는 이유가 이것이다.
 * 실험을 처음부터 다시 돌려도 과거 점수가 그대로 재현되지 않으면, 곡선의 어떤 변화가 전략
 * 때문인지 운 때문인지 영원히 구분할 수 없다.
 */

/** 10단위 구간 경계(1-9 / 10-19 / 20-29 / 30-39 / 40-45). filters.maxPerDecade 가 쓴다. */
const DECADE_OF = (n: number): number => Math.min(4, Math.floor(n / 10));
const DECADE_COUNT = 5;

/** 6개 합의 이론 범위. 21 = 1+2+3+4+5+6, 255 = 40+…+45. */
const SUM_MIN = 21;
const SUM_MAX = 255;

/** 한 세트를 필터 통과시킬 때까지의 재추출 상한. 넘으면 필터를 포기하고 마지막 후보를 쓴다. */
const MAX_FILTER_ATTEMPTS = 150;

// ── 시드 RNG ──

/** mulberry32. 32비트 시드 하나로 재현 가능한 난수열을 만든다. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** (회차, 세대) → 시드. 세대가 바뀌면 같은 회차라도 다른 번호가 나온다. */
export function seedFor(round: number, version: number): number {
  return (Math.imul(round, 1000003) ^ Math.imul(version, 2654435761)) >>> 0;
}

// ── 사양 정규화 ──

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number =>
  Math.round(clamp(v, lo, hi, fallback));

/**
 * 1세대(시드) 사양 = **순수 무작위**.
 *
 * 실험의 출발점이 무작위여야 "발전했다"는 말이 의미를 갖는다. explore=1 이면 특징 계수가
 * 무엇이든 균등분포가 되므로, 계수를 0 으로 두는 것보다 의도가 분명하다.
 */
export const SEED_SPEC: LottoStrategySpec = {
  weights: { hot: 0, cold: 0, overall: 0, gap: 0, decay: 0, pair: 0 },
  windowSize: 50,
  halfLife: 50,
  temperature: 1,
  explore: 1,
  coverage: "independent",
  filters: {
    sumMin: SUM_MIN,
    sumMax: SUM_MAX,
    oddMin: 0,
    oddMax: LOTTO_PICK,
    maxConsecutive: LOTTO_PICK,
    maxPerDecade: LOTTO_PICK,
    excludeLastDraw: false,
  },
};

/**
 * 에이전트가 준 임의의 JSON 을 **반드시 실행 가능한 사양**으로 만든다.
 *
 * 이 함수는 방어선이다. 모델이 문자열·null·NaN·범위 밖 값을 주더라도 엔진이 죽거나
 * (더 나쁘게) 조용히 이상한 분포를 쓰는 일이 없어야 한다. 알 수 없는 필드는 버린다.
 */
export function normalizeSpec(raw: unknown): LottoStrategySpec {
  const r = (raw ?? {}) as Record<string, unknown>;
  const w = (r.weights ?? {}) as Record<string, unknown>;
  const f = (r.filters ?? {}) as Record<string, unknown>;

  // 계수 범위 ±5: z-점수에 곱해지므로 5면 이미 극단적인 편향이다. 더 키워도 온도로 나뉘어
  // 형태가 크게 달라지지 않는데, 지수 폭주로 확률이 1개 번호에 몰리는 사고만 늘어난다.
  const coef = (v: unknown) => clamp(v, -5, 5, 0);

  const sumMin = clampInt(f.sumMin, SUM_MIN, SUM_MAX, SUM_MIN);
  const sumMax = clampInt(f.sumMax, sumMin, SUM_MAX, SUM_MAX);
  const oddMin = clampInt(f.oddMin, 0, LOTTO_PICK, 0);
  const oddMax = clampInt(f.oddMax, oddMin, LOTTO_PICK, LOTTO_PICK);

  const coverage =
    r.coverage === "partition" || r.coverage === "max-coverage" ? r.coverage : "independent";

  return {
    weights: {
      hot: coef(w.hot),
      cold: coef(w.cold),
      overall: coef(w.overall),
      gap: coef(w.gap),
      decay: coef(w.decay),
      pair: coef(w.pair),
    },
    windowSize: clampInt(r.windowSize, 5, 500, 50),
    halfLife: clamp(r.halfLife, 1, 1000, 50),
    // 온도 하한 0.05: 더 낮추면 exp 가 폭주해 확률이 사실상 1개 번호로 붕괴한다.
    temperature: clamp(r.temperature, 0.05, 20, 1),
    explore: clamp(r.explore, 0, 1, 0),
    coverage,
    filters: {
      sumMin,
      sumMax,
      oddMin,
      oddMax,
      maxConsecutive: clampInt(f.maxConsecutive, 1, LOTTO_PICK, LOTTO_PICK),
      maxPerDecade: clampInt(f.maxPerDecade, 1, LOTTO_PICK, LOTTO_PICK),
      excludeLastDraw: f.excludeLastDraw === true,
    },
  };
}

// ── 특징 ──

/** 번호 1..45 의 특징 벡터들(인덱스 0 = 번호 1). */
export interface NumberFeatures {
  hot: number[];
  cold: number[];
  overall: number[];
  gap: number[];
  decay: number[];
  pair: number[];
}

/** 45개 값을 z-점수로. 표준편차가 0이면(=신호 없음) 전부 0 을 준다. */
function standardize(v: number[]): number[] {
  const n = v.length;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const varr = v.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const sd = Math.sqrt(varr);
  if (!(sd > 1e-12)) return v.map(() => 0);
  return v.map((x) => (x - mean) / sd);
}

/**
 * 과거 이력에서 번호별 특징을 뽑는다.
 *
 * ⚠️ `history` 에는 **예측 대상 회차보다 앞선 회차만** 들어와야 한다. 이 함수는 그것을
 * 검사하지 않는다 — 호출부(experiment.ts)가 슬라이스를 책임진다. 여기서 한 회차라도
 * 미래가 새면 실험 전체가 무효가 되므로 그 경계를 한 곳에만 두었다.
 *
 * 출현 여부는 **보너스를 포함한 7개** 기준이다(채점 규칙과 일치시켜야 특징이 의미를 갖는다).
 */
export function buildFeatures(history: LottoDraw[], spec: LottoStrategySpec): NumberFeatures {
  const N = LOTTO_MAX_NUMBER;
  const hot = new Array<number>(N).fill(0);
  const overall = new Array<number>(N).fill(0);
  const decay = new Array<number>(N).fill(0);
  const pair = new Array<number>(N).fill(0);
  const lastSeen = new Array<number>(N).fill(-1); // 마지막 출현의 history 인덱스

  const len = history.length;
  const windowStart = Math.max(0, len - spec.windowSize);
  const lambda = Math.LN2 / Math.max(1e-9, spec.halfLife);

  // 직전 회차 번호 — pair 특징의 기준이자 excludeLastDraw 의 대상.
  const prevSet = len > 0 ? new Set(winningNumbers(history[len - 1])) : new Set<number>();

  for (let i = 0; i < len; i++) {
    const nums = winningNumbers(history[i]);
    const age = len - 1 - i; // 0 = 가장 최근
    const decayW = Math.exp(-lambda * age);
    // 직전 회차 자신은 pair 합에서 뺀다 — 넣으면 '직전 번호와 함께 나왔다'가 자기 자신을
    // 세어 prevSet 번호에만 +1 이 붙는데, 그건 동반출현 신호가 아니라 상수다.
    const pairHits = i === len - 1 ? 0 : nums.reduce((s, n) => s + (prevSet.has(n) ? 1 : 0), 0);

    for (const n of nums) {
      const k = n - 1;
      overall[k] += 1;
      decay[k] += decayW;
      if (i >= windowStart) hot[k] += 1;
      lastSeen[k] = i;
      if (pairHits > 0) pair[k] += pairHits;
    }
  }

  // gap: 마지막 출현 이후 경과 회차. 한 번도 안 나왔으면 이력 전체 길이 + 1.
  const gap = lastSeen.map((idx) => (idx < 0 ? len + 1 : len - idx));

  return {
    hot: standardize(hot),
    cold: standardize(hot).map((z) => -z), // 정의상 hot 의 부호 반전
    overall: standardize(overall),
    gap: standardize(gap),
    decay: standardize(decay),
    pair: standardize(pair),
  };
}

/**
 * 특징 + 계수 → 번호별 확률.
 * explore 로 균등분포와 섞는다(explore=1 이면 완전 무작위).
 */
export function numberProbabilities(
  features: NumberFeatures,
  spec: LottoStrategySpec
): number[] {
  const N = LOTTO_MAX_NUMBER;
  const w = spec.weights;
  const raw = new Array<number>(N);
  for (let k = 0; k < N; k++) {
    raw[k] =
      w.hot * features.hot[k] +
      w.cold * features.cold[k] +
      w.overall * features.overall[k] +
      w.gap * features.gap[k] +
      w.decay * features.decay[k] +
      w.pair * features.pair[k];
  }

  // 최대값을 빼고 지수화 — 오버플로 방지의 표준 수법.
  const max = Math.max(...raw);
  const exps = raw.map((x) => Math.exp((x - max) / spec.temperature));
  const sum = exps.reduce((s, x) => s + x, 0);
  const soft = sum > 0 ? exps.map((x) => x / sum) : exps.map(() => 1 / N);

  const e = spec.explore;
  return soft.map((p) => e / N + (1 - e) * p);
}

// ── 추출 ──

/** 후보 풀에서 확률에 비례해 k개를 비복원 추출. */
function sampleWithout(
  pool: number[],
  probs: number[],
  k: number,
  rng: () => number
): number[] {
  const avail = [...pool];
  const out: number[] = [];
  for (let i = 0; i < k && avail.length > 0; i++) {
    let total = 0;
    for (const n of avail) total += probs[n - 1];
    let x = rng() * total;
    let pick = avail.length - 1;
    for (let j = 0; j < avail.length; j++) {
      x -= probs[avail[j] - 1];
      if (x <= 0) {
        pick = j;
        break;
      }
    }
    out.push(avail[pick]);
    avail.splice(pick, 1);
  }
  return out.sort((a, b) => a - b);
}

/** 필터 통과 여부. excludeLastDraw 는 풀 단계에서 처리하므로 여기서는 보지 않는다. */
export function passesFilters(set: number[], spec: LottoStrategySpec): boolean {
  const f = spec.filters;
  const sum = set.reduce((s, n) => s + n, 0);
  if (sum < f.sumMin || sum > f.sumMax) return false;

  const odd = set.reduce((s, n) => s + (n % 2), 0);
  if (odd < f.oddMin || odd > f.oddMax) return false;

  const sorted = [...set].sort((a, b) => a - b);
  let run = 1;
  let maxRun = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
    if (run > maxRun) maxRun = run;
  }
  if (maxRun > f.maxConsecutive) return false;

  const decades = new Array<number>(DECADE_COUNT).fill(0);
  for (const n of sorted) decades[DECADE_OF(n)] += 1;
  if (decades.some((c) => c > f.maxPerDecade)) return false;

  return true;
}

/** 필터를 만족하는 한 세트. 상한까지 못 찾으면 마지막 후보를 그대로 쓴다(멈추지 않는다). */
function drawSet(pool: number[], probs: number[], spec: LottoStrategySpec, rng: () => number) {
  let last: number[] = [];
  for (let i = 0; i < MAX_FILTER_ATTEMPTS; i++) {
    last = sampleWithout(pool, probs, LOTTO_PICK, rng);
    if (passesFilters(last, spec)) return last;
  }
  return last;
}

const setKey = (s: number[]) => s.join(",");

/**
 * 한 회차에 제출할 10세트.
 *
 * @param history 예측 대상 회차 **이전**의 회차들(오름차순)
 * @param round   예측 대상 회차 (시드에만 쓰인다)
 * @param version 전략 세대 (시드에만 쓰인다)
 */
export function generateSets(
  spec: LottoStrategySpec,
  history: LottoDraw[],
  round: number,
  version: number
): number[][] {
  const rng = makeRng(seedFor(round, version));
  const features = buildFeatures(history, spec);
  const probs = numberProbabilities(features, spec);

  const all = Array.from({ length: LOTTO_MAX_NUMBER }, (_, i) => i + 1);

  // excludeLastDraw 는 풀에서 빼는 방식으로 건다. 필터로 걸면 재추출이 거의 매번 실패해
  // 상한만 태우고 결국 완화되는데, 그러면 옵션이 켜져 있어도 실질 효과가 없다.
  // ⚠️ max-coverage 와는 양립할 수 없다(45개를 다 덮어야 하는데 7개를 빼면 불가능) →
  //    그 모드에서는 무시한다.
  const excluded =
    spec.filters.excludeLastDraw && spec.coverage !== "max-coverage" && history.length > 0
      ? new Set(winningNumbers(history[history.length - 1]))
      : new Set<number>();
  const pool = all.filter((n) => !excluded.has(n));

  const sets: number[][] =
    spec.coverage === "max-coverage"
      ? drawMaxCoverage(all, probs, rng)
      : spec.coverage === "partition"
        ? drawPartition(pool, probs, spec, rng)
        : Array.from({ length: LOTTO_SET_COUNT }, () => drawSet(pool, probs, spec, rng));

  // 같은 세트를 두 번 내는 것은 낭비다(같은 운명을 두 번 산다). 중복이면 몇 번 다시 뽑는다.
  const seen = new Set<string>();
  for (let i = 0; i < sets.length; i++) {
    let tries = 0;
    while (seen.has(setKey(sets[i])) && tries < 20) {
      sets[i] = drawSet(pool, probs, spec, rng);
      tries += 1;
    }
    seen.add(setKey(sets[i]));
  }

  return sets;
}

/**
 * partition — 번호를 나눠 담아 세트 간 중복을 최소화한다.
 * 45개로는 7세트(42개)까지만 겹치지 않게 채울 수 있어, 소진되면 풀을 다시 채운다.
 */
function drawPartition(
  pool: number[],
  probs: number[],
  spec: LottoStrategySpec,
  rng: () => number
): number[][] {
  const sets: number[][] = [];
  let remaining = [...pool];
  for (let i = 0; i < LOTTO_SET_COUNT; i++) {
    if (remaining.length < LOTTO_PICK) remaining = [...pool];
    const set = drawSet(remaining, probs, spec, rng);
    sets.push(set);
    const used = new Set(set);
    remaining = remaining.filter((n) => !used.has(n));
  }
  return sets;
}

/**
 * max-coverage — 45개 번호가 **최소 1회씩** 반드시 등장하도록 배치한다.
 *
 * 10세트 × 6칸 = 60칸이므로 45개를 모두 넣고도 15칸이 남는다. 45개를 먼저 흩뿌린 뒤
 * 남은 칸을 확률로 채운다. 필터는 여기서 강제하지 않는다 — 커버리지가 우선 제약이고,
 * 둘을 동시에 만족시키려 하면 대부분의 사양에서 해가 없어 조용히 완화된다.
 */
function drawMaxCoverage(all: number[], probs: number[], rng: () => number): number[][] {
  // 확률 가중 셔플: 확률이 높은 번호가 앞쪽(= 먼저 배정)에 오게 한다.
  const order = sampleWithout(all, probs, all.length, rng);
  // sampleWithout 은 정렬해서 돌려주므로 추출 순서가 사라진다 → 여기서만 순서가 필요하니
  // 다시 섞되, 시드 RNG 로 결정론을 유지한다.
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const sets: number[][] = Array.from({ length: LOTTO_SET_COUNT }, () => []);
  order.forEach((n, i) => sets[i % LOTTO_SET_COUNT].push(n));

  for (const set of sets) {
    while (set.length < LOTTO_PICK) {
      const used = new Set(set);
      const avail = all.filter((n) => !used.has(n));
      const [pick] = sampleWithout(avail, probs, 1, rng);
      set.push(pick);
    }
    set.sort((a, b) => a - b);
  }
  return sets;
}
