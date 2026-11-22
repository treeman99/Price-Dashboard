// 뉴스 사용자 규칙(2026-11-23): 취합 제외 사이트·재분류 학습이 **모델 프롬프트**와 **큐레이션 후처리**에 모두 들어가는지.
//
// ⚠️ DB_PATH 를 임시 디렉터리로 돌린 뒤 동적 import 한다(운영 data/ 를 건드리지 않게). 모델 호출은 스텁이다.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-news-rules-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");
fs.writeFileSync(
  path.join(tmpDir, "news-categories.json"),
  JSON.stringify([
    { key: "ai", label: "AI", emoji: "🤖", color: "#000" },
    { key: "sci", label: "과학", emoji: "⚛️", color: "#111" },
  ])
);

const excluded = await import("./excluded.ts");
const reclass = await import("./reclass.ts");
const { __setAgentQueryDepsForTest } = await import("../util/agent-query.ts");
const { curateNews } = await import("./curate.ts");
const { localDate } = await import("../util/date.ts");

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("도메인 정규화: URL·호스트를 받아 www./m. 를 떼고, 하위 도메인까지 매칭한다", () => {
  assert.equal(excluded.normalizeDomain("https://www.Example.com/a?b=1"), "example.com");
  assert.equal(excluded.normalizeDomain("m.news.example.co.kr"), "news.example.co.kr");
  assert.equal(excluded.normalizeDomain("not a domain"), null);
  const match = excluded.buildDomainMatcher([{ domain: "example.com", label: null, addedAt: "" }]);
  assert.equal(match("https://blog.example.com/x"), true);
  assert.equal(match("https://notexample.com/x"), false);
  assert.equal(match(null), false);
});

test("제외 사이트·재분류 기록이 프롬프트에 들어가고, 모델이 가져온 제외 사이트 기사는 후처리에서 빠진다", async () => {
  excluded.addExcludedDomain({ url: "https://www.spam.example/news/1", label: "스팸뉴스" });
  reclass.addNewsReclass({
    title: "양자 오류정정 신기록",
    channel: "과학일보",
    fromKey: "ai",
    fromLabel: "AI",
    toKey: "sci",
    toLabel: "과학",
    movedAt: "2026-11-23T00:00:00.000Z",
  });
  const today = localDate();
  let prompt = "";
  const reply = JSON.stringify({
    categories: {
      ai: [
        { title: "제외 사이트 기사", source: "스팸뉴스", date: today, summary: "s", link: "https://news.spam.example/a", related: [] },
        {
          title: "정상 기사",
          source: "정상",
          date: today,
          summary: "s",
          link: "https://ok.example/a",
          related: [
            { label: "스팸", link: "https://spam.example/b" },
            { label: "다른 곳", link: "https://other.example/c" },
          ],
        },
      ],
      sci: [],
    },
  });
  const stub = async (p: string) => {
    prompt = p;
    return reply;
  };
  const restore = __setAgentQueryDepsForTest({ runClaude: stub, runCodex: stub, recordFallback: () => false, clearFallback: () => false });
  let snap;
  try {
    snap = await curateNews(today, { geekNews: [] });
  } finally {
    restore();
  }
  // ① 프롬프트
  assert.match(prompt, /취합 제외 사이트/);
  assert.match(prompt, /spam\.example \(스팸뉴스\)/);
  assert.match(prompt, /사용자 재분류 규칙/);
  assert.match(prompt, /"양자 오류정정 신기록" \(과학일보\) 같은 기사 → 'AI'가 아니라 '과학'에 넣어라/);
  // ② 후처리 하드 필터(대표 링크·관련 출처 모두)
  const ai = snap.categories.find((c) => c.key === "ai")!;
  assert.deepEqual(ai.items.map((i) => i.title), ["정상 기사"]);
  assert.deepEqual(ai.items[0].related.map((r) => r.link), ["https://other.example/c"]);
});

test("제외 해제·중복 추가: 같은 도메인은 한 번만, 해제하면 프롬프트에서 빠진다", () => {
  const before = excluded.loadExcludedDomains().length;
  excluded.addExcludedDomain({ domain: "spam.example" });
  assert.equal(excluded.loadExcludedDomains().length, before, "이미 있으면 그대로");
  assert.equal(excluded.removeExcludedDomain("https://spam.example/x"), true);
  assert.doesNotMatch(excluded.excludedDomainsSection(), /spam\.example/);
  assert.throws(() => excluded.addExcludedDomain({ domain: "???" }), /올바르지 않습니다/);
});
