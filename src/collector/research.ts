import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import type { Product, Review } from "../../shared/types.ts";

export interface ResearchResult {
  coupangLowest: number | null;
  danawaLowest: number | null;
  overallLowest: number | null;
  lowestSource: string;
  comparisonLink: string | null;
  reviews: Review[];
}

const EMPTY: ResearchResult = {
  coupangLowest: null,
  danawaLowest: null,
  overallLowest: null,
  lowestSource: "",
  comparisonLink: null,
  reviews: [],
};

function buildPrompt(product: Product): string {
  const minMan = Math.round(product.minPrice / 10000);
  return `당신은 한국 가격비교 리서처다. 아래 "정품 본체"의 현재 최저가와 최신 리뷰를 웹검색으로 조사하라.

상품명: ${product.name}
정품 본체 최소가 기준: ${minMan}만원 이상 (이 미만은 액세서리/소모품이므로 무시)
제외: 직구/해외/병행/중고/리퍼, 케이스·필름·배터리 등 액세서리, 해외몰(AliExpress/Amazon/eBay).

다음 검색을 수행하라:
1. "다나와 ${product.name} 최저가"
2. "에누리 ${product.name} 최저가"
3. "${product.name} 쿠팡 가격"

추출 대상:
- 쿠팡 최저가(원), 다나와 최저가(원), 전체 최저가(원)와 그 판매처, 가격비교 페이지 링크
- 최신 리뷰 3~5개: 출처, 날짜(YYYY-MM-DD 가능하면), 2~3줄 요약, 평점(0~5, 없으면 null), 원문 링크. 최근 3개월·실사용 후기 우선.

반드시 아래 JSON 형식으로만, 다른 텍스트 없이 응답하라(가격은 숫자, 없으면 null):
{"coupangLowest": number|null, "danawaLowest": number|null, "overallLowest": number|null, "lowestSource": string, "comparisonLink": string|null, "reviews": [{"source": string, "date": string|null, "summary": string, "rating": number|null, "link": string|null}]}`;
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("JSON 미발견");
  return JSON.parse(text.slice(start, end + 1));
}

function sanitizePrice(v: unknown, minPrice: number): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < minPrice) return null; // 최소가 미만은 액세서리로 간주
  return Math.round(n);
}

/**
 * Agent SDK 웹리서치. ANTHROPIC_API_KEY 없거나 실패 시 EMPTY 반환(네이버 결과만으로 진행).
 * 결정적 작업(네이버/필터/저장)은 호출하지 않으며, 오직 비교가/쿠팡/리뷰 리서치만 담당.
 */
export async function researchProduct(product: Product): Promise<ResearchResult> {
  if (!config.anthropicApiKey) return EMPTY;

  try {
    const q = query({
      prompt: buildPrompt(product),
      options: {
        allowedTools: ["WebSearch"],
        permissionMode: "bypassPermissions",
        settingSources: [], // 로컬 CLAUDE.md/설정 로드 방지
        maxTurns: 8,
        systemPrompt:
          "너는 가격비교 리서처다. 반드시 마지막에 지정된 JSON 한 개만 출력한다.",
      },
    });

    let finalText = "";
    for await (const msg of q) {
      if (msg.type === "result") {
        if (msg.subtype === "success") finalText = msg.result;
      }
    }
    if (!finalText) return EMPTY;

    const parsed = extractJson(finalText) as Record<string, unknown>;
    const reviewsRaw = Array.isArray(parsed.reviews) ? parsed.reviews : [];
    const reviews: Review[] = reviewsRaw.slice(0, 5).map((r) => {
      const rr = r as Record<string, unknown>;
      const rating = Number(rr.rating);
      return {
        source: String(rr.source ?? "출처미상"),
        date: rr.date ? String(rr.date) : null,
        summary: String(rr.summary ?? ""),
        rating: Number.isFinite(rating) ? rating : null,
        link: rr.link ? String(rr.link) : null,
      };
    });

    const result: ResearchResult = {
      coupangLowest: sanitizePrice(parsed.coupangLowest, product.minPrice),
      danawaLowest: sanitizePrice(parsed.danawaLowest, product.minPrice),
      overallLowest: sanitizePrice(parsed.overallLowest, product.minPrice),
      lowestSource: String(parsed.lowestSource ?? ""),
      comparisonLink: parsed.comparisonLink ? String(parsed.comparisonLink) : null,
      reviews,
    };
    log.info(
      `리서치 [${product.name}] 쿠팡=${result.coupangLowest ?? "-"} 다나와=${result.danawaLowest ?? "-"} 리뷰 ${reviews.length}개`
    );
    return result;
  } catch (e) {
    log.warn(`리서치 [${product.name}] 실패 → 네이버 결과만 사용: ${(e as Error).message}`);
    return EMPTY;
  }
}
