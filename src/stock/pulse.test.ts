import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 펄스 실행(runPulse) — 메일·문자 발송 기능 제거(2026-11-22) 이후의 계약.
 *
 * - 펄스는 판정을 **원장에만** 남긴다. 예전 발송·보류 대상('sent'·'queued')은 'muted'(판정만 기록)다.
 * - 야간(조용 시간)에도 큐에 넣지 않는다 — 나중에 몰아 보낼 발송 경로가 없다.
 * - 실행 on/off 는 대시보드 스케줄이 정본이고, 환경 변수(iMessage)로 실행을 막지 않는다.
 *
 * ★ 실제 data/ 를 건드리지 않는다(config 가 import 시점에 DB_PATH 를 읽으므로 먼저 갈아끼운다).
 * ★ 네트워크·LLM 을 막는다: fetch 는 즉시 실패(시세·속보는 실패해도 진행하는 경로),
 *   에이전트는 주입한 고정 응답.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-pulse-test-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");
process.env.STOCK_FETCH_DELAY_MS = "0";

const { localDate } = await import("../util/date.ts");
const { fingerprint } = await import("../../shared/pulse.ts");
const { saveTabSettings } = await import("../settings/tab-settings.ts");
const { __setAgentQueryDepsForTest } = await import("../util/agent-query.ts");
const repo = await import("../db/repo.ts");
const pulseModule = await import("./pulse.ts");
const { runPulse } = pulseModule;

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("테스트에서 네트워크 금지");
}) as typeof fetch;

let agentCalls = 0;
/** 보유 종목 직격 1건(긴급) + 거시 1건(중요). 근거·출처가 있어 정규화를 통과한다. */
const AGENT_JSON = JSON.stringify({
  impacts: [
    {
      symbol: "AAPL",
      market: "us",
      name: "애플",
      issueKey: "애플 공급망 이슈",
      direction: "negative",
      severity: "urgent",
      trigger: "company",
      headline: "애플 공급망 차질 보도",
      rationale: "주요 협력사 가동 중단 보도",
      risks: "보도가 정정될 수 있음",
      sources: [{ title: "기사", origin: "매체", url: "https://example.com/a", publishedAt: null }],
    },
    {
      symbol: null,
      market: null,
      name: "반도체 섹터",
      issueKey: "반도체 관세",
      direction: "negative",
      severity: "important",
      trigger: "macro",
      headline: "반도체 관세 논의",
      rationale: "정부 발표",
      risks: "협상 여지",
      sources: [{ title: "발표", origin: "정부", url: "https://example.com/b", publishedAt: null }],
    },
  ],
  notes: null,
});
/** 테스트가 바꿔 끼우는 응답. null 이면 AGENT_JSON. */
let agentReply: ((label: string) => string) | null = null;
const record = async (_prompt: string, _options: unknown, _timeoutMs: number, label: string) => {
  agentCalls++;
  return agentReply ? agentReply(label) : AGENT_JSON;
};
const restoreAgent = __setAgentQueryDepsForTest({
  runClaude: record,
  runCodex: record,
  recordFallback: () => false,
  clearFallback: () => false,
});

after(() => {
  restoreAgent();
  globalThis.fetch = realFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

repo.createHolding({
  market: "us",
  symbol: "AAPL",
  name: "애플",
  quoteCode: "AAPL.O",
  exchange: "NASDAQ",
  quantity: 1,
  avgPrice: 100,
});

beforeEach(() => {
  agentCalls = 0;
  agentReply = null;
  // 조용 시간 창 없음(시작=끝) — 각 테스트가 필요한 것만 바꾼다.
  saveTabSettings({ stockPulse: { quietStartHour: 0, quietEndHour: 0 } });
});

const rowsOf = (slot: string) => repo.allRecentPulseAlerts(24).filter((r) => r.slot === slot);
const today = () => localDate();

/** 지금 시각이 들어가는 조용 시간 창(1시간). 테스트가 몇 시에 돌든 '야간'이 된다. */
function quietNow(): { quietStartHour: number; quietEndHour: number } {
  const h = new Date().getHours();
  return { quietStartHour: h, quietEndHour: (h + 1) % 24 };
}

/** 원장 집계 테스트용 판정. */
function impact(symbol: string | null, headline: string) {
  return {
    symbol,
    market: symbol ? ("us" as const) : null,
    name: symbol ?? "거시",
    direction: "negative" as const,
    severity: "urgent" as const,
    trigger: "company" as const,
    headline,
    rationale: "근거",
    risks: "위험",
    sources: [{ title: "기사", origin: "매체", url: "https://example.com/x", publishedAt: null }],
  };
}

test("발송 기능 제거: 문턱을 넘은 판정도 'muted' 로만 기록되고 발송·보류는 0건", async () => {
  const r = await runPulse({ slot: "t-record", trigger: "test", force: true });
  assert.equal(r.ok, true);
  assert.equal(agentCalls, 1, "환경 변수와 무관하게 실행한다");
  assert.equal(r.sent, 0);
  assert.equal(r.queued, 0);
  const rows = rowsOf("t-record");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.status === "muted"), JSON.stringify(rows.map((x) => x.status)));
  assert.equal(repo.listQueuedPulseAlerts().length, 0);
  assert.deepEqual(repo.countPulseSentToday(today()), { total: 0, bySymbol: {}, macro: 0 });
});

test("야간에도 큐에 넣지 않는다 — 몰아 보낼 발송 경로가 없다", async () => {
  saveTabSettings({ stockPulse: quietNow() });
  agentReply = () => AGENT_JSON.replace("애플 공급망 이슈", "야간 이슈").replace("반도체 관세", "야간 거시");
  const r = await runPulse({ slot: "t-quiet", trigger: "test", force: true });
  assert.equal(r.ok, true);
  assert.equal(r.queued, 0);
  assert.equal(repo.listQueuedPulseAlerts().length, 0);
  assert.ok(rowsOf("t-quiet").every((x) => x.status !== "queued"));
});

test("보류 플러시(flushPulseQueue)는 더 이상 없다", () => {
  assert.equal("flushPulseQueue" in pulseModule, false);
});

test("muted 는 상한(countPulseSentToday)·중복(recentPulseAlerts) 집계에 잡히지 않는다", () => {
  const d = "2000-01-01"; // 다른 테스트의 오늘 기록과 섞이지 않는 날짜
  const base = { date: d, slot: "t-muted", impact: impact("AAPL", "muted 무해성") };
  repo.insertPulseAlert({ ...base, fingerprint: "m1", status: "muted" });
  assert.deepEqual(repo.countPulseSentToday(d), { total: 0, bySymbol: {}, macro: 0 });
  repo.insertPulseAlert({ ...base, fingerprint: "s1", status: "sent" });
  assert.deepEqual(repo.countPulseSentToday(d), { total: 1, bySymbol: { AAPL: 1 }, macro: 0 });
  const recentFps = repo.recentPulseAlerts(24).map((r) => r.fingerprint);
  assert.ok(recentFps.includes("s1"));
  assert.ok(!recentFps.includes("m1"));
});

// ── 언어 검증 ──

/** 헤드라인이 오염된 판정 1건. 앞선 테스트의 중복 억제에 걸리지 않게 이슈를 따로 둔다. */
const dirtyPulseJson = (issueKey: string) =>
  JSON.stringify({
    impacts: [
      {
        symbol: "AAPL",
        market: "us",
        name: "애플",
        issueKey,
        direction: "negative",
        severity: "urgent",
        trigger: "company",
        headline: `애플 供应链 ${issueKey}`,
        rationale: "주요 협력사 가동 중단 보도",
        risks: "보도가 정정될 수 있음",
        sources: [{ title: "기사", origin: "매체", url: "https://example.com/a", publishedAt: null }],
      },
    ],
    notes: null,
  });

test("언어 검증: 교정된 headline 이 원장에 남고 지문은 LLM issueKey 그대로다", async () => {
  const issueKey = "language-gate-corrected";
  agentReply = (label) =>
    label.includes("language-fix")
      ? JSON.stringify({ f1: `애플 공급망 ${issueKey}` })
      : dirtyPulseJson(issueKey);

  const r = await runPulse({ slot: "t-lang-fix", trigger: "test", force: true });

  assert.equal(r.ok, true);
  assert.equal(agentCalls, 2);
  const row = rowsOf("t-lang-fix")[0];
  assert.equal(row.impact.headline, `애플 공급망 ${issueKey}`);
  assert.equal(row.fingerprint, fingerprint("AAPL", issueKey));
});

test("언어 검증: 교정이 실패해 headline 이 오염으로 남으면 원장에 남지 않는다", async () => {
  const issueKey = "language-gate-dropped";
  agentReply = (label) => {
    if (label.includes("language-fix")) throw new Error("교정 실패");
    return dirtyPulseJson(issueKey);
  };

  const r = await runPulse({ slot: "t-lang-drop", trigger: "test", force: true });

  assert.equal(r.ok, true);
  assert.equal(r.impacts, 0);
  assert.equal(rowsOf("t-lang-drop").length, 0);
});
