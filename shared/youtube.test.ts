import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_WATCH_MIN_AWAY_MS, autoWatchedNotice, shouldAutoMarkWatched } from "./youtube.ts";

const T0 = 1_700_000_000_000;

test("shouldAutoMarkWatched: 충분히 오래 다녀오면 체크", () => {
  assert.equal(shouldAutoMarkWatched(T0, T0 + AUTO_WATCH_MIN_AWAY_MS, 1), true);
  assert.equal(shouldAutoMarkWatched(T0, T0 + 60_000, 3), true);
});

test("shouldAutoMarkWatched: 곧바로 돌아오면(오클릭) 체크 안 함", () => {
  assert.equal(shouldAutoMarkWatched(T0, T0 + 100, 1), false);
  assert.equal(shouldAutoMarkWatched(T0, T0 + AUTO_WATCH_MIN_AWAY_MS - 1, 1), false);
});

test("shouldAutoMarkWatched: 연 영상이 없거나 탭을 떠난 적 없으면 체크 안 함", () => {
  assert.equal(shouldAutoMarkWatched(T0, T0 + 60_000, 0), false);
  assert.equal(shouldAutoMarkWatched(null, T0 + 60_000, 1), false);
});

test("shouldAutoMarkWatched: 시각이 뒤집혀도(음수 이탈) 체크 안 함", () => {
  assert.equal(shouldAutoMarkWatched(T0, T0 - 60_000, 1), false);
  assert.equal(shouldAutoMarkWatched(T0, Number.NaN, 1), false);
});

test("autoWatchedNotice: 1건이면 제목, 여러 건이면 '외 N건'", () => {
  assert.equal(autoWatchedNotice(["새 모델 공개"]), "'새 모델 공개'을(를) 본영상으로 체크했어요");
  assert.equal(autoWatchedNotice(["A", "B", "C"]), "'A' 외 2건을 본영상으로 체크했어요");
  assert.equal(autoWatchedNotice([]), "");
});

test("autoWatchedNotice: 긴 제목은 잘라서 표시", () => {
  const long = "가".repeat(60);
  const msg = autoWatchedNotice([long]);
  assert.ok(msg.includes("…"));
  assert.ok(msg.length < long.length + 20);
});
