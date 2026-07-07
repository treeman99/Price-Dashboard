import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDescribePrompt, shouldAutoDescribe, AUTO_DESCRIBE_MAX_HINT } from "./category-describe.ts";

test("shouldAutoDescribe: 설명이 없거나 짧으면 true, 충분히 길면 false", () => {
  assert.equal(shouldAutoDescribe(undefined), true);
  assert.equal(shouldAutoDescribe(""), true);
  assert.equal(shouldAutoDescribe("   "), true);
  assert.equal(shouldAutoDescribe("AI 코딩 도구 리뷰"), true); // 짧은 힌트 → 확장 대상
  assert.equal(shouldAutoDescribe("가".repeat(AUTO_DESCRIBE_MAX_HINT)), false); // 충분한 지침 → 유지
  assert.equal(shouldAutoDescribe(123), true); // 문자열 아님 → 생성 대상
});

test("buildDescribePrompt(youtube): 이름·힌트·검색범위·제외조건·채널 규칙 포함", () => {
  const p = buildDescribePrompt({
    kind: "youtube",
    label: "드론",
    hint: "촬영용 드론 위주",
    region: "kr",
    excludeKeywords: ["군사", "택배"],
  });
  assert.match(p, /유튜브 영상 수집 카테고리/);
  assert.match(p, /카테고리 이름: 드론/);
  assert.match(p, /촬영용 드론 위주/);
  assert.match(p, /한국 채널·한국어 영상만/);
  assert.match(p, /제외 조건\(참고\): 군사, 택배/);
  assert.match(p, /한국 채널만 추천/);
});

test("buildDescribePrompt(youtube/global): 글로벌 범위·혼합 채널 추천 명시", () => {
  const p = buildDescribePrompt({ kind: "youtube", label: "로봇", region: "global" });
  assert.match(p, /글로벌\(해외 채널·영어 영상 포함\)/);
  assert.match(p, /글로벌·한국 채널을 섞어도 된다/);
  assert.match(p, /\(없음 — 이름에서 유추\)/); // 힌트 없음 표기
});

test("buildDescribePrompt(news): 뉴스 문맥, region/채널 규칙 없음", () => {
  const p = buildDescribePrompt({ kind: "news", label: "우주 산업" });
  assert.match(p, /뉴스 기사 수집 카테고리/);
  assert.doesNotMatch(p, /검색 범위:/);
  assert.doesNotMatch(p, /추천 채널/);
});
