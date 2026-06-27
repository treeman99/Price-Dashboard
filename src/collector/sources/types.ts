// 가격비교 소스 추상화 (문서 §5.1).
// 상품을 키워드가 아니라 소스별 고정 식별자(예: 다나와 pcode/URL)로 추적하기 위한 계약.

/** 지원 소스 식별자. DB(product_sources.source)·PricePoint.source 와 문자열이 일치한다. */
export type SourceId = "danawa" | "enuri" | "llm-websearch";

/** 상품 × 소스마다 고정된 재조회 대상. resolve()가 만들고 사람이 확정한다. */
export interface SourceRef {
  source: SourceId;
  /** danawa pcode 등 소스 내부 식별자. LLM처럼 식별자가 없으면 null. */
  refId: string | null;
  /** 매일 재조회할 고정 URL (사람 검수용 + 감사용) */
  url: string;
}

/** 소스 1회 조회 결과 (정규화된 형태). 오케스트레이터는 status만 보고 폴백을 판단한다. */
export interface SourcePriceResult {
  source: SourceId;
  status: "ok" | "blocked" | "not-listed" | "parse-error" | "empty";
  /** ISO(UTC). KST는 표시단에서 변환. */
  fetchedAt: string;
  productName: string | null;
  modelName: string | null;
  /** 쿠팡 판매가 + 로켓 여부 (쿠팡 미편입이면 null) */
  coupang: { price: number; isRocket: boolean; url: string | null } | null;
  /** 전체 최저가 + 판매처 */
  overallLowest: { price: number; mall: string; url: string | null } | null;
  /** 감사/디버그용 원본(파서 입력 일부, LLM 리서치 결과 등). 저장하지 않을 수 있음. */
  raw?: unknown;
}

/** resolve() 입력. 문서 §5.1 스케치 기준 + 다나와 후보 필터용 mustExclude(선택). */
export interface ResolveQuery {
  name: string;
  /** 모델명 엄격 매칭 (AND of OR-groups). 각 그룹에서 1개 이상 제목에 포함되어야 통과. */
  mustInclude: string[][];
  /** 액세서리/소모품 제외 최소가(원) */
  minPrice: number;
  /** 상품별 추가 제외 토큰 (선택). 전역 "해외구매" 제외와 별개. */
  mustExclude?: string[];
}

/** 가격비교 소스 플러그인. */
export interface PriceSource {
  id: SourceId;
  /** 최초 1회: 키워드/모델 → 후보 ref 목록 (사람이 확정). LLM 소스는 빈 배열. */
  resolve(q: ResolveQuery): Promise<SourceRef[]>;
  /** 매일: 고정 ref 재조회 → 정규화 결과. */
  fetch(ref: SourceRef): Promise<SourcePriceResult>;
}
