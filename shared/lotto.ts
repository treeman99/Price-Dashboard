/**
 * 로또 예측 실험 — 서버/프론트 공용 타입과 **채점 규칙**.
 *
 * 채점 규칙이 여기 한 곳에만 있는 이유: 점수는 세 곳에서 필요하다(실험 엔진이 매길 때,
 * API 가 요약할 때, 화면이 기준선을 그릴 때). 규칙이 복제되면 화면의 "기준선 -11.0"과
 * 엔진의 실제 채점이 조용히 갈라지고, 그러면 차트가 거짓말을 한다.
 */

/** 한 회차 당첨 결과. numbers 는 본번호 6개(오름차순), bonus 는 보너스 1개. */
export interface LottoDraw {
  round: number;
  /** YYYY-MM-DD */
  drawDate: string;
  numbers: number[];
  bonus: number;
}

// ── 게임/채점 상수 ──

/** 번호 범위 1..45. */
export const LOTTO_MAX_NUMBER = 45;
/** 한 세트의 번호 개수. */
export const LOTTO_PICK = 6;
/** 한 회차에 제출하는 세트 수. */
export const LOTTO_SET_COUNT = 10;
/** 한 세트에서 하나도 못 맞혔을 때의 벌점. */
export const LOTTO_ZERO_PENALTY = -6;

/**
 * ⚠️ **보너스 번호를 당첨번호로 인정한다**(2026-07-29 인터뷰 결정).
 * 따라서 대조 대상은 6개가 아니라 **7개**다. 이 한 줄이 기대점수를 -16.03 → -11.00 으로
 * 바꾸므로, 기준선을 다시 계산하지 않고 이 상수만 뒤집으면 차트가 틀어진다.
 */
export const LOTTO_BONUS_COUNTS = true;

/** 대조 대상 당첨번호 집합(본번호 + 보너스). */
export function winningNumbers(draw: LottoDraw): number[] {
  return LOTTO_BONUS_COUNTS ? [...draw.numbers, draw.bonus] : [...draw.numbers];
}

/** 한 세트가 맞힌 개수. */
export function countMatches(set: readonly number[], winning: readonly number[]): number {
  const w = new Set(winning);
  return set.reduce((n, v) => n + (w.has(v) ? 1 : 0), 0);
}

/** 맞힌 개수 → 세트 점수. 1개 이상이면 그 개수만큼 +, 0개면 -6. */
export function setScore(matches: number): number {
  return matches >= 1 ? matches : LOTTO_ZERO_PENALTY;
}

/** 10세트 합산 = 회차 점수. 이론 범위는 -60 ~ +60. */
export function roundScore(matchesPerSet: readonly number[]): number {
  return matchesPerSet.reduce((s, m) => s + setScore(m), 0);
}

// ── 무작위 기준선 ──
//
// 이 값이 실험의 **유일한 판정 기준**이다. "알고리즘이 좋아졌다"는 말은 이 선을 유의하게
// 넘었다는 뜻이어야 하고, 넘지 못했다면 그것도 결과다. 하드코딩하지 않고 매번 계산하는
// 이유는 위의 LOTTO_BONUS_COUNTS 같은 규칙 변경이 기준선에 자동 반영되게 하기 위해서다.

function combinations(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/**
 * 무작위로 6개를 골랐을 때 맞힐 개수의 분포(초기하분포).
 * 전체 45개 중 당첨표시가 K개(보너스 포함 7개), 6개를 비복원 추출.
 */
export function matchProbabilities(): number[] {
  const K = LOTTO_BONUS_COUNTS ? 7 : 6;
  const total = combinations(LOTTO_MAX_NUMBER, LOTTO_PICK);
  const out: number[] = [];
  for (let m = 0; m <= LOTTO_PICK; m++) {
    out.push((combinations(K, m) * combinations(LOTTO_MAX_NUMBER - K, LOTTO_PICK - m)) / total);
  }
  return out;
}

/** 무작위 전략의 세트당 기대점수. */
export const LOTTO_BASELINE_PER_SET = matchProbabilities().reduce(
  (acc, p, m) => acc + p * setScore(m),
  0
);

/**
 * 무작위 전략의 **회차당 기대점수**(현재 규칙에서 ≈ -11.00).
 *
 * ⚠️ 수학적으로 이 값은 **어떤 전략을 쓰든 동일하다.** 당첨번호가 균등 무작위이므로 고정된
 * 6개 집합이 맞힐 개수의 분포는 그 집합이 무엇이든 같은 초기하분포다. 전략이 바꿀 수 있는
 * 것은 기대값이 아니라 **분산**뿐이다(세트를 서로 겹치지 않게 깔면 점수가 이 선 근처로
 * 모이고, 10세트를 똑같이 찍으면 크게 흔들린다).
 * 이 사실을 숨기지 않고 차트에 선으로 그려 두는 것이 이 실험의 요점이다 — 에이전트가
 * 무엇을 제안하든 곡선은 이 선으로 수렴해야 하고, 수렴하지 않으면 그건 발견이 아니라 버그다.
 */
export const LOTTO_BASELINE_PER_ROUND = LOTTO_BASELINE_PER_SET * LOTTO_SET_COUNT;

// ── 실험의 목표: 3+ 적중 회차 비율 ──
//
// 2026-07-29 목표 전환. 점수(위)는 **어떤 전략을 써도 기대값이 같다**는 것이 실데이터 1234회차로
// 확인됐고(전 전략 |z| < 1.5), 엔진이 쓰는 6개 특징의 예측 AUC 도 전부 0.50 이었다.
// 즉 '예측 정확도' 축에는 올릴 것이 없다.
//
// 반면 **"10세트 중 최소 1세트가 3개 이상 맞힌 회차의 비율"** 은 실제로 움직인다.
// 3+ 세트의 **총 개수**는 여전히 고정이지만(기대값 선형성), 그것을 여러 회차에 흩뿌릴지 한 회차에
// 몰아넣을지는 디자인이 정한다. 실측 범위는 5.6%(극단 집중) ~ 36.4%(최적)로 6배가 넘는다.

/** 세트 1개가 3개 이상 맞힐 확률. 아래 두 상수의 출처이자 상한의 근거. */
export const LOTTO_P_THREE_PLUS = matchProbabilities()
  .slice(3)
  .reduce((a, p) => a + p, 0);

/**
 * 무작위로 10세트를 뽑았을 때의 3+ 적중 회차 비율. **기준선.**
 * 닫힌 해가 없어(세트끼리 같은 당첨번호를 공유해 독립이 아니다) 몬테카를로로 측정했다:
 * 무작위 디자인 20개 × 40만 회 추첨 = 33.36%.
 */
export const LOTTO_HIT3_RANDOM = 0.3336;

/**
 * 도달 가능한 **천장**. 40만 회 검증표본에서 국소탐색이 6회 재시작 모두 36.26~36.43% 로
 * 수렴했다. 구조적으로는 (1) 45개 번호를 전부 덮고 (2) 어떤 두 세트도 번호를 1개까지만
 * 공유할 때 나오는 값이다(그때 10세트가 덮는 서로 다른 3조합이 이론 최대인 200개가 된다).
 *
 * ⚠️ 이 값을 에이전트 프롬프트에 넣지 않는다 — 답을 알려주면 실험이 아니라 받아쓰기가 된다.
 *    화면에만 그려 사용자가 '어디까지 왔는지'를 볼 수 있게 한다.
 */
export const LOTTO_HIT3_CEILING = 0.3643;

// ── 전략 사양 ──

/**
 * 에이전트가 조작할 수 있는 노브 전체. **선언형**이라는 점이 핵심이다.
 * 에이전트에게 코드를 쓰게 하면 eval 이 필요하고, 그 순간 외부 텍스트가 서버에서 실행된다.
 * 대신 엔진이 해석하는 사양만 받고, 서버가 범위를 강제한다(normalizeSpec).
 */
export interface LottoStrategySpec {
  /**
   * 번호별 점수를 만드는 특징들의 선형 결합 계수. 각 특징은 z-점수로 표준화된 뒤 더해진다.
   * 음수를 주면 반대 방향으로 작동한다(예: hot 에 -1 = 최근 많이 나온 번호를 피함).
   */
  weights: {
    /** 최근 windowSize 회차 출현 횟수 */
    hot: number;
    /** hot 의 반대(미출현). 중복이지만 에이전트의 표현을 그대로 받기 위해 남긴다 */
    cold: number;
    /** 전체 기간 출현 횟수 */
    overall: number;
    /** 마지막 출현 이후 경과 회차(클수록 '오래 안 나온') */
    gap: number;
    /** 반감기 halfLife 로 감쇠시킨 가중 출현 빈도 */
    decay: number;
    /** 직전 회차 당첨번호와의 동반 출현 횟수 */
    pair: number;
  };
  /** hot/cold 계산 창(회차). */
  windowSize: number;
  /** decay 특징의 반감기(회차). */
  halfLife: number;
  /** 점수 → 확률 변환 온도. 작을수록 탐욕적(상위 번호에 몰림), 클수록 평평해진다. */
  temperature: number;
  /** 균등분포와의 혼합 비율. 1이면 특징을 전부 무시한 순수 무작위. */
  explore: number;
  /**
   * **10세트의 배치 구조.** 목표가 3+ 적중 회차 비율로 바뀌면서 성능을 좌우하는 축이
   * 여기로 옮겨졌다 — 번호 선택 확률(위의 weights/temperature/explore)은 실측 예측력이
   * AUC 0.50 으로 무력하다는 것이 1234회차로 확인됐다.
   *
   * 예전의 `coverage: independent|partition|max-coverage` 를 대체한다. 세 모드가 전부
   * 아래 두 노브의 특수한 조합이라 표현력이 더 넓다:
   *   independent  ≡ { fullCover: false, maxSetOverlap: 6 }
   *   max-coverage ≡ { fullCover: true,  maxSetOverlap: 6 }
   *   partition    ≈ { fullCover: true,  maxSetOverlap: 1 }
   */
  design: {
    /** 45개 번호가 10세트 전체에서 최소 1회씩 등장하도록 강제할지. */
    fullCover: boolean;
    /** 서로 다른 두 세트가 공유할 수 있는 번호 개수의 상한(1~6). 6이면 제약 없음. */
    maxSetOverlap: number;
    /**
     * 목적함수에 대한 **국소탐색 스텝 수**(0이면 탐색 안 함).
     *
     * ⚠️ 이 탐색은 **미래 회차를 보지 않는다.** 당첨번호가 균등 무작위라는 사실만으로
     * 목적함수(3+ 적중 확률)를 사전에 계산할 수 있어서, 고정 시드로 뽑은 가상 추첨 표본
     * 위에서 디자인을 다듬는다. walk-forward 규칙을 어기지 않는다.
     */
    searchSteps: number;
  };
  /** 뽑은 세트가 통과해야 하는 조건들. 통과 못 하면 재추출(상한 도달 시 조건 완화). */
  filters: {
    /** 6개 합계 하한(이론 최소 21) */
    sumMin: number;
    /** 6개 합계 상한(이론 최대 255) */
    sumMax: number;
    /** 홀수 개수 하한/상한 */
    oddMin: number;
    oddMax: number;
    /** 연속번호(예: 12,13,14) 최대 길이 */
    maxConsecutive: number;
    /** 10단위 구간(1-9,10-19,20-29,30-39,40-45)별 최대 개수 */
    maxPerDecade: number;
    /** 직전 회차 당첨번호를 제외할지 */
    excludeLastDraw: boolean;
  };
}

/**
 * 반복 1회(= 전 회차를 한 바퀴 돈 것)의 요약.
 *
 * '실험 반복'은 초기화가 아니다. 전략 세대는 계속 이어지고 이전 반복의 기록도 남는다.
 * 따라서 반복 간 비교가 이 실험의 핵심 증거가 된다 — 2회차 바퀴가 1회차 바퀴보다 나은가?
 */
export interface LottoRunStat {
  run: number;
  fromRound: number;
  toRound: number;
  rounds: number;
  /** 이 반복에서 쓰인 전략 세대 범위 */
  firstVersion: number;
  lastVersion: number;
  /** **목표 지표** */
  hit3Rate: number;
  hit3Rounds: number;
  /** 대조군(전략과 무관하게 고정되어야 한다) */
  avgScore: number;
  avgMatches: number;
  bestMatch: number;
  /** 아직 진행 중인 반복인지 */
  inProgress: boolean;
}

/** 전략 세대 1개. */
export interface LottoStrategy {
  version: number;
  /** 이 세대가 만들어진 반복 회차 */
  run: number;
  /** 이 세대가 적용되기 시작한 회차 */
  fromRound: number;
  spec: LottoStrategySpec;
  /** 에이전트가 남긴 근거 */
  rationale: string;
  /** 검증 가능한 형태로 남긴 가설 */
  hypothesis: string;
  /** 'seed' = 최초 무작위 세대, 'agent' = 에이전트 제안 */
  author: "seed" | "agent";
  /** 제안한 모델 ID (seed 는 빈 문자열) */
  model: string;
  createdAt: string;
}

/** 한 회차 채점 결과. */
export interface LottoRoundResult {
  round: number;
  drawDate: string;
  version: number;
  /** 제출한 10세트 */
  sets: number[][];
  /** 세트별 맞힌 개수 */
  matches: number[];
  /** 회차 점수 */
  score: number;
  /** 누적 점수 */
  cumScore: number;
}

/**
 * 최근 회차 상세 — 채점 결과에 **그 회차 당첨번호**를 얹은 것.
 *
 * LottoRoundResult 에 당첨번호를 넣지 않은 이유: 그건 lotto_draws 의 값이고 예측 기록이 아니다.
 * 다만 화면에서 "어느 번호가 맞았는지" 배지를 찍으려면 둘이 한자리에 있어야 해서, 최근 몇
 * 회차에 한해 조인해 내려준다(전 회차에 붙이면 스냅샷이 몇 배로 부푼다).
 */
export interface LottoRecentRound extends LottoRoundResult {
  /** 당첨 본번호 6개(오름차순) */
  drawNumbers: number[];
  /** 보너스 번호 */
  drawBonus: number;
}

/** 스냅샷에 싣는 최근 회차 상세 개수. 화면의 '최근 회차' 표와 같은 값. */
export const LOTTO_RECENT_LIMIT = 20;

/** 차트 한 점. 회차 수가 1000을 넘으므로 필드를 최소로 유지한다. */
export interface LottoScorePoint {
  round: number;
  drawDate: string;
  score: number;
  cumScore: number;
  /** 최근 50회차 이동평균(회차당 점수) */
  movingAvg: number;
  version: number;
  /** 이 회차에 3개 이상 맞힌 세트가 하나라도 있었는가(= 목표 지표의 1회 관측) */
  hit3: boolean;
  /** 최근 LOTTO_HIT3_WINDOW 회차의 3+ 적중 회차 비율. **이 실험의 주인공 계열.** */
  hit3Rate: number;
  /** 1회차부터의 누적 3+ 적중 회차 비율 */
  cumHit3Rate: number;
  /** 이 회차에서 한 세트가 맞힌 최대 개수 */
  bestMatch: number;
}

/** 세대별 성적 요약. 에이전트 프롬프트와 화면이 같은 표를 본다. */
export interface LottoGenerationStat {
  version: number;
  fromRound: number;
  toRound: number;
  rounds: number;
  totalScore: number;
  avgScore: number;
  bestScore: number;
  worstScore: number;
  /** 세트당 평균 맞힌 개수 */
  avgMatches: number;
  /** 0개 맞힌 세트의 비율 (0~1) */
  zeroSetRate: number;
  /** **목표 지표** — 3개 이상 맞힌 세트가 있었던 회차의 비율 (0~1) */
  hit3Rate: number;
  /** 3+ 적중 회차 수 */
  hit3Rounds: number;
  /** 3+ 를 달성한 세트의 총 개수(기대값은 전략과 무관하게 고정 — 대조군) */
  hit3Sets: number;
  /** 이 세대에서 한 세트가 맞힌 최대 개수 */
  bestMatch: number;
}

/** 실험 진행 상태. */
export type LottoStatus = "idle" | "running" | "paused" | "done";

/** 멈춘 이유. usage-limit 만 자동 재개 대상이다. */
export type LottoPauseReason = "usage-limit" | "manual" | "error" | null;

export interface LottoState {
  status: LottoStatus;
  /**
   * 지금 몇 번째 바퀴인가(1부터). '실험 반복'을 누를 때마다 +1.
   * ⚠️ 초기화(reset)와 다르다 — 반복은 이전 기록과 전략 세대를 그대로 두고 새 바퀴만 시작한다.
   */
  run: number;
  pauseReason: LottoPauseReason;
  /** 토큰 한도로 멈췄을 때 자동 재개 예정 시각(ISO). 그 외에는 null. */
  resumeAt: string | null;
  lastError: string | null;
  startedAt: string | null;
  /** 최신 회차까지 완주한 시각 */
  finishedAt: string | null;
  /** 사용자가 완주 배너를 확인했는지. 확인 전까지 배너를 계속 띄운다. */
  doneAcknowledged: boolean;
  updatedAt: string;
}

/** 로또 탭이 한 번에 받아 가는 전체 스냅샷. */
export interface LottoSnapshot {
  state: LottoState;
  /** 채점을 마친 마지막 회차 */
  scoredThrough: number | null;
  /** DB 에 확보한 가장 오래된/최신 회차 */
  firstDraw: number | null;
  latestDraw: number | null;
  /** 다음에 예측할 회차. null 이면 더 읽을 회차가 없다(= 완주). */
  nextRound: number | null;
  /** 남은 회차 수 */
  remaining: number;
  totalScored: number;
  cumScore: number;
  /** 회차당 평균 점수 */
  avgScore: number | null;
  /** 무작위 기준선(회차당 점수) — 이제는 '전략이 못 움직인다'를 보여주는 대조군이다 */
  baselinePerRound: number;
  /** **목표 지표** — 전체 3+ 적중 회차 비율 */
  hit3Rate: number | null;
  /** 3+ 적중 회차 수 */
  hit3Rounds: number;
  /** 무작위 디자인의 3+ 적중 회차 비율(기준선) */
  hit3Random: number;
  /** 도달 가능한 천장 */
  hit3Ceiling: number;
  strategies: LottoStrategy[];
  generations: LottoGenerationStat[];
  /** 반복별 요약(오래된 순). 반복이 1회뿐이면 항목 1개. */
  runs: LottoRunStat[];
  /** 차트용 점 — **현재 반복**만. 반복이 쌓여도 차트가 뒤엉키지 않게 한다. */
  points: LottoScorePoint[];
  /** 최근 회차 상세(당첨번호 포함). 최신이 뒤에 오는 오름차순. */
  recentResults: LottoRecentRound[];
  /** 아직 추첨되지 않은 다음 회차에 대한 추천 번호(완주했을 때만 채워진다) */
  upcoming: { round: number; sets: number[][] } | null;
}

/** 몇 회차마다 에이전트가 전략을 개정하는지(2026-07-29 인터뷰 결정). */
export const LOTTO_EVOLVE_EVERY = 50;

/** 이동평균 창. 차트와 세대 요약이 같은 값을 쓴다. */
export const LOTTO_MOVING_AVG_WINDOW = 50;

/**
 * 3+ 적중률 이동평균 창.
 *
 * 점수(50)보다 넓게 잡는다. 목표 지표는 회차마다 0/1 뿐이라, 기준선 33.4% 와 천장 36.4% 의
 * 차이(3%p)를 보려면 표본이 훨씬 많아야 한다 — 50회차 창의 표준오차는 6.7%p 로 차이의
 * 두 배가 넘어 곡선이 의미 없이 요동친다. 200회차면 3.3%p 로 줄어든다.
 */
export const LOTTO_HIT3_WINDOW = 200;
