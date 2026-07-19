import { test } from "node:test";
import assert from "node:assert/strict";
import { isChannelBlocked, channelKey, blockId } from "./blocklist.ts";
import type { BlockedChannel } from "../../shared/types.ts";

function entry(channel: string, handle: string | null, categoryKey: string | null = null): BlockedChannel {
  return {
    id: blockId(channel, handle, categoryKey),
    channel,
    handle,
    categoryKey,
    blockedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("핸들로 차단하면 같은 채널의 핸들 없는 영상도 이름 폴백으로 잡는다(누수 방지)", () => {
  const list = [entry("MKBHD", "@mkbhd")];
  // 같은 채널인데 핸들이 들어온 영상
  assert.equal(isChannelBlocked(list, "MKBHD", "@mkbhd"), true);
  // 같은 채널인데 LLM이 핸들을 누락한 형제 영상 → 이름으로 폴백 차단
  assert.equal(isChannelBlocked(list, "MKBHD", null), true);
  assert.equal(isChannelBlocked(list, "mkbhd", undefined), true); // 대소문자 무시
});

test("둘 다 핸들이 있으면 핸들로만 판정 → 표시명이 같아도 다른 채널은 과차단 안 함", () => {
  const list = [entry("Tech", "@tech1")];
  assert.equal(isChannelBlocked(list, "Tech", "@tech2"), false); // 동명 다른 핸들 = 다른 채널
  assert.equal(isChannelBlocked(list, "Tech", "@tech1"), true);
});

test("이름으로 차단하면 핸들 유무와 무관하게 같은 채널을 잡는다", () => {
  const list = [entry("조코딩 JoCoding", null)];
  assert.equal(isChannelBlocked(list, "조코딩 JoCoding", null), true);
  assert.equal(isChannelBlocked(list, "조코딩 JoCoding", "@jocoding"), true); // 차단측 핸들 없음 → 이름 폴백
});

test("핸들 정규화: 앞쪽 @ 유무/공백/대소문자 무시", () => {
  const list = [entry("X", "mkbhd")]; // @ 없이 저장돼도
  assert.equal(isChannelBlocked(list, "anything", "@MKBHD"), true);
  assert.equal(isChannelBlocked(list, "anything", " @mkbhd "), true);
});

test("차단 목록에 없는 채널은 통과", () => {
  const list = [entry("MKBHD", "@mkbhd")];
  assert.equal(isChannelBlocked(list, "Linus Tech Tips", "@ltt"), false);
  assert.equal(isChannelBlocked(list, "Linus Tech Tips", null), false);
});

test("빈 목록이면 무엇도 차단되지 않는다", () => {
  assert.equal(isChannelBlocked([], "MKBHD", "@mkbhd"), false);
});

test("channelKey: 핸들 우선, 없으면 이름", () => {
  assert.equal(channelKey("MKBHD", "@mkbhd"), "@mkbhd");
  assert.equal(channelKey("MKBHD", null), "name:mkbhd");
  assert.equal(channelKey("  MKBHD  ", "  @MKBHD "), "@mkbhd"); // 정규화
});

test("카테고리별 차단: 차단된 카테고리에서만 잡히고 다른 카테고리는 통과", () => {
  const list = [entry("MKBHD", "@mkbhd", "reviews")]; // reviews 에서만 제외
  assert.equal(isChannelBlocked(list, "MKBHD", "@mkbhd", "reviews"), true); // 그 카테고리 → 차단
  assert.equal(isChannelBlocked(list, "MKBHD", "@mkbhd", "ai"), false); // 다른 카테고리 → 통과
  assert.equal(isChannelBlocked(list, "MKBHD", "@mkbhd"), false); // 카테고리 미지정 → 전역만 매칭(이건 전역 아님)
});

test("전역 차단(categoryKey=null)은 모든 카테고리에서 잡힌다(구버전 하위호환)", () => {
  const list = [entry("MKBHD", "@mkbhd", null)];
  assert.equal(isChannelBlocked(list, "MKBHD", "@mkbhd", "reviews"), true);
  assert.equal(isChannelBlocked(list, "MKBHD", "@mkbhd", "ai"), true);
  assert.equal(isChannelBlocked(list, "MKBHD", "@mkbhd"), true); // 카테고리 미지정도 전역은 매칭
});

test("같은 채널을 카테고리별로 각각 차단하면 두 카테고리 모두 잡힌다", () => {
  const list = [entry("Tech", "@tech1", "ai"), entry("Tech", "@tech1", "reviews")];
  assert.equal(isChannelBlocked(list, "Tech", "@tech1", "ai"), true);
  assert.equal(isChannelBlocked(list, "Tech", "@tech1", "reviews"), true);
  assert.equal(isChannelBlocked(list, "Tech", "@tech1", "game"), false);
});

test("blockId: 채널키::카테고리(전역은 *) — 카테고리별로 다른 id", () => {
  assert.equal(blockId("MKBHD", "@mkbhd", "reviews"), "@mkbhd::reviews");
  assert.equal(blockId("MKBHD", "@mkbhd", null), "@mkbhd::*");
  assert.equal(blockId("조코딩", null, "ai"), "name:조코딩::ai");
});
