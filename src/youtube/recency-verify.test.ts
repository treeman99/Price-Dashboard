// 유튜브 조사 기간 재검증(2026-11-23): watch 페이지의 실제 업로드 **시각**으로 실행 시점 기준 최근 N시간을 판정한다.
// 모델 호출·네트워크는 모두 스텁이다(실제 유튜브·LLM 호출 없음).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-yt-recency-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");
fs.writeFileSync(
  path.join(tmpDir, "youtube-categories.json"),
  JSON.stringify([{ key: "t1", label: "테스트", emoji: "🧪", color: "#000000", region: "global" }])
);

const { __setAgentQueryDepsForTest } = await import("../util/agent-query.ts");
const { curateYoutube } = await import("./curate.ts");
const { extractUploadIso } = await import("./oembed.ts");
const { parseRssEntries } = await import("./channels.ts");
const { localDate } = await import("../util/date.ts");
const { toLocalIso, windowEndingAt } = await import("../util/recency.ts");

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("watch 페이지: 시각이 있는 업로드 값을 먼저 쓴다(날짜만인 itemprop 보다 uploadDate 의 시각)", () => {
  const html = `<meta itemprop="datePublished" content="2026-11-22"><script>{"uploadDate":"2026-11-22T05:00:12-08:00"}</script>`;
  assert.equal(extractUploadIso(html), "2026-11-22T05:00:12-08:00");
  assert.equal(extractUploadIso(`<meta itemprop="datePublished" content="2026-11-22">`), "2026-11-22");
});

test("RSS: 게시 시각(로컬 오프셋 ISO)을 날짜와 함께 남긴다", () => {
  const xml = `<feed><entry><yt:videoId>abcdefghijk</yt:videoId><yt:channelId>UCxxxxxxxxxxxxxxxxxxxxxx</yt:channelId><title>t</title><author><name>c</name></author><published>2026-11-22T23:30:00+00:00</published></entry></feed>`;
  const [v] = parseRssEntries(xml);
  assert.equal(v.publishedAt, "2026-11-23T08:30:00+09:00");
  assert.equal(v.date, "2026-11-23");
});

test("재검증: 실제 업로드 시각으로 구간 판정, watch 를 못 받으면 LLM 시각은 믿지 않고 날짜만으로 보수적으로", async () => {
  const now = new Date();
  const w = windowEndingAt(now, 24);
  const iso = (msAgo: number) => toLocalIso(new Date(now.getTime() - msAgo));
  const today = localDate(now);
  const yesterday = localDate(new Date(now.getTime() - 24 * 3_600_000));
  const H = 3_600_000;
  // 11자 영상 ID
  const A = "AAAAAAAAAA1"; // watch: 2시간 전 → 통과(시각 확인)
  const B = "BBBBBBBBBB2"; // watch: 30시간 전 → 드롭(LLM 은 오늘이라고 함)
  const C = "CCCCCCCCCC3"; // watch 실패 + LLM 날짜 오늘 → 날짜만으로 통과(시각 미확인)
  const D = "DDDDDDDDDD4"; // watch 실패 + LLM 날짜 어제(LLM 시각은 구간 안이라고 주장) → 드롭
  const watch: Record<string, string | null> = { [A]: iso(2 * H), [B]: iso(30 * H), [C]: null, [D]: null };

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/oembed")) {
      return new Response(JSON.stringify({ title: "t", author_name: "채널", author_url: "https://www.youtube.com/@chan" }), { status: 200 });
    }
    if (url.includes("/shorts/")) return new Response(null, { status: 303 });
    const id = /v=([A-Za-z0-9_-]{11})/.exec(url)?.[1];
    if (id && id in watch) {
      const at = watch[id];
      return at ? new Response(`<script>{"uploadDate":"${at}"}</script>`, { status: 200 }) : new Response("", { status: 500 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  const vid = (id: string, date: string, publishedAt: string | null) => ({
    title: `영상 ${id[0]}`,
    channel: "채널",
    date,
    publishedAt,
    summary: "s",
    url: `https://www.youtube.com/watch?v=${id}`,
  });
  let curationPrompt = "";
  const reply = async (prompt: string, _o: unknown, _t: number, label: string) => {
    if (label.includes("채널 발굴")) return '{"channels":{}}';
    curationPrompt = prompt;
    return JSON.stringify({
      categories: {
        t1: [vid(A, yesterday, null), vid(B, today, iso(1 * H)), vid(C, today, iso(1 * H)), vid(D, yesterday, iso(1 * H))],
      },
    });
  };
  const restore = __setAgentQueryDepsForTest({ runClaude: reply, runCodex: reply, recordFallback: () => false, clearFallback: () => false });
  let snap;
  try {
    snap = await curateYoutube(today, { window: w });
  } finally {
    restore();
    globalThis.fetch = origFetch;
  }
  assert.match(curationPrompt, /실행 시점 기준 최근 24시간 이내/);
  assert.match(curationPrompt, /업로드 \*\*시각\*\*이/);
  const items = snap.categories[0].items;
  const byId = new Map(items.map((v) => [v.videoId, v]));
  assert.deepEqual([...byId.keys()].sort(), [A, C].sort(), "B(30시간 전)·D(어제 날짜, 시각 미검증)는 빠진다");
  assert.equal(byId.get(A)?.publishedAt, watch[A], "실제 업로드 시각으로 교체");
  assert.equal(byId.get(A)?.timeApprox, false);
  assert.equal(byId.get(C)?.timeApprox, true, "시각 미확인 표시");
  assert.equal(byId.get(C)?.publishedAt, null, "검증 못 한 LLM 시각은 쓰지 않는다");
  assert.equal(snap.freshHours, 24);
});
