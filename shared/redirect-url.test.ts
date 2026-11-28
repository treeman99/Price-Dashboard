import { test } from "node:test";
import assert from "node:assert/strict";
import { isRedirectUrl, linkSite, redirectKind, siteDomain, unwrapRedirectParam } from "./redirect-url.ts";

// 2026-11-28 보고서(runs/20261128T000000Z-8ae7)에 실제로 저장된 Gemini 검색 근거 주소.
const VERTEX =
  "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGQGIPDPMCXYqC-BSHLiuWIPXk24ZeXjxfiXAkXsUuJXgm5OTdtUamOC4jYAVhHPE1NcH9scV0rank8dzm6Ofhr_MeEG3BltsS4seykDiCWrBfwWrKom-yNX-h6qEF_AjeNv3HShyRzePXlP7ta6oVeX6kkZOfz9xShPMH8P8jwz7kVICMlE1qw8qBW2TXkhHtQ6S1lON6u-ySK0s2_TfKRyA8WvRYc2LoMPpESKT8x6IIRCEsMMgduxHIZo76Hdz2WrEsg3tysoR_hV0950uCY13E23jSezShh2mMxeHao41C__U4=";

test("경유 주소 판별: Gemini 검색 근거·Google·Bing·DuckDuckGo·Facebook·Google 뉴스·t.co", () => {
  assert.equal(redirectKind(VERTEX), "network");
  assert.equal(redirectKind("https://www.google.com/url?q=https://a.example/x&sa=U"), "param");
  assert.equal(redirectKind("https://google.co.kr/url?url=https://a.example/x"), "param");
  assert.equal(redirectKind("https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9hLmV4YW1wbGUveA&ntb=1"), "param");
  assert.equal(redirectKind("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Fx"), "param");
  assert.equal(redirectKind("https://l.facebook.com/l.php?u=https%3A%2F%2Fa.example%2Fx"), "param");
  assert.equal(redirectKind("https://news.google.com/rss/articles/CBMiXGh0dHBz?oc=5"), "network");
  assert.equal(redirectKind("https://t.co/AbCdEf"), "network");
  // 원래 사이트 주소는 경유 주소가 아니다(google 계열 일반 페이지 포함).
  for (const u of [
    "https://www.prnewswire.com/news-releases/x.html",
    "https://blog.google/technology/ai/x/",
    "https://www.google.com/search?q=x",
    "https://vertexaisearch.cloud.google.com/other",
    "https://finance.yahoo.com/news/x.html",
    "javascript:alert(1)",
    null,
  ]) {
    assert.equal(isRedirectUrl(u), false, String(u));
  }
});

test("파라미터 경유 주소는 네트워크 없이 원래 주소를 꺼낸다(http(s) 만)", () => {
  assert.equal(unwrapRedirectParam("https://www.google.com/url?q=https://a.example/x?y=1&sa=U"), "https://a.example/x?y=1");
  assert.equal(unwrapRedirectParam("https://www.google.com/url?url=https%3A%2F%2Fa.example%2Fx"), "https://a.example/x");
  assert.equal(unwrapRedirectParam("https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9hLmV4YW1wbGUveA&ntb=1"), "https://a.example/x");
  assert.equal(unwrapRedirectParam("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Fx"), "https://a.example/x");
  assert.equal(unwrapRedirectParam("https://l.facebook.com/l.php?u=https%3A%2F%2Fa.example%2Fx"), "https://a.example/x");
  assert.equal(unwrapRedirectParam("https://www.google.com/url?q=javascript:alert(1)"), null);
  assert.equal(unwrapRedirectParam(VERTEX), null, "network 종류는 파라미터로 못 푼다");
});

test("표시용 사이트: 원래 주소는 도메인, 경유 주소는 '확인 불가'(힌트 도메인이 있으면 함께)", () => {
  assert.equal(siteDomain("https://www.prnewswire.com/apac/x.html"), "prnewswire.com");
  assert.equal(siteDomain("https://m.news.example.co.kr/a"), "news.example.co.kr");
  assert.equal(siteDomain(VERTEX), null);
  assert.deepEqual(linkSite("https://www.bloomberg.com/news/a"), { domain: "bloomberg.com", unresolved: false });
  assert.deepEqual(linkSite(VERTEX), { domain: null, unresolved: true });
  assert.deepEqual(linkSite(VERTEX, "prnewswire.com"), { domain: "prnewswire.com", unresolved: true });
});
