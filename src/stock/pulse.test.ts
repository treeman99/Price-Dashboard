import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 펄스 실행(runPulse) — 메일·문자 발송 기능 제거(2026-11-22) 이후의 계약.
 *
 * - 펄스는 판정을 **원장에만** 남긴다. 예전 발송·보류 대상('sent'·'queued')은 'muted'(판정만 기록)다.
 * - muted 는 예전 sent 처럼 상한·중복 집계에 센다 — 같은 이슈가 매시간 다시 '문턱 이상'으로 쌓이지 않는다.
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
  // 조용 시간 창 없음(시작=끝) + 상한 최대 — 같은 날 원장에 쌓인 앞 테스트의 판정(muted 도 상한에 센다)이
  // 다음 테스트를 'capped' 로 만들지 않게 한다. 상한 자체는 아래 전용 테스트가 본다.
  saveTabSettings({
    stockPulse: { quietStartHour: 0, quietEndHour: 0, perSymbolCap: 10, dailyCap: 30, macroCap: 10 },
  });
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
  // 문턱 이상 판정(muted)은 그날 상한 집계에 잡힌다 — 종목 1 + 거시 1
  assert.deepEqual(repo.countPulseSentToday(today()), { total: 2, bySymbol: { AAPL: 1 }, macro: 1 });
});

/** 앞선 테스트와 겹치지 않는 사건 두 개(지문·헤드라인 모두 다르게 — 중복 판정은 헤드라인 유사도도 본다). */
function distinctReply(company: string, macro: string): string {
  const j = JSON.parse(AGENT_JSON);
  j.impacts[0].issueKey = company;
  j.impacts[0].headline = company;
  j.impacts[1].issueKey = macro;
  j.impacts[1].headline = macro;
  return JSON.stringify(j);
}

test("같은 이슈를 다음 실행에서 다시 판정하면 'dup' 으로 기록한다(muted 도 중복 기준에 든다)", async () => {
  agentReply = () => distinctReply("애플 실적 가이던스 하향 조정", "달러 환율 급등 경고 발령");
  await runPulse({ slot: "t-dup-1", trigger: "test", force: true });
  await runPulse({ slot: "t-dup-2", trigger: "test", force: true });
  assert.ok(rowsOf("t-dup-1").every((x) => x.status === "muted"));
  assert.deepEqual(rowsOf("t-dup-2").map((x) => x.status).sort(), ["dup", "dup"]);
});

test("야간에도 큐에 넣지 않는다 — 몰아 보낼 발송 경로가 없다", async () => {
  saveTabSettings({ stockPulse: quietNow() });
  agentReply = () => distinctReply("애플 협력사 파업 확대 우려", "연준 금리 동결 시사 발언");
  const r = await runPulse({ slot: "t-quiet", trigger: "test", force: true });
  assert.equal(r.ok, true);
  assert.equal(r.queued, 0);
  assert.equal(repo.listQueuedPulseAlerts().length, 0);
  // 야간이라 예전에는 '중요'(거시)가 큐에 들어갔지만 이제는 둘 다 기록만(muted)
  assert.deepEqual(rowsOf("t-quiet").map((x) => x.status), ["muted", "muted"]);
});

test("상한: 같은 날 앞서 기록된 muted 판정이 상한을 채우면 새 판정은 'capped' 로 기록한다", async () => {
  const macroToday = repo.countPulseSentToday(today()).macro;
  assert.ok(macroToday >= 1, "앞 테스트의 거시 muted 판정이 그날 집계에 잡혀 있어야 한다");
  saveTabSettings({ stockPulse: { macroCap: macroToday } });
  agentReply = () => distinctReply("애플 신규 데이터센터 투자 발표", "유가 급락 원유 재고 증가");
  await runPulse({ slot: "t-cap", trigger: "test", force: true });
  const rows = rowsOf("t-cap");
  assert.equal(rows.find((x) => x.impact.symbol === null)?.status, "capped", "거시 상한이 muted 로 이미 찼다");
  assert.equal(rows.find((x) => x.impact.symbol === "AAPL")?.status, "muted");
});

test("보류 플러시(flushPulseQueue)는 더 이상 없다", () => {
  assert.equal("flushPulseQueue" in pulseModule, false);
});

test("muted·예전 sent 는 상한(countPulseSentToday)·중복(recentPulseAlerts) 집계에 잡히고, below 는 잡히지 않는다", () => {
  const d = "2000-01-01"; // 다른 테스트의 오늘 기록과 섞이지 않는 날짜
  const base = { date: d, slot: "t-muted", impact: impact("AAPL", "muted 집계") };
  repo.insertPulseAlert({ ...base, fingerprint: "m1", status: "muted" });
  assert.deepEqual(repo.countPulseSentToday(d), { total: 1, bySymbol: { AAPL: 1 }, macro: 0 });
  repo.insertPulseAlert({ ...base, fingerprint: "s1", status: "sent" });
  repo.insertPulseAlert({ ...base, fingerprint: "b1", status: "below" });
  assert.deepEqual(repo.countPulseSentToday(d), { total: 2, bySymbol: { AAPL: 2 }, macro: 0 });
  const recentFps = repo.recentPulseAlerts(24).map((r) => r.fingerprint);
  assert.ok(recentFps.includes("s1"));
  assert.ok(recentFps.includes("m1"));
  assert.ok(!recentFps.includes("b1"));
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
