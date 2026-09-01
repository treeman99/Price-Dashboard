/**
 * 스킬 랭킹 탭의 공용 계약 (서버·프론트가 함께 읽는다).
 *
 * ── 왜 두 개의 랭킹인가 ────────────────────────────────────────────────────
 * star **총합** 순위만 두면 상위권이 몇 달째 고정된다(1위와 2위의 격차가 주간 증감보다
 * 훨씬 크다). 그래서 "이번 주에 가장 많이 늘어난" 순위를 나란히 둔다. 총합은 '지금 무엇이
 * 표준인가'를, 증가분은 '지금 무엇이 뜨고 있는가'를 답한다.
 *
 * ── 왜 우리가 직접 스냅샷을 쌓는가 ─────────────────────────────────────────
 * GitHub 은 과거 star 수를 주지 않는다. 2026-09-01 실측:
 *   - REST `/repos/{o}/{r}/stargazers` + `Accept: application/vnd.github.star+json`
 *     (star 를 찍은 시각) → 인증해도 **404**. 큰 저장소·작은 저장소 모두.
 *   - GraphQL `stargazers(last:100){ starredAt }` → `stargazerCount` 는 172,944 인데
 *     `totalCount: 0`, edges 는 빈 배열.
 *   - 외부 서비스(OSSInsight)는 응답하지만 **월 단위** 시계열이라 주간에 못 쓰고,
 *     핵심 지표를 남의 서비스에 매다는 셈이 된다.
 * → 유일하게 견고한 경로는 **매주 우리 DB 에 스냅샷을 남기고 직접 차분**하는 것이다.
 *   조인 키는 `full_name` 이 아니라 GitHub 저장소 고유 **id** 다 — 저장소 이름이 바뀌어도
 *   추적이 끊기지 않아야 증가분이 거짓말을 하지 않는다.
 *
 * ⚠️ 그 결과 **첫 회차에는 증가 랭킹이 비어 있다**(비교 대상이 없다). 두 번째 회차부터
 *    채워지고, 그 구간은 정확히 7일이 아닐 수 있다(배포일이 월요일이 아니면). 그래서
 *    구간을 숨기지 않고 SkillWindow 로 **실제 일수를 그대로** 화면까지 올린다.
 *    "7일간"이라고 적어 두고 실제로는 6일치를 보여주는 쪽이 훨씬 나쁘다.
 */

/** 랭킹 종류. 화면의 두 목록에 1:1 대응한다. */
export type SkillRankKind = "total" | "growth";

/** 수집 대상 GitHub topic. 합집합으로 후보 풀을 만든다(2026-09-01 실측 검색 건수 주석). */
export const SKILLS_TOPICS: readonly string[] = [
  "agent-skills", // 20,113건
  "claude-skills", // 7,719건
  "claude-skill", // 4,893건
  "claude-code-skills", // 1,634건
];

/** 화면에 노출하는 랭킹 길이(각 목록당). */
export const SKILLS_RANK_SIZE = 50;

/**
 * 매주 스냅샷으로 **추적**하는 저장소 풀 크기.
 *
 * 노출하는 50개보다 훨씬 넓게 잡는 이유: 이번 주 급상승 저장소가 총 star TOP 50 **밖**에
 * 있을 수 있다. 풀이 좁으면 증가 랭킹은 "이미 유명한 것들 중 조금 는 것"만 보여준다.
 * 주당 400행 × 52주 ≈ 21,000행이라 DB 부담은 없다.
 */
export const SKILLS_TRACK_POOL = 400;

/** 주간 갱신 시각. cron 식과 경계 계산이 같은 상수를 보게 한다(로또 사이클과 같은 규약). */
export const SKILLS_CYCLE_WEEKDAY = 1; // 0=일요일 → 1=월요일
export const SKILLS_CYCLE_HOUR = 9;
export const SKILLS_CYCLE_CRON = `0 ${SKILLS_CYCLE_HOUR} * * ${SKILLS_CYCLE_WEEKDAY}`;
export const SKILLS_CYCLE_LABEL = "월요일 09:00";

/** 저장소 1건 = 목록의 한 줄. */
export interface SkillRepo {
  /** GitHub 저장소 고유 id. 이름 변경에도 불변 — 주간 차분의 조인 키다. */
  id: number;
  /** "anthropics/skills" */
  fullName: string;
  owner: string;
  name: string;
  url: string;
  /** GitHub 원문 설명. 설명을 안 적은 저장소가 실제로 있어 null 을 허용한다. */
  description: string | null;
  /**
   * LLM 한국어 요약(2~3줄). 요약에 실패했거나 아직 안 만든 항목은 null 이고,
   * 화면은 그때 description 으로 폴백한다 — 요약 실패가 목록을 비우면 안 된다.
   *
   * ★ 숫자(star·증가분·순위)는 **절대** 여기서 나오지 않는다. LLM 은 문장만 쓴다.
   *   종합최저가 사건([[overall-lowest-price-link-integrity]] 와 같은 원칙)에서 배운 대로,
   *   검증 가능한 값과 생성된 문장은 경로를 분리한다.
   */
  summary: string | null;
  stars: number;
  forks: number;
  watchers: number;
  openIssues: number;
  language: string | null;
  /** SPDX id ("MIT", "Apache-2.0"). 라이선스 미표기 저장소가 있어 null 허용. */
  license: string | null;
  topics: string[];
  /** ISO. 저장소 생성 시각 — "신생인데 급상승"을 읽어내는 근거. */
  createdAt: string;
  /** ISO. 마지막 푸시 — 별만 많고 죽은 저장소를 가려낸다. */
  pushedAt: string;
  archived: boolean;
}

/** 랭킹 한 줄 = 저장소 + 그 랭킹에서의 위치·변동. */
export interface SkillRankEntry {
  /** 1부터. 이 랭킹(total | growth) 안에서의 순위. */
  rank: number;
  repo: SkillRepo;
  /** 직전 스냅샷의 **같은 랭킹**에서의 순위. 신규 진입이면 null(화면은 NEW 배지). */
  prevRank: number | null;
  /**
   * 직전 스냅샷 대비 star 증가분. 비교 기준이 없으면 null.
   * growth 랭킹의 정렬 키이며, total 랭킹에서도 참고값으로 함께 보여 준다.
   */
  starsGained: number | null;
}

/**
 * 증가 랭킹의 비교 구간.
 *
 * days 를 굳이 실어 보내는 이유는 이 파일 머리말에 적은 대로다 — 첫 회차 구간은 7일이
 * 아닐 수 있고, 맥이 자서 월요일 cron 을 통째로 놓치면 14일이 될 수도 있다. 화면은
 * 이 값을 그대로 라벨에 쓴다("최근 6일간 +1,204").
 */
export interface SkillWindow {
  /** 비교 기준(이전) 스냅샷 날짜 YYYY-MM-DD */
  fromDate: string;
  /** 이번 스냅샷 날짜 YYYY-MM-DD */
  toDate: string;
  /** 두 날짜의 실제 간격(일). 7 이라고 가정하지 말 것. */
  days: number;
}

/** 화면·API·이메일이 공유하는 최신 스냅샷 1건. */
export interface SkillsSnapshot {
  /** 이 스냅샷의 로컬 날짜 YYYY-MM-DD */
  date: string;
  /** ISO */
  updatedAt: string;
  /** "github" = 정상 수집 / "empty" = 아직 수집 전 / "error" = 실패 */
  source: "github" | "empty" | "error";
  /** 이번 회차에 실제로 추적(스냅샷 저장)한 저장소 수. 화면 각주에 쓴다. */
  trackedCount: number;
  /** star 총합 순위 (최대 SKILLS_RANK_SIZE) */
  byStars: SkillRankEntry[];
  /**
   * 주간 증가 순위 (최대 SKILLS_RANK_SIZE).
   * 비교 대상이 없는 **첫 회차에는 빈 배열**이고 window 도 null 이다.
   */
  byGrowth: SkillRankEntry[];
  /** 증가 랭킹의 비교 구간. 첫 회차에는 null. */
  window: SkillWindow | null;
  /** 사람에게 보여줄 상태 문구(스냅샷 보호 발동 안내 등). */
  notes?: string;
}
