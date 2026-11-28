// 뉴스 큐레이션 직후 경유 주소 풀기(2026-11-28): Gemini 처럼 검색 근거 경유 주소로 온 링크가 조사 구간·제외 사이트 판정 전에
// 원래 주소로 바뀌는지, 못 풀면 링크를 지우지 않고 도메인 힌트로 제외 판정하는지.
//
// ⚠️ DB_PATH 를 임시 디렉터리로 돌린 뒤 동적 import 한다(운영 data/ 를 건드리지 않게). 모델 호출·네트워크는 스텁이다.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-news-resolve-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");
fs.writeFileSync(path.join(tmpDir, "news-categories.json"), JSON.stringify([{ key: "ai", label: "AI", emoji: "🤖", color: "#000" }]));

const excluded = await import("./excluded.ts");
const { __setAgentQueryDepsForTest } = await import("../util/agent-query.ts");
const { curateNews } = await import("./curate.ts");
const { localDate } = await import("../util/date.ts");
const { rememberRedirectHints, __clearRedirectHintsForTest } = await import("../util/redirect-resolve.ts");

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const V = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/";

test("모델이 가져온 경유 주소를 원래 주소로 바꾼 뒤 제외 사이트를 거르고, 못 푼 링크는 도메인 힌트로 판정한다", async () => {
  excluded.addExcludedDomain({ domain: "spam.example", label: "스팸" });
  __clearRedirectHintsForTest();
  // Gemini search_web 결과에 적혀 있던 [도메인](경유 주소) — 이 둘은 네트워크로 못 푼다.
  rememberRedirectHints(`[1] [bnnbloomberg.ca](${V}DEADBNN)\n[2] [spam.example](${V}DEADSPAM)`);
  const today = localDate();
  const reply = JSON.stringify({
    categories: {
      ai: [
        {
          title: "푸두 로보틱스 300% 성장",
          source: "PR Newswire",
          date: today,
          summary: "s",
          link: `${V}PUDU`,
          related: [
            { label: "BNN Bloomberg", link: `${V}DEADBNN` },
            { label: "스팸 재게시", link: `${V}SPAMOK` },
          ],
        },
        { title: "못 푼 스팸 기사", source: "스팸", date: today, summary: "s", link: `${V}DEADSPAM`, related: [] },
        { title: "힌트도 없는 기사", source: "어딘가", date: today, summary: "s", link: `${V}DEADNOHINT`, related: [] },
        {
          title: "Opus 가 준 google.com/url 링크",
          source: "The Verge",
          date: today,
          summary: "s",
          link: "https://www.google.com/url?sa=t&url=https%3A%2F%2Fwww.theverge.com%2Fx",
          related: [],
        },
      ],
    },
  });
  const stub = async () => reply;
  const restore = __setAgentQueryDepsForTest({ runClaude: stub, runCodex: stub, recordFallback: () => false, clearFallback: () => false });
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(`${init?.method} ${url}`);
    assert.ok(url.startsWith(V), `경유 주소에만 요청: ${url}`);
    const token = url.slice(V.length);
    const to: Record<string, string> = {
      PUDU: "https://www.prnewswire.com/apac/news-releases/pudu-302951721.html",
      SPAMOK: "https://news.spam.example/repost/1",
    };
    if (to[token]) return new Response(null, { status: 302, headers: { location: to[token] } });
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  let snap;
  try {
    snap = await curateNews(today, { geekNews: [] });
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
  const items = snap.categories.find((c) => c.key === "ai")!.items;
  assert.deepEqual(
    items.map((i) => i.title),
    ["푸두 로보틱스 300% 성장", "힌트도 없는 기사", "Opus 가 준 google.com/url 링크"],
    "못 푼 링크라도 힌트 도메인이 제외 사이트면 빠진다"
  );
  const [pudu, nohint, verge] = items;
  assert.equal(pudu.link, "https://www.prnewswire.com/apac/news-releases/pudu-302951721.html");
  assert.equal(pudu.sourceDomain, undefined);
  // 풀린 관련 출처가 제외 사이트면 빠지고, 못 푼 것은 링크 그대로 + 도메인 힌트
  assert.deepEqual(pudu.related, [{ label: "BNN Bloomberg", link: `${V}DEADBNN`, domain: "bnnbloomberg.ca" }]);
  assert.equal(nohint.link, `${V}DEADNOHINT`, "못 풀면 링크를 지우지 않는다");
  assert.equal(nohint.sourceDomain, null);
  assert.equal(verge.link, "https://www.theverge.com/x");
  assert.ok(!asked.some((a) => a.includes("google.com/url")), "파라미터 경유 주소는 요청하지 않는다");
});

test("제외 사이트: 경유 주소의 호스트(Google)는 제외하지 않고, 판정도 힌트 도메인으로만", () => {
  assert.throws(() => excluded.addExcludedDomain({ url: `${V}ABC`, label: "x" }), /경유 주소/);
  assert.throws(() => excluded.addExcludedDomain({ domain: "vertexaisearch.cloud.google.com" }), /경유 주소/);
  const m = excluded.buildDomainMatcher([{ domain: "google.com", label: null, addedAt: "" }]);
  assert.equal(m(`${V}ABC`), false, "google.com 을 제외해도 경유 주소 전부가 빠지지 않는다");
  assert.equal(m(`${V}ABC`, "blog.google.com"), true);
  assert.equal(m("https://news.google.com/x"), true);
});
