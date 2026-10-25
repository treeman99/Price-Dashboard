/**
 * 가동 중단 알림 **배선**(src/uptime/index.ts) — 대시보드 '가동 중단 알림' 탭 스위치가 합성 루트의
 * 두 판정(일지 "알림:" 줄, 60초 스윕 해제)까지 닿는지 확인한다.
 *
 * 발송 게이트(uptime/notify.ts)만 탭을 따르고 합성 루트가 전역 설정만 보면, 탭을 끈 뒤에도 일지는
 * "발송 준비 중"으로 거짓말을 하고 스윕은 보낼 수 없는 사건을 1분마다 영원히 훑는다.
 *
 * ★ 실제 data/ 를 건드리지 않는다(config 가 import 시점에 DB_PATH 를 읽으므로 먼저 갈아끼운다).
 * ★ 실제 문자가 나가지 않는다 — 발송기를 갈아끼운다. 켠 스윕 타이머는 각 테스트 끝에서 끈다.
 */
import assert from "node:assert/strict";
import { test, after, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-index-notify-test-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");

const { config } = await import("../config.ts");
const { saveTabSettings } = await import("../settings/tab-settings.ts");
const { __setIMessageTransportForTest } = await import("../notify/imessage.ts");
const { __testing } = await import("./index.ts");
const { recordDowntimeEvent, listDowntimeEvents } = await import("./store.ts");
type Ev = Parameters<typeof recordDowntimeEvent>[0];

const sent: string[] = [];
__setIMessageTransportForTest(async (_to, body) => {
  sent.push(body);
});
config.notify.imessage = true;
config.notify.imessageTo = "+820000000000";
// 조용 시간 창을 없앤다(시작=끝) — 테스트가 밤에 돌아도 '보류'가 아니라 '발송' 경로를 탄다.
saveTabSettings({ stockPulse: { quietStartHour: 0, quietEndHour: 0 } });

afterEach(() => __testing.disarmNotifySweep());
after(() => {
  __setIMessageTransportForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 손실 1건(evaluated) = '사고' 등급. 재평가 유예가 이미 지난 과거 사건이다. */
function incident(): Ev {
  const t0 = new Date(2026, 7, 2, 0, 29, 10).getTime();
  return {
    source: "tick",
    verdict: { cause: "sleep", confidence: "확실", gapExact: true },
    gapStartMs: t0,
    gapEndMs: t0 + 10 * 60_000,
    evidence: {
      bootEpochBefore: 1785245050,
      bootEpochNow: 1785245050,
      bootChanged: false,
      bootFromFallback: false,
      prevPid: 1,
      currentPid: 1,
      sameProcess: true,
      prevBeaconMode: "alive",
      lastCleanShutdownEpoch: 1785244805,
      shutdownLogParsed: true,
      panicAtEpoch: null,
      panicDirReadable: true,
      pmsetParsed: true,
      pmsetLines: [],
      darkWakeCount: 0,
      batteryAtGapStart: { percent: null, onBattery: null },
      cpuSecondsInGap: null,
      dutyPercent: null,
      beaconWriteFailures: 0,
      clockSuspect: false,
    },
    missed: [
      {
        tab: "news",
        label: "뉴스",
        slot: "08:00",
        date: "2026-08-02",
        scheduledAt: "2026-08-02T08:00:00+09:00",
        evaluated: true,
        recovered: false,
        recoveredAt: null,
        note: null,
      },
    ],
  };
}

test("탭 off 면 일지 '알림:' 줄이 '미설정'이 되고 스윕이 꺼진다 — 탭 on 이면 발송되고 스윕이 유지된다", async () => {
  const rec = recordDowntimeEvent(incident(), __testing.narrator);
  assert.ok(rec, "사건이 기록되지 않았다");
  assert.equal(rec.event.severity, "사고");

  // ── 탭 off ──
  saveTabSettings({ notify: { uptime: { imessage: false } } });
  assert.match(__testing.narrator.journalEntry(rec.event), /알림:\s*미설정/);

  __testing.armNotifySweep();
  assert.equal(__testing.isNotifySweepArmed(), true);
  await __testing.runNotifySweep();
  assert.equal(__testing.isNotifySweepArmed(), false, "보낼 수 없으면 스윕을 끈다");
  assert.equal(sent.length, 0);
  assert.equal(listDowntimeEvents()[0]!.notified.imessage, false);

  // ── 탭 on(전역 on) — 같은 사건이 발송되고, 그 회차에는 스윕이 유지된다 ──
  saveTabSettings({ notify: { uptime: { imessage: true } } });
  assert.match(__testing.narrator.journalEntry(rec.event), /알림:\s*발송 준비 중/);

  __testing.armNotifySweep();
  await __testing.runNotifySweep();
  assert.equal(sent.length, 1, "탭 on 이면 보류 사건을 보낸다");
  assert.equal(__testing.isNotifySweepArmed(), true, "보낼 사건이 있던 회차에는 스윕을 끄지 않는다");
  assert.equal(listDowntimeEvents()[0]!.notified.imessage, true);
});
