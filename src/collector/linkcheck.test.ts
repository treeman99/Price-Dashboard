import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeadListing, isDeadPage, type FetchedPage, type PageFetcher } from "./linkcheck.ts";

// ── 실제 라이브 마크업 기반 픽스처(§verify-parsers-with-real-markup) ──
// 죽은 11번가 상품 페이지(게이트웨이가 meta-refresh 로 넘긴 최종 페이지). ≈200바이트, 본문은 alert 뿐.
const DEAD_11ST_PRODUCT = `<html>
<head>
    <title>11번가</title>
    <script type='text/javascript'>
        alert("죄송합니다. 판매가 중지된 상품이거나 잘못된 상품번호입니다.");
        history.back();
    </script>
</head>
<body>
</body>
</html>`;

// 죽은 11번가 게이트웨이(EUC-KR, 사망 문구 없음) → meta-refresh 로 /products/{id} 로 넘긴다.
const DEAD_11ST_GATEWAY = `<!DOCTYPE html><html lang="ko"><head><meta charset="euc-kr">
<meta http-equiv="refresh" content="0; url=https://www.11st.co.kr/products/9497821331?utm_source=x">
<title>11st move</title>
<script>function redirect(){document.location.replace("https://www.11st.co.kr/products/9497821331?utm_source=x");} redirect();</script>
</head><body></body></html>`;

// 살아있는 11번가 상품 페이지(실제 상품 제목 + 240KB). 본문에 "품절"이 연관영역으로 섞여 있다.
const LIVE_11ST = `<html><head><title>로보락 S10 MaxV Slim 로봇청소기 일반형 블랙</title></head>
<body><h1>로보락 S10 MaxV Slim</h1>${"상품 상세 설명 ".repeat(20000)}<div class="related">다른 상품 품절</div></body></html>`;

// 살아있는 cafe24(37degrees) 페이지 — 검증용 템플릿에 "존재하지 않는 상품/삭제된 상품/판매기간이 종료" 문구가 박혀 있다.
const LIVE_CAFE24 = `<html><head><title>인스타360 루나 울트라 카메라 표준번들</title></head>
<body><h1>인스타360 루나 울트라</h1>${"제품 설명 ".repeat(30000)}
<script>var msg={notFound:"존재하지 않는 상품입니다",deleted:"삭제된 상품입니다",expired:"판매기간이 종료되었습니다"};</script>
</body></html>`;

// 스마트스토어: 봇에게 로그인 페이지를 준다(사망 아님).
const SMARTSTORE_LOGIN = `<html><head><title>네이버 : 로그인</title></head><body>${"로그인 폼 ".repeat(500)}</body></html>`;
// 네이버 카탈로그: 418 차단(사망 아님).
const NAVER_BLOCKED = `<html><head><title>네이버쇼핑</title></head><body>${"blocked ".repeat(200)}</body></html>`;

function fetcherFor(map: Record<string, FetchedPage>): PageFetcher {
  return async (url) => {
    if (map[url]) return map[url];
    throw new Error(`unexpected url: ${url}`);
  };
}

test("isDeadPage: 죽은 11번가 상품 페이지(작은 인터스티셜)는 사망", () => {
  assert.equal(isDeadPage(DEAD_11ST_PRODUCT), true);
});

test("isDeadPage: 살아있는 11번가 페이지('품절' 포함, 대형)는 사망 아님", () => {
  assert.equal(isDeadPage(LIVE_11ST), false);
});

test("isDeadPage: cafe24 라이브 페이지(템플릿에 '존재하지 않/삭제된' 박힘)는 사망 아님", () => {
  assert.equal(isDeadPage(LIVE_CAFE24), false);
});

test("isDeadPage: 로그인 리다이렉트/차단 페이지는 사망 아님", () => {
  assert.equal(isDeadPage(SMARTSTORE_LOGIN), false);
  assert.equal(isDeadPage(NAVER_BLOCKED), false);
});

test("isDeadPage: 빈 문자열/사망문구 없음 → 사망 아님", () => {
  assert.equal(isDeadPage(""), false);
  assert.equal(isDeadPage("<html><body>정상</body></html>"), false);
});

test("isDeadListing: 게이트웨이(meta-refresh) → 죽은 상품 페이지까지 추적해 사망 판정", async () => {
  const gatewayUrl = "https://www.11st.co.kr/connect/Gateway.tmall?prdNo=9497821331";
  const productUrl = "https://www.11st.co.kr/products/9497821331?utm_source=x";
  const dead = await isDeadListing(gatewayUrl, {
    fetcher: fetcherFor({
      [gatewayUrl]: { status: 200, finalUrl: gatewayUrl, body: DEAD_11ST_GATEWAY },
      [productUrl]: { status: 200, finalUrl: productUrl, body: DEAD_11ST_PRODUCT },
    }),
  });
  assert.equal(dead, true);
});

test("isDeadListing: 살아있는 링크는 사망 아님", async () => {
  const url = "https://www.11st.co.kr/products/9290381794";
  const alive = await isDeadListing(url, {
    fetcher: fetcherFor({ [url]: { status: 200, finalUrl: url, body: LIVE_11ST } }),
  });
  assert.equal(alive, false);
});

test("isDeadListing: 차단(418)/로그인 리다이렉트는 fail-open(살아있음)", async () => {
  const naver = "https://search.shopping.naver.com/catalog/60027830124";
  const store = "https://smartstore.naver.com/main/products/13370763497";
  assert.equal(
    await isDeadListing(naver, {
      fetcher: fetcherFor({ [naver]: { status: 418, finalUrl: naver, body: NAVER_BLOCKED } }),
    }),
    false
  );
  assert.equal(
    await isDeadListing(store, {
      fetcher: fetcherFor({ [store]: { status: 200, finalUrl: store, body: SMARTSTORE_LOGIN } }),
    }),
    false
  );
});

test("isDeadListing: fetch 예외는 살아있음으로 흡수(fail-open)", async () => {
  const url = "https://example.com/x";
  const dead = await isDeadListing(url, {
    fetcher: async () => {
      throw new Error("네트워크 폭발");
    },
  });
  assert.equal(dead, false);
});
