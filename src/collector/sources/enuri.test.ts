import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnuriSource, parseEnuriDetail, parseEnuriCandidates } from "./enuri.ts";
import type { Fetcher, HttpResponse } from "./http.ts";
import type { SourceRef } from "./types.ts";

// ── 실제 라이브 에누리 상세 앵커(2026-06 실측, modelno 142943178) ──
// 전체 최저가는 JSON-LD "lowPrice"(1차) / og:description "최저가 N원"(2차)에 노출.
// 쿠팡 개별가는 노출되지 않는다(광고/기획전만) → coupang=null.
const DETAIL_LD = `<!doctype html><html><head>
<meta property="og:title" content="로보락 S10 MaxV Ultra [화이트] - 에누리 가격비교">
<meta property="og:description" content="최저가 1,689,990원">
<script type="application/ld+json">
{"@type":"Product","name":"로보락 S10 MaxV Ultra","offers":{"@type":"AggregateOffer",
 "url":"https://www.enuri.com/detail.jsp?modelno=142943178","offerCount":29,
 "priceCurrency":"KRW","lowPrice":1689990,"highPrice":2994000}}
</script></head><body>본문</body></html>`;

// JSON-LD 없이 og:description 만 (2차 앵커 폴백)
const DETAIL_OG_ONLY = `<!doctype html><html><head>
<meta property="og:title" content="DJI 오즈모 포켓4 - 에누리 가격비교">
<meta property="og:description" content="최저가 662,000원 | DJI">
</head><body></body></html>`;

// 가격 앵커 없음
const DETAIL_NO_PRICE = `<!doctype html><html><head>
<meta property="og:title" content="단종 상품 - 에누리 가격비교">
</head><body>판매처 없음</body></html>`;

const SEARCH_PAGE = `<ul>
  <li><a href="https://www.enuri.com/detail.jsp?modelno=142943178&cate=05">로보락 S10 MaxV Ultra</a></li>
  <li><a href="https://www.enuri.com/detail.jsp?modelno=999&cate=05">로보락 액세서리</a></li>
</ul>`;

function resp(body: string, status = 200): HttpResponse {
  return { status, ok: status === 200, body };
}
/** 첫 호출부터 순서대로 응답을 반환하는 가짜 Fetcher(네트워크 호출 없음). */
function fakeFetcher(...responses: HttpResponse[]): Fetcher {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)];
}

const REF: SourceRef = {
  source: "enuri",
  refId: "142943178",
  url: "https://www.enuri.com/detail.jsp?modelno=142943178",
};

// ── 파서 ──────────────────────────────────────────────

test("parseEnuriDetail: JSON-LD lowPrice 1차 + 상품명(에누리 접미사 제거)", () => {
  const d = parseEnuriDetail(DETAIL_LD);
  assert.equal(d.overallLowest, 1689990);
  assert.equal(d.productName, "로보락 S10 MaxV Ultra [화이트]");
});

test("parseEnuriDetail: JSON-LD 없으면 og:description 2차 앵커", () => {
  const d = parseEnuriDetail(DETAIL_OG_ONLY);
  assert.equal(d.overallLowest, 662000);
  assert.equal(d.productName, "DJI 오즈모 포켓4");
});

test("parseEnuriDetail: 가격 앵커 없으면 overallLowest=null", () => {
  assert.equal(parseEnuriDetail(DETAIL_NO_PRICE).overallLowest, null);
});

test("parseEnuriCandidates: modelno 후보 추출(중복 제거)", () => {
  const c = parseEnuriCandidates(SEARCH_PAGE);
  assert.equal(c.length, 2);
  assert.equal(c[0].refId, "142943178");
  assert.match(c[0].url, /modelno=142943178/);
});

// ── fetch (주입 Fetcher) ──────────────────────────────

test("fetch: 상세 성공 → status ok + 전체최저가, 쿠팡은 항상 null(에누리 미노출)", async () => {
  const src = createEnuriSource({ fetcher: fakeFetcher(resp(DETAIL_LD)), now: () => "T" });
  const r = await src.fetch(REF);
  assert.equal(r.status, "ok");
  assert.equal(r.coupang, null, "에누리는 쿠팡 개별가 미노출 → 반드시 null");
  assert.deepEqual(r.overallLowest, {
    price: 1689990,
    mall: "에누리최저가",
    url: REF.url,
  });
  assert.equal(r.productName, "로보락 S10 MaxV Ultra [화이트]");
});

test("fetch: 상세 차단(403) → blocked", async () => {
  const src = createEnuriSource({ fetcher: fakeFetcher(resp("", 403)), now: () => "T" });
  const r = await src.fetch(REF);
  assert.equal(r.status, "blocked");
});

test("fetch: 가격 추출 실패 → not-listed (폴백 체인이 llm-websearch 로)", async () => {
  const src = createEnuriSource({ fetcher: fakeFetcher(resp(DETAIL_NO_PRICE)), now: () => "T" });
  const r = await src.fetch(REF);
  assert.equal(r.status, "not-listed");
  assert.equal(r.overallLowest, null);
});

test("resolve: 검색 → modelno SourceRef 후보", async () => {
  const src = createEnuriSource({ fetcher: fakeFetcher(resp(SEARCH_PAGE)), now: () => "T" });
  const refs = await src.resolve({ name: "로보락 S10 MaxV Ultra", mustInclude: [], minPrice: 0 });
  assert.equal(refs.length, 2);
  assert.equal(refs[0].source, "enuri");
  assert.equal(refs[0].refId, "142943178");
});
