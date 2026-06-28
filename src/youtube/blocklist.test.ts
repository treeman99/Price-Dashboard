import { test } from "node:test";
import assert from "node:assert/strict";
import { isChannelBlocked, channelKey } from "./blocklist.ts";
import type { BlockedChannel } from "../../shared/types.ts";

function entry(channel: string, handle: string | null): BlockedChannel {
  return { id: channelKey(channel, handle), channel, handle, blockedAt: "2026-01-01T00:00:00.000Z" };
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
