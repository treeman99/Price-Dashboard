// 증시 알림 원장 — '꺼진 채널'과 '발송 실패'의 구분 회귀 테스트(2026-10-25 QA H1).
//
// 실제 버그: 대시보드에서 증시 탭 메일(또는 문자) 알림을 끄면 send 함수가 false 를 돌려주고, 알림 블록이
// 그 false 를 그대로 원장 플래그로 남겼다. 원장 플래그의 뜻은 '발송 성공'이 아니라 '더 보낼 것 없음'
// (notify-ledger SLOT_HANDLED)이라, 그 슬롯은 영원히 미발송으로 보였고 catch-up 이 자정까지 30분마다
// 증시 브리핑 전체(LLM)를 다시 수집했다. 전역 off(NOTIFY_IMESSAGE=false 등)에서도 있던 잠복 결함이다.
//
// ★ 실제 data/ 를 건드리지 않는다: config 는 import 시점에 DB_PATH 를 읽으므로 동적 import 전에 임시 경로를
//   심는다(google-oauth.json·mail-alert.json·tab-settings.json 기본 위치도 함께 임시 디렉터리로 옮겨진다).
// ★ 실제 발송이 없다: 개발 머신 .env 에 실제 수신 번호·Gmail 자격증명이 있으므로 iMessage 발송기,
//   재인증 경고 발송기, fetch(Gmail API) 를 전부 갈아끼운다.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StockSnapshot } from "../../shared/types.ts";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-stock-notify-slot-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

const { config } = await import("../config.ts");
const { saveTabSettings } = await import("../settings/tab-settings.ts");
const { __setIMessageTransportForTest } = await import("../notify/imessage.ts");
const { __setIMessageSenderForTest } = await import("../notify/mailer.ts");
const { __setStorePathForTest, disconnect } = await import("../notify/google-auth.ts");
const { sendStockEmail, sendStockIMessage, stockChannelOffReason } = await import("../notify/stock-email.ts");
const { notifySlotChannels } = await import("./stock.ts");
const { finishStockRun } = await import("../db/repo.ts");
const ledger = await import("./notify-ledger.ts");

const DATE = "2026-10-26";
const TAB_STORE = path.join(tmpDir, "tab-settings.json");
const OAUTH_STORE = path.join(tmpDir, "google-oauth.json");

/** 문자 발송기: 기본은 성공, failText 면 osascript 실패처럼 throw. */
const texts: string[] = [];
let failText = false;
__setIMessageTransportForTest(async (_to, body) => {
  if (failText) throw new Error("osascript -1743 (테스트)");
  texts.push(body);
});
/** 재인증 경고(메일이 죽었을 때 문자로 알림)도 실제로 나가면 안 된다. */
const reauthAlerts: string[] = [];
__setIMessageSenderForTest(async (t: string) => void reauthAlerts.push(t));

/** Gmail API: 기본은 200, mailStatus 를 바꾸면 그 상태로 실패. */
const realFetch = globalThis.fetch;
let mailCalls = 0;
let mailStatus = 200;
globalThis.fetch = (async () => {
  mailCalls++;
  return {
    ok: mailStatus === 200,
    status: mailStatus,
    json: async () => ({ id: "t1" }),
    text: async () => (mailStatus === 200 ? "{}" : '{"error":"bad request (테스트)"}'),
  };
}) as unknown as typeof fetch;

after(async () => {
  __setIMessageTransportForTest(null);
  __setIMessageSenderForTest(null);
  __setStorePathForTest(null);
  globalThis.fetch = realFetch;
  const { closeDb } = await import("../db/index.ts");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 전역 두 채널 켜짐 + Google 연결됨(토큰 유효) + 탭 스위치 기본값(켜짐). */
function allOn(): void {
  config.notify.email = true;
  config.notify.gmailAddress = "tester@gmail.com";
  config.notify.googleClientId = "test-client-id";
  config.notify.googleClientSecret = "test-client-secret";
  config.notify.imessage = true;
  config.notify.imessageTo = "+820000000000";
  fs.writeFileSync(
    OAUTH_STORE,
    JSON.stringify({
      refreshToken: "rt-1",
      accessToken: "at-1",
      expiresAt: Date.now() + 3600_000,
      email: "tester@gmail.com",
      needsReauth: false,
      lastError: null,
      lastSuccessAt: new Date().toISOString(),
    }),
    "utf8"
  );
  __setStorePathForTest(OAUTH_STORE); // 토큰 상태 메모리 캐시를 비워 방금 쓴 파일을 다시 읽게 한다
}

beforeEach(() => {
  fs.rmSync(TAB_STORE, { force: true });
  allOn();
  texts.length = 0;
  reauthAlerts.length = 0;
  failText = false;
  mailCalls = 0;
  mailStatus = 200;
});

function snap(): StockSnapshot {
  return {
    market: "kr",
    date: DATE,
    sessionDate: DATE,
    updatedAt: `${DATE}T08:05:00+09:00`,
    source: "llm",
    closed: false,
    closedReason: null,
    indices: [{ name: "코스피", value: 3245.12, changePct: 0.8, history: [], comment: "", outlook: "", rationale: "" }],
    news: [],
    analyses: [],
    watchlist: [],
    disclaimer: "투자 권유 아님",
  } as unknown as StockSnapshot;
}

/**
 * stock.ts 6단계 알림 블록과 같은 순서: 원장에서 그 슬롯의 플래그를 읽고 → 채널 처리 → 맵 전체를 재기록.
 * 돌려주는 needsCatchup 이 scheduler.checkStockCatchup 의 원장 게이트다.
 */
async function runSlot(slot: string) {
  const map = ledger.loadNotifiedMap(DATE, "kr");
  const flags = await notifySlotChannels(snap(), slot, ledger.slotNotified(map, slot));
  finishStockRun(DATE, "kr", true, { source: "llm", notifiedBySlot: ledger.mergeNotified(map, slot, flags) });
  return { flags, needsCatchup: ledger.slotNeedsCatchup(DATE, "kr", slot) };
}

test("기준: 두 채널 다 켜짐 → 메일·문자 각 1건 발송, 슬롯 닫힘", async () => {
  const r = await runSlot("01:00");
  assert.deepEqual(r.flags, { email: true, imessage: true });
  assert.equal(r.needsCatchup, false);
  assert.equal(mailCalls, 1);
  assert.equal(texts.length, 1);
});

test("탭 메일 off(대시보드) → 메일은 안 보내고 슬롯 종료 처리, slotNeedsCatchup=false", async () => {
  saveTabSettings({ notify: { stock: { email: false } } });
  const r = await runSlot("02:00");
  assert.deepEqual(r.flags, { email: true, imessage: true }, "꺼진 채널은 SLOT_HANDLED(=더 보낼 것 없음)");
  assert.equal(r.needsCatchup, false, "QA H1: 이전에는 true 라 30분마다 전체 재수집");
  assert.equal(mailCalls, 0, "꺼진 채널로 Gmail API 를 부르면 안 된다");
  assert.equal(texts.length, 1, "켜진 채널(문자)은 그대로 발송");
});

test("탭 문자 off(대시보드) → 문자는 안 보내고 슬롯 종료 처리", async () => {
  saveTabSettings({ notify: { stock: { imessage: false } } });
  const r = await runSlot("03:00");
  assert.deepEqual(r.flags, { email: true, imessage: true });
  assert.equal(r.needsCatchup, false);
  assert.equal(texts.length, 0);
  assert.equal(mailCalls, 1);
});

test("전역 off(NOTIFY_EMAIL=false / NOTIFY_IMESSAGE=false)도 같은 규칙 — 슬롯 닫힘", async () => {
  config.notify.email = false;
  const a = await runSlot("04:00");
  assert.equal(a.needsCatchup, false, "전역 메일 off");
  assert.equal(mailCalls, 0);

  allOn();
  config.notify.imessage = false;
  const b = await runSlot("04:30");
  assert.equal(b.needsCatchup, false, "전역 문자 off");
  assert.equal(texts.length, 1, "04:00 슬롯의 문자 1건뿐 — 04:30 은 안 보냄");
});

test("메일 자격증명 미설정 · iMessage 수신자 없음도 '꺼짐' — 슬롯 닫힘", async () => {
  config.notify.gmailAddress = "";
  config.notify.imessageTo = "";
  const r = await runSlot("05:00");
  assert.deepEqual(r.flags, { email: true, imessage: true });
  assert.equal(r.needsCatchup, false);
  assert.equal(mailCalls, 0);
  assert.equal(texts.length, 0);

  allOn();
  config.notify.googleClientId = "";
  assert.equal((await runSlot("05:30")).needsCatchup, false, "OAuth 클라이언트 미설정도 메일 미설정");
  assert.equal(mailCalls, 0);
});

test("실제 발송 실패(문자 예외·Gmail API 오류)는 열어 둔다 → slotNeedsCatchup=true, 재시도는 실패 채널만", async () => {
  failText = true;
  mailStatus = 400;
  const r = await runSlot("06:00");
  assert.deepEqual(r.flags, { email: false, imessage: false });
  assert.equal(r.needsCatchup, true, "실패는 재시도 대상");

  // 다음 catch-up: 메일은 복구, 문자는 여전히 실패 → 메일만 닫히고 슬롯은 계속 열림.
  mailStatus = 200;
  const r2 = await runSlot("06:00");
  assert.deepEqual(r2.flags, { email: true, imessage: false });
  assert.equal(r2.needsCatchup, true);

  // 문자 복구 → 문자만 보내고(메일 중복 없음) 슬롯 닫힘.
  failText = false;
  const calls = mailCalls;
  const r3 = await runSlot("06:00");
  assert.deepEqual(r3.flags, { email: true, imessage: true });
  assert.equal(r3.needsCatchup, false);
  assert.equal(mailCalls, calls, "이미 닫힌 메일 채널은 다시 보내지 않는다");
  assert.equal(texts.length, 1);
});

test("발송 실패로 열린 슬롯에서 그 채널을 끄면 다음 catch-up 이 보내지 않고 닫는다", async () => {
  failText = true;
  assert.equal((await runSlot("07:00")).needsCatchup, true);
  saveTabSettings({ notify: { stock: { imessage: false } } });
  failText = false;
  const r = await runSlot("07:00");
  assert.equal(r.needsCatchup, false);
  assert.equal(texts.length, 0);
});

test("Google 미연결(자격증명은 있음)은 '꺼짐'이 아니다 — 시도·실패로 열어 둬야 재연결 뒤 보충된다", async () => {
  disconnect(); // 대시보드 '연결 해제'와 같은 상태: 토큰 파일·캐시 없음, .env 자격증명은 그대로
  const r = await runSlot("08:00");
  assert.equal(r.flags.email, false);
  assert.equal(r.needsCatchup, true);
  assert.equal(stockChannelOffReason("email"), null);
  assert.equal(reauthAlerts.length, 1, "재인증 경고는 (스텁된) 문자로 나간다");
});

test("stockChannelOffReason: send 함수 조기 반환과 같은 판정 — 꺼짐이면 사유, 켜짐이면 null", async () => {
  assert.equal(stockChannelOffReason("email"), null);
  assert.equal(stockChannelOffReason("imessage"), null);

  saveTabSettings({ notify: { stock: { email: false, imessage: false } } });
  assert.match(stockChannelOffReason("email") ?? "", /대시보드 운영 설정/);
  assert.match(stockChannelOffReason("imessage") ?? "", /대시보드 운영 설정/);
  assert.equal(await sendStockEmail(snap()), false);
  assert.equal(await sendStockIMessage(snap()), false);
  assert.equal(mailCalls + texts.length, 0);

  fs.rmSync(TAB_STORE, { force: true });
  config.notify.email = false;
  config.notify.imessage = false;
  assert.match(stockChannelOffReason("email") ?? "", /NOTIFY_EMAIL/);
  assert.match(stockChannelOffReason("imessage") ?? "", /NOTIFY_IMESSAGE/);

  allOn();
  config.notify.gmailAddress = "";
  config.notify.imessageTo = "";
  assert.match(stockChannelOffReason("email") ?? "", /메일 설정 미완료/);
  assert.match(stockChannelOffReason("imessage") ?? "", /IMESSAGE_TO/);
  assert.equal(await sendStockEmail(snap()), false);
  assert.equal(await sendStockIMessage(snap()), false);
  assert.equal(mailCalls + texts.length, 0);
});
