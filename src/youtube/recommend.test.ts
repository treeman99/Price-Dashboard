import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNKNOWN_CHANNEL,
  recommendedChannelValue,
  isRecommendedChannel,
  addRecommendedChannel,
  removeRecommendedChannel,
} from "../../shared/youtube.ts";

test("recommendedChannelValue: 이름+핸들 → '이름 (@핸들)', 한쪽만 있으면 그 값, 둘 다 없으면 null", () => {
  assert.equal(recommendedChannelValue("테크몽 Techmong", "@techmong"), "테크몽 Techmong (@techmong)");
  assert.equal(recommendedChannelValue("테크몽", "TechMong"), "테크몽 (@techmong)"); // 핸들 @ 없어도 정규화
  assert.equal(recommendedChannelValue(UNKNOWN_CHANNEL, "@techmong"), "@techmong");
  assert.equal(recommendedChannelValue("곽튜브", null), "곽튜브");
  assert.equal(recommendedChannelValue("", null), null);
  assert.equal(recommendedChannelValue(UNKNOWN_CHANNEL, "  "), null);
});

test("recommendedChannelValue: 콤마 포함 채널명은 소독(콤마 구분 편집 UI·프롬프트와 충돌 방지)", () => {
  assert.equal(recommendedChannelValue("발명, 붕어빵", null), "발명 붕어빵");
  assert.equal(recommendedChannelValue("Kim, Coder", "@kimcoder"), "Kim Coder (@kimcoder)");
});

test("isRecommendedChannel: 이름/핸들 어느 쪽이든 대소문자·@·공백 무시 매칭 (수기 항목 호환)", () => {
  const list = ["ITSub잇섭", "@techmong", "Two  Minute Papers"];
  assert.equal(isRecommendedChannel(list, "ITSub잇섭", null), true);
  assert.equal(isRecommendedChannel(list, "itsub잇섭", null), true); // 대소문자 무시
  assert.equal(isRecommendedChannel(list, "테크몽", "@TechMong"), true); // 핸들 매칭
  assert.equal(isRecommendedChannel(list, "테크몽", "techmong"), true); // 카드 핸들에 @ 없어도 매칭
  assert.equal(isRecommendedChannel(list, "Two Minute Papers", null), true); // 연속 공백 정규화
  assert.equal(isRecommendedChannel(["techmong"], null, "@techmong"), true); // 수기 이름 항목 ↔ 카드 핸들
  assert.equal(isRecommendedChannel(list, "다른채널", "@other"), false);
  assert.equal(isRecommendedChannel([], "ITSub잇섭", null), false);
  assert.equal(isRecommendedChannel(undefined, "ITSub잇섭", null), false);
});

test("isRecommendedChannel: '이름 (@핸들)' 결합 항목은 이름이 바뀌어도 핸들로 매칭(개명·oEmbed 실패 대비)", () => {
  const list = ["테크몽 (@techmong)"];
  assert.equal(isRecommendedChannel(list, "테크몽 Techmong", "@techmong"), true); // 이름 드리프트
  assert.equal(isRecommendedChannel(list, "테크몽", null), true); // 이름만으로도 매칭
  assert.equal(isRecommendedChannel(list, "완전히다른이름", "@techmong"), true); // 개명 후에도 핸들 매칭
  assert.equal(isRecommendedChannel(list, "테크몽", "@other"), true); // 이름이 같으면 핸들 달라도 이름 매칭(수기 항목과 동일 규칙)
  assert.equal(isRecommendedChannel(list, "무관한이름", "@other"), false);
});

test("isRecommendedChannel: 채널 미상은 이름 매칭에서 제외(핸들로만 매칭)", () => {
  const list = [UNKNOWN_CHANNEL];
  // 목록에 '(채널 미상)'이 있어도 미상 카드가 전부 '추천됨'으로 매칭되면 안 된다.
  assert.equal(isRecommendedChannel(list, UNKNOWN_CHANNEL, null), false);
  assert.equal(isRecommendedChannel(["@abc"], UNKNOWN_CHANNEL, "@abc"), true);
});

test("addRecommendedChannel: 중복이면 그대로, 아니면 뒤에 추가, 식별 불가면 null", () => {
  assert.deepEqual(addRecommendedChannel(["곽튜브"], "빠니보틀", "@paniboy"), [
    "곽튜브",
    "빠니보틀 (@paniboy)",
  ]);
  assert.deepEqual(addRecommendedChannel(["곽튜브"], "곽튜브", null), ["곽튜브"]); // 중복 방지
  assert.deepEqual(addRecommendedChannel(["@paniboy"], "빠니보틀", "PaniBoy"), ["@paniboy"]); // 핸들로 중복 감지
  assert.deepEqual(addRecommendedChannel(undefined, "곽튜브", null), ["곽튜브"]);
  assert.equal(addRecommendedChannel([], UNKNOWN_CHANNEL, null), null);
});

test("addRecommendedChannel: 이름 드리프트 시 재추가해도 중복 등록되지 않음", () => {
  const list = ["테크몽 (@techmong)"];
  // 같은 채널이 다른 표기(oEmbed 실패·개명)로 와도 핸들로 중복을 감지한다.
  assert.deepEqual(addRecommendedChannel(list, "테크몽 Techmong", "@techmong"), list);
});

test("removeRecommendedChannel: 이름/핸들 매칭 항목만 제거, 식별자 없으면 no-op", () => {
  assert.deepEqual(removeRecommendedChannel(["곽튜브", "@paniboy"], "빠니보틀", "@PaniBoy"), ["곽튜브"]);
  assert.deepEqual(removeRecommendedChannel(["곽튜브", "빠니 보틀"], "빠니 보틀", null), ["곽튜브"]);
  assert.deepEqual(removeRecommendedChannel(["곽튜브"], "없는채널", null), ["곽튜브"]);
  assert.deepEqual(removeRecommendedChannel(["곽튜브"], null, null), ["곽튜브"]); // 식별자 전무 → 그대로
  assert.deepEqual(removeRecommendedChannel(undefined, "곽튜브", null), []);
});

test("add→remove 왕복: 채널명 표기가 바뀌어도 핸들로 제거되어 잔존 항목이 없다", () => {
  const base = ["ITSub잇섭"];
  const added = addRecommendedChannel(base, "테크몽", "@techmong");
  assert.deepEqual(added, ["ITSub잇섭", "테크몽 (@techmong)"]);
  // 다음 수집에서 채널명이 "테크몽 Techmong"으로 바뀐 카드에서 해제해도 깨끗이 제거.
  assert.deepEqual(removeRecommendedChannel(added!, "테크몽 Techmong", "@techmong"), base);
});

test("콤마 채널명 왕복: 소독된 저장값이 원본 카드와 매칭된다", () => {
  const added = addRecommendedChannel([], "발명, 붕어빵", null);
  assert.deepEqual(added, ["발명 붕어빵"]);
  assert.equal(isRecommendedChannel(added!, "발명, 붕어빵", null), true);
  assert.deepEqual(removeRecommendedChannel(added!, "발명, 붕어빵", null), []);
});
