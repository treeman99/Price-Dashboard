import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 탭별 타임아웃 **배선** 회귀 테스트.
 *
 * config 에 탭별 상수를 만들어 두고 호출부를 그대로 두는 바람에, "60분 → 20분" 조정이 실제로는
 * 전혀 적용되지 않은 채 프로덕션이 돈 적이 있다(2026-08-02 로그의 `예산 3600s` 가 증거).
 * 상수의 **존재**가 아니라 그 값이 `runAgentQueryText` 까지 **도달하는지**를 잠근다 —
 * 호출부가 공용 값이나 다른 탭 상수로 되돌아가면 여기서 깨진다.
 *
 * config 는 import 시점에 env 를 굳히므로 값 주입과 데이터 디렉터리 격리를 import 전에 끝내고
 * 모듈은 동적 import 한다(운영 data/ 에 카테고리 파일을 만들지 않기 위함).
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-news-timeout-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");
process.env.NEWS_TIMEOUT_MS = "111000"; // 다른 탭·공용 값과 겹치지 않는 표식값
process.env.AGENT_QUERY_TIMEOUT_MS = "999000";

const { config } = await import("../config.ts");
const { __setAgentQueryDepsForTest } = await import("../util/agent-query.ts");
const { curateNews } = await import("./curate.ts");

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("뉴스 큐레이션은 뉴스 전용 예산(newsTimeoutMs)으로 실행한다", async () => {
  const calls: { label: string; timeoutMs: number }[] = [];
  const record = async (_prompt: string, _options: unknown, timeoutMs: number, label: string) => {
    calls.push({ label, timeoutMs });
    return '{"categories":{}}'; // 파싱만 통과시키고 후처리는 0건 — 네트워크를 타지 않는다
  };
  // 선택 모델이 Codex 든 Claude 든 timeoutMs 는 같은 자리로 오므로 두 실행기를 모두 갈아끼운다.
  const restore = __setAgentQueryDepsForTest({
    runClaude: record,
    runCodex: record,
    recordFallback: () => false,
    clearFallback: () => false,
  });
  try {
    await curateNews("2026-08-02");
  } finally {
    restore();
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, "뉴스 큐레이션");
  assert.equal(calls[0].timeoutMs, config.newsTimeoutMs);
  // 표식값 그대로여야 한다 = 공용 999_000(agentQueryTimeoutMs)이 아니라 뉴스 값이 배선됐다.
  assert.equal(calls[0].timeoutMs, 111_000);
});
