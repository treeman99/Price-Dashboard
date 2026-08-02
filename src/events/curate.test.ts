import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RawCorpus } from "./gather.ts";

/**
 * 팝업/전시 탭의 타임아웃 **배선** 회귀 테스트. (배경은 src/news/curate.test.ts 주석 참고)
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-events-timeout-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");
process.env.EVENTS_TIMEOUT_MS = "333000"; // 다른 탭·공용 값과 겹치지 않는 표식값
process.env.AGENT_QUERY_TIMEOUT_MS = "999000";

const { config } = await import("../config.ts");
const { __setAgentQueryDepsForTest } = await import("../util/agent-query.ts");
const { curate } = await import("./curate.ts");

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("팝업/전시 큐레이션은 이벤트 전용 예산(eventsTimeoutMs)으로 실행한다", async () => {
  const corpus: RawCorpus = { month: "2026년 8월", popupGroups: [], venues: [], festivalGroups: [] };
  const calls: { label: string; timeoutMs: number }[] = [];
  const record = async (_prompt: string, _options: unknown, timeoutMs: number, label: string) => {
    calls.push({ label, timeoutMs });
    return "{}"; // 파싱만 통과 — 팝업·전시·축제 모두 0건이라 후처리에 네트워크가 없다
  };
  const restore = __setAgentQueryDepsForTest({
    runClaude: record,
    runCodex: record,
    recordFallback: () => false,
    clearFallback: () => false,
  });
  try {
    await curate(corpus, "2026-08-02");
  } finally {
    restore();
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, "팝업/전시 큐레이션");
  assert.equal(calls[0].timeoutMs, config.eventsTimeoutMs);
  // 표식값 그대로여야 한다 = 공용 999_000(agentQueryTimeoutMs)이 아니라 이벤트 값이 배선됐다.
  assert.equal(calls[0].timeoutMs, 333_000);
});
