import { test } from "node:test";
import assert from "node:assert/strict";
import { isWatchedActive, pruneWatched } from "./watched.ts";
import type { WatchedVideo } from "../../shared/types.ts";

const DAY = 86400000;
const NOW = Date.parse("2026-07-11T00:00:00.000Z");
const at = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();

const list = (): WatchedVideo[] => [
  { videoId: "aaaaaaaaaaa", title: "오늘 체크", channel: "ch", watchedAt: at(0) },
  { videoId: "bbbbbbbbbbb", title: "6일 전 체크", channel: "ch", watchedAt: at(6) },
  { videoId: "ccccccccccc", title: "8일 전 체크(만료)", channel: "ch", watchedAt: at(8) },
];

test("제외 기간(7일) 이내면 활성, 초과면 비활성", () => {
  const l = list();
  assert.equal(isWatchedActive(l, "aaaaaaaaaaa", NOW, 7), true); // 0일 전
  assert.equal(isWatchedActive(l, "bbbbbbbbbbb", NOW, 7), true); // 6일 전
  assert.equal(isWatchedActive(l, "ccccccccccc", NOW, 7), false); // 8일 전 → 만료
});

test("목록에 없는 videoId / 빈 videoId 는 비활성", () => {
  assert.equal(isWatchedActive(list(), "zzzzzzzzzzz", NOW, 7), false);
  assert.equal(isWatchedActive(list(), null, NOW, 7), false);
  assert.equal(isWatchedActive(list(), "", NOW, 7), false);
});

test("경계: 정확히 7일 전은 아직 활성(>= cutoff)", () => {
  const l: WatchedVideo[] = [{ videoId: "ddddddddddd", title: "", channel: "", watchedAt: at(7) }];
  assert.equal(isWatchedActive(l, "ddddddddddd", NOW, 7), true);
});

test("pruneWatched 는 만료 항목만 제거한다", () => {
  const pruned = pruneWatched(list(), NOW, 7);
  const ids = pruned.map((w) => w.videoId).sort();
  assert.deepEqual(ids, ["aaaaaaaaaaa", "bbbbbbbbbbb"]);
});
