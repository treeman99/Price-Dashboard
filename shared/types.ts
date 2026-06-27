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

/** 카테고리 정의(설정). 스냅샷의 NewsCategory와 달리 items 대신 검색 가이드(description)를 갖는다. */
export interface NewsCategoryDef {
  key: string;
  label: string;
  emoji: string;
  color: string;
  /** LLM 수집 가이드(이 카테고리에서 어떤 뉴스를 원하는지). 선택. */
  description?: string;
}

export interface NewsRelated {
  /** 관련 출처 라벨 (예: "Reuters", "📺 영상") */
  label: string;
  link: string;
}

export interface NewsItem {
  /** 한국어 제목 */
  title: string;
  /** 출처 (예: "TechCrunch", "GeekNews", "📺 YouTube (@mkbhd)") */
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
