import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDanawaSource,
  detectMallListBlock,
  matchCandidates,
  parseCoupangRow,
  parseOverallLowest,
  parseProductPage,
  parseSearchCandidates,
} from "./danawa.ts";
import type { Fetcher, HttpResponse } from "./http.ts";
import type { SourceRef } from "./types.ts";

// ── 고정 HTML 픽스처 (실제 네트워크 호출 없이 파서 검증) ──

// 쿠팡=최저가 + 로켓. 네이버 행이 먼저 와서 '전역 첫 prc_c' 매칭의 함정을 만든다.
const MALL_LIST_COUPANG_LOWEST = `
<div id="lowPriceCompareArea"><table><tbody id="defaultMallList">
  <tr class="row"><td class="logo"><a href="/redirect/?cmpnyc=NV001&pcode=1"><img src="n.png" alt="네이버"></a></td>
    <td class="name"><a href="/redirect/?cmpnyc=NV001&pcode=1">네이버</a></td>
    <td class="price"><span class="price"><a href="#"><em class="prc_c">1,600,000</em></a></span></td></tr>
  <tr class="row"><td class="logo"><a href="/redirect/?cmpnyc=TP40F&pcode=1"><img src="c.png" alt="쿠팡"></a></td>
    <td class="name"><a href="/redirect/?cmpnyc=TP40F&pcode=1">쿠팡</a></td>
    <td class="price"><span class="price lowest"><a href="#"><em class="prc_c">1,571,700</em></a></span>
      <span class="delivery">로켓배송</span></td></tr>
  <tr class="row"><td class="logo"><a href="/redirect/?cmpnyc=GM999&pcode=1"><img src="g.png" alt="지마켓"></a></td>
    <td class="name"><a href="/redirect/?cmpnyc=GM999&pcode=1">지마켓</a></td>
    <td class="price"><span class="price"><a href="#"><em class="prc_c">1,650,000</em></a></span></td></tr>
</tbody></table></div>`;

// 네이버=최저가, 쿠팡은 더 비싸고 로켓 아님(무료배송)
const MALL_LIST_NAVER_LOWEST = `
<tbody id="defaultMallList">
  <tr><td class="logo"><a href="/r?cmpnyc=NV001"><img alt="네이버"></a></td>
    <td class="name"><a href="/r?cmpnyc=NV001">네이버</a></td>
    <td class="price"><span class="price lowest"><a href="#"><em class="prc_c">1,499,000</em></a></span></td></tr>
  <tr><td class="logo"><a href="/r?cmpnyc=TP40F"><img alt="쿠팡"></a></td>
    <td class="name"><a href="/r?cmpnyc=TP40F">쿠팡</a></td>
    <td class="price"><span class="price"><a href="#"><em class="prc_c">1,571,700</em></a></span>
      <span class="delivery">무료배송</span></td></tr>
</tbody>`;

// 쿠팡 미편입(TP40F 없음)
const MALL_LIST_NO_COUPANG = `
<tbody id="defaultMallList">
  <tr><td><a href="/r?cmpnyc=NV001"><img alt="네이버"></a><a href="/r?cmpnyc=NV001">네이버</a>
    <span class="price lowest"><em class="prc_c">1,499,000</em></span></td></tr>
  <tr><td><a href="/r?cmpnyc=GM999"><img alt="지마켓"></a><a href="/r?cmpnyc=GM999">지마켓</a>
    <em class="prc_c">1,520,000</em></td></tr>
</tbody>`;

const INFO_PAGE = `<!doctype html><html><head>
<meta property="og:title" content="로보락 S10 MaxV Ultra (정품)">
<title>로보락 - 다나와</title></head><body>
<script>var cate1='862'; var cate2='874'; var cate3='12366'; var cate4='0'; var productCode = '106736861';</script>
<div class="summary"><span class="price lowest"><em class="prc_c">1,571,700</em></span></div>
</body></html>`;

const SEARCH_PAGE = `<ul class="product_list">
  <li><a href="https://prod.danawa.com/info/?pcode=106736861&cate=123">로보락 S10 MaxV Ultra 화이트 (정품)</a></li>
  <li><a href="https://prod.danawa.com/info/?pcode=999&cate=123">로보락 S10 해외구매 직구</a></li>
  <li><a href="https://prod.danawa.com/info/?pcode=222&cate=123">샤오미 로봇청소기</a></li>
</ul>`;

function resp(body: string, status = 200): HttpResponse {
  return { status, ok: status === 200, body };
}

// ── 파서 단위테스트 ─────────────────────────────────────

test("parseCoupangRow: 쿠팡 행으로 스코프해 개별가/로켓 추출 (전역 첫 매치 금지)", () => {
  const r = parseCoupangRow(MALL_LIST_COUPANG_LOWEST);
  assert.ok(r);
  // 네이버(1,600,000)가 먼저 등장하지만 쿠팡 행 가격을 정확히 잡아야 함
  assert.equal(r!.price, 1571700);
  assert.equal(r!.isRocket, true);
  assert.match(r!.url ?? "", /cmpnyc=TP40F/);
});

test("parseCoupangRow: 로켓 아님(무료배송)일 때 isRocket=false, 가격은 쿠팡 행", () => {
  const r = parseCoupangRow(MALL_LIST_NAVER_LOWEST);
  assert.ok(r);
  assert.equal(r!.price, 1571700);
  assert.equal(r!.isRocket, false);
});

test("parseCoupangRow: 쿠팡 미편입이면 null", () => {
  assert.equal(parseCoupangRow(MALL_LIST_NO_COUPANG), null);
});

test("parseOverallLowest: 최저가 배지 행(쿠팡)을 전체 최저가로", () => {
  const r = parseOverallLowest(MALL_LIST_COUPANG_LOWEST);
  assert.ok(r);
  assert.equal(r!.price, 1571700);
  assert.equal(r!.mall, "쿠팡");
});

test("parseOverallLowest: 최저가 배지가 다른 몰이면 그 몰을 반환", () => {
  const r = parseOverallLowest(MALL_LIST_NAVER_LOWEST);
  assert.ok(r);
  assert.equal(r!.price, 1499000);
  assert.equal(r!.mall, "네이버");
});

test("parseProductPage: cate/productCode/요약최저가/상품명 추출(단순 픽스처)", () => {
  const p = parseProductPage(INFO_PAGE);
  assert.deepEqual(p.cate, { cate1: "862", cate2: "874", cate3: "12366", cate4: "0" });
  assert.equal(p.productCode, "106736861");
  assert.equal(p.summaryLowest, 1571700);
  assert.equal(p.productName, "로보락 S10 MaxV Ultra (정품)");
});

// 실제 다나와 HTML 픽스처: .lowest 컨테이너와 <em class="prc_c"> 사이에 배지/sell-price 영역이
// 200자를 초과해 끼어 있어 기존 정규식(거리 200자 제한)이 null을 반환하는 버그를 재현한다.
// data-base-price 속성을 1차 파서로, 2000자 창을 2차로 사용해야 올바른 값을 반환해야 한다.
const INFO_PAGE_REAL_HTML = `<!doctype html><html><head>
<meta property="og:title" content="로보락 S10 MaxV Ultra (화이트) (정품)">
<title>로보락 S10 MaxV Ultra - 다나와</title></head><body>
<script>var cate1='862'; var cate2='874'; var cate3='12366'; var cate4='0'; var productCode = '106736861';</script>
<div class="box__price lowest" data-base-price="1571700">
  <div class="box__sell-price">
    <span class="txt__sell-price">최저</span>
    <span class="badge_area">
      <span class="badge badge--red badge--square">최저가</span>
      <span class="badge badge--gray">가격비교</span>
      <span class="badge badge--blue">인증판매자</span>
    </span>
    <span class="price_list">
      <span class="txt__price-info">이 제품의 최저가는</span>
      <em class="prc_c">1,571,700</em>
      <em class="unit">원</em>
    </span>
    <a href="..." class="btn__buy">최저가 구매</a>
  </div>
</div>
</body></html>`;

// data-base-price 속성 사용(1차 파서): .lowest와 <em> 사이 거리 무관
test("parseProductPage: 실제 HTML(200자 초과 배지 영역) — data-base-price 1차 파서", () => {
  const p = parseProductPage(INFO_PAGE_REAL_HTML);
  assert.equal(p.summaryLowest, 1571700, "summaryLowest가 null이면 파서 버그");
  assert.equal(p.productName, "로보락 S10 MaxV Ultra (화이트) (정품)");
  assert.equal(p.cate.cate1, "862");
});

// 2차 파서(data-base-price 없음, 2000자 창 사용) 검증 — 배지 영역이 200~2000자 사이
const INFO_PAGE_NO_DATA_ATTR = `<!doctype html><html><head>
<meta property="og:title" content="DJI 오즈모 포켓4 (정품)">
<title>DJI 오즈모 - 다나와</title></head><body>
<script>var cate1='100'; var cate2='200'; var cate3='300'; var cate4='0'; var productCode = '122628409';</script>
<div class="box__price lowest">
  <div class="box__sell-price">
    <span class="txt__sell-price">최저</span>
    <span class="badge_area">
      ${"<span class='badge'>배지내용</span>".repeat(15)}
    </span>
    <span class="price_list">
      <em class="prc_c">662,000</em>
      <em class="unit">원</em>
    </span>
  </div>
</div>
</body></html>`;

test("parseProductPage: data-base-price 없고 배지 영역 200자 초과 — 2000자 창 폴백 파서", () => {
  const p = parseProductPage(INFO_PAGE_NO_DATA_ATTR);
  // 배지 반복이 200자를 넘어야 기존 버그가 재현된다 — 실제로 넘는지 확인
  const distanceInHtml = INFO_PAGE_NO_DATA_ATTR.indexOf('<em class="prc_c">662,000</em>') -
    INFO_PAGE_NO_DATA_ATTR.indexOf('class="box__price lowest"');
  assert.ok(distanceInHtml > 200, `배지 영역이 ${distanceInHtml}자 — 픽스처 수정 필요`);
  assert.equal(p.summaryLowest, 662000, "summaryLowest가 null이면 2차 파서 버그");
});

test("parseSearchCandidates + matchCandidates: pcode 후보 해석 + 해외구매 제외 + mustInclude", () => {
  const cands = parseSearchCandidates(SEARCH_PAGE);
  assert.equal(cands.length, 3);
  const matched = matchCandidates(cands, {
    mustInclude: [["로보락", "Roborock"], ["S10"]],
    mustExclude: [],
  });
  assert.equal(matched.length, 1);
  assert.equal(matched[0].pcode, "106736861");
});

// ── 차단 감지 분기 ──────────────────────────────────────

test("detectMallListBlock: 정상 응답은 ok", () => {
  assert.equal(detectMallListBlock(resp(MALL_LIST_COUPANG_LOWEST)), "ok");
});

test("detectMallListBlock: HTTP 403 → blocked", () => {
  assert.equal(detectMallListBlock(resp("forbidden access denied page body padding............", 403)), "blocked");
});

test("detectMallListBlock: 캡차/보안문자 키워드 → blocked", () => {
  assert.equal(
    detectMallListBlock(resp("<html><body>보안문자를 입력하세요. 비정상적인 접근이 감지되었습니다. 패딩패딩패딩</body></html>")),
    "blocked"
  );
});

test("detectMallListBlock: 기대 셀렉터(defaultMallList)·cmpnyc 부재 → blocked", () => {
  assert.equal(
    detectMallListBlock(resp("<html><body>정상 200 이지만 몰리스트 컨테이너가 전혀 없는 응답입니다. 패딩 패딩 패딩 패딩</body></html>")),
    "blocked"
  );
});

// ── fetch() 통합(주입 fetcher) ──────────────────────────

function fakeFetcher(map: Array<{ prefix: string; res: HttpResponse }>, counter?: { n: number }): Fetcher {
  return async (url) => {
    if (counter) counter.n++;
    for (const { prefix, res } of map) if (url.startsWith(prefix)) return res;
    return resp("", 404);
  };
}

const REF: SourceRef = {
  source: "danawa",
  refId: "106736861",
  url: "https://prod.danawa.com/info/?pcode=106736861",
};

const noSleep = async () => {};

test("fetch: info→ajax 성공 시 status ok + 쿠팡가/로켓/전체최저가", async () => {
  const src = createDanawaSource({
    ajaxEnabled: true,
    sleep: noSleep,
    fetcher: fakeFetcher([
      { prefix: "https://prod.danawa.com/info/ajax/", res: resp(MALL_LIST_COUPANG_LOWEST) },
      { prefix: "https://prod.danawa.com/info/?pcode=", res: resp(INFO_PAGE) },
    ]),
  });
  const r = await src.fetch(REF);
  assert.equal(r.status, "ok");
  assert.equal(r.coupang?.price, 1571700);
  assert.equal(r.coupang?.isRocket, true);
  assert.equal(r.overallLowest?.price, 1571700);
  assert.equal(r.productName, "로보락 S10 MaxV Ultra (정품)");
});

test("fetch: 쿠팡 미편입이지만 전체최저가 있으면 ok + coupang null", async () => {
  const src = createDanawaSource({
    ajaxEnabled: true,
    sleep: noSleep,
    fetcher: fakeFetcher([
      { prefix: "https://prod.danawa.com/info/ajax/", res: resp(MALL_LIST_NO_COUPANG) },
      { prefix: "https://prod.danawa.com/info/?pcode=", res: resp(INFO_PAGE) },
    ]),
  });
  const r = await src.fetch(REF);
  assert.equal(r.status, "ok");
  assert.equal(r.coupang, null);
  assert.equal(r.overallLowest?.mall, "네이버");
});

test("fetch: info 페이지 차단(403) → blocked + 당일 백오프(이후 네트워크 호출 안 함)", async () => {
  const counter = { n: 0 };
  const src = createDanawaSource({
    ajaxEnabled: true,
    sleep: noSleep,
    today: () => "2026-06-27",
    fetcher: fakeFetcher(
      [{ prefix: "https://prod.danawa.com/info/?pcode=", res: resp("blocked forbidden body padding..............", 403) }],
      counter
    ),
  });
  const r1 = await src.fetch(REF);
  assert.equal(r1.status, "blocked");
  const callsAfterFirst = counter.n;
  const r2 = await src.fetch(REF);
  assert.equal(r2.status, "blocked");
  // 당일 백오프: 두 번째 fetch 는 네트워크를 때리지 않아야 한다
  assert.equal(counter.n, callsAfterFirst);
});

test("fetch: ajax 비활성(데이터센터 가드) → SSR 요약 최저가만으로 ok", async () => {
  const counter = { n: 0 };
  const src = createDanawaSource({
    ajaxEnabled: false,
    sleep: noSleep,
    fetcher: fakeFetcher(
      [{ prefix: "https://prod.danawa.com/info/?pcode=", res: resp(INFO_PAGE) }],
      counter
    ),
  });
  const r = await src.fetch(REF);
  assert.equal(r.status, "ok");
  assert.equal(r.coupang, null);
  assert.equal(r.overallLowest?.price, 1571700);
  assert.match(r.overallLowest?.mall ?? "", /요약/);
  // info 1회만 호출, ajax 호출 없음
  assert.equal(counter.n, 1);
});

test("fetch: refId(pcode) 없으면 parse-error", async () => {
  const src = createDanawaSource({ ajaxEnabled: true, sleep: noSleep, fetcher: fakeFetcher([]) });
  const r = await src.fetch({ source: "danawa", refId: null, url: "x" });
  assert.equal(r.status, "parse-error");
});
