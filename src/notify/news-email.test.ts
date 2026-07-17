import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNewsEmailHtml, newsIMessageText } from "./news-email.ts";
import type { NewsSnapshot, NewsItem, NewsCategory } from "../../shared/types.ts";

function item(over: Partial<NewsItem> = {}): NewsItem {
  return {
    title: "AI 모델 공개",
    source: "TechCrunch",
    date: "2026-07-17",
    summary: "새 모델이 공개됐다.",
    link: "https://example.com/a",
    related: [],
    ...over,
  };
}

function category(over: Partial<NewsCategory> = {}): NewsCategory {
  return {
    key: "ai",
    label: "AI / LLM",
    emoji: "🤖",
    color: "#4361ee",
    items: [item()],
    ...over,
  } as NewsCategory;
}

function snapshot(over: Partial<NewsSnapshot> = {}): NewsSnapshot {
  return {
    date: "2026-07-17",
    updatedAt: "2026-07-17T08:00:00+09:00",
    source: "llm",
    categories: [category()],
    notes: null,
    ...over,
  };
}

// ── 기존 동작 고정 (안전망) ────────────────────────────────────

test("buildNewsEmailHtml: 헤더·날짜·카테고리·본문이 렌더된다", () => {
  const html = buildNewsEmailHtml(snapshot());
  assert.ok(html.includes("📰 Daily News Digest"));
  assert.ok(html.includes("2026-07-17"));
  assert.ok(html.includes("AI / LLM"));
  assert.ok(html.includes("AI 모델 공개"));
  assert.ok(html.includes("새 모델이 공개됐다."));
});

test("buildNewsEmailHtml: 빈 카테고리는 안내 문구", () => {
  const html = buildNewsEmailHtml(snapshot({ categories: [category({ items: [] })] }));
  assert.ok(html.includes("오늘은 해당 카테고리의 최신 뉴스가 없습니다."));
});

test("buildNewsEmailHtml: 카테고리 0개에서도 throw 없이 문자열", () => {
  const html = buildNewsEmailHtml(snapshot({ categories: [] }));
  assert.equal(typeof html, "string");
  assert.ok(html.includes("📰 Daily News Digest"));
});

test("buildNewsEmailHtml: link 가 null 이면 '원문 보기' 앵커가 없다", () => {
  const html = buildNewsEmailHtml(snapshot({ categories: [category({ items: [item({ link: null })] })] }));
  assert.ok(!html.includes("🔗 원문 보기"));
});

test("buildNewsEmailHtml: 정상 링크는 앵커로 렌더된다", () => {
  const html = buildNewsEmailHtml(snapshot());
  assert.ok(html.includes(`<a href="https://example.com/a"`));
  assert.ok(html.includes("🔗 원문 보기"));
});

test("buildNewsEmailHtml: XSS — 제목·요약의 <script> 가 이스케이프된다", () => {
  const evil = '<script>alert("x")</script>';
  const html = buildNewsEmailHtml(
    snapshot({ categories: [category({ items: [item({ title: evil, summary: evil, source: evil })] })] })
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

// ── safeHref 가드 ──────────────────────────────────────────────

test("buildNewsEmailHtml: XSS — javascript: 링크는 앵커로 렌더하지 않는다", () => {
  const html = buildNewsEmailHtml(
    // eslint-disable-next-line no-script-url
    snapshot({ categories: [category({ items: [item({ link: "javascript:alert(1)" })] })] })
  );
  assert.ok(!html.includes("javascript:"));
  assert.ok(!html.includes("🔗 원문 보기"));
});

test("buildNewsEmailHtml: XSS — data: 링크도 앵커로 렌더하지 않는다", () => {
  const html = buildNewsEmailHtml(
    snapshot({ categories: [category({ items: [item({ link: "data:text/html,<script>alert(1)</script>" })] })] })
  );
  assert.ok(!html.includes("data:text/html"));
  assert.ok(!html.includes("🔗 원문 보기"));
});

test("buildNewsEmailHtml: related 의 javascript: 링크는 앵커 없이 라벨만 남는다", () => {
  const html = buildNewsEmailHtml(
    snapshot({
      categories: [
        category({
          items: [
            item({
              link: null,
              // eslint-disable-next-line no-script-url
              related: [{ label: "Reuters", link: "javascript:alert(1)" }],
            }),
          ],
        }),
      ],
    })
  );
  assert.ok(!html.includes("javascript:"));
  // 라벨은 남되 앵커가 아니어야 한다 (푸터의 localhost 앵커는 별개라 문자열 전체가 아닌 해당 구간을 본다)
  assert.ok(html.includes("관련 출처: Reuters"));
  assert.ok(!html.includes(">Reuters</a>"));
});

test("buildNewsEmailHtml: related 의 정상 링크는 앵커로 렌더된다", () => {
  const html = buildNewsEmailHtml(
    snapshot({
      categories: [
        category({ items: [item({ related: [{ label: "Reuters", link: "https://reuters.com/x" }] })] }),
      ],
    })
  );
  assert.ok(html.includes(`<a href="https://reuters.com/x"`));
});

// ── newsIMessageText ───────────────────────────────────────────

test("newsIMessageText: 총건수와 카테고리별 상위 제목", () => {
  const t = newsIMessageText(snapshot());
  assert.match(t, /📰 뉴스 다이제스트 — 2026-07-17 \(총 1건\)/);
  assert.ok(t.includes("AI 모델 공개"));
});
