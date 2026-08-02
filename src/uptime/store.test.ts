/**
 * `src/uptime/store.ts` 회귀 테스트 (명세 §10.5).
 *
 * 검증 대상 4가지:
 * 1. §3.6 병합 — 15분 이내 동일 cause / 같은 Sleep 윈도. 사건 1건으로, id 불변, gapEnd 연장.
 * 2. §5.2 회전 — 101건 → 100건, 최신이 앞.
 * 3. §5.3 일지 — 헤더 1회, `무시` 는 안 적힘, 200건 상한, tmp 잔여 없음(부분 기록 없음).
 * 4. ack / 알림 상태 / `getDowntimeView()`(§6.5 배너·배지 분리).
 *
 * ★ 실제 `data/` 를 절대 건드리지 않는다. `config` 는 import 시점에 `DB_PATH` 를 읽으므로
 *   store 를 불러오기 **전에** 임시 경로로 갈아끼운다(`src/util/model-store.test.ts:9` 관례).
 *   dotenv 는 이미 설정된 env 를 덮어쓰지 않으므로 안전하다.
 */

import assert from "node:assert/strict";
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-store-test-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");

const {
  DOWNTIME_JOURNAL_PATH,
  DOWNTIME_LEDGER_PATH,
  ackDowntimeEvent,
  findDowntimeMergeTarget,
  getDowntimeView,
  listDowntimeEvents,
  loadDowntimeLedger,
  markDowntimeNotified,
  patchDowntimeEvent,
  recordDowntimeEvent,
} = await import("./store.ts");
type StoreModule = typeof import("./store.ts");
type Narrator = Parameters<StoreModule["recordDowntimeEvent"]>[1];

const { JOURNAL_MAX_ENTRIES, LEDGER_MAX_EVENTS } = await import("../../shared/uptime.ts");
type Ev = Parameters<StoreModule["recordDowntimeEvent"]>[0];

// ── 픽스처 ──────────────────────────────────────────────────────────────────

/** 실측 재현용 기준 시각(2026-08-02 00:29:10 KST 사고). 테스트 안에서만 쓴다. */
const T0 = new Date(2026, 7, 2, 0, 29, 10).getTime();

function evidence(over: Partial<Ev["evidence"]> = {}): Ev["evidence"] {
  return {
    bootEpochBefore: 1785245050,
    bootEpochNow: 1785245050,
    bootChanged: false,
    bootFromFallback: false,
    prevPid: 91880,
    currentPid: 91880,
    sameProcess: true,
    prevBeaconMode: "alive",
    lastCleanShutdownEpoch: 1785244805,
    shutdownLogParsed: true,
    panicAtEpoch: null,
    panicDirReadable: true,
    pmsetParsed: true,
    pmsetLines: [{ at: 1785252550, kind: "Sleep", reason: "Clamshell Sleep", power: "Batt", charge: 80 }],
    darkWakeCount: 68,
    batteryAtGapStart: { percent: 80, onBattery: true },
    cpuSecondsInGap: 27.8,
    dutyPercent: 0.07,
    beaconWriteFailures: 0,
    clockSuspect: false,
    ...over,
  };
}

function missedSlot(over: Partial<Ev["missed"][number]> = {}): Ev["missed"][number] {
  return {
    tab: "news",
    label: "뉴스",
    slot: "08:00",
    date: "2026-08-02",
    scheduledAt: "2026-08-02T08:00:00+09:00",
    evaluated: true,
    recovered: false,
    recoveredAt: null,
    note: null,
    ...over,
  };
}

function input(over: Partial<Ev> = {}): Ev {
  return {
    source: "tick",
    verdict: { cause: "sleep", confidence: "확실", gapExact: true },
    gapStartMs: T0,
    gapEndMs: T0 + 10 * 60_000,
    evidence: evidence(),
    missed: [],
    ...over,
  };
}

/**
 * 가짜 내레이터. 실제 문구는 `narrate.ts` 소유라 여기서는 **계약만** 지킨다 —
 * 일지 블록의 첫 줄이 `[YYYY-MM-DD HH:mm …` 으로 시작해야 재작성이 옛 기록과 새 기록을
 * 시각으로 가를 수 있다(store 의 `blockAtMs`).
 */
const narrator: Narrator = {
  narrate: (e) => ({
    headline: `H:${e.cause}:${e.gapMinutes}분`,
    body: `B:${e.missed.length}건`,
    reasonLine: `판정근거: ${e.confidence}`,
  }),
  journalEntry: (e) => {
    const d = new Date(Date.parse(e.gapEnd));
    const stamp =
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` +
      ` ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return [
      `[${stamp} KST] ${e.cause} — ${e.headline}`,
      `  무슨 일: ${e.body}`,
      `  판정근거: ${e.reasonLine}`,
      `  알림: ${e.notified.imessage ? "발송 완료" : "보내지 않음"}`,
    ].join("\n");
  },
};

/** 각 테스트가 앞 테스트의 저장 상태를 물려받지 않게 한다. `data/` 가 아니라 tmpDir 다. */
function reset(): void {
  fs.rmSync(DOWNTIME_LEDGER_PATH, { force: true });
  fs.rmSync(DOWNTIME_JOURNAL_PATH, { force: true });
}

/** 일지 파일을 헤더 줄 수와 항목 블록으로 쪼갠다(검증용). */
function readJournal(): { headerLines: string[]; blocks: string[] } {
  const text = fs.readFileSync(DOWNTIME_JOURNAL_PATH, "utf8");
  const lines = text.split("\n");
  const headerLines = lines.filter((l) => l.startsWith("#"));
  const blocks = text
    .split(/\n(?=\[)/)
    .slice(1)
    .map((b) => b.trimEnd())
    .filter(Boolean);
  return { headerLines, blocks };
}

// ── 1. 기본 기록 ─────────────────────────────────────────────────────────────

test("사건을 기록하면 원장 1건 + 문구가 내레이터로 채워진다", () => {
  reset();
  const r = recordDowntimeEvent(input({ missed: [missedSlot()] }), narrator);
  assert.ok(r);
  assert.equal(r.merged, false);
  assert.equal(r.event.severity, "사고"); // evaluated 손실 1건
  assert.equal(r.event.gapMinutes, 10);
  assert.equal(r.event.headline, "H:sleep:10분");
  assert.equal(r.event.recoveryState, "복구중");
  assert.equal(r.event.reevalCount, 0);
  assert.deepEqual(r.event.notified, { imessage: false, at: null, queuedUntil: null });
  // id 는 gapStart 기준 안정 키(§5.2)
  assert.equal(r.event.id, r.event.gapStart);
  assert.equal(loadDowntimeLedger().events.length, 1);
});

test("MIN_GAP_MS 미만은 원장의 마지막 문지기가 거절한다(§3.2 Q0)", () => {
  reset();
  const r = recordDowntimeEvent(input({ gapEndMs: T0 + 30_000 }), narrator);
  assert.equal(r, null);
  assert.equal(loadDowntimeLedger().events.length, 0);
});

// ── 2. 병합 (§3.6) ──────────────────────────────────────────────────────────

test("15분 이내 동일 cause 두 공백 → 사건 1건, id 불변, gapEnd 연장", () => {
  reset();
  const first = recordDowntimeEvent(
    input({ gapStartMs: T0, gapEndMs: T0 + 5 * 60_000, missed: [missedSlot()] }),
    narrator
  );
  assert.ok(first);
  const second = recordDowntimeEvent(
    input({
      gapStartMs: T0 + 10 * 60_000,
      gapEndMs: T0 + 20 * 60_000,
      missed: [missedSlot({ tab: "youtube", label: "유튜브 소식", slot: "09:00" })],
    }),
    narrator
  );
  assert.ok(second);
  assert.equal(second.merged, true);
  assert.equal(second.event.id, first.event.id, "병합해도 id 는 바뀌지 않는다");
  assert.equal(second.event.gapStart, first.event.gapStart);
  assert.equal(Date.parse(second.event.gapEnd), T0 + 20 * 60_000, "gapEnd 가 뒤로 연장된다");
  assert.equal(second.event.gapMinutes, 20);
  // 손실은 합집합 — 앞 조각의 뉴스 08:00 이 사라지면 안 된다
  assert.deepEqual(
    second.event.missed.map((m) => m.tab).sort(),
    ["news", "youtube"]
  );
  assert.equal(loadDowntimeLedger().events.length, 1, "사건은 하나로 뭉친다");
});

test("병합해도 알림·확인 상태는 승계한다(알림 폭탄·재발송 방지)", () => {
  reset();
  const first = recordDowntimeEvent(input({ missed: [missedSlot()] }), narrator);
  assert.ok(first);
  markDowntimeNotified(first.event.id, { imessage: true, at: "2026-08-02T02:15:41.402Z" }, narrator);
  const merged = recordDowntimeEvent(
    input({ gapStartMs: T0 + 12 * 60_000, gapEndMs: T0 + 25 * 60_000, missed: [missedSlot()] }),
    narrator
  );
  assert.ok(merged);
  assert.equal(merged.merged, true);
  assert.equal(merged.event.notified.imessage, true, "이미 보낸 알림이 병합으로 되살아나면 안 된다");
});

test("15분을 넘거나 cause 가 다르면 병합하지 않는다", () => {
  reset();
  recordDowntimeEvent(input({ gapStartMs: T0, gapEndMs: T0 + 5 * 60_000 }), narrator);
  // 20분 뒤 시작 → 창 밖
  const far = recordDowntimeEvent(
    input({ gapStartMs: T0 + 25 * 60_000, gapEndMs: T0 + 30 * 60_000 }),
    narrator
  );
  assert.ok(far);
  assert.equal(far.merged, false);
  assert.equal(loadDowntimeLedger().events.length, 2);
  // 최신이 앞(§5.2)
  assert.equal(Date.parse(loadDowntimeLedger().events[0].gapStart), T0 + 25 * 60_000);
});

test("cause 가 달라도 같은 Sleep 윈도 안이면 병합한다(§3.6 조건 2)", () => {
  reset();
  const first = recordDowntimeEvent(input({ gapStartMs: T0, gapEndMs: T0 + 5 * 60_000 }), narrator);
  assert.ok(first);
  // 두 공백을 모두 덮는 Sleep 윈도 하나(§4.4 커버 정의: 양끝 ±120초 여유)
  const window: NonNullable<Ev["sleepWindows"]>[number] = {
    startSec: Math.floor(T0 / 1000) - 60,
    endSec: Math.floor(T0 / 1000) + 60 * 60,
    reason: "Clamshell Sleep",
    power: "Batt",
    chargeStart: 80,
    chargeEnd: 48,
  };
  const merged = recordDowntimeEvent(
    input({
      gapStartMs: T0 + 30 * 60_000,
      gapEndMs: T0 + 40 * 60_000,
      verdict: { cause: "app-gap", confidence: "추정", gapExact: true },
      sleepWindows: [window],
    }),
    narrator
  );
  assert.ok(merged);
  assert.equal(merged.merged, true);
  assert.equal(merged.event.id, first.event.id);
  assert.equal(loadDowntimeLedger().events.length, 1);
});

test("findDowntimeMergeTarget 은 빈 원장에서 null", () => {
  reset();
  assert.equal(
    findDowntimeMergeTarget({
      verdict: { cause: "sleep", confidence: "확실", gapExact: true },
      gapStartMs: T0,
      gapEndMs: T0 + 60_000,
    }),
    null
  );
});

// ── 3. 회전 (§5.2) ──────────────────────────────────────────────────────────

test(`원장 ${LEDGER_MAX_EVENTS + 1}건 → ${LEDGER_MAX_EVENTS}건으로 절삭, 최신이 앞`, () => {
  reset();
  const base = Date.now() - (LEDGER_MAX_EVENTS + 2) * 60 * 60_000;
  for (let i = 0; i <= LEDGER_MAX_EVENTS; i += 1) {
    const s = base + i * 60 * 60_000; // 1시간 간격 → 15분 병합 창 밖
    recordDowntimeEvent(input({ gapStartMs: s, gapEndMs: s + 2 * 60_000 }), narrator);
  }
  const events = loadDowntimeLedger().events;
  assert.equal(events.length, LEDGER_MAX_EVENTS);
  // 오래된 것부터 잘린다 → 남은 것 중 가장 오래된 것이 base 보다 뒤
  assert.ok(Date.parse(events[events.length - 1].gapStart) > base);
  // 최신이 앞
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(Date.parse(events[i - 1].gapStart) > Date.parse(events[i].gapStart));
  }
  assert.equal(listDowntimeEvents(5).length, 5);
});

test("180일보다 오래된 사건은 절삭되지만 최신 1건은 무조건 남는다", () => {
  reset();
  const old = Date.now() - 200 * 24 * 60 * 60_000;
  recordDowntimeEvent(input({ gapStartMs: old, gapEndMs: old + 5 * 60_000 }), narrator);
  // 아직 1건뿐이므로 최신 보호로 살아 있다
  assert.equal(loadDowntimeLedger().events.length, 1);
  const now = Date.now();
  recordDowntimeEvent(input({ gapStartMs: now - 5 * 60_000, gapEndMs: now }), narrator);
  const events = loadDowntimeLedger().events;
  assert.equal(events.length, 1, "200일 전 사건은 나이 절삭 대상");
  assert.ok(Date.parse(events[0].gapStart) > old);
});

// ── 4. 일지 (§5.3 / §6.1) ───────────────────────────────────────────────────

test("일지에는 영구 헤더가 1회만 있고 사건 항목이 뒤따른다", () => {
  reset();
  recordDowntimeEvent(input({ missed: [missedSlot()] }), narrator);
  const first = readJournal();
  assert.ok(first.headerLines.length >= 3, "한국어 헤더가 있어야 한다");
  assert.ok(first.headerLines[0].includes("가동 중단 기록"));
  assert.ok(first.headerLines.some((l) => l.includes("덮개")), "멘탈모델 교정 문장(§6.4)이 있어야 한다");
  assert.equal(first.blocks.length, 1);

  const t2 = Date.now();
  recordDowntimeEvent(
    input({ gapStartMs: t2, gapEndMs: t2 + 5 * 60_000, missed: [missedSlot({ slot: "10:00" })] }),
    narrator
  );
  const second = readJournal();
  assert.equal(second.headerLines.length, first.headerLines.length, "헤더가 두 번 적히면 안 된다");
  assert.equal(second.blocks.length, 2);
});

test("severity 가 '무시' 인 사건은 원장에만 남고 일지에는 적히지 않는다(§3.5)", () => {
  reset();
  // 손실 0 + 정상 원인 + 6시간 미만 → 무시
  const r = recordDowntimeEvent(input(), narrator);
  assert.ok(r);
  assert.equal(r.event.severity, "무시");
  assert.equal(loadDowntimeLedger().events.length, 1);
  assert.equal(fs.existsSync(DOWNTIME_JOURNAL_PATH), true, "헤더만 있는 파일은 생겨도 된다");
  assert.equal(readJournal().blocks.length, 0);
});

test("손실 0이어도 power-cut 은 '기록만' 으로 일지에 남는다(§3.5 / §12.3-3)", () => {
  reset();
  const r = recordDowntimeEvent(
    input({ verdict: { cause: "power-cut", confidence: "확실", gapExact: true } }),
    narrator
  );
  assert.ok(r);
  assert.equal(r.event.severity, "기록만");
  assert.equal(readJournal().blocks.length, 1);
});

test("일지는 tmp+rename 으로만 바뀐다 — 부분 기록도 tmp 잔여도 없다", () => {
  reset();
  for (let i = 0; i < 5; i += 1) {
    const s = T0 + i * 60 * 60_000;
    recordDowntimeEvent(
      input({ gapStartMs: s, gapEndMs: s + 5 * 60_000, missed: [missedSlot({ slot: `0${i}:00` })] }),
      narrator
    );
    // 매 회차마다 파일이 통째로 유효해야 한다(헤더 + 완결된 블록 i+1개)
    const j = readJournal();
    assert.ok(j.headerLines.length >= 3);
    assert.equal(j.blocks.length, i + 1);
    assert.ok(j.blocks.every((b) => b.includes("무슨 일:") && b.includes("알림:")));
  }
  const strays = fs.readdirSync(path.dirname(DOWNTIME_LEDGER_PATH)).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(strays, [], "tmp 파일이 남으면 안 된다");
  // 원장도 항상 유효한 JSON
  assert.ok(JSON.parse(fs.readFileSync(DOWNTIME_LEDGER_PATH, "utf8")).events.length > 0);
});

test(`일지는 ${JOURNAL_MAX_ENTRIES}항목을 넘지 않고 오래된 것부터 잘린다`, () => {
  reset();
  // 원장(100건)보다 많은 옛 항목은 원장에서 재생성할 수 없으므로 텍스트로 보존된다.
  // 그 보존분까지 합쳐 200 상한이 지켜지는지 본다.
  const legacy: string[] = [];
  for (let i = 0; i < 260; i += 1) {
    const d = new Date(2020, 0, 1, 0, 0, 0);
    d.setMinutes(d.getMinutes() + i);
    const stamp =
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` +
      ` ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    legacy.push(`[${stamp} KST] 절전 — 옛 기록 ${i}\n  무슨 일: …\n  알림: 보내지 않음`);
  }
  fs.mkdirSync(path.dirname(DOWNTIME_JOURNAL_PATH), { recursive: true });
  fs.writeFileSync(DOWNTIME_JOURNAL_PATH, `# 옛 헤더\n\n${legacy.join("\n\n")}\n`, "utf8");

  recordDowntimeEvent(input({ missed: [missedSlot()] }), narrator);
  const j = readJournal();
  assert.equal(j.blocks.length, JOURNAL_MAX_ENTRIES);
  // 가장 오래된 것이 잘렸고 방금 기록한 사건은 맨 뒤에 있다
  assert.ok(!j.blocks[0].includes("옛 기록 0"));
  assert.ok(j.blocks[j.blocks.length - 1].includes("H:sleep"));
});

test("원장에서 밀려난 옛 일지 항목은 텍스트로 보존된다", () => {
  reset();
  fs.mkdirSync(path.dirname(DOWNTIME_JOURNAL_PATH), { recursive: true });
  fs.writeFileSync(
    DOWNTIME_JOURNAL_PATH,
    "# 옛 헤더\n\n[2019-01-01 09:00 KST] 절전 — 아주 옛 기록\n  무슨 일: …\n",
    "utf8"
  );
  recordDowntimeEvent(input({ missed: [missedSlot()] }), narrator);
  const j = readJournal();
  assert.equal(j.blocks.length, 2);
  assert.ok(j.blocks[0].includes("아주 옛 기록"), "원장에 없는 옛 항목을 지우면 안 된다");
});

// ── 5. 패치 · 알림 · ack · 화면 상태 ────────────────────────────────────────

test("재평가 패치는 missed 를 교체하고 severity·문구·일지를 다시 만든다(§8.5)", () => {
  reset();
  const r = recordDowntimeEvent(input({ missed: [missedSlot()] }), narrator);
  assert.ok(r);
  const patched = patchDowntimeEvent(
    r.event.id,
    {
      missed: [missedSlot({ recovered: true, recoveredAt: "2026-08-02T11:21:00+09:00" })],
      recoveryState: "복구완료",
      reevalCount: 3,
    },
    narrator
  );
  assert.ok(patched);
  assert.equal(patched.recoveryState, "복구완료");
  assert.equal(patched.reevalCount, 3);
  assert.equal(patched.missed[0].recovered, true);
  assert.equal(patched.severity, "사고", "복구돼도 '놓쳤다'는 사실은 남는다");
  assert.equal(loadDowntimeLedger().events.length, 1);
  assert.equal(readJournal().blocks.length, 1, "패치가 항목을 늘리면 안 된다");
});

test("손실이 없어진 재평가는 severity 를 내린다", () => {
  reset();
  const r = recordDowntimeEvent(input({ missed: [missedSlot()] }), narrator);
  assert.ok(r);
  assert.equal(readJournal().blocks.length, 1);
  const patched = patchDowntimeEvent(r.event.id, { missed: [] }, narrator);
  assert.ok(patched);
  assert.equal(patched.severity, "무시");
  assert.equal(readJournal().blocks.length, 0, "무시로 내려가면 일지에서도 빠진다");
});

test("없는 id 패치는 null", () => {
  reset();
  assert.equal(patchDowntimeEvent("없는-id", { reevalCount: 1 }, narrator), null);
  assert.equal(markDowntimeNotified("없는-id", { imessage: true }), null);
  assert.equal(ackDowntimeEvent("없는-id"), null);
});

test("ack 는 확인 시각을 남기고 보류 중인 알림을 취소한다(§7-4)", () => {
  reset();
  const r = recordDowntimeEvent(input({ missed: [missedSlot()] }), narrator);
  assert.ok(r);
  markDowntimeNotified(r.event.id, { queuedUntil: "2026-08-02T07:00:00+09:00" });
  const acked = ackDowntimeEvent(r.event.id, narrator);
  assert.ok(acked);
  assert.ok(acked.ackedAt);
  assert.equal(acked.notified.queuedUntil, null, "확인한 사고를 조용시간 뒤에 또 보내면 안 된다");
  const again = ackDowntimeEvent(r.event.id);
  assert.equal(again?.ackedAt, acked.ackedAt, "최초 확인 시각을 덮어쓰지 않는다");
});

test("getDowntimeView: 배너는 '사고' 만, 배지는 '무시' 를 뺀 전부(§3.5 / §6.5)", () => {
  reset();
  const empty = getDowntimeView();
  assert.deepEqual(empty, { current: null, unackedCount: 0 });

  // 1) 무시 — 배너·배지 어디에도 안 나온다
  const t1 = Date.now() - 5 * 60 * 60_000;
  recordDowntimeEvent(input({ gapStartMs: t1, gapEndMs: t1 + 2 * 60_000 }), narrator);
  assert.deepEqual(getDowntimeView(), { current: null, unackedCount: 0 });

  // 2) 기록만(power-cut, 손실 0) — 배지만
  const t2 = Date.now() - 3 * 60 * 60_000;
  recordDowntimeEvent(
    input({
      gapStartMs: t2,
      gapEndMs: t2 + 5 * 60_000,
      verdict: { cause: "power-cut", confidence: "확실", gapExact: true },
    }),
    narrator
  );
  assert.equal(getDowntimeView().current, null);
  assert.equal(getDowntimeView().unackedCount, 1);

  // 3) 사고 — 배너 + 배지
  const t3 = Date.now() - 60 * 60_000;
  const acc = recordDowntimeEvent(
    input({ gapStartMs: t3, gapEndMs: t3 + 10 * 60_000, missed: [missedSlot()] }),
    narrator
  );
  assert.ok(acc);
  const view = getDowntimeView();
  assert.equal(view.current?.id, acc.event.id);
  assert.equal(view.unackedCount, 2);

  // 4) 확인하면 배너와 배지에서 모두 빠진다
  ackDowntimeEvent(acc.event.id);
  const after = getDowntimeView();
  assert.equal(after.current, null);
  assert.equal(after.unackedCount, 1);
});

// ── 6. 망가진 파일 ──────────────────────────────────────────────────────────

test("원장 JSON 이 깨지면 .broken 으로 보존하고 새 원장으로 계속 간다", () => {
  reset();
  fs.mkdirSync(path.dirname(DOWNTIME_LEDGER_PATH), { recursive: true });
  fs.writeFileSync(DOWNTIME_LEDGER_PATH, "{ 이건 JSON 이 아니다", "utf8");
  assert.deepEqual(loadDowntimeLedger().events, []);
  assert.ok(fs.existsSync(`${DOWNTIME_LEDGER_PATH}.broken`), "깨진 파일을 지우지 않고 옆에 남긴다");
  const r = recordDowntimeEvent(input({ missed: [missedSlot()] }), narrator);
  assert.ok(r, "손상 뒤에도 기록은 이어져야 한다");
  fs.rmSync(`${DOWNTIME_LEDGER_PATH}.broken`, { force: true });
});

// ── 7. 실제 narrate.ts 와의 배선 계약 ───────────────────────────────────────

test("실제 narrate.ts 를 꽂아도 §6.1 포맷 그대로 나온다(index.ts 배선 계약)", async () => {
  reset();
  const n = await import("./narrate.ts");
  // ★ index.ts 가 해야 할 배선을 그대로 재현한다. `DowntimeEvent` 는 구조적으로
  //   `NarrationInput` / `JournalEntryInput` 을 만족하므로 어댑터가 필요 없다.
  const real: Narrator = {
    narrate: (e) => n.narrate(e),
    journalEntry: (e) => n.renderJournalEntry(e, false),
    journalHeader: () => n.DOWNTIME_JOURNAL_HEADER,
    splitEntries: (text) => n.splitJournalEntries(text),
  };

  const r = recordDowntimeEvent(input({ gapEndMs: T0 + 645 * 60_000, missed: [missedSlot()] }), real);
  assert.ok(r);
  assert.equal(r.event.severity, "사고");
  const text = fs.readFileSync(DOWNTIME_JOURNAL_PATH, "utf8");
  for (const label of ["무슨 일:", "놓친 것:", "지금 상태:", "판정근거:", "알림:"]) {
    assert.ok(text.includes(label), `§6.1 항목 라벨 누락: ${label}`);
  }
  assert.ok(text.startsWith("# 가동 중단 기록"));
  // §5.3: 일지 시각은 전부 KST 한국어. UTC ISO 문자열이 새면 안 된다.
  const body = text.split("\n").filter((l) => !l.startsWith("#")).join("\n");
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(body), "일지 본문에 ISO/UTC 시각이 있으면 안 된다");

  // 두 번째 사건: 헤더는 한 번뿐이고 항목은 2개, 앞 항목이 중복되지 않는다.
  const t2 = T0 + 30 * 24 * 60 * 60_000;
  recordDowntimeEvent(
    input({
      gapStartMs: t2,
      gapEndMs: t2 + 20 * 60_000,
      verdict: { cause: "power-cut", confidence: "확실", gapExact: true },
    }),
    real
  );
  const after = fs.readFileSync(DOWNTIME_JOURNAL_PATH, "utf8");
  assert.equal(after.split("# 가동 중단 기록").length - 1, 1, "헤더는 파일당 1회");
  assert.equal(n.splitJournalEntries(after).length, 2);
});

test("내레이터가 splitEntries 를 주면 그것으로 옛 항목을 되읽는다", () => {
  reset();
  let used = 0;
  const withSplit: Narrator = {
    ...narrator,
    splitEntries: (text) => {
      used += 1;
      return text
        .split(/\n(?=\[)/)
        .filter((b) => b.startsWith("["))
        .map((b) => b.trimEnd());
    },
  };
  fs.mkdirSync(path.dirname(DOWNTIME_JOURNAL_PATH), { recursive: true });
  fs.writeFileSync(DOWNTIME_JOURNAL_PATH, "# 옛 헤더\n\n[2019-01-01 09:00 KST] 절전 — 옛것\n  무슨 일: …\n", "utf8");
  recordDowntimeEvent(input({ missed: [missedSlot()] }), withSplit);
  assert.ok(used > 0, "주입한 역함수가 실제로 쓰여야 한다");
  const j = readJournal();
  assert.equal(j.blocks.length, 2);
  assert.ok(j.blocks[0].includes("옛것"));
});

test("내레이터가 던져도 사건은 원장에 남는다(진단 기능이 서비스를 죽이지 않는다)", () => {
  reset();
  const broken: Narrator = {
    narrate: () => {
      throw new Error("문구 실패");
    },
    journalEntry: () => {
      throw new Error("일지 실패");
    },
  };
  const r = recordDowntimeEvent(input({ missed: [missedSlot()] }), broken);
  assert.ok(r);
  assert.equal(loadDowntimeLedger().events.length, 1);
  assert.equal(r.event.headline, "");
});


// 테스트가 만든 임시 디렉터리를 지운다. 없으면 npm test 를 돌릴 때마다
// os.tmpdir() 에 uptime-* 디렉터리가 쌓인다(2026-08-02 검증에서 24개 관측).
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
