// 기존 research.ts(Agent SDK WebSearch)를 PriceSource 로 보존하는 어댑터.
// 스크래핑(다나와/에누리)이 전부 막혀도 가격선이 끊기지 않는 최종 폴백.
//
// 주의: LLM 경로는 고정 ref 개념이 약하다 →
//   - resolve(): no-op(빈 배열). 사람이 확정할 pcode 같은 게 없다.
//   - fetch():  상품 컨텍스트(이름/최소가/매칭규칙)가 필요하므로 product 를 클로저로 받는다.
// 따라서 소스 인스턴스는 상품마다 생성한다(createLlmWebsearchSource).

import { researchProduct, type ResearchResult } from "../research.ts";
import type { Product } from "../../../shared/types.ts";
import type { PriceSource, SourcePriceResult, SourceRef } from "./types.ts";

/** ResearchResult → SourcePriceResult 정규화. reviews 등은 raw 로 넘겨 collect 단계가 활용. */
export function researchToResult(
  r: ResearchResult,
  productName: string,
  fetchedAt: string
): SourcePriceResult {
  const coupang =
    r.coupangLowest != null
      ? { price: r.coupangLowest, isRocket: false, url: r.comparisonLink }
      : null;
  const overallLowest =
    r.overallLowest != null
      ? { price: r.overallLowest, mall: r.lowestSource || "가격비교", url: r.comparisonLink }
      : null;

  const hasAny = coupang != null || overallLowest != null;
  return {
    source: "llm-websearch",
    status: hasAny ? "ok" : "empty",
    fetchedAt,
    productName,
    modelName: null,
    coupang,
    overallLowest,
    raw: r, // reviews / danawaLowest 등 부가정보 보존
  };
}

/**
 * 상품 컨텍스트를 클로저로 묶은 LLM 소스 인스턴스.
 * researchFn 은 테스트에서 주입 가능(기본은 실제 Agent SDK 호출).
 */
export function createLlmWebsearchSource(
  product: Product,
  researchFn: (p: Product) => Promise<ResearchResult> = researchProduct
): PriceSource {
  return {
    id: "llm-websearch",
    async resolve(): Promise<SourceRef[]> {
      return []; // LLM: 고정 ref 없음
    },
    async fetch(_ref: SourceRef): Promise<SourcePriceResult> {
      const r = await researchFn(product);
      return researchToResult(r, product.name, new Date().toISOString());
    },
  };
}
