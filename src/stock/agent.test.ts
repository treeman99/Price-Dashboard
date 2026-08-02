import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 증시 에이전트의 타임아웃 **배선** 회귀 테스트. (배경은 src/news/curate.test.ts 주석 참고)
 *
 * 증시는 모드가 둘이고 예산도 둘이다. 브리핑이 펄스 값을 쓰면 매시간 실행이 슬롯을 밀어내고,
 * 펄스가 브리핑 값을 쓰면 실행 하나가 다음 정시와 겹쳐 그 시각이 통째로 날아간다 —
 * 두 방향 모두 조용히 망가지므로 각각 확인한다.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-stock-timeout-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");
process.env.STOCK_BRIEF_TIMEOUT_MS = "444000"; // 표식값
process.env.STOCK_PULSE_TIMEOUT_MS = "555000"; // 표식값
process.env.AGENT_QUERY_TIMEOUT_MS = "999000";

const { config } = await import("../config.ts");
const { __setAgentQueryDepsForTest } = await import("../util/agent-query.ts");
const { runStockAgent } = await import("./agent.ts");

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("증시: 브리핑은 stockBriefTimeoutMs, 펄스는 stockPulseTimeoutMs 로 실행한다", async () => {
  const calls: { label: string; timeoutMs: number }[] = [];
  const record = async (_prompt: string, _options: unknown, timeoutMs: number, label: string) => {
    calls.push({ label, timeoutMs });
    return "{}";
  };
  const restore = __setAgentQueryDepsForTest({
    runClaude: record,
    runCodex: record,
    recordFallback: () => false,
    clearFallback: () => false,
  });
  try {
    await runStockAgent({ mode: "briefing", prompt: "테스트", label: "한국장" });
    await runStockAgent({ mode: "pulse", prompt: "테스트", label: "13:00" });
  } finally {
    restore();
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].label, "증시 에이전트[briefing](한국장)");
  assert.equal(calls[0].timeoutMs, config.stockBriefTimeoutMs);
  // 표식값 그대로여야 한다 = 공용 999_000(agentQueryTimeoutMs)이 아니라 브리핑 값이 배선됐다.
  assert.equal(calls[0].timeoutMs, 444_000);

  assert.equal(calls[1].label, "증시 에이전트[pulse](13:00)");
  assert.equal(calls[1].timeoutMs, config.stockPulseTimeoutMs);
  assert.equal(calls[1].timeoutMs, 555_000);
});
