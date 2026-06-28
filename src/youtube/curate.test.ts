import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, extractVideoId, matchesExclude } from "./curate.ts";
import { parseHandle } from "./oembed.ts";
import type { YoutubeCategoryDef } from "../../shared/types.ts";

const defs: YoutubeCategoryDef[] = [
  { key: "ai", label: "AI · LLM", emoji: "🤖", color: "#000", region: "global" },
  { key: "reviews", label: "신제품 리뷰", emoji: "🆕", color: "#000", region: "kr" },
  { key: "game", label: "게임", emoji: "🎮", color: "#000" }, // region 미지정 → kr 취급
];

test("buildPrompt: global 카테고리는 해외 가능, 그 외/미지정은 한국 전용 명시", () => {
  const p = buildPrompt(defs, "2026-06-28", "2026-06-21", 7, "2026-06-28 12:00", []);
  assert.match(p, /AI · LLM \(key: "ai"\) \[검색범위: 해외\(영어 포함\) 가능\]/);
  assert.match(p, /신제품 리뷰 \(key: "reviews"\) \[검색범위: 한국 채널·한국어 영상만\]/);
  assert.match(p, /게임 \(key: "game"\) \[검색범위: 한국 채널·한국어 영상만\]/);
  // 검색범위 준수 규칙 블록 포함
  assert.match(p, /검색 범위.*반드시 준수/s);
});

test("buildPrompt: 차단 채널이 있으면 제외 섹션 포함", () => {
  const p = buildPrompt(defs, "2026-06-28", "2026-06-21", 7, "2026-06-28 12:00", ["나쁜채널 (@bad)"]);
  assert.match(p, /제외 채널/);
  assert.match(p, /나쁜채널 \(@bad\)/);
});

test("matchesExclude: 제목/채널/원제에 제외 키워드 포함 시 true(대소문자 무시)", () => {
  const kw = ["자동차", "SUV", "모빌리티"];
  assert.equal(matchesExclude({ title: "현대 투싼 vs 기아 스포티지 SUV 비교", channel: "스튜디오ㅋㅇㅋ" }, kw), true);
  assert.equal(matchesExclude({ title: "신형 아반떼 리뷰", channel: "mediaAUTO", originalTitle: "부산모빌리티쇼 CN8" }, kw), true);
  assert.equal(matchesExclude({ title: "갤럭시 Z플립8 유출 총정리", channel: "케통령" }, kw), false);
  assert.equal(matchesExclude({ title: "아이폰 리뷰", channel: "잇섭" }, []), false); // 키워드 없으면 제외 안 함
  assert.equal(matchesExclude({ title: "테슬라 오토파일럿", channel: "ch" }, ["테슬라"]), true);
});

test("parseHandle: author_url에서 @handle 추출", () => {
  assert.equal(parseHandle("https://www.youtube.com/@KTpresident"), "@KTpresident");
  assert.equal(parseHandle("https://www.youtube.com/@media.AUTO_1"), "@media.AUTO_1");
  assert.equal(parseHandle("https://www.youtube.com/channel/UCabc123"), null);
  assert.equal(parseHandle(null), null);
});

test("extractVideoId: 다양한 URL에서 11자 id 추출", () => {
  assert.equal(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://youtu.be/dQw4w9WgXcQ?si=x"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://example.com/none"), null);
  assert.equal(extractVideoId(null), null);
});
