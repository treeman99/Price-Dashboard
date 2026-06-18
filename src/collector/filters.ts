import type { Product } from "../../shared/types.ts";

/**
 * 전역 제외 키워드 (모든 상품 공통). Cowork daily-price 규칙 그대로 이식.
 * - 직구/중고/리퍼 등 비정품 채널
 * - 케이스/필름/배터리/브러시 등 액세서리·소모품
 */
export const GLOBAL_EXCLUDE_KEYWORDS: string[] = [
  // 비정품/채널
  "직구", "해외", "병행", "수입", "리퍼", "중고", "used", "refurbished", "import",
  "parallel", "그레이", "벌크", "오픈박스", "데모", "전시", "스크래치",
  // 액세서리/부속
  "케이스", "필름", "스트랩", "파우치", "가방", "커버", "보호", "강화유리", "액정",
  "거치대", "충전", "캡", "팁", "그립", "배터리", "어댑터", "리모컨", "삼각대", "짐벌",
  "스팸", "이어팁", "이어캡", "클리닝", "한쪽", "젤리", "단품", "미포함", "렌즈캡",
  "밴드만", "밴드단품", "보호필름", "액세서리",
  // 로봇청소기 소모품
  "먼지통", "먼지봉투", "물걸레", "걸레", "패드", "메인브러시", "사이드브러시",
  "필터교체", "소모품",
];

/** 해외 쇼핑몰 도메인/이름 (mallName 기준 제외) */
export const FOREIGN_MALLS = ["aliexpress", "amazon", "ebay", "alibaba", "wish", "qoo10"];

/** Naver 제목의 <b> 태그 및 HTML 엔티티 제거 */
export function cleanTitle(title: string): string {
  return title
    .replace(/<\/?b>/gi, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .trim();
}

function norm(s: string): string {
  return s.toLowerCase();
}

/** 전역 제외어 또는 상품별 제외어가 제목에 있으면 true */
export function isExcluded(title: string, product: Product): boolean {
  const t = norm(title);
  for (const kw of GLOBAL_EXCLUDE_KEYWORDS) {
    if (t.includes(norm(kw))) return true;
  }
  for (const kw of product.mustExclude) {
    if (t.includes(norm(kw))) return true;
  }
  return false;
}

/** AND of OR-groups: 모든 그룹에서 동의어 1개 이상 포함되어야 true */
export function matchesIncludeGroups(title: string, product: Product): boolean {
  const t = norm(title);
  for (const group of product.mustInclude) {
    if (group.length === 0) continue;
    const hit = group.some((syn) => t.includes(norm(syn)));
    if (!hit) return false;
  }
  return true;
}

export function isForeignMall(mallName: string | undefined): boolean {
  if (!mallName) return false;
  const m = norm(mallName);
  return FOREIGN_MALLS.some((f) => m.includes(f));
}

/**
 * 한 검색 결과 항목이 해당 상품의 정품 본체 후보로 유효한지.
 * 제목 매칭/제외 + 최소가 임계값 + 해외몰 제외.
 */
export function isValidCandidate(
  item: { title: string; price: number; mallName?: string },
  product: Product
): boolean {
  const title = cleanTitle(item.title);
  if (item.price < product.minPrice) return false;
  if (isForeignMall(item.mallName)) return false;
  if (isExcluded(title, product)) return false;
  if (!matchesIncludeGroups(title, product)) return false;
  return true;
}
