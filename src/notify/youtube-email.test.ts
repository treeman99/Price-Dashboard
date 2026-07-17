import { test } from "node:test";
import assert from "node:assert/strict";
import { buildYoutubeEmailHtml, youtubeIMessageText } from "./youtube-email.ts";
import type { YoutubeSnapshot, YoutubeVideo, YoutubeCategory } from "../../shared/types.ts";

function video(over: Partial<YoutubeVideo> = {}): YoutubeVideo {
  return {
    title: "새 AI 도구 리뷰",
    channel: "MKBHD",
    channelHandle: "@mkbhd",
    date: "2026-07-16",
    summary: "도구의 실사용 후기를 다룬다.",
    url: "https://www.youtube.com/watch?v=abc123",
    videoId: "abc123",
    thumbnail: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
    views: "1.2M views",
    duration: "12:34",
    ...over,
  };
}

function category(over: Partial<YoutubeCategory> = {}): YoutubeCategory {
  return {
    key: "ai",
    label: "AI · LLM",
    emoji: "🤖",
    color: "#ff0000",
    items: [video()],
    ...over,
  } as YoutubeCategory;
}

function snapshot(over: Partial<YoutubeSnapshot> = {}): YoutubeSnapshot {
  return {
    date: "2026-07-17",
    updatedAt: "2026-07-17T08:00:00+09:00",
    source: "llm",
    freshDays: 7,
    categories: [category()],
    notes: null,
    ...over,
  };
}

// ── 기존 동작 고정 (안전망) ────────────────────────────────────

test("buildYoutubeEmailHtml: 헤더·카테고리·영상 정보가 렌더된다", () => {
  const html = buildYoutubeEmailHtml(snapshot());
  assert.ok(html.includes("▶ YouTube 소식"));
  assert.ok(html.includes("AI · LLM"));
  assert.ok(html.includes("새 AI 도구 리뷰"));
  assert.ok(html.includes("MKBHD"));
  assert.ok(html.includes("12:34"));
  assert.ok(html.includes("최근 7일 이내 영상"));
});

test("buildYoutubeEmailHtml: 빈 카테고리는 안내 문구", () => {
  const html = buildYoutubeEmailHtml(snapshot({ categories: [category({ items: [] })] }));
  assert.ok(html.includes("최근 새 영상이 없습니다."));
});

test("buildYoutubeEmailHtml: 정상 url 은 앵커·썸네일로 렌더된다", () => {
  const html = buildYoutubeEmailHtml(snapshot());
  assert.ok(html.includes(`<a href="https://www.youtube.com/watch?v=abc123"`));
  assert.ok(html.includes("▶ 영상 보기"));
  assert.ok(html.includes(`<img src="https://i.ytimg.com/vi/abc123/hqdefault.jpg"`));
});

test("buildYoutubeEmailHtml: thumbnail 이 null 이면 img 없이 본문만", () => {
  const html = buildYoutubeEmailHtml(snapshot({ categories: [category({ items: [video({ thumbnail: null })] })] }));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("▶ 영상 보기")); // 링크는 그대로
});

test("buildYoutubeEmailHtml: XSS — 제목·채널의 <script> 가 이스케이프된다", () => {
  const evil = '<script>alert("x")</script>';
  const html = buildYoutubeEmailHtml(
    snapshot({ categories: [category({ items: [video({ title: evil, channel: evil, summary: evil })] })] })
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

// ── safeHref 가드 ──────────────────────────────────────────────

test("buildYoutubeEmailHtml: XSS — javascript: url 은 앵커로 렌더하지 않는다", () => {
  const html = buildYoutubeEmailHtml(
    // eslint-disable-next-line no-script-url
    snapshot({ categories: [category({ items: [video({ url: "javascript:alert(1)", thumbnail: null })] })] })
  );
  assert.ok(!html.includes("javascript:"));
  assert.ok(!html.includes("▶ 영상 보기"));
  assert.ok(html.includes("새 AI 도구 리뷰")); // 카드 자체는 남는다
});

test("buildYoutubeEmailHtml: XSS — data: url 도 앵커로 렌더하지 않는다", () => {
  const html = buildYoutubeEmailHtml(
    snapshot({
      categories: [category({ items: [video({ url: "data:text/html,<script>alert(1)</script>", thumbnail: null })] })],
    })
  );
  assert.ok(!html.includes("data:text/html"));
  assert.ok(!html.includes("▶ 영상 보기"));
});

test("buildYoutubeEmailHtml: url 이 불안전하면 썸네일을 앵커로 감싸지 않는다", () => {
  const html = buildYoutubeEmailHtml(
    // eslint-disable-next-line no-script-url
    snapshot({ categories: [category({ items: [video({ url: "javascript:alert(1)" })] })] })
  );
  assert.ok(!html.includes("javascript:"));
  assert.ok(html.includes("<img src=")); // 썸네일(https)은 살아있되
  assert.ok(!html.includes("▶ 영상 보기")); // 앵커는 없다
});

test("buildYoutubeEmailHtml: XSS — data: 썸네일은 img 로 렌더하지 않는다", () => {
  const html = buildYoutubeEmailHtml(
    snapshot({
      categories: [category({ items: [video({ thumbnail: "data:text/html,<script>alert(1)</script>" })] })],
    })
  );
  assert.ok(!html.includes("data:text/html"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("▶ 영상 보기")); // url 은 정상이라 링크는 남는다
});

// ── youtubeIMessageText ────────────────────────────────────────

test("youtubeIMessageText: 총건수와 카테고리별 상위 제목", () => {
  const t = youtubeIMessageText(snapshot());
  assert.match(t, /📺 유튜브 소식 — 2026-07-17 \(총 1건\)/);
  assert.ok(t.includes("새 AI 도구 리뷰"));
});
