import { test } from "node:test";
import assert from "node:assert/strict";
import { renderProduct, priceIMessageText } from "./email.ts";
import type { ProductSummary, Product, Listing, Review } from "../../shared/types.ts";

function product(over: Partial<Product> = {}): Product {
  return {
    id: 1,
    name: "리코 GR4",
    mustInclude: [["GR4"]],
    mustExclude: [],
    minPrice: 500000,
    active: true,
    sortOrder: 0,
    createdAt: "2026-07-01T00:00:00+09:00",
    ...over,
  };
}

function listing(over: Partial<Listing> = {}): Listing {
  return { rank: 1, mall: "쿠팡", price: 1200000, link: "https://example.com/buy", ...over };
}

function review(over: Partial<Review> = {}): Review {
  return {
    source: "블로그",
    date: "2026-07-10",
    summary: "화질이 좋다",
    rating: 4.5,
    link: "https://example.com/review",
    ...over,
  };
}

function summary(over: Partial<ProductSummary> = {}): ProductSummary {
  return {
    product: product(),
    latest: {
      date: "2026-07-17",
      naverLowest: null,
      coupangLowest: 1250000,
      danawaLowest: 1200000,
      avgPrice: 1230000,
      overallLowest: 1200000,
      lowestSource: "다나와",
    },
    change: { direction: "down", amount: 30000, percent: -2.4 },
    topListings: [listing()],
    reviews: [review()],
    lastCollectedAt: "2026-07-17T08:00:00+09:00",
    ...over,
  };
}

// ── 기존 동작 고정 (안전망) ────────────────────────────────────

test("renderProduct: 상품명·가격·차트 cid 가 렌더된다", () => {
  const html = renderProduct(summary(), "chart_1@dailyprice");
  assert.ok(html.includes("리코 GR4"));
  assert.ok(html.includes("1,200,000원"));
  assert.ok(html.includes(`src="cid:chart_1@dailyprice"`));
  assert.ok(html.includes("Top3 최저가"));
  assert.ok(html.includes("리뷰"));
});

test("renderProduct: 하락은 초록(#2ecc71) — 쇼핑 리포트의 기존 색 규칙", () => {
  const html = renderProduct(summary(), "cid1");
  assert.match(html, /color:#2ecc71[^>]*>▼/);
});

test("renderProduct: 리스팅·리뷰가 없어도 throw 없이 렌더된다", () => {
  const html = renderProduct(summary({ topListings: [], reviews: [] }), "cid1");
  assert.equal(typeof html, "string");
  assert.ok(!html.includes("Top3 최저가"));
  assert.ok(!html.includes("<b style=\"font-size:13px\">리뷰</b>"));
});

test("renderProduct: 정상 링크는 앵커로 렌더된다", () => {
  const html = renderProduct(summary(), "cid1");
  assert.ok(html.includes(`<a href="https://example.com/buy"`));
  assert.ok(html.includes(`<a href="https://example.com/review"`));
});

test("renderProduct: XSS — 상품명·판매처·리뷰의 <script> 가 이스케이프된다", () => {
  const evil = '<script>alert("x")</script>';
  const html = renderProduct(
    summary({
      product: product({ name: evil }),
      topListings: [listing({ mall: evil })],
      reviews: [review({ source: evil, summary: evil })],
    }),
    "cid1"
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

// ── safeHref 가드 ──────────────────────────────────────────────
// 링크는 수집기(LLM/WebSearch)가 만들어 온 값이라 신뢰할 수 없다.

test("renderProduct: XSS — 리스팅의 javascript: 링크는 앵커로 렌더하지 않는다", () => {
  const html = renderProduct(
    // eslint-disable-next-line no-script-url
    summary({ topListings: [listing({ link: "javascript:alert(1)" })] }),
    "cid1"
  );
  assert.ok(!html.includes("javascript:"));
  assert.ok(html.includes("쿠팡")); // 판매처 이름은 평문으로 남는다
  assert.ok(!html.includes(">쿠팡</a>"));
});

test("renderProduct: XSS — 종합 최저가도 불안전 링크면 앵커 없이 값만", () => {
  const html = renderProduct(
    // eslint-disable-next-line no-script-url
    summary({ topListings: [listing({ link: "javascript:alert(1)" })] }),
    "cid1"
  );
  assert.ok(!html.includes("javascript:"));
  assert.ok(html.includes("<b>1,200,000원</b>")); // 앵커로 감싸지 않은 값
});

test("renderProduct: XSS — 리뷰의 data: 링크는 앵커로 렌더하지 않는다", () => {
  const html = renderProduct(
    summary({ reviews: [review({ link: "data:text/html,<script>alert(1)</script>" })] }),
    "cid1"
  );
  assert.ok(!html.includes("data:text/html"));
  assert.ok(html.includes("화질이 좋다")); // 요약은 평문으로 남는다
  assert.ok(!html.includes(">화질이 좋다</a>"));
});

// ── priceIMessageText ──────────────────────────────────────────

test("priceIMessageText: 상품별 최저가와 변동", () => {
  const t = priceIMessageText([summary()], "2026-07-17");
  assert.match(t, /📷 관심 물건 최저가 — 2026-07-17/);
  assert.ok(t.includes("리코 GR4: 1,200,000원 ▼30,000원 2.4%"));
});
