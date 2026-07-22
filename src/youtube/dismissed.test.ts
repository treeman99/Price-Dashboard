import { test } from "node:test";
import assert from "node:assert/strict";
import { isDismissed, pickDismissHints, rejectDismissed } from "./dismissed.ts";
import type { DismissedVideo, YoutubeSnapshot, YoutubeVideo } from "../../shared/types.ts";

const DAY = 86400000;
const NOW = Date.parse("2026-07-21T00:00:00.000Z");
const at = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();

function entry(videoId: string, daysAgo: number, reason: string | null = null): DismissedVideo {
  return {
    videoId,
    title: `제외 ${videoId}`,
    channel: "ch",
    url: `https://www.youtube.com/watch?v=${videoId}`,
    categoryKey: "ai",
    reason,
    dismissedAt: at(daysAgo),
  };
}

const list = (): DismissedVideo[] => [
  entry("aaaaaaaaaaa", 0),
  entry("bbbbbbbbbbb", 30),
  entry("ccccccccccc", 400, "쇼츠라서 싫음"),
];

// ── isDismissed ──────────────────────────────────────────────────────────────

test("제외 목록에 있으면 true — 아무리 오래돼도 만료되지 않는다(영구)", () => {
  const l = list();
  assert.equal(isDismissed(l, "aaaaaaaaaaa"), true); // 오늘 제외
  assert.equal(isDismissed(l, "ccccccccccc"), true); // 400일 전 제외해도 여전히 제외
});

test("목록에 없는 videoId / 빈 videoId 는 false", () => {
  assert.equal(isDismissed(list(), "zzzzzzzzzzz"), false);
  assert.equal(isDismissed(list(), null), false);
  assert.equal(isDismissed(list(), undefined), false);
  assert.equal(isDismissed(list(), ""), false);
});

test("빈 목록이면 무엇도 제외되지 않는다", () => {
  assert.equal(isDismissed([], "aaaaaaaaaaa"), false);
});

// ── pickDismissHints ─────────────────────────────────────────────────────────

test("사유 없는 항목끼리는 최근 제외 우선으로 정렬된다", () => {
  const hints = pickDismissHints([entry("bbbbbbbbbbb", 30), entry("aaaaaaaaaaa", 0)], 40);
  assert.deepEqual(
    hints.map((d) => d.videoId),
    ["aaaaaaaaaaa", "bbbbbbbbbbb"]
  );
});

test("사유가 있는 항목이 더 오래됐어도 앞선다(학습 신호가 더 강하므로)", () => {
  const hints = pickDismissHints(list(), 40);
  assert.equal(hints[0].videoId, "ccccccccccc"); // 400일 전이지만 사유 있음 → 최우선
  assert.deepEqual(
    hints.map((d) => d.videoId),
    ["ccccccccccc", "aaaaaaaaaaa", "bbbbbbbbbbb"]
  );
});

test("상한을 넘으면 잘리되, 사유 있는 항목은 살아남는다", () => {
  // 사유 없는 최신 항목 50건 + 사유 있는 아주 오래된 항목 1건
  const many: DismissedVideo[] = [];
  for (let i = 0; i < 50; i++) many.push(entry(`v${String(i).padStart(10, "0")}`, i));
  many.push(entry("ccccccccccc", 999, "쇼츠라서 싫음"));

  const hints = pickDismissHints(many, 40);
  assert.equal(hints.length, 40); // 상한 준수
  assert.equal(hints[0].videoId, "ccccccccccc"); // 사유 있는 항목이 잘려나가지 않음
});

test("상한이 0 이하면 빈 배열", () => {
  assert.deepEqual(pickDismissHints(list(), 0), []);
  assert.deepEqual(pickDismissHints(list(), -1), []);
});

test("원본 배열을 변형하지 않는다(정렬 부작용 방지)", () => {
  const l = list();
  const before = l.map((d) => d.videoId);
  pickDismissHints(l, 40);
  assert.deepEqual(
    l.map((d) => d.videoId),
    before
  );
});

test("dismissedAt 이 깨져 있어도 정렬이 무너지지 않고 목록에 포함된다", () => {
  const broken: DismissedVideo[] = [
    { ...entry("aaaaaaaaaaa", 0), dismissedAt: "깨진값" },
    entry("bbbbbbbbbbb", 10),
  ];
  const hints = pickDismissHints(broken, 40);
  assert.equal(hints.length, 2);
  assert.equal(hints[0].videoId, "bbbbbbbbbbb"); // 파싱 실패는 0(가장 오래됨)으로 취급
});

// ── rejectDismissed ──────────────────────────────────────────────────────────

function video(videoId: string | null): YoutubeVideo {
  return {
    title: `영상 ${videoId}`,
    channel: "ch",
    date: "2026-07-20",
    summary: "요약",
    url: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    thumbnail: null,
  };
}

function snapshot(): YoutubeSnapshot {
  return {
    date: "2026-07-21",
    updatedAt: "2026-07-21T00:00:00.000Z",
    source: "llm",
    freshDays: 7,
    categories: [
      {
        key: "ai",
        label: "AI · LLM",
        emoji: "🤖",
        color: "#000000",
        items: [video("aaaaaaaaaaa"), video("xxxxxxxxxxx")],
      },
      {
        key: "reviews",
        label: "리뷰",
        emoji: "📱",
        color: "#111111",
        items: [video("bbbbbbbbbbb")],
      },
    ],
    notes: null,
  };
}

test("제외된 영상은 카드에서 '제거'된다(플래그 주석이 아니라 하드 필터)", () => {
  const l = list();
  const out = rejectDismissed(snapshot(), (id) => isDismissed(l, id));
  assert.ok(out);
  assert.deepEqual(
    out.categories[0].items.map((v) => v.videoId),
    ["xxxxxxxxxxx"] // aaaaaaaaaaa 제거
  );
  assert.deepEqual(out.categories[1].items, []); // bbbbbbbbbbb 제거 → 빈 카테고리
});

test("카테고리 구조 자체는 보존된다(빈 카테고리도 사라지지 않음)", () => {
  const l = list();
  const out = rejectDismissed(snapshot(), (id) => isDismissed(l, id));
  assert.ok(out);
  assert.deepEqual(
    out.categories.map((c) => c.key),
    ["ai", "reviews"]
  );
});

test("videoId 가 null 인 영상은 제외 대상이 아니다(식별 불가 → 통과)", () => {
  const snap = snapshot();
  snap.categories[0].items = [video(null)];
  const out = rejectDismissed(snap, (id) => isDismissed(list(), id));
  assert.ok(out);
  assert.equal(out.categories[0].items.length, 1);
});

test("원본 스냅샷을 변형하지 않는다(사본 반환)", () => {
  const snap = snapshot();
  rejectDismissed(snap, (id) => isDismissed(list(), id));
  assert.equal(snap.categories[0].items.length, 2); // 원본 그대로
});

test("스냅샷이 null 이면 null 을 그대로 돌려준다", () => {
  assert.equal(rejectDismissed(null, () => true), null);
});
