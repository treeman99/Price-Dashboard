import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 유튜브 탭의 타임아웃 **배선** 회귀 테스트. (배경은 src/news/curate.test.ts 주석 참고)
 *
 * 파일을 curate.test.ts 와 나눈 이유: 이 테스트는 env 를 먼저 세팅한 뒤 모듈을 동적 import 해야
 * 하는데, 기존 curate.test.ts 는 상단에서 curate.ts 를 정적 import 하므로 같은 파일에 둘 수 없다
 * (node:test 는 파일 단위로 프로세스를 분리하므로 파일을 나누면 서로 간섭하지 않는다).
 *
 * 유튜브는 큐레이션 앞에 '채널 발굴' 호출이 하나 더 있어 **예산이 2개**다. 둘 다 확인한다.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-youtube-timeout-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");
process.env.YOUTUBE_TIMEOUT_MS = "222000"; // 다른 탭·공용 값과 겹치지 않는 표식값
process.env.AGENT_QUERY_TIMEOUT_MS = "999000";
// 추천 채널이 없는 카테고리 1개만 둔다. 발굴 결과까지 비우면 RSS 하베스트(harvestFreshUploads)가
// 아예 돌지 않아 이 테스트는 네트워크를 전혀 타지 않는다.
fs.writeFileSync(
  path.join(tmpDir, "youtube-categories.json"),
  JSON.stringify([{ key: "t1", label: "테스트", emoji: "🧪", color: "#000000", region: "kr" }])
);

const { config } = await import("../config.ts");
const { __setAgentQueryDepsForTest } = await import("../util/agent-query.ts");
const { curateYoutube, CHANNEL_DISCOVERY_TIMEOUT_MS } = await import("./curate.ts");

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("유튜브: 큐레이션은 youtubeTimeoutMs, 채널 발굴은 전용 상수로 실행한다", async () => {
  const calls: { label: string; timeoutMs: number }[] = [];
  const record = async (_prompt: string, _options: unknown, timeoutMs: number, label: string) => {
    calls.push({ label, timeoutMs });
    // 발굴은 빈 채널맵 → RSS 하베스트 스킵, 큐레이션은 빈 카테고리 → oEmbed·watch 검증 스킵.
    return label.includes("채널 발굴") ? '{"channels":{}}' : '{"categories":{}}';
  };
  const restore = __setAgentQueryDepsForTest({
    runClaude: record,
    runCodex: record,
    recordFallback: () => false,
    clearFallback: () => false,
  });
  try {
    await curateYoutube("2026-08-02");
  } finally {
    restore();
  }

  const discovery = calls.find((c) => c.label === "유튜브 채널 발굴");
  const curation = calls.find((c) => c.label === "유튜브 큐레이션");
  assert.ok(discovery, "채널 발굴 호출이 없다");
  assert.ok(curation, "큐레이션 호출이 없다");

  assert.equal(curation.timeoutMs, config.youtubeTimeoutMs);
  // 표식값 그대로여야 한다 = 공용 999_000(agentQueryTimeoutMs)이 아니라 유튜브 값이 배선됐다.
  assert.equal(curation.timeoutMs, 222_000);

  // 발굴은 탭 예산과 별개인 곁가지 예산이다(상수 선언부 주석 참고). 탭 예산을 따라가면 안 된다.
  assert.equal(discovery.timeoutMs, CHANNEL_DISCOVERY_TIMEOUT_MS);
  assert.equal(discovery.timeoutMs, 240_000);
});
