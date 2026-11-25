// 뉴스 큐레이터 ↔ 공통 관대 JSON 파서 배선 회귀 테스트(2026-11-25 Gemini 4 Neon 뉴스 JSON 오류).
//
// 실행기(agy·Codex·Claude)를 갈아끼워 네트워크·모델 없이 curateNews 전체(파싱 → 구간 판정 → 스냅샷)를 돈다.
// ★ 실제 data/ 를 건드리지 않는다: config 는 import 시점에 DB_PATH 를 읽으므로 동적 import 전에 임시 경로를 심는다.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-news-json-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");

const { __setAgentQueryDepsForTest } = await import("../util/agent-query.ts");
const { LlmJsonError } = await import("../util/llm-json.ts");
const { windowEndingAt } = await import("../util/recency.ts");
const { curateNews } = await import("./curate.ts");

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const RAW = fs.readFileSync(path.join(import.meta.dirname, "..", "report", "fixtures", "gemini-news-20261125T081122Z-9c67.txt"), "utf8");
// 실패한 실행과 같은 조사 구간(2026-11-24 17:11 ~ 11-25 17:11 KST).
const WINDOW = windowEndingAt(new Date("2026-11-25T08:11:22Z"), 24);
const GEMINI = "gemini-4-neon-xhigh";

type Call = { prompt: string; options: { model?: unknown; tools?: unknown; maxTurns?: unknown }; label: string };

function stub(replies: string[]) {
  const calls: Call[] = [];
  const reply = async (prompt: string, options: Call["options"], _t: number, label: string) => {
    calls.push({ prompt, options, label });
    const r = replies.shift();
    if (r === undefined) throw new Error("예상보다 많은 호출");
    return r;
  };
  const restore = __setAgentQueryDepsForTest({
    runAntigravity: reply as never,
    runCodex: reply as never,
    runClaude: reply as never,
    recordFallback: () => false,
    clearFallback: () => false,
  });
  return { calls, restore };
}

test("재현: 2026-11-25 Gemini 원문(괄호 하나 빠짐)으로 뉴스 큐레이션이 성공하고 재요청은 없다", async () => {
  const { calls, restore } = stub([RAW]);
  try {
    const snap = await curateNews("2026-11-25", { model: GEMINI, strict: true, window: WINDOW, geekNews: null });
    assert.equal(calls.length, 1, "로컬 복구로 끝 — 같은 모델 재요청 없음");
    const by = Object.fromEntries(snap.categories.map((c) => [c.key, c.items.length]));
    // 기본 카테고리(ai·robotics·quantum·products)에 해당하는 항목이 살아 있다(사용자 정의 c_* 키는 이 임시 환경에 없다).
    assert.ok(by.ai > 0 && by.robotics > 0 && by.quantum > 0 && by.products > 0, JSON.stringify(by));
    assert.match(snap.notes ?? "", /^본 환경에 read_url_content 도구가 없어/, "categories 안에 들어간 notes 를 최상위로 옮겼다");
    assert.equal(snap.source, "llm");
  } finally {
    restore();
  }
});

test("복구 불가 응답 → 같은 모델·도구 없음·1턴으로 JSON 재출력 1회 요청, 성공하면 그 결과를 쓴다", async () => {
  const fixed = JSON.stringify({
    categories: {
      ai: [
        {
          title: "재요청으로 살린 기사",
          source: "테스트",
          date: "2026-11-25",
          publishedAt: "2026-11-25T10:00+09:00",
          summary: "요약",
          link: "https://example.com/a",
          related: [],
        },
      ],
    },
    notes: null,
  });
  for (const model of [GEMINI, "gpt-6.1-sol"]) {
    const { calls, restore } = stub(['{"categories":{"ai":[{"title": tru e}]}}', fixed]);
    try {
      const snap = await curateNews("2026-11-25", { model, strict: true, window: WINDOW, geekNews: null });
      assert.equal(calls.length, 2, model);
      const re = calls[1];
      assert.equal(re.options.model, model, "같은 모델에 요청(대체 금지)");
      assert.deepEqual(re.options.tools, [], "웹 도구 없이");
      assert.equal(re.options.maxTurns, 1);
      assert.equal(re.label, `뉴스 큐레이션(${model}) JSON 재요청`);
      assert.ok(re.prompt.includes('{"title": tru e}'), "원래 응답을 넘긴다");
      assert.deepEqual(
        snap.categories.find((c) => c.key === "ai")!.items.map((i) => i.title),
        ["재요청으로 살린 기사"]
      );
    } finally {
      restore();
    }
  }
});

test("재요청도 실패하면 strict 큐레이션은 LlmJsonError(원문 보관)로 던진다 — 보고서는 오류로 건너뜀", async () => {
  const bad = '{"categories":{"ai":[{"title": tru e}]}}';
  const { calls, restore } = stub([bad, "여전히 망가진 {응답"]);
  try {
    await assert.rejects(
      curateNews("2026-11-25", { model: GEMINI, strict: true, window: WINDOW, geekNews: null }),
      (e: unknown) => e instanceof LlmJsonError && e.rawResponse === bad && /JSON 재요청 응답도 파싱 실패/.test(e.message)
    );
    assert.equal(calls.length, 2, "재요청은 딱 1회");
  } finally {
    restore();
  }
});
