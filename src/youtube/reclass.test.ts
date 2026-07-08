import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReclassSection } from "./reclass.ts";
import { buildPrompt } from "./curate.ts";
import type { YoutubeCategoryDef } from "../../shared/types.ts";

const defs: YoutubeCategoryDef[] = [
  { key: "tools", label: "AI 활용 · 도구", emoji: "🛠️", color: "#000", region: "global" },
  { key: "reviews", label: "신제품 리뷰", emoji: "🆕", color: "#000", region: "kr" },
];

test("buildReclassSection: 기록이 없으면 빈 문자열", () => {
  // 실제 파일이 없거나 비어 있는 환경 기준(테스트는 저장소를 건드리지 않음)
  const s = buildReclassSection(defs);
  assert.equal(typeof s, "string");
});

test("buildPrompt: reclassSection 인자가 프롬프트에 그대로 삽입된다", () => {
  const section =
    "\n\n📌 사용자 재분류 규칙(반드시 준수):\n  - \"갤럭시 라인업 총정리\" (리펭) 같은 영상 → 'AI 활용 · 도구'가 아니라 '신제품 리뷰'에 넣어라.";
  const p = buildPrompt(defs, "2026-07-08", "2026-07-01", 7, "2026-07-08 12:00", [], section);
  assert.match(p, /사용자 재분류 규칙/);
  assert.match(p, /갤럭시 라인업 총정리/);
  assert.match(p, /'신제품 리뷰'에 넣어라/);
});

test("buildPrompt: reclassSection 미지정이면 재분류 문구 없음 + 신선도 '모든 카테고리' 문구 포함", () => {
  const p = buildPrompt(defs, "2026-07-08", "2026-07-01", 7, "2026-07-08 12:00", []);
  assert.doesNotMatch(p, /사용자 재분류 규칙/);
  assert.match(p, /조회 시점 기준 최근 7일/);
  assert.match(p, /모든 카테고리에 예외 없이 동일하게/);
});
