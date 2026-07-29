import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "./collect.ts";
import type { NaverResult } from "./naver.ts";
import type { SourcePriceResult } from "./sources/types.ts";

// 종합 최저가의 값·링크 정합성 회귀 테스트 (2026-07-29).
// 버그: 링크를 무조건 네이버 Top1 로 고정해서, 가격비교 소스가 최저가일 때
//       화면 금액과 링크를 눌러 도착한 페이지 금액이 서로 달랐다.

const NAVER_TOP = "https://smartstore.naver.com/main/products/1";

function naver(over: Partial<NaverResult> = {}): NaverResult {
  return {
    naverLowest: 1040000,
    candidates: [
      { title: "벤큐 MA320UP", price: 1040000, mall: "벤큐공식쇼핑몰", link: NAVER_TOP },
      { title: "벤큐 MA320UP", price: 1050000, mall: "모니터마트", link: "https://x/2" },
    ],
    ...over,
  };
}

function sourceResult(over: Partial<SourcePriceResult> = {}): SourcePriceResult {
  return {
    source: "danawa",
    status: "ok",
    fetchedAt: "2026-07-29T00:00:00.000Z",
    productName: "벤큐 MA320UP",
    modelName: null,
    overallLowest: {
      price: 990000,
      mall: "다나와(요약최저가)",
      url: "https://prod.danawa.com/info/?pcode=1",
    },
    ...over,
  };
}

test("가격비교 소스가 최저면 lowestUrl 은 그 소스의 페이지", () => {
  const { point } = normalize("2026-07-29", naver(), sourceResult());
  assert.equal(point.overallLowest, 990000);
  assert.equal(point.lowestUrl, "https://prod.danawa.com/info/?pcode=1");
  assert.equal(point.lowestMall, "다나와(요약최저가)");
  assert.equal(point.source, "danawa");
});

test("네이버가 최저면 lowestUrl 은 네이버 Top1 리스팅", () => {
  const chosen = sourceResult({
    overallLowest: { price: 1200000, mall: "다나와(요약최저가)", url: "https://prod.danawa.com/info/?pcode=1" },
  });
  const { point } = normalize("2026-07-29", naver(), chosen);
  assert.equal(point.overallLowest, 1040000);
  assert.equal(point.lowestUrl, NAVER_TOP);
  assert.equal(point.lowestMall, "네이버");
});

test("채택된 소스가 없으면 네이버 단독 — 값과 링크 모두 네이버", () => {
  const { point } = normalize("2026-07-29", naver(), null);
  assert.equal(point.overallLowest, 1040000);
  assert.equal(point.lowestUrl, NAVER_TOP);
  assert.equal(point.source, null);
  assert.equal(point.danawaLowest, null);
});

test("소스가 url 없이 최저가만 주면 링크는 null(엉뚱한 페이지로 보내지 않는다)", () => {
  const chosen = sourceResult({
    overallLowest: { price: 990000, mall: "에누리최저가", url: null },
  });
  const { point } = normalize("2026-07-29", naver(), chosen);
  assert.equal(point.overallLowest, 990000);
  assert.equal(point.lowestUrl, null); // 네이버 Top1 로 대체하지 않는다
});

test("danawaLowest 레거시 컬럼은 실제 다나와 채택일 때만 채운다", () => {
  const viaDanawa = normalize("2026-07-29", naver(), sourceResult()).point;
  assert.equal(viaDanawa.danawaLowest, 990000);

  const viaEnuri = normalize(
    "2026-07-29",
    naver(),
    sourceResult({
      source: "enuri",
      overallLowest: { price: 990000, mall: "에누리최저가", url: "https://www.enuri.com/detail.jsp?modelno=1" },
    })
  ).point;
  assert.equal(viaEnuri.danawaLowest, null);
});

test("네이버 후보가 비어도 소스 가격·링크는 살아남는다", () => {
  const { point, listings } = normalize(
    "2026-07-29",
    naver({ naverLowest: null, candidates: [] }),
    sourceResult()
  );
  assert.equal(point.naverLowest, null);
  assert.equal(point.avgPrice, null);
  assert.equal(point.overallLowest, 990000);
  assert.equal(point.lowestUrl, "https://prod.danawa.com/info/?pcode=1");
  assert.deepEqual(listings, []);
});

test("동일 가격이면 네이버가 우선(먼저 평가) — 링크는 네이버", () => {
  const chosen = sourceResult({
    overallLowest: { price: 1040000, mall: "다나와(요약최저가)", url: "https://prod.danawa.com/info/?pcode=1" },
  });
  const { point } = normalize("2026-07-29", naver(), chosen);
  assert.equal(point.overallLowest, 1040000);
  assert.equal(point.lowestUrl, NAVER_TOP);
});
