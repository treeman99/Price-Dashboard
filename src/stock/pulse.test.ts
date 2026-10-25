import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 펄스 실행(runPulse)·보류 플러시(flushPulseQueue)와 **두 개의 스위치**.
 *
 * - 전역(NOTIFY_IMESSAGE+IMESSAGE_TO) off = 환경 미설정 → 실행 자체를 건너뛴다(기존 설계).
 * - 대시보드 탭 알림(notify.stockPulse.imessage) off = **발송만 끈다** → 실행하고 판정을 'muted' 로
 *   원장에 남긴다(일일 브리핑의 24시간 요약이 계속 채워진다). 큐에도 넣지 않는다.
 *   화면에 '자동 실행'(스케줄 enabled)과 '알림'이 별개 스위치라 둘이 같은 효과를 내면 안 된다.
 *
 * ★ 실제 data/ 를 건드리지 않는다(config 가 import 시점에 DB_PATH 를 읽으므로 먼저 갈아끼운다).
 * ★ 네트워크·LLM·문자 모두 막는다: fetch 는 즉시 실패(시세·속보는 실패해도 진행하는 경로),
 *   에이전트는 주입한 고정 응답, iMessage 는 발송기 주입으로 기록만.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-pulse-test-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");
process.env.STOCK_FETCH_DELAY_MS = "0";

const { config } = await import("../config.ts");
const { localDate } = await import("../util/date.ts");
const { saveTabSettings } = await import("../settings/tab-settings.ts");
const { __setIMessageTransportForTest } = await import("../notify/imessage.ts");
const { __setAgentQueryDepsForTest } = await import("../util/agent-query.ts");
const repo = await import("../db/repo.ts");
const { runPulse, flushPulseQueue } = await import("./pulse.ts");

// ── 격리 장치 ──

const texts: string[] = [];
__setIMessageTransportForTest(async (_to, body) => {
  texts.push(body);
});

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
const record = async () => {
  agentCalls++;
  return AGENT_JSON;
};
const restoreAgent = __setAgentQueryDepsForTest({
  runClaude: record,
  runCodex: record,
  recordFallback: () => false,
  clearFallback: () => false,
});

after(() => {
  restoreAgent();
  __setIMessageTransportForTest(null);
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

function globalOn(): void {
  config.notify.imessage = true;
  config.notify.imessageTo = "+820000000000";
}

beforeEach(() => {
  texts.length = 0;
  agentCalls = 0;
  globalOn();
  // 조용 시간 창 없음(시작=끝) + 탭 알림 켬 — 각 테스트가 필요한 것만 바꾼다.
  saveTabSettings({
    notify: { stockPulse: { imessage: true } },
    stockPulse: { quietStartHour: 0, quietEndHour: 0 },
  });
});

const rowsOf = (slot: string) => repo.allRecentPulseAlerts(24).filter((r) => r.slot === slot);
const today = () => localDate();

/** 지금 시각이 들어가는 조용 시간 창(1시간). 테스트가 몇 시에 돌든 '야간'이 된다. */
function quietNow(): { quietStartHour: number; quietEndHour: number } {
  const h = new Date().getHours();
  return { quietStartHour: h, quietEndHour: (h + 1) % 24 };
}

// ── (b) 전역 off ──

test("전역 off(NOTIFY_IMESSAGE 꺼짐) → 기존대로 실행 자체를 건너뛴다(LLM·원장 0)", async () => {
  config.notify.imessage = false;
  const r = await runPulse({ slot: "t-global-off", trigger: "test", force: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, "iMessage 미설정");
  assert.equal(agentCalls, 0);
  assert.equal(rowsOf("t-global-off").length, 0);
  assert.equal(texts.length, 0);
});

test("전역 on 이어도 수신자(IMESSAGE_TO)가 없으면 건너뛴다", async () => {
  config.notify.imessageTo = "";
  const r = await runPulse({ slot: "t-no-to", trigger: "test", force: true });
  assert.equal(r.error, "iMessage 미설정");
  assert.equal(agentCalls, 0);
});

// ── (a) 탭 off = 판정만 기록 ──

test("탭 문자 off → 실행하고 판정을 'muted' 로 기록, 문자 0건·큐 0건·상한 소모 0", async () => {
  saveTabSettings({ notify: { stockPulse: { imessage: false } } });
  const before = repo.countPulseSentToday(today());

  const r = await runPulse({ slot: "t-tab-off", trigger: "test", force: true });
  assert.equal(r.ok, true);
  assert.equal(agentCalls, 1, "탭 off 여도 판정은 돌린다");
  assert.equal(r.impacts, 2);
  assert.equal(r.sent, 0);
  assert.equal(r.queued, 0);
  assert.equal(r.suppressed, 2);

  const rows = rowsOf("t-tab-off");
  assert.deepEqual(rows.map((x) => x.status).sort(), ["muted", "muted"]);
  assert.equal(texts.length, 0);
  assert.equal(repo.listQueuedPulseAlerts().length, 0);
  assert.deepEqual(repo.countPulseSentToday(today()), before, "보내지 않은 판정은 그날 상한을 쓰지 않는다");
});

test("탭 문자 off + 야간 → '중요' 판정도 큐에 넣지 않는다(다시 켰을 때 몰아 보내지 않게)", async () => {
  saveTabSettings({ notify: { stockPulse: { imessage: false } }, stockPulse: quietNow() });
  const r = await runPulse({ slot: "t-tab-off-night", trigger: "test", force: true });
  assert.equal(r.ok, true);
  assert.equal(r.queued, 0);
  assert.deepEqual(rowsOf("t-tab-off-night").map((x) => x.status).sort(), ["muted", "muted"]);
  assert.equal(repo.listQueuedPulseAlerts().length, 0);
  assert.equal(texts.length, 0);
});

test("탭을 다시 켜면 같은 판정이 정상 발송된다 — muted 는 중복 차단·상한에 걸리지 않는다", async () => {
  const r = await runPulse({ slot: "t-tab-on", trigger: "test", force: true });
  assert.equal(r.ok, true);
  assert.equal(r.sent, 2, "앞선 muted 기록이 '이미 알린 사건'으로 취급되면 dup 으로 막힌다");
  assert.deepEqual(rowsOf("t-tab-on").map((x) => x.status).sort(), ["sent", "sent"]);
  assert.equal(texts.length, 2);
});

// ── (c) 탭 off 상태의 보류분 플러시 ──

function impact(symbol: string | null, headline: string) {
  return {
    symbol,
    market: symbol ? ("us" as const) : null,
    name: symbol ?? "거시",
    direction: "neutral" as const,
    severity: "important" as const,
    headline,
    rationale: "r",
    risks: "k",
    sources: [{ title: "t", origin: "o", url: "https://example.com/q", publishedAt: null }],
    trigger: symbol ? ("company" as const) : ("macro" as const),
  };
}

function queueOne(headline: string): number {
  return repo.insertPulseAlert({
    fingerprint: `fp-${headline}`,
    date: today(),
    slot: "t-queued",
    impact: impact(null, headline),
    status: "queued",
  }).id;
}

test("탭 문자 off 상태의 보류분 플러시 → 발송 0건, 큐에서 빼 'muted' 로 정리하고 예산을 돌려준다", async () => {
  const before = repo.countPulseSentToday(today()).macro;
  const id = queueOne("야간 보류 1");
  assert.equal(repo.countPulseSentToday(today()).macro, before + 1, "보류분은 예산을 쓴다(기존 규칙)");

  saveTabSettings({ notify: { stockPulse: { imessage: false } } });
  assert.equal(await flushPulseQueue("test"), 0);
  assert.equal(texts.length, 0);
  assert.equal(repo.listQueuedPulseAlerts().length, 0);
  assert.equal(repo.allRecentPulseAlerts(24).find((r) => r.id === id)?.status, "muted");
  assert.equal(repo.countPulseSentToday(today()).macro, before, "정리된 보류분의 예산은 돌아온다");

  // 다시 켜도 밀린 문자가 나가지 않는다.
  saveTabSettings({ notify: { stockPulse: { imessage: true } } });
  assert.equal(await flushPulseQueue("test"), 0);
  assert.equal(texts.length, 0);
});

test("전역 off 플러시는 기존대로 보류분을 유지한다(환경 미설정 — 보내지도 지우지도 않음)", async () => {
  const id = queueOne("야간 보류 2");
  config.notify.imessage = false;
  assert.equal(await flushPulseQueue("test"), 0);
  assert.equal(repo.allRecentPulseAlerts(24).find((r) => r.id === id)?.status, "queued");
  globalOn();
  assert.equal(await flushPulseQueue("test"), 1, "전역·탭 모두 켜지면 정상 묶음 발송");
  assert.equal(texts.length, 1);
});

// ── muted 무해성 ──

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
