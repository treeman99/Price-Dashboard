// 백엔드(api/collector)와 프론트(web)가 공유하는 타입.
// 백엔드는 상대경로로, web은 vite alias `@shared`로 임포트한다.

/** 상품(관심 물건) */
export interface Product {
  id: number;
  name: string;
  /**
   * 모델명 엄격 매칭(AND of OR-groups). 각 그룹은 동의어 OR 묶음이며,
   * 모든 그룹에서 최소 1개가 제목에 포함되어야 통과. (대소문자 무시)
   * 예) GR4 → [["GR4","GRIV","GR IV"]] / 루나울트라 → [["루나","Luna"],["울트라","Ultra"]]
   */
  mustInclude: string[][];
  /** 이 상품에만 적용되는 추가 제외 토큰 (대소문자 무시). 전역 제외어와 별개. */
  mustExclude: string[];
  /** 액세서리 제외용 최소 가격(원). 이 값 미만은 후보에서 제외 */
  minPrice: number;
  /** false면 추적 중지(soft delete) */
  active: boolean;
  createdAt: string;
}

/** 하루치 가격 스냅샷 */
export interface PricePoint {
  date: string; // YYYY-MM-DD
  naverLowest: number | null;
  coupangLowest: number | null;
  danawaLowest: number | null;
  avgPrice: number | null;
  overallLowest: number | null;
  lowestSource: string;
  // ── 쿠팡 가격 수집 강화(신규, 기존 코드 호환 위해 옵셔널) ──
  /** 쿠팡 로켓배송 여부. 미수집/미편입이면 null. */
  coupangIsRocket?: boolean | null;
  /** 전체 최저가 판매처 상호. */
  lowestMall?: string | null;
  /** 가격을 채택한 소스: 'danawa' | 'enuri' | 'llm-websearch' (없으면 null). */
  source?: string | null;
}

/** 상품 × 소스 고정 ref (watchlist). source 는 'danawa'|'enuri'|'llm-websearch'. */
export interface ProductSource {
  productId: number;
  source: string;
  /** 소스 내부 식별자(다나와 pcode 등). LLM 등은 null. */
  refId: string | null;
  /** 매일 재조회할 고정 URL. */
  url: string;
  /** 사람이 확정했는지(1이어야 매일 고정 ref 재조회, 아니면 degrade). */
  confirmed: boolean;
  createdAt: string;
}

/** 상품 × 소스 ref upsert 입력. */
export interface UpsertProductSourceInput {
  productId: number;
  source: string;
  refId: string | null;
  url: string;
  confirmed?: boolean;
}

/**
 * resolve 프록시 후보 1건 (사람이 보고 pcode 확정하는 표시 단위).
 * SourceRef(source/refId/url)에 사람 검수용 표시 라벨(title)을 더한 형태.
 */
export interface ResolveCandidate {
  /** 'danawa' | 'enuri' | 'llm-websearch' */
  source: string;
  /** 소스 내부 식별자(다나와 pcode 등). */
  refId: string | null;
  /** 확정 시 그대로 저장할 고정 URL. */
  url: string;
  /** 사람 검수용 표시 제목(검색 결과 상품명). */
  title: string;
}

/** resolve 프록시 응답. 외부 호출 실패/차단 시에도 200 + 빈 후보 + note 로 내려준다. */
export interface ResolveResult {
  /** 조회한 소스. */
  source: string;
  /** pcode 후보 목록. 실패/미매칭 시 빈 배열. */
  candidates: ResolveCandidate[];
  /** 후보가 없거나 차단 시 프론트가 안내할 사유(정상이면 null). */
  note: string | null;
}

/** 당일 Top3 후보 (판매처/가격/링크) */
export interface Listing {
  rank: number;
  mall: string;
  price: number;
  link: string | null;
}

/** 리뷰 카드 */
export interface Review {
  source: string;
  date: string | null;
  summary: string;
  rating: number | null;
  link: string | null;
}

/** 전일 대비 변동 방향 */
export type ChangeDirection = "up" | "down" | "flat";

/** 대시보드 카드용 상품 요약 */
export interface ProductSummary {
  product: Product;
  latest: PricePoint | null;
  /** 전일 대비 종합최저가 변동 */
  change: {
    direction: ChangeDirection;
    amount: number | null; // 절대 변동액(원)
    percent: number | null;
  };
  topListings: Listing[];
  reviews: Review[];
  /** 마지막 수집 일시(ISO) */
  lastCollectedAt: string | null;
}

/** 상품별 히스토리(차트용) */
export interface ProductHistory {
  product: Product;
  points: PricePoint[];
}

/** 수집 실행 결과 */
export interface CollectResult {
  date: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  perProduct: Array<{
    productId: number;
    name: string;
    ok: boolean;
    naverLowest: number | null;
    overallLowest: number | null;
    error: string | null;
  }>;
  notified: { email: boolean };
  error: string | null;
}

/** 상품 생성 요청 */
export interface CreateProductInput {
  name: string;
  mustInclude: string[][];
  mustExclude: string[];
  minPrice: number;
}

export type PeriodDays = 7 | 30 | 90;

// ── 팝업스토어 · 전시회 보드 (이력 저장 없음, 최신 스냅샷만) ──

export type EventTag = "신규" | "종료임박" | "예정" | null;

export interface PopupItem {
  name: string;
  /** 지역(성수/홍대/여의도/강남/기타 등) */
  region: string;
  /** 기간 표시용 문자열, 없으면 "" */
  period: string;
  /** 구조화 시작/종료일 (YYYY-MM-DD), 모르면 null */
  startDate: string | null;
  endDate: string | null;
  summary: string;
  link: string | null;
  category: string | null;
  tag: EventTag;
}

export interface ExhibitionItem {
  title: string;
  venue: string;
  period: string;
  startDate: string | null;
  endDate: string | null;
  summary: string;
  link: string | null;
  tag: EventTag;
}

export interface VenueGroup {
  name: string; // 코엑스 / 세텍 / 킨텍스 / 수원컨벤션센터
  items: ExhibitionItem[];
}

/** 대한민국 축제(전국). 지역 제한 없음. */
export interface FestivalItem {
  name: string;
  /** 개최 지역 (예: "전남 함평", "서울 여의도", "경남 진해") */
  region: string;
  period: string;
  startDate: string | null;
  endDate: string | null;
  summary: string;
  link: string | null;
  tag: EventTag;
}

export interface EventsSnapshot {
  date: string; // YYYY-MM-DD (로컬)
  updatedAt: string; // ISO
  /** 큐레이션 출처: LLM 정제 or 네이버 검색 원본 */
  source: "llm" | "naver-raw";
  popups: PopupItem[];
  exhibitions: {
    venues: VenueGroup[];
  };
  /** 대한민국 전역 축제 */
  festivals: FestivalItem[];
  notes: string | null;
}

// ── 데일리 뉴스 다이제스트 (최근 24시간, 7개 카테고리) ──

/** 동적 카테고리 키 (기본 7종 + 사용자 추가). */
export type NewsCategoryKey = string;

/**
 * 카테고리 정의(설정). 뉴스·유튜브 보드가 공유한다.
 * 스냅샷의 NewsCategory/YoutubeCategory와 달리 items 대신 검색 가이드(description)를 갖는다.
 */
export interface CategoryDef {
  key: string;
  label: string;
  emoji: string;
  color: string;
  /** LLM 수집 가이드(이 카테고리에서 무엇을 원하는지). 선택. */
  description?: string;
  /**
   * (유튜브 전용) 검색 범위.
   * - "kr": 한국 채널·한국어 영상만
   * - "global": 해외(영어 등) 포함
   * 미지정이면 유튜브에서는 "kr"로 취급. 뉴스에서는 무시.
   */
  region?: "kr" | "global";
  /**
   * (유튜브 전용) 제외 키워드. 제목/채널명에 이 단어가 포함된 영상은 하드 제거.
   * 예) 신제품 리뷰에서 자동차를 빼려면 ["자동차","SUV","모빌리티",...]. 대소문자 무시.
   */
  excludeKeywords?: string[];
}

/** 뉴스 카테고리 정의(=공용 CategoryDef). 하위 호환을 위해 별칭 유지. */
export type NewsCategoryDef = CategoryDef;

export interface NewsRelated {
  /** 관련 출처 라벨 (예: "Reuters", "Bloomberg") */
  label: string;
  link: string;
}

export interface NewsItem {
  /** 한국어 제목 */
  title: string;
  /** 출처 (예: "TechCrunch", "GeekNews", "연합뉴스") — 영상/유튜브 제외 */
  source: string;
  /** 발행일 YYYY-MM-DD */
  date: string;
  /** 한국어 요약 (5줄 이내) */
  summary: string;
  link: string | null;
  /** 중복 통합 시 관련 출처 (최대 2개) */
  related: NewsRelated[];
}

export interface NewsCategory {
  key: NewsCategoryKey;
  /** 표시 라벨 (예: "AI / LLM") */
  label: string;
  emoji: string;
  /** 섹션 색상 (hex) */
  color: string;
  items: NewsItem[];
}

export interface NewsSnapshot {
  date: string; // YYYY-MM-DD (로컬)
  updatedAt: string; // ISO
  /** 큐레이션 출처: LLM or 미수집(empty) */
  source: "llm" | "empty";
  categories: NewsCategory[];
  notes: string | null;
}

// ── 유튜브 소식 (AI·LLM / 신제품 리뷰 등, 최근 며칠 영상) ──

/** 유튜브 카테고리 정의(=공용 CategoryDef). */
export type YoutubeCategoryDef = CategoryDef;

/** 큐레이션된 유튜브 영상 1건 */
export interface YoutubeVideo {
  /** 한국어 제목(원제가 영어면 번역, 원제는 originalTitle에 보존) */
  title: string;
  /** 원제(번역 전). 한국어 영상이면 title과 동일하거나 생략 가능. */
  originalTitle?: string | null;
  /** 채널명 (예: "Marques Brownlee") */
  channel: string;
  /** 채널 핸들 (예: "@mkbhd"). 모르면 null. */
  channelHandle?: string | null;
  /** 영상 게시일 YYYY-MM-DD (없으면 상대표현 추정 불가 → 채택 안 함) */
  date: string;
  /** 한국어 요약 — 영상이 다루는 핵심 내용(제목 재진술이 아니라 실제 내용). */
  summary: string;
  /** 영상 watch URL (https://www.youtube.com/watch?v=...) */
  url: string;
  /** 영상 ID(url에서 추출). 썸네일/임베드에 사용. */
  videoId: string | null;
  /** 썸네일 URL(videoId에서 파생). 없으면 null. */
  thumbnail: string | null;
  /** 조회수 표시 문자열 (예: "1.2M views", "조회수 53만회"). 모르면 null. */
  views?: string | null;
  /** 영상 길이 표시 (예: "12:34"). 모르면 null. */
  duration?: string | null;
}

export interface YoutubeCategory {
  key: NewsCategoryKey;
  /** 표시 라벨 (예: "AI · LLM") */
  label: string;
  emoji: string;
  /** 섹션 색상 (hex) */
  color: string;
  items: YoutubeVideo[];
}

export interface YoutubeSnapshot {
  date: string; // YYYY-MM-DD (로컬)
  updatedAt: string; // ISO
  /** 큐레이션 출처: LLM or 미수집(empty) */
  source: "llm" | "empty";
  /** 신선도 기준일 수(이 일수 이내 게시 영상만 채택) */
  freshDays: number;
  categories: YoutubeCategory[];
  notes: string | null;
}

/** 조사에서 제외할 유튜브 채널(차단 목록 1건). */
export interface BlockedChannel {
  /** 안정적 식별자. handle이 있으면 "@handle", 없으면 "name:채널명"(모두 정규화). */
  id: string;
  /** 표시용 채널명(차단 시점에 보였던 이름). */
  channel: string;
  /** 채널 핸들(있으면, 예: "@mkbhd"). 없으면 null. */
  handle: string | null;
  /** 차단 시각(ISO). */
  blockedAt: string;
}
