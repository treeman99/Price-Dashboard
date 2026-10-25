import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 탭별 운영 설정 저장소(src/settings/tab-settings.ts) + 알림 AND 게이트 + 소비처 즉시 반영.
 *
 * ★ 실제 data/ 를 건드리지 않는다. config 는 import 시점에 DB_PATH 와 .env 를 읽으므로 모듈을
 *   불러오기 **전에** 임시 경로와 표식값을 심는다(dotenv 는 이미 있는 env 를 덮지 않는다).
 * ★ 실제 문자가 나가지 않는다. '전역 켜짐'을 만들어야 게이트를 발송 함수 단위로 볼 수 있는데,
 *   그때 게이트가 틀리면 Messages.app 으로 진짜 문자가 나간다 — 발송기를 갈아끼워 막는다.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-tab-settings-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");
process.env.YOUTUBE_FRESH_DAYS = "4"; // 표식값
process.env.STOCK_PULSE_THRESHOLD = "info"; // 깨진 값 폴백이 '덜 보내는 쪽'인지 보려고 가장 느슨한 값
process.env.STOCK_PULSE_DEDUP_HOURS = "24";
process.env.NEWS_TIMEOUT_MS = "900000"; // 15분

const { config } = await import("../config.ts");
const ts = await import("./tab-settings.ts");
const { __setIMessageTransportForTest } = await import("../notify/imessage.ts");
const { sendNewsIMessage, sendNewsEmail } = await import("../notify/news-email.ts");
const { sendPulseIMessage, isPulseNotifyEnabled, isPulseTextEnabled, pulseThreshold, PULSE_CAPS } =
  await import("../notify/pulse-imessage.ts");
const { uptimeIMessageEnabled, notifyDowntimeEvent } = await import("../uptime/notify.ts");

const STORE = path.join(tmpDir, "tab-settings.json");

const sent: string[] = [];
__setIMessageTransportForTest(async (_to, body) => {
  sent.push(body);
});
const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("테스트에서 네트워크 금지");
}) as typeof fetch;

after(() => {
  __setIMessageTransportForTest(null);
  globalThis.fetch = realFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function globalOn(): void {
  config.notify.imessage = true;
  config.notify.imessageTo = "+820000000000";
  config.notify.email = true;
  config.notify.gmailAddress = "me@example.com";
  config.notify.googleClientId = "test-client-id";
  config.notify.googleClientSecret = "test-client-secret";
}

beforeEach(() => {
  fs.rmSync(STORE, { force: true });
  sent.length = 0;
  fetchCalls = 0;
  globalOn();
});

const readStore = () => JSON.parse(fs.readFileSync(STORE, "utf8"));

const NEWS = {
  date: "2026-10-25",
  categories: [{ key: "k", label: "테스트", emoji: "🧪", color: "#000", items: [{ title: "제목" }] }],
} as any;

const IMPACT = {
  symbol: "AAPL",
  market: "us",
  name: "애플",
  direction: "negative",
  severity: "urgent",
  headline: "헤드라인",
  rationale: "근거",
  risks: "위험",
  sources: [{ title: "t", origin: "o", url: null, publishedAt: null }],
  trigger: "company",
} as any;

// ── 기본값 = .env ──

test("기본값은 .env(config.ts) 값이다 — 파일이 없으면 settings 와 defaults 가 같다", () => {
  const r = ts.getTabSettingsResponse();
  assert.deepEqual(r.settings, r.defaults);
  assert.equal(r.settings.youtube.freshDays, 4);
  assert.equal(r.settings.stockPulse.threshold, "info");
  assert.equal(r.settings.timeouts.newsMin, 15);
  assert.equal(r.settings.timeouts.youtubeMin, config.youtubeTimeoutMs / 60_000);
  assert.equal(r.settings.stock.historyRetentionDays, config.historyRetentionDays);
  assert.equal(r.settings.events.verifyDates, config.eventsVerifyDates);
  assert.deepEqual(r.settings.stockPulse, config.stockPulse);
  // 탭 알림 기본값 = 현재 동작(존재하는 채널은 모두 켜짐), 없는 채널은 false.
  assert.deepEqual(r.settings.notify.news, { email: true, imessage: true });
  assert.deepEqual(r.settings.notify.stockPulse, { email: false, imessage: true });
  assert.deepEqual(r.settings.notify.uptime, { email: false, imessage: true });
  assert.deepEqual(r.channels, ts.NOTIFY_CHANNELS);
  assert.equal(r.numberRules, ts.NUMBER_RULES);
  assert.deepEqual(r.globalChannels, { email: true, imessage: true });
});

test("모든 숫자 필드에 범위 규칙이 있다(필드를 늘리고 규칙을 빠뜨리면 저장이 불가능해진다)", () => {
  const d = ts.getTabSettingsResponse().defaults as unknown as Record<string, Record<string, unknown>>;
  for (const [section, fields] of Object.entries(d)) {
    if (section === "notify") continue;
    for (const [field, v] of Object.entries(fields)) {
      if (typeof v === "number") assert.ok(ts.NUMBER_RULES[`${section}.${field}`], `${section}.${field}`);
    }
  }
});

// ── sparse 저장 / 병합 ──

test("바꾼 필드만 sparse 저장하고, 나머지는 계속 기본값을 따른다", () => {
  const s1 = ts.saveTabSettings({ youtube: { freshDays: 9 } });
  assert.equal(s1.youtube.freshDays, 9);
  assert.equal(s1.youtube.watchedExcludeDays, config.youtubeWatchedExcludeDays);
  assert.deepEqual(readStore(), { youtube: { freshDays: 9 } });

  const s2 = ts.saveTabSettings({ stockPulse: { dedupHours: 12 }, notify: { news: { imessage: false } } });
  assert.equal(s2.youtube.freshDays, 9, "앞서 저장한 값이 유지된다");
  assert.equal(s2.stockPulse.dedupHours, 12);
  assert.deepEqual(s2.notify.news, { email: true, imessage: false });
  assert.deepEqual(readStore(), {
    youtube: { freshDays: 9 },
    stockPulse: { dedupHours: 12 },
    notify: { news: { imessage: false } },
  });
});

test("기본값과 같은 값을 보내면 저장분에서 빠져 다시 .env 를 따른다('기본값으로 되돌리기')", () => {
  ts.saveTabSettings({ youtube: { freshDays: 9 }, timeouts: { newsMin: 30 } });
  ts.saveTabSettings({ youtube: { freshDays: 4 } });
  assert.deepEqual(readStore(), { timeouts: { newsMin: 30 } });
  assert.equal(ts.getTabSettings().youtube.freshDays, 4);
  assert.equal(ts.tabTimeoutMs("newsMin"), 30 * 60_000);
});

test("탭에 없는 채널(stockPulse.email)은 타입만 확인하고 무시한다", () => {
  const s = ts.saveTabSettings({ notify: { stockPulse: { email: true } } });
  assert.equal(s.notify.stockPulse.email, false);
  assert.deepEqual(readStore(), {});
});

// ── 깨진 파일: 관대 읽기 ──

test("깨진 JSON·배열·스칼라 파일은 통째로 기본값", () => {
  const def = ts.getTabSettingsResponse().defaults;
  for (const body of ["{not json", "[1,2]", "42", "null"]) {
    fs.writeFileSync(STORE, body);
    assert.deepEqual(ts.getTabSettings(), def, body);
  }
});

test("필드 단위 관대 읽기: 타입 오류→기본값, 범위 밖 숫자→범위로 자름, 깨진 문턱→덜 보내는 쪽", () => {
  fs.writeFileSync(
    STORE,
    JSON.stringify({
      youtube: { freshDays: "abc", watchedExcludeDays: 5 },
      events: { verifyDates: "yes" },
      stockPulse: { quietStartHour: 30, quietEndHour: -3, threshold: "infoo", dailyCap: 7.9 },
      timeouts: { newsMin: 999 },
      notify: { news: { imessage: "off" }, youtube: { email: false } },
      unknown: { x: 1 },
    })
  );
  const s = ts.getTabSettings();
  assert.equal(s.youtube.freshDays, 4, "타입 오류 → 기본값");
  assert.equal(s.youtube.watchedExcludeDays, 5, "정상 값은 그대로");
  assert.equal(s.events.verifyDates, config.eventsVerifyDates);
  assert.equal(s.stockPulse.quietStartHour, 23, "0~23 클램프(config.ts clampHour 원칙)");
  assert.equal(s.stockPulse.quietEndHour, 0);
  // 기본값이 info 여도 깨진 값은 important 로 접는다 — info 로 떨어지면 참고 등급까지 문자로 나간다.
  assert.equal(s.stockPulse.threshold, "important");
  assert.equal(s.stockPulse.dailyCap, 7, "정수로 자른다");
  assert.equal(s.timeouts.newsMin, 60, "상한으로 자른다");
  assert.equal(s.notify.news.imessage, true, "불리언 아님 → 기본값");
  assert.equal(s.notify.youtube.email, false);
});

// ── 엄격 쓰기: 거부 ──

test("범위 밖·정수 아님·타입 오류·알 수 없는 항목은 throw 하고 파일을 바꾸지 않는다", () => {
  ts.saveTabSettings({ youtube: { freshDays: 9 } });
  const before = fs.readFileSync(STORE, "utf8");
  const bad: unknown[] = [
    { youtube: { freshDays: 0 } },
    { youtube: { freshDays: 31 } },
    { youtube: { freshDays: 2.5 } },
    { youtube: { freshDays: "7" } },
    { stockPulse: { quietStartHour: 24 } },
    { stockPulse: { threshold: "high" } },
    { stockPulse: { threshold: "Urgent" } },
    { events: { verifyDates: "true" } },
    { timeouts: { stockPulseMin: 31 } },
    { timeouts: { newsMin: 0 } },
    { stock: { historyRetentionDays: 7 } },
    { notify: { lotto: { email: true } } },
    { notify: { news: { sms: true } } },
    { notify: { news: { email: 1 } } },
    { youtube: { unknownField: 1 } },
    { secrets: { gmailAddress: "x" } },
    { youtube: 5 },
    JSON.parse('{"__proto__":{"polluted":true}}'),
    JSON.parse('{"youtube":{"__proto__":{"freshDays":1}}}'),
    { constructor: {} },
    [],
  ];
  for (const b of bad) {
    assert.throws(() => ts.saveTabSettings(b as never), Error, JSON.stringify(b));
  }
  assert.equal(fs.readFileSync(STORE, "utf8"), before);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("거부 사유는 한국어 이름과 허용 범위를 담는다", () => {
  assert.throws(() => ts.saveTabSettings({ youtube: { freshDays: 99 } }), /유튜브 신선도: 1~30일 사이의 정수/);
  assert.throws(() => ts.saveTabSettings({ stockPulse: { threshold: "x" as never } }), /urgent \/ important \/ info/);
});

// ── 알림 AND 게이트 ──

test("isTabNotifyEnabled: 탭 스위치 AND 전역 스위치", () => {
  assert.equal(ts.isTabNotifyEnabled("news", "imessage"), true);
  assert.equal(ts.isTabNotifyEnabled("stockPulse", "email"), false, "탭에 없는 채널");

  ts.saveTabSettings({ notify: { news: { imessage: false } } });
  assert.equal(ts.isTabNotifyEnabled("news", "imessage"), false, "탭 off");
  assert.equal(ts.isTabNotifyEnabled("news", "email"), true, "다른 채널은 영향 없음");

  ts.saveTabSettings({ notify: { news: { imessage: true } } });
  config.notify.imessage = false;
  assert.equal(ts.isTabNotifyEnabled("news", "imessage"), false, "전역 off 면 탭 on 이어도 꺼짐");
  globalOn();
  config.notify.imessageTo = "";
  assert.equal(ts.isTabNotifyEnabled("news", "imessage"), false, "수신자 없음 = 전역 미설정");
  globalOn();
  config.notify.email = false;
  assert.equal(ts.isTabNotifyEnabled("news", "email"), false);
  assert.equal(ts.getTabSettingsResponse().globalChannels.email, false);
});

test("발송 함수: 탭 off → 미발송, 전역 off → 탭 on 이어도 미발송, 둘 다 on → 발송", async () => {
  assert.equal(await sendNewsIMessage(NEWS), true);
  assert.equal(sent.length, 1);

  ts.saveTabSettings({ notify: { news: { imessage: false } } });
  assert.equal(await sendNewsIMessage(NEWS), false);
  assert.equal(sent.length, 1, "탭 off 면 발송기를 부르지 않는다");

  ts.saveTabSettings({ notify: { news: { imessage: true } } });
  config.notify.imessage = false;
  assert.equal(await sendNewsIMessage(NEWS), false);
  assert.equal(sent.length, 1, "전역 off 면 탭 on 이어도 발송기를 부르지 않는다");
});

test("메일: 탭 off·전역 off 모두 Gmail API 를 부르지 않는다", async () => {
  ts.saveTabSettings({ notify: { news: { email: false } } });
  assert.equal(await sendNewsEmail(NEWS), false);
  ts.saveTabSettings({ notify: { news: { email: true } } });
  config.notify.email = false;
  assert.equal(await sendNewsEmail(NEWS), false);
  assert.equal(fetchCalls, 0);
});

test("펄스 문자: 탭 off 는 발송 게이트만 끈다 — 실행 게이트(isPulseNotifyEnabled)는 전역만 본다", async () => {
  assert.equal(isPulseNotifyEnabled(), true);
  assert.equal(isPulseTextEnabled(), true);
  assert.equal(await sendPulseIMessage(IMPACT), true);
  ts.saveTabSettings({ notify: { stockPulse: { imessage: false } } });
  assert.equal(isPulseNotifyEnabled(), true, "탭 off 여도 펄스는 실행한다(판정만 기록)");
  assert.equal(isPulseTextEnabled(), false);
  assert.equal(await sendPulseIMessage(IMPACT), false);
  assert.equal(sent.length, 1);
  config.notify.imessage = false;
  assert.equal(isPulseNotifyEnabled(), false, "전역 off 면 실행 자체를 건너뛴다");
});

test("가동 중단 알림: 탭 off 면 '미설정 또는 꺼짐'으로 건너뛴다", async () => {
  assert.equal(uptimeIMessageEnabled(), true);
  ts.saveTabSettings({ notify: { uptime: { imessage: false } } });
  assert.equal(uptimeIMessageEnabled(), false);
  const ev = { id: "t1", severity: "사고", ackedAt: null, notified: { imessage: false, at: null, queuedUntil: null } };
  const r = await notifyDowntimeEvent(ev as never);
  assert.equal(r.outcome, "skipped");
  assert.match(r.reason, /미설정 또는 꺼짐/);
  assert.equal(sent.length, 0);
});

// ── 저장 직후 소비처가 새 값을 쓴다 ──

test("펄스 문턱·상한은 저장 직후 다음 호출부터 새 값", () => {
  assert.equal(pulseThreshold(), "info");
  ts.saveTabSettings({ stockPulse: { threshold: "urgent", dailyCap: 3, perSymbolCap: 1, macroCap: 0 } });
  assert.equal(pulseThreshold(), "urgent");
  assert.deepEqual(PULSE_CAPS(), { perSymbolCap: 1, dailyCap: 3, macroCap: 0 });
});
