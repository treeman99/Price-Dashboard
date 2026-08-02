/**
 * 로또 예측 — 서버/프론트 공용 타입과 **채점 규칙**.
 *
 * 채점 규칙이 여기 한 곳에만 있는 이유: 점수는 두 곳에서 필요하다(주간 사이클이 매길 때,
 * 에이전트 프롬프트가 성적을 요약할 때). 규칙이 복제되면 사용자가 보는 표와 모델이 보는 표가
 * 조용히 갈라진다.
 *
 * ## 2026-07-30 전환 — 백테스트 실험 → 주간 자동 운영
 * 1회차부터 최신 회차까지 walk-forward 로 걸으며 전략을 진화시키던 **반복 학습(run)을
 * 중단했다**(사용자 지시: 과잉 정합성). 지금 이 모듈이 지탱하는 것은 하나뿐이다 —
 *
 *   매주 일요일 10:00 → 새 추첨 결과 수집 → **지난주에 저장해 둔 추천 번호** 채점 →
 *   그 결과를 에이전트에 전달해 전략 갱신 → 다음 회차 번호 추출·저장
 *
 * 그래서 세대 이력·바퀴별 성적표·차트용 시계열 타입은 전부 제거했다. 반면 채점과 목표 지표의
 * 수학은 그대로 남는다 — 에이전트가 최적화할 대상이 그것이기 때문이다.
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
 * 바꾸므로, 기준선을 다시 계산하지 않고 이 상수만 뒤집으면 채점 전체가 틀어진다.
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
// 하드코딩하지 않고 매번 계산하는 이유는 위의 LOTTO_BONUS_COUNTS 같은 규칙 변경이 기준선에
// 자동 반영되게 하기 위해서다.

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
 * 것은 기대값이 아니라 **분산**뿐이다. 1234회차 실측에서도 전 전략이 |z| < 1.5 였다.
 * 에이전트 프롬프트가 이 값을 '대조군'으로 인용한다.
 */
export const LOTTO_BASELINE_PER_ROUND = LOTTO_BASELINE_PER_SET * LOTTO_SET_COUNT;

/** 세트 1개가 3개 이상 맞힐 확률. 이 값은 어떤 번호를 고르든 같다(에이전트 프롬프트가 인용). */
export const LOTTO_P_THREE_PLUS = matchProbabilities()
  .slice(3)
  .reduce((a, p) => a + p, 0);

// ── 목표 지표: 가중 회차 점수 ──
//
// ⚠️ **세트 단위로 더하는 지표는 최적화할 수 없다.** 기대값이 디자인과 무관하게 고정이기
//    때문이다(실측: 회차당 3+ 세트 수가 무작위 0.39364 / 전커버 0.39410 / 풀10집중 0.39184,
//    이론 0.39370 — 전부 같다). 점수표를 지수로 바꿔도 상수만 달라지고 디자인 의존성은 0이다.
//
// 그래서 '높을수록 더 좋다'를 **회차 단위 지시함수의 가중합**으로 옮긴다. 이건 비선형이라
// 최적화가 가능하다(같은 총 적중량을 한 회차에 몰지 않고 여러 회차에 흩뿌리는 문제가 된다):
//     회차 점수 = 1·[3+ 있음] + 2·[4+ 있음] + 4·[5+ 있음] + 8·[6 있음]   (0 ~ 15)
export const LOTTO_HIT_WEIGHTS: ReadonlyArray<{ k: number; w: number }> = [
  { k: 3, w: 1 },
  { k: 4, w: 2 },
  { k: 5, w: 4 },
  { k: 6, w: 8 },
];

/** 그 회차 최고 적중 개수 → 가중 점수. */
export function weightedHitScore(bestMatch: number): number {
  return LOTTO_HIT_WEIGHTS.reduce((s, { k, w }) => s + (bestMatch >= k ? w : 0), 0);
}

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
   * **10세트의 배치 구조.** 목표가 가중 회차 점수인 이상 성능을 좌우하는 축은 여기다 —
   * 번호 선택 확률(위의 weights/temperature/explore)은 실측 예측력이 AUC 0.50 으로
   * 무력하다는 것이 1234회차로 확인됐다.
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
     * 목적함수를 사전에 계산할 수 있어서, 고정 시드로 뽑은 가상 추첨 표본 위에서 디자인을
     * 다듬는다. walk-forward 규칙을 어기지 않는다.
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

/** 전략 세대 1개. 주간 운영에서는 **한 주에 한 세대**가 만들어진다. */
export interface LottoStrategy {
  version: number;
  /** 이 세대가 만들어진 반복 회차(백테스트 시절의 스코프. 지금은 고정) */
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
  /** 누적 점수. 회차를 건너뛰지 않았다는 증거로 함께 저장한다 */
  cumScore: number;
}

/**
 * 지난 회차 비교 결과 — 채점 결과에 **그 회차 당첨번호**를 얹은 것.
 *
 * LottoRoundResult 에 당첨번호를 넣지 않은 이유: 그건 lotto_draws 의 값이고 예측 기록이
 * 아니다. 다만 화면에서 "어느 번호가 맞았는지" 배지를 찍으려면 둘이 한자리에 있어야 해서,
 * 최근 몇 회차에 한해 조인해 내려준다.
 */
export interface LottoRecentRound extends LottoRoundResult {
  /** 당첨 본번호 6개(오름차순) */
  drawNumbers: number[];
  /** 보너스 번호 */
  drawBonus: number;
}

/** 화면과 스냅샷이 함께 쓰는 '지난 회차' 표시 개수(2026-07-30 사용자 지시로 20 → 10). */
export const LOTTO_RECENT_LIMIT = 10;

/**
 * 채점 기록 요약. **에이전트 프롬프트 전용**이다(화면에는 성적표가 없다).
 *
 * 여기 두는 이유는 계산 위치를 한 곳으로 묶기 위해서다 — 저장소가 집계하고 프롬프트가 인용한다.
 */
export interface LottoSummary {
  rounds: number;
  avgScore: number;
  avgMatches: number;
  hit3Rounds: number;
  hit4Rounds: number;
  hit5Rounds: number;
  /** 3+ 를 달성한 **세트 수**. 전략과 무관하게 기대값이 고정 — 대조군이다 */
  hit3Sets: number;
  hit3Rate: number;
  weightedRate: number;
  bestMatch: number;
}

/**
 * **아직 추첨되지 않은 다음 회차의 확정 추천 번호.**
 *
 * ⚠️ 이 값이 저장되어야 하는 이유가 이 기능의 전부다. 화면을 열 때마다 번호를 다시 생성하면
 * 다음 주에 채점할 대상이 매번 달라져 "추천했던 번호와 실제 추첨 결과를 비교"라는 말 자체가
 * 성립하지 않는다(전에는 실제로 매 요청마다 재생성했다). 추첨 전에 한 번 뽑아 못박고,
 * 그 뒤로는 읽기만 한다.
 */
export interface LottoUpcoming {
  round: number;
  /** 10세트 × 6번호 */
  sets: number[][];
  /** 이 번호를 뽑은 전략 세대 */
  version: number;
  createdAt: string;
}

/**
 * 확정 번호를 붙여넣기 좋은 평문으로. 회차 머리말 + `n. a, b, c, d, e, f` 10줄.
 *
 * 머리말을 넣는 이유: 번호만 복사해 두면 나중에 몇 회차 것인지 알 수 없다. 메모·메신저에
 * 그대로 붙여도 읽히는 형태가 목적이라 표 서식이나 JSON 이 아니라 평문 줄바꿈을 쓴다.
 * 세대(v)는 넣지 않는다 — 사용자에게는 의미 없는 내부 값이고 붙여넣은 곳에서 잡음이 된다.
 *
 * UI 가 아니라 여기 두는 이유는 순수 함수라 테스트 대상이기 때문이다(web/ 은 러너 밖).
 */
export function upcomingToText(u: LottoUpcoming): string {
  return [`${u.round}회차 예상 번호`, ...u.sets.map((set, i) => `${i + 1}. ${set.join(", ")}`)].join(
    "\n"
  );
}

/**
 * 주간 자동 사이클의 상태.
 *
 * 사용자 조작 버튼(시작·정지·동기화·초기화·반복)이 전부 없어졌으므로 여기 남는 것은
 * '자동 사이클이 언제 무엇을 했는가'뿐이다. status 머신(idle/running/paused/done)도
 * 함께 사라졌다 — 멈춰 있을 상태가 없다.
 */
export interface LottoState {
  /**
   * 예측 기록의 스코프. 과거 백테스트가 1~1234회차를 8바퀴 돌았고 그 기록이 (run, round) 로
   * 남아 있다. 라이브 예측은 **마지막 바퀴를 그대로 이어서** 쌓으므로 이 값은 더 이상
   * 증가하지 않는다(반복 기능 제거).
   */
  run: number;
  /** 마지막으로 주간 사이클을 시도한 시각(성공·실패 무관). 놓친 실행을 판정하는 기준이다. */
  lastCycleAt: string | null;
  /** 마지막으로 채점을 마친 회차 */
  lastScoredRound: number | null;
  /**
   * **에이전트가 결과를 반영한 마지막 회차.**
   *
   * 이 값이 따로 필요한 이유: 전략을 갱신할지 판정하는 유일한 기준이기 때문이다. 전략 행의
   * `from_round` 로 재면 안 된다 — 한도 소진으로 갱신을 미룬 주에는 이미 못박은 번호 때문에
   * from_round 가 회차를 건너뛰어(다음 회차부터 적용) 조건이 영구히 거짓이 되고, 그러면
   * 그 주의 결과가 **영원히 반영되지 않는다**.
   */
  lastEvolvedRound: number | null;
  /** 마지막 사이클이 남긴 오류. 성공하면 null */
  lastError: string | null;
  /** 오류·토큰 한도로 미룬 재시도 예정 시각(ISO). 스케줄러가 30분마다 확인한다 */
  retryAt: string | null;
  updatedAt: string;
}

/** 로또 탭이 한 번에 받아 가는 전체 스냅샷. */
export interface LottoSnapshot {
  /** **다음 회차 예상 번호.** 추첨 전에 저장해 둔 값 그대로(재생성하지 않는다) */
  upcoming: LottoUpcoming | null;
  /** 지난 회차 비교 결과 — **최신이 앞**, 최대 LOTTO_RECENT_LIMIT 건 */
  recentResults: LottoRecentRound[];
  /** DB 가 확보한 최신 추첨 회차 */
  latestDraw: number | null;
  /** 현재 전략 세대 */
  version: number | null;
  state: LottoState;
  /** 지금 주간 사이클이 돌고 있는지 */
  busy: boolean;
  /** 다음 자동 실행 예정 시각(ISO) */
  nextCycleAt: string;
}
