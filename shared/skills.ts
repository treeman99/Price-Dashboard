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

// 회차 요일·주기·시각은 상수가 아니라 스케줄(`getSchedule().skills`, 기본 매주 월요일 09:00)이 정본이다
// (2026-10-25 스케줄 v2). 표시 문구는 `describeSchedule(schedule.skills)` 로 만든다.

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
  /**
   * 네트워크 접근 판정(집계). 이 기능 배포 전에 만들어진 스냅샷에는 없으므로 선택 필드다.
   * 화면은 없으면 칩을 아예 그리지 않는다(모른다고 표시하지 말 것 — 옛 스냅샷일 뿐이다).
   */
  access?: SkillAccess;
  /**
   * 펼쳐보기용 개별 스킬 목록. **표본에 든 것만** 담는다(SKILLS_SCAN_CAP).
   * access.total 보다 짧을 수 있고, 그 사실은 access.checked 로 드러난다.
   */
  units?: SkillUnit[];
}

/**
 * ── 네트워크 접근 판정 ────────────────────────────────────────────────────────
 *
 * 판정 근거는 **저장소 파일의 실제 내용**이다. SKILL.md 를 읽어 런타임 네트워크 신호
 * (WebFetch / WebSearch / curl / wget / fetch("http…") / requests / httpx / axios /
 *  urllib / api 호스트 URL / MCP 참조)를 찾는다. ★ LLM 이 판정하지 않는다 —
 * 태그는 사실처럼 읽히므로, 틀리면 사용자가 "로컬"을 믿고 외부로 나가는 스킬을 돌린다.
 * 검증 가능한 값과 생성된 문장을 분리하는 이 파일의 원칙(summary 주석)과 같은 이유다.
 *
 * ★★ 판정은 **의도적으로 비대칭**이다.
 *   - 신호를 **찾으면** 확정이다. 표본만 봤어도 "찾았다"는 사실은 참이다.
 *   - 신호를 **못 찾은 것**은 없다는 증거가 아니다. 전수 검사여야만 "로컬"로 단정하고,
 *     표본이면 `local-sampled` 로 내려 단정을 피한다. 864개 중 40개만 보고 "로컬"이라
 *     적는 것은 사실상 거짓말이다.
 */
export type SkillAccessKind =
  /** 전수 검사에서 신호 0 → 로컬 확정 */
  | "local"
  /** 표본 검사에서 신호 0 → 로컬 '추정'. 화면은 표본 범위를 함께 적어야 한다. */
  | "local-sampled"
  /** 검사한 스킬 **전부**에서 신호 발견 */
  | "external"
  /** 검사한 스킬 중 **일부**에서 신호 발견 */
  | "partial"
  /** SKILL.md 가 없는 저장소(awesome 목록·도구·무관 저장소). 상위 50 중 실제로 6건 있었다. */
  | "no-skill"
  /** 트리 조회·파일 읽기 실패로 판정 불가. 죽은 판정이 아니라 '모른다'이다. */
  | "unknown";

/** 저장소 단위 집계 판정. */
export interface SkillAccess {
  kind: SkillAccessKind;
  /** 저장소에 있는 SKILL.md 총 개수(트리 기준). */
  total: number;
  /** 실제로 읽어 검사한 개수. total 보다 작으면 표본이다. */
  checked: number;
  /** 그중 네트워크 신호가 하나라도 나온 개수. */
  network: number;
  /** 발견된 신호 종류(중복 제거, 표시용). 예: ["WebFetch","curl","MCP"] */
  signals: string[];
  /**
   * 외부 스킬을 빼도 나머지가 도는가. **kind 가 `partial` 일 때만** 있다 — 전부 로컬이면 뺄 것이
   * 없고, 전부 외부면 빼고 남는 것이 없다. 옛 스냅샷·캐시에는 없으므로 화면은 없으면 그리지 않는다.
   */
  separability?: SkillSeparability;
}

/**
 * ── 분리 가능성 판정 ──────────────────────────────────────────────────────────
 *
 * 질문은 하나다 — **"네트워크를 쓰는 스킬을 지우고 나머지만 남겨도 문제없이 도는가."**
 * 근거는 네트워크 판정과 같은 SKILL.md 본문이다. 로컬 스킬 본문이 외부 스킬을 가리키는지를 본다.
 * ★ LLM 이 판정하지 않는다(위 네트워크 판정과 같은 이유).
 *
 * 참조는 강도가 다른 두 갈래로 나눈다(2026-10-31 실제 저장소 표본으로 정했다).
 *   - `file`   — 외부 스킬 **디렉터리 안의 파일**을 쓴다. 예: kharmanskyi/open-steps 의
 *                `bash <this skill's folder>/../os-big-picture/scripts/census.sh`.
 *                그 디렉터리를 지우면 파일이 사라지므로 **깨진다고 확정**할 수 있다.
 *   - `invoke` — 외부 스킬을 **이름으로 부르거나 가리킨다**(`/story-long-scan`, "the pr-lens skill",
 *                백틱으로 감싼 스킬 이름). 다음 단계 추천일 수도, 필수 단계일 수도 있다 —
 *                본문만으로는 가릴 수 없으므로 단정하지 않고 '확인 필요'로 둔다.
 *
 * ★★ 판정은 네트워크 판정과 같은 방향으로 **비대칭**이다.
 *   - 참조를 **찾으면** 그 사실은 참이다(근거를 links 로 화면까지 올린다).
 *   - 참조를 **못 찾은 것**은 전수 검사일 때만 "분리 가능"으로 단정한다. 표본이면 읽지 않은 스킬이
 *     외부 스킬을 부를 수 있으므로 `separable-sampled`(추정)로 내린다.
 *
 * ⚠️ 한계: SKILL.md 본문만 본다. 로컬 스킬의 scripts/·references/ 안에서 외부 스킬을 부르는 경우와,
 *    여러 스킬이 함께 쓰는 공용 스크립트는 보지 못한다. 화면 툴팁이 이 한계를 함께 적는다.
 */
export type SkillSeparabilityKind =
  /** 전수 검사, 외부 스킬을 참조하는 로컬 스킬 0 → 빼도 된다 */
  | "separable"
  /** 표본 검사, 참조 0 → 빼도 될 것으로 '추정' */
  | "separable-sampled"
  /** 로컬 스킬이 외부 스킬을 이름으로 부르거나 가리킨다(파일 의존은 없음) → 확인 필요 */
  | "referenced"
  /** 로컬 스킬이 외부 스킬 디렉터리의 파일을 쓴다 → 빼면 깨진다 */
  | "dependent";

/** 참조 강도. 위 머리말의 두 갈래. */
export type SkillRefVia = "file" | "invoke";

/** 로컬 스킬 1건이 외부 스킬 1건을 가리키는 근거 1건. */
export interface SkillRef {
  /** 가리키는 외부 스킬 이름(SkillUnit.name). */
  to: string;
  via: SkillRefVia;
  /** 본문에서 잡힌 그 부분(최대 80자). 사용자가 툴팁에서 "무엇을 보고"를 그대로 읽는다. */
  evidence: string;
}

/** 저장소 단위 분리 가능성 판정. */
export interface SkillSeparability {
  kind: SkillSeparabilityKind;
  /** 검사한 로컬 스킬 수(= access.checked - access.network). */
  local: number;
  /** 그중 외부 스킬을 하나라도 참조하는 로컬 스킬 수. */
  dependents: number;
  /** 근거 목록(from = 로컬 스킬 이름). 화면 툴팁용이라 최대 SKILLS_SEPARABILITY_LINKS 건만 싣는다. */
  links: Array<SkillRef & { from: string }>;
}

/** SkillSeparability.links 최대 건수. 툴팁 한 칸에 들어갈 만큼만. */
export const SKILLS_SEPARABILITY_LINKS = 6;

/** 저장소 안의 개별 스킬 1건. 펼쳐보기 목록의 한 줄. */
export interface SkillUnit {
  /** SKILL.md 가 든 디렉터리명 = 스킬 이름. 루트면 저장소 이름을 쓴다. */
  name: string;
  /** 저장소 내 경로("skills/claude-api/SKILL.md"). */
  path: string;
  /** 그 파일을 GitHub 에서 여는 링크. */
  url: string;
  /** 이 스킬에서 발견된 네트워크 신호. **빈 배열이면 로컬**이다. */
  signals: string[];
  /**
   * **로컬 스킬에만** 있다: 이 스킬 본문이 가리키는 같은 저장소의 외부(네트워크) 스킬.
   * 비었거나 없으면 외부 스킬을 참조하지 않는다. 옛 캐시에는 없다(신호 정의 버전이 바뀌어 재스캔된다).
   */
  refs?: SkillRef[];
}

/**
 * 저장소당 읽어볼 SKILL.md 최대 개수.
 *
 * 실측(2026-09-02, 상위 50 저장소): SKILL.md 합계 10,607개, 최대 보유 저장소는 6,632개.
 * 전수는 불가능하다. 40으로 자르면 50개 저장소 중 42개가 사실상 전수이고, 876건을 10초에
 * 읽었다. 표본이 된 저장소는 kind 가 `local-sampled` 로 내려가 단정하지 않는다.
 */
export const SKILLS_SCAN_CAP = 40;

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
  /** 이번 회차에 실제로 추적(스냅샷 저장 — 중간 점검이면 조회만)한 저장소 수. 화면 각주에 쓴다. */
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
  /**
   * 회차 사이에 '지금 갱신'으로 만든 **중간 점검** 결과일 때만 있다.
   *
   * 중간 점검은 DB 스냅샷(skill_repo_points)에 남지 않는다 — 남기면 그 날짜가 다음 회차의
   * 비교 기준이 되어 '주간 증가'가 수요일~월요일 5일치로 쪼그라든다. 그래서 숫자는 지금 값이지만
   * 기록은 정식 회차만 쌓는다. `cycleUpdatedAt` 은 이 점검이 딛고 선 마지막 정식 회차의
   * updatedAt 이고, 스케줄러의 '이번 회차 커버됨' 판정은 updatedAt 대신 이 값을 본다
   * (점검 시각이 놓친 회차를 덮어 가리면 보충이 영영 안 돈다).
   */
  interim?: { cycleUpdatedAt: string };
}
