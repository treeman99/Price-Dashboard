import { test } from "node:test";
import assert from "node:assert/strict";
import {
  YOUTUBE_THUMB_SIZES,
  entryVideoId,
  isYoutubeVideoId,
  nextThumbIndex,
  youtubeId,
  youtubeThumbCandidates,
  youtubeThumbUrl,
} from "./youtube-thumb.ts";

test("youtubeId: watch·youtu.be·shorts·embed·live 주소에서 11자 ID, 아니면 null", () => {
  assert.equal(youtubeId("https://www.youtube.com/watch?v=NSYrO2UG780&t=10"), "NSYrO2UG780");
  assert.equal(youtubeId("https://www.youtube.com/watch?feature=share&v=ldVMaeLgJSE"), "ldVMaeLgJSE");
  assert.equal(youtubeId("https://youtu.be/IoRV8nEj-2A"), "IoRV8nEj-2A");
  assert.equal(youtubeId("https://www.youtube.com/shorts/3hckzuyDPbo"), "3hckzuyDPbo");
  assert.equal(youtubeId("https://www.youtube.com/embed/0vDoLWz0noE"), "0vDoLWz0noE");
  assert.equal(youtubeId("https://www.youtube.com/live/CwJT-0h2L6A"), "CwJT-0h2L6A");
  assert.equal(youtubeId("https://www.youtube.com/@channel"), null);
  assert.equal(youtubeId(null), null);
});

test("entryVideoId: videoId → 항목 키(yt:<ID>) → 영상 URL 순 — 예전 실행(videoId 없음)도 ID 를 찾는다", () => {
  assert.equal(entryVideoId({ videoId: "NSYrO2UG780", key: "yt:ldVMaeLgJSE" }), "NSYrO2UG780");
  // 2026-11-22 실행처럼 report.json 에 videoId 가 없으면 키나 URL 에서.
  assert.equal(entryVideoId({ key: "yt:ldVMaeLgJSE", url: null }), "ldVMaeLgJSE");
  assert.equal(entryVideoId({ videoId: null, url: "https://www.youtube.com/watch?v=IoRV8nEj-2A" }), "IoRV8nEj-2A");
  // 형식이 틀린 videoId·키는 믿지 않고 다음 근거로.
  assert.equal(entryVideoId({ videoId: "bad", key: "yt:x", url: "https://youtu.be/3hckzuyDPbo" }), "3hckzuyDPbo");
  assert.equal(entryVideoId({ videoId: null, key: "https://news.example/a", url: "https://news.example/a" }), null);
});

test("youtubeThumbCandidates: hqdefault → mqdefault → default, 영상 ID 형식이 아니면 주소를 만들지 않는다", () => {
  assert.deepEqual(YOUTUBE_THUMB_SIZES, ["hqdefault", "mqdefault", "default"]);
  assert.deepEqual(youtubeThumbCandidates("NSYrO2UG780"), [
    "https://i.ytimg.com/vi/NSYrO2UG780/hqdefault.jpg",
    "https://i.ytimg.com/vi/NSYrO2UG780/mqdefault.jpg",
    "https://i.ytimg.com/vi/NSYrO2UG780/default.jpg",
  ]);
  assert.equal(youtubeThumbUrl("NSYrO2UG780"), "https://i.ytimg.com/vi/NSYrO2UG780/hqdefault.jpg");
  assert.equal(youtubeThumbUrl("NSYrO2UG780", "mqdefault"), "https://i.ytimg.com/vi/NSYrO2UG780/mqdefault.jpg");
  // LLM·RSS 값이라 주소·속성에 끼워 넣기 전에 형식만 통과시킨다.
  for (const bad of [null, undefined, "", "short", 'abc"><img/x', "../../x/yyyyy", "NSYrO2UG7801"]) {
    assert.equal(isYoutubeVideoId(bad), false, String(bad));
    assert.deepEqual(youtubeThumbCandidates(bad), []);
    assert.equal(youtubeThumbUrl(bad), null);
  }
});

test("nextThumbIndex: 로드 실패·120px 이하 자리표시면 다음 크기, 마지막(default 120×90)은 0px 일 때만 실패", () => {
  const total = 3;
  // 정상 hq(480×360)·mq(320×180) — 그대로.
  assert.equal(nextThumbIndex(0, total, { naturalWidth: 480 }), 0);
  assert.equal(nextThumbIndex(1, total, { naturalWidth: 320 }), 1);
  // 로드 실패 → 다음.
  assert.equal(nextThumbIndex(0, total, { error: true }), 1);
  assert.equal(nextThumbIndex(1, total, { error: true }), 2);
  // 섬네일 없는 영상: i.ytimg.com 이 404 + 120×90 회색 JPEG 를 주고 브라우저가 load 로 끝내는 경우 → 다음.
  assert.equal(nextThumbIndex(0, total, { naturalWidth: 120 }), 1);
  assert.equal(nextThumbIndex(1, total, { naturalWidth: 120 }), 2);
  // 마지막 default 는 원래 120×90 — 받은 그대로 쓴다. 실패·0px 이면 total(=자리표시).
  assert.equal(nextThumbIndex(2, total, { naturalWidth: 120 }), 2);
  assert.equal(nextThumbIndex(2, total, { naturalWidth: 0 }), 3);
  assert.equal(nextThumbIndex(2, total, { error: true }), 3);
});
