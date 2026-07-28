import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDanawaSource,
  matchCandidates,
  parseProductPage,
  parseSearchCandidates,
} from "./danawa.ts";
import type { Fetcher, HttpResponse } from "./http.ts";
import type { SourceRef } from "./types.ts";

// ── 고정 HTML 픽스처 (실제 네트워크 호출 없이 파서 검증) ──

// 실제 라이브 다나와 info 페이지 앵커 라인을 그대로 사용 (2026-06 실측).
const INFO_PAGE = `<!doctype html><html><head>
<meta property="og:title" content="로보락 S10 MaxV Ultra (정품)">
<meta property="og:description" content="최저가 1,571,700원">
<title>로보락 - 다나와</title></head><body>
<script>var productCode = '106736861';</script>
<input type="hidden" id="min_price_106736861" value="1571700">
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

test("parseProductPage: productCode/요약최저가/상품명 추출(단순 픽스처)", () => {
  const p = parseProductPage(INFO_PAGE);
  assert.equal(p.productCode, "106736861");
  assert.equal(p.summaryLowest, 1571700);
  assert.equal(p.productName, "로보락 S10 MaxV Ultra (정품)");
});

// ── 실제 라이브 다나와 info 페이지 앵커(스파이크 실측, pcode 106736861) ──
// 라이브 페이지엔 data-base-price도 `box__price lowest`+prc_c도 없다. 요약 최저가는
// hidden input id="min_price_{pcode}" 와 og:description 에만 존재한다.
// (예전 합성 data-base-price 픽스처는 테스트 통과해도 라이브에선 null 이던 버그를 재현·고정한다.)
const INFO_PAGE_LIVE_ANCHORS = `<!doctype html><html><head>
<meta property="og:title" content="로보락 S10 MaxV Ultra (화이트)">
<meta property="og:description" content="최저가 1,571,700원"/>
<title>로보락 S10 MaxV Ultra (화이트) : 다나와 가격비교</title></head><body>
<script>var productCode = '106736861';</script>
<input type="hidden" id="min_price_106736861" value="1571700" />
<input type="hidden" id="strDeliveryFee" value="1,571,700원+무료배송" />
</body></html>`;

test("parseProductPage: 실제 라이브 앵커 — min_price hidden input 1차 (data-base-price/.lowest 부재)", () => {
  // 회귀 방지: 라이브 마크업엔 data-base-price 가 없어야 진짜 라이브 조건이다.
  assert.ok(!/data-base-price/.test(INFO_PAGE_LIVE_ANCHORS), "픽스처에 data-base-price 없어야 라이브 재현");
  assert.ok(!/box__price lowest/.test(INFO_PAGE_LIVE_ANCHORS), "픽스처에 .lowest+prc_c 없어야 라이브 재현");
  const p = parseProductPage(INFO_PAGE_LIVE_ANCHORS);
  assert.equal(p.summaryLowest, 1571700, "min_price 앵커로 못 잡으면 라이브 버그 재발");
  assert.equal(p.productCode, "106736861");
});

test("parseProductPage: min_price 없고 og:description만 있어도 요약최저가 추출(2차 앵커)", () => {
  const noMinPrice = INFO_PAGE_LIVE_ANCHORS.replace(/<input type="hidden" id="min_price_[^>]*>/, "");
  const p = parseProductPage(noMinPrice);
  assert.equal(p.summaryLowest, 1571700, "og:description 폴백 실패");
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

// ── fetch() 통합(주입 fetcher) ──────────────────────────

function fakeFetcher(
  map: Array<{ prefix: string; res: HttpResponse }>,
  seen?: { urls: string[] }
): Fetcher {
  return async (url) => {
    seen?.urls.push(url);
    for (const { prefix, res } of map) if (url.startsWith(prefix)) return res;
    return resp("", 404);
  };
}

const REF: SourceRef = {
  source: "danawa",
  refId: "106736861",
  url: "https://prod.danawa.com/info/?pcode=106736861",
};

test("fetch: info 페이지 SSR 요약최저가로 ok — 요청은 info 1회뿐(ajax 호출 없음)", async () => {
  const seen = { urls: [] as string[] };
  const src = createDanawaSource({
    fetcher: fakeFetcher([{ prefix: "https://prod.danawa.com/info/?pcode=", res: resp(INFO_PAGE) }], seen),
  });
  const r = await src.fetch(REF);
  assert.equal(r.status, "ok");
  assert.equal(r.overallLowest?.price, 1571700);
  assert.match(r.overallLowest?.mall ?? "", /요약/);
  assert.equal(r.productName, "로보락 S10 MaxV Ultra (정품)");
  assert.equal(seen.urls.length, 1);
});

// 쿠팡 수집 제거(2026-07-28)의 핵심 회귀 가드.
// robots 가 막은 /info/ajax/ 경로가 다시 들어오면 여기서 깨져야 한다.
test("fetch: robots 금지 경로(/info/ajax/)를 절대 호출하지 않는다", async () => {
  const seen = { urls: [] as string[] };
  const src = createDanawaSource({
    fetcher: fakeFetcher([{ prefix: "https://prod.danawa.com/info/?pcode=", res: resp(INFO_PAGE) }], seen),
  });
  await src.fetch(REF);
  assert.ok(
    seen.urls.every((u) => !u.includes("/info/ajax/")),
    `robots 금지 ajax 경로 호출됨: ${seen.urls.join(", ")}`
  );
});

test("fetch: 요약최저가를 못 잡으면 not-listed (상품명은 유지)", async () => {
  const noPrice = `<!doctype html><html><head>
<meta property="og:title" content="로보락 S10 MaxV Ultra (정품)">
<title>로보락 - 다나와</title></head><body>
<script>var productCode = '106736861';</script>
<p>가격 정보가 아직 없습니다. 패딩 패딩 패딩 패딩 패딩 패딩 패딩 패딩</p>
</body></html>`;
  const src = createDanawaSource({
    fetcher: fakeFetcher([{ prefix: "https://prod.danawa.com/info/?pcode=", res: resp(noPrice) }]),
  });
  const r = await src.fetch(REF);
  assert.equal(r.status, "not-listed");
  assert.equal(r.overallLowest, null);
  assert.equal(r.productName, "로보락 S10 MaxV Ultra (정품)");
});

test("fetch: info 페이지 차단(403) → blocked + 당일 백오프(이후 네트워크 호출 안 함)", async () => {
  const seen = { urls: [] as string[] };
  const src = createDanawaSource({
    today: () => "2026-06-27",
    fetcher: fakeFetcher(
      [{ prefix: "https://prod.danawa.com/info/?pcode=", res: resp("blocked forbidden body padding..............", 403) }],
      seen
    ),
  });
  const r1 = await src.fetch(REF);
  assert.equal(r1.status, "blocked");
  const callsAfterFirst = seen.urls.length;
  const r2 = await src.fetch(REF);
  assert.equal(r2.status, "blocked");
  // 당일 백오프: 두 번째 fetch 는 네트워크를 때리지 않아야 한다
  assert.equal(seen.urls.length, callsAfterFirst);
});

test("fetch: refId(pcode) 없으면 parse-error", async () => {
  const src = createDanawaSource({ fetcher: fakeFetcher([]) });
  const r = await src.fetch({ source: "danawa", refId: null, url: "x" });
  assert.equal(r.status, "parse-error");
});
