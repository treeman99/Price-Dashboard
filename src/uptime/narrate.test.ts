import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DOWNTIME_JOURNAL_HEADER,
  REASON_PREFIX,
  downtimeIMessageText,
  formatDurationKorean,
  formatKoreanClock,
  journalHeader,
  narrate,
  narrateIMessage,
  narrateMissedSummary,
  narrateNotifyLine,
  narrateRecoveryLine,
  narrateStdout,
  renderJournalEntry,
  resolveJournalPath,
  splitJournalEntries,
  type JournalEntryInput,
  type NarrationInput,
} from "./narrate.ts";
import type { DowntimeEvidence, MissedSlot, PmsetLine } from "../../shared/uptime.ts";

/**
 * 문구 테스트의 목적은 "예쁜가"가 아니라 **다음 사고 때 사람이 원인을 오해하지 않는가** 다.
 * 그래서 어서션은 대부분 "이 문자열이 반드시 있다 / 절대 없다" 형태다.
 *
 * 회귀 방지선 세 개:
 * 1. `sleep` 본문·stdout 에 **"LLM 장애가 아니라"** 가 있는가 — 2026-08-02 오진의 직접 대응책.
 * 2. `unknown` 이 전원 차단을 **단정하지 않는가** — §3.2 Q2b fail-open 이 문구까지 이어지는가.
 * 3. 사용자 문장에 **ISO/UTC 시각이 새지 않는가** — 사용자는 `2026-08-02T02:29:04.118Z` 를 못 읽는다.
 *
 * 시각 고정: 2026-08-02 사고 실측값(부팅 1785245050 = 07-28 22:24:10 KST,
 * 직전 정상 종료 1785244805 = 07-28 22:20:05 KST). 타임존 고정 계산이므로 러너의 TZ 와 무관하다.
 */

const GAP_START = "2026-08-02T00:29:10+09:00";
const GAP_END = "2026-08-02T11:14:46+09:00";
const GAP_START_SEC = 1785598150;
const GAP_END_SEC = 1785636886;
const BOOT_SEC = 1785245050; // 2026-07-28 22:24:10 KST
const CLEAN_SEC = 1785244805; // 2026-07-28 22:20:05 KST

/** 공백을 정확히 덮는 클램셸 슬립 한 쌍(§4.4 화이트리스트 재조립본). */
const CLAMSHELL_LINES: PmsetLine[] = [
  { at: GAP_START_SEC - 20, kind: "Sleep", reason: "Clamshell Sleep", power: "Batt", charge: 80 },
  { at: GAP_END_SEC - 6, kind: "Wake", reason: null, power: "Batt", charge: 48 },
];

function evidence(over: Partial<DowntimeEvidence> = {}): DowntimeEvidence {
  return {
    bootEpochBefore: BOOT_SEC,
    bootEpochNow: BOOT_SEC,
    bootChanged: false,
    bootFromFallback: false,
    prevPid: 91880,
    currentPid: 91880,
    sameProcess: true,
    prevBeaconMode: "alive",
    lastCleanShutdownEpoch: CLEAN_SEC,
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
    ...over,
  };
}

function slot(over: Partial<MissedSlot> = {}): MissedSlot {
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

function input(over: Partial<NarrationInput> = {}): NarrationInput {
  return {
    cause: "sleep",
    confidence: "확실",
    severity: "사고",
    gapStart: GAP_START,
    gapEnd: GAP_END,
    gapMinutes: 645,
    gapExact: true,
    missed: [],
    recoveryState: "복구중",
    evidence: evidence(),
    ...over,
  };
}

/** 이번 사고 재현: 클램셸 슬립 10시간 45분 + 3건 손실. */
function sleepIncident(over: Partial<NarrationInput> = {}): NarrationInput {
  return input({
    cause: "sleep",
    severity: "사고",
    evidence: evidence({
      pmsetLines: CLAMSHELL_LINES,
      darkWakeCount: 68,
      batteryAtGapStart: { percent: 80, onBattery: true },
      cpuSecondsInGap: 27.8,
      dutyPercent: 0.07,
    }),
    missed: [
      slot(),
      slot({ tab: "youtube", label: "유튜브 소식", slot: "09:00" }),
      slot({ tab: "events", label: "팝업·전시", slot: "10:00" }),
    ],
    ...over,
  });
}

function journalInput(n: NarrationInput, over: Partial<JournalEntryInput> = {}): JournalEntryInput {
  const parts = narrate(n);
  return {
    ...n,
    headline: parts.headline,
    body: parts.body,
    reasonLine: parts.reasonLine,
    notified: { imessage: false, at: null, queuedUntil: null },
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 1. cause 8종 — 전부 실제 문장이 나오는가 (자리표시자·미구현 분기 0)
// ────────────────────────────────────────────────────────────────────────────

test("cause 8종 모두 완성된 한국어 문장을 낸다 (자리표시자·영어 잔재 없음)", () => {
  const causes = [
    "sleep",
    "restart-intended",
    "app-gap",
    "reboot-clean",
    "power-cut",
    "battery-dead",
    "panic",
    "unknown",
  ] as const;

  for (const cause of causes) {
    const n = input({
      cause,
      confidence: cause === "unknown" ? "불명" : "확실",
      evidence: evidence({
        bootChanged: cause !== "sleep" && cause !== "app-gap" && cause !== "restart-intended",
        panicAtEpoch: cause === "panic" ? GAP_START_SEC + 30 : null,
        shutdownLogParsed: cause !== "unknown",
        batteryAtGapStart:
          cause === "battery-dead" ? { percent: 4, onBattery: true } : { percent: 62, onBattery: true },
        pmsetLines: cause === "sleep" ? CLAMSHELL_LINES : [],
      }),
    });
    const { headline, body, reasonLine } = narrate(n);

    for (const [name, text] of [
      ["headline", headline],
      ["body", body],
      ["reasonLine", reasonLine],
    ] as const) {
      assert.ok(text.length > 0, `${cause} 의 ${name} 이 비었다`);
      assert.ok(!text.includes("…"), `${cause} 의 ${name} 에 자리표시자가 남았다: ${text}`);
      assert.ok(!/TODO|undefined|NaN|\[object/u.test(text), `${cause} ${name}: ${text}`);
    }
    // 본문에는 기술 용어가 새면 안 된다(그건 판정근거 줄의 몫이다).
    assert.ok(
      !/pmset|sysctl|boottime|SIGTERM|epoch/iu.test(`${headline}\n${body}`),
      `${cause} 본문에 기술 용어가 샜다: ${body}`
    );
    assert.ok(headline.endsWith(")") || headline.endsWith("."), `${cause} headline 끝맺음: ${headline}`);
    assert.ok(reasonLine.startsWith(REASON_PREFIX), `${cause} reasonLine 접두사 누락`);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 2. §10.3-1 sleep — 이번 사고 재현. ★ LLM 알리바이가 핵심
// ────────────────────────────────────────────────────────────────────────────

test("sleep(배터리·손실 3건): 절전을 절전이라 부르고, ★ LLM 장애가 아님을 못 박는다", () => {
  const { headline, body, reasonLine } = narrate(sleepIncident());

  assert.equal(
    headline,
    "새벽 0시 29분부터 오전 11시 15분까지, 10시간 45분 동안 맥북이 잠들어 있었습니다."
  );

  // 멘탈모델 교정: "전원이 나간 게 아니라 잠든 것"(§2, §12.3-2)
  assert.match(body, /덮개를 닫으면 충전기를 꽂아 두어도 맥북은 잠듭니다/u);
  assert.match(body, /전원이 나간 것이 아니라 잠든 것입니다/u);
  // 프로세스가 죽지 않았다는 사실 + 실가동률(§6.1 판정근거 재료 13)
  assert.match(body, /수집 프로그램은 죽지 않았지만 맥과 함께 멈춰 있었습니다/u);
  assert.match(body, /27\.8초\(0\.07%\)뿐입니다/u);
  assert.match(body, /배터리는 80% → 48%로 줄었을 뿐, 꺼지지는 않았습니다/u);
  // ★★ 이 한 줄이 이 기능의 존재 이유다.
  assert.ok(
    body.includes("LLM 장애가 아니라"),
    `일지 본문에 LLM 알리바이가 없다:\n${body}`
  );
  assert.match(body, /"응답 시간 초과" 오류는 LLM 장애가 아니라 위 절전 때문입니다/u);

  // 판정근거 — 명세 §6.1 sleep 예시와 항목·순서까지 같아야 한다(초 단위는 반올림하지 않는다).
  assert.equal(
    reasonLine,
    "판정근거: 부팅 시각 변화 없음(07-28 22:24:10) / 마지막 생존 08-02 00:29:10 / " +
      "전원관리 기록에 같은 구간의 절전(사유 'Clamshell Sleep', 배터리 80% → 48%, 짧은 깨어남 68회) / " +
      "프로세스 동일(pid 91880)"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// 3. §10.3-2 unknown — ★ 정직성 조항
// ────────────────────────────────────────────────────────────────────────────

test("unknown: '단정하지 않겠습니다' 를 말하고, 전원 차단을 단정하는 표현은 절대 쓰지 않는다", () => {
  const n = input({
    cause: "unknown",
    confidence: "불명",
    severity: "기록만",
    gapMinutes: 270,
    evidence: evidence({
      bootChanged: true,
      bootEpochBefore: BOOT_SEC,
      bootEpochNow: BOOT_SEC + 200_000,
      shutdownLogParsed: false,
      lastCleanShutdownEpoch: null,
      sameProcess: false,
      currentPid: 4242,
    }),
  });
  const { headline, body, reasonLine } = narrate(n);

  assert.ok(body.includes("단정하지 않겠습니다"), body);
  assert.match(body, /정상 종료였는지 전원이 나간 것인지 판정하지 못했습니다/u);

  // 전원 차단을 사실로 주장하는 표현이 하나라도 있으면 fail-open 이 문구에서 깨진 것이다.
  const all = `${headline}\n${body}`;
  for (const forbidden of [
    "전원이 갑자기 끊겼",
    "전원이 나갔습니다",
    "강제 종료된 것",
    "비정상 종료",
    "배터리가 다 떨어져",
  ]) {
    assert.ok(!all.includes(forbidden), `unknown 문구가 원인을 단정했다: "${forbidden}"\n${all}`);
  }
  assert.match(reasonLine, /종료 기록 파일을 찾지 못함\(형식 변경 가능성\)/u);
});

// ────────────────────────────────────────────────────────────────────────────
// 4. §10.3-3 reboot-clean + 손실 0 — 경고체가 아니어야 한다
// ────────────────────────────────────────────────────────────────────────────

test("reboot-clean + 손실 0: '(사고 아님)' 을 달고, 겁주는 표현을 쓰지 않는다", () => {
  const n = input({
    cause: "reboot-clean",
    severity: "무시",
    gapMinutes: 4,
    gapStart: "2026-07-28T22:20:05+09:00",
    gapEnd: "2026-07-28T22:24:10+09:00",
    recoveryState: "복구없음",
    evidence: evidence({ bootChanged: true, sameProcess: false, currentPid: 4242 }),
  });
  const { headline, body, reasonLine } = narrate(n);

  assert.equal(headline, "4분 동안 수집이 멈췄습니다. (사고 아님)");
  assert.match(body, /7월 28일 밤 10시 20분에 맥을 정상적으로 종료하셨고, 10시 24분에 다시 켜졌습니다/u);
  assert.match(body, /강제 종료나 전원 차단이 아닙니다/u);
  assert.match(reasonLine, /직전 정상 종료 기록 07-28 22:20:05 \(차이 245초, shutdown 기록 파일\)/u);

  // 손실이 0이면 "지금 상태" 는 안심시키는 한 줄이어야 한다.
  assert.equal(narrateRecoveryLine(n), "정상입니다. 확인하실 것 없습니다.");
  assert.equal(narrateMissedSummary(n.missed), "없음 — 이 구간에 예정된 자동 수집이 없었습니다.");

  for (const scary of ["⚠️", "오류", "실패했습니다", "사고입니다"]) {
    assert.ok(!`${headline}${body}`.includes(scary), `정상 재시작에 경고체가 섞였다: ${scary}`);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 5. §10.3-4 confidence 하향 → "…로 보입니다"
// ────────────────────────────────────────────────────────────────────────────

test("confidence '추정' 이면 단정형이 아니라 '…로 보입니다' 계열로 내려간다", () => {
  const sure = narrate(sleepIncident());
  const guess = narrate(sleepIncident({ confidence: "추정" }));

  assert.match(sure.headline, /맥북이 잠들어 있었습니다\.$/u);
  assert.match(guess.headline, /맥북이 잠들어 있었던 것으로 보입니다\.$/u);
  assert.match(guess.body, /전원이 나간 것이 아니라 잠든 것으로 보입니다/u);
  assert.ok(!guess.body.includes("잠든 것입니다"), guess.body);
});

test("비컨 쓰기 실패가 있으면 '기록에 실패했다' 는 사실을 문장으로 밝힌다 (§3.4)", () => {
  const n = sleepIncident({
    confidence: "추정",
    evidence: evidence({
      pmsetLines: CLAMSHELL_LINES,
      darkWakeCount: 68,
      beaconWriteFailures: 2,
      batteryAtGapStart: { percent: 80, onBattery: true },
    }),
  });
  const { body, reasonLine } = narrate(n);
  assert.match(body, /가동 기록을 남기는 데 2번 실패한 구간이라, 위 판정은 확정이 아니라 추정입니다/u);
  assert.match(reasonLine, /가동 기록 쓰기 실패 2회/u);
});

test("clockSuspect 이면 길이를 말하지 않고 그 사실을 밝힌다 (§4.5)", () => {
  const n = sleepIncident({ gapExact: false, confidence: "추정" });
  const { headline } = narrate(n);
  assert.ok(!headline.includes("10시간 45분"), headline);
  assert.match(headline, /시스템 시각이 바뀐 흔적이 있어 정확한 길이는 알 수 없습니다/u);
});

// ────────────────────────────────────────────────────────────────────────────
// 6. §10.3-5 시각 표기 — 사용자 문장에 ISO/UTC 가 새면 안 된다
// ────────────────────────────────────────────────────────────────────────────

test("사용자 문장의 시각은 전부 KST 한국어이고 ISO/UTC 문자열이 새지 않는다", () => {
  const cases = [sleepIncident(), input({ cause: "power-cut", severity: "기록만" })];
  for (const n of cases) {
    const { headline, body } = narrate(n);
    const userText = `${headline}\n${body}`;
    assert.ok(!/\d{4}-\d{2}-\d{2}T/u.test(userText), `ISO 날짜가 샜다: ${userText}`);
    assert.ok(!/\dZ\b|GMT|UTC|\+09:00/u.test(userText), `UTC 표기가 샜다: ${userText}`);
    assert.match(userText, /(새벽|오전|오후|밤)\s?\d+시/u, `한국어 시각 표기가 없다: ${userText}`);
  }
});

test("한국어 시각·기간 포맷 (명세 §6.1 예시에서 역산한 경계)", () => {
  const at = (iso: string) => new Date(iso).getTime();
  assert.equal(formatKoreanClock(at("2026-08-02T00:29:10+09:00")), "새벽 0시 29분");
  assert.equal(formatKoreanClock(at("2026-08-03T04:51:00+09:00")), "새벽 4시 51분");
  assert.equal(formatKoreanClock(at("2026-08-03T09:20:00+09:00")), "오전 9시 20분");
  assert.equal(formatKoreanClock(at("2026-08-02T11:15:00+09:00")), "오전 11시 15분");
  assert.equal(formatKoreanClock(at("2026-08-02T15:12:00+09:00")), "오후 3시 12분");
  assert.equal(formatKoreanClock(at("2026-08-02T20:40:00+09:00")), "오후 8시 40분");
  assert.equal(formatKoreanClock(at("2026-07-28T22:20:00+09:00")), "밤 10시 20분");
  assert.equal(formatKoreanClock(at("2026-08-02T08:00:00+09:00")), "오전 8시");
  assert.equal(
    formatKoreanClock(at("2026-07-28T22:20:05+09:00"), { withDate: true }),
    "7월 28일 밤 10시 20분"
  );

  assert.equal(formatDurationKorean(645), "10시간 45분");
  assert.equal(formatDurationKorean(4), "4분");
  assert.equal(formatDurationKorean(328), "5시간 28분");
  assert.equal(formatDurationKorean(120), "2시간");
  assert.equal(formatDurationKorean(0), "1분 미만");
  assert.equal(formatDurationKorean(1500), "1일 1시간");
});

// ────────────────────────────────────────────────────────────────────────────
// 7. 나머지 cause 의 실제 문구 (§6.1 예시 대조)
// ────────────────────────────────────────────────────────────────────────────

test("power-cut: '정상 종료 기록이 없다' 를 근거로 말하고, 패닉·방전을 하나씩 지운다", () => {
  const n = input({
    cause: "power-cut",
    severity: "기록만",
    gapMinutes: 328,
    gapStart: "2026-08-02T15:12:00+09:00",
    gapEnd: "2026-08-02T20:40:11+09:00",
    evidence: evidence({
      bootChanged: true,
      bootEpochNow: Math.floor(new Date("2026-08-02T20:40:11+09:00").getTime() / 1000),
      sameProcess: false,
      currentPid: 4242,
      batteryAtGapStart: { percent: 62, onBattery: false },
    }),
  });
  const { headline, body, reasonLine } = narrate(n);

  assert.equal(headline, "5시간 28분 동안 맥이 꺼져 있었습니다. (놓친 수집은 없습니다)");
  // ★ 5시간 반 떨어진 시각에서 '오후'를 생략하면 아침 8시로 읽힌다 — 반드시 다시 붙는다.
  assert.match(body, /8월 2일 오후 3시 12분을 마지막으로 기록이 끊겼고, 오후 8시 40분에 다시 켜졌습니다/u);
  assert.match(body, /그 사이에 '정상 종료' 기록이 남지 않았습니다/u);
  assert.match(body, /커널 패닉 기록은 없고, 마지막으로 확인된 배터리는 62%라 방전도 아닙니다/u);
  assert.match(reasonLine, /직전 부팅보다 과거 → 비정상/u);
  assert.match(reasonLine, /커널 패닉 파일 0건/u);
});

test("battery-dead: 잔량과 충전기 상태를 말한다", () => {
  const n = input({
    cause: "battery-dead",
    confidence: "추정",
    severity: "기록만",
    gapMinutes: 269,
    gapStart: "2026-08-03T04:51:00+09:00",
    gapEnd: "2026-08-03T09:20:00+09:00",
    evidence: evidence({
      bootChanged: true,
      bootEpochNow: Math.floor(new Date("2026-08-03T09:20:00+09:00").getTime() / 1000),
      sameProcess: false,
      currentPid: 4242,
      batteryAtGapStart: { percent: 4, onBattery: true },
    }),
  });
  const { body } = narrate(n);
  assert.match(body, /배터리가 다 떨어져 8월 3일 새벽 4시 51분에 맥이 꺼진 것으로 보입니다/u);
  assert.match(body, /마지막으로 확인된 잔량은 4%였고 충전기가 꽂혀 있지 않았습니다/u);
  assert.match(body, /오전 9시 20분에 다시 켜졌습니다/u);
});

test("panic: 전원이 끊긴 게 아니라 macOS 가 스스로 멈췄다고 설명한다", () => {
  const panicSec = Math.floor(new Date("2026-08-03T04:51:00+09:00").getTime() / 1000);
  const n = input({
    cause: "panic",
    severity: "기록만",
    gapMinutes: 269,
    gapStart: "2026-08-03T04:51:00+09:00",
    gapEnd: "2026-08-03T09:20:00+09:00",
    evidence: evidence({
      bootChanged: true,
      panicAtEpoch: panicSec,
      sameProcess: false,
      currentPid: 4242,
    }),
  });
  const { headline, body } = narrate(n);
  assert.match(headline, /^맥이 스스로 재시작됐습니다\./u);
  assert.match(body, /8월 3일 새벽 4시 51분에 시스템 오류\(커널 패닉\)로 맥이 재시작됐습니다/u);
  assert.match(body, /전원이 끊긴 것이 아니라 macOS 가 스스로 멈춘 것입니다/u);
});

test("app-gap: 10분 미만이면 '직접 재시작하셨다면 무시하셔도 됩니다' 를 붙인다 (§12.2-7)", () => {
  const short = input({
    cause: "app-gap",
    confidence: "추정",
    severity: "기록만",
    gapMinutes: 3,
    gapStart: "2026-08-02T15:09:00+09:00",
    gapEnd: "2026-08-02T15:12:00+09:00",
    evidence: evidence({ sameProcess: false, currentPid: 4242 }),
  });
  const long = input({
    cause: "app-gap",
    confidence: "추정",
    severity: "기록만",
    gapMinutes: 40,
    gapStart: "2026-08-02T14:32:00+09:00",
    gapEnd: "2026-08-02T15:12:00+09:00",
    evidence: evidence({ sameProcess: false, currentPid: 4242 }),
  });
  assert.match(narrate(short).body, /직접 재시작하셨다면 무시하셔도 됩니다/u);
  assert.ok(!narrate(long).body.includes("직접 재시작하셨다면"), narrate(long).body);
  assert.match(narrate(short).body, /맥은 켜져 있었고 \(부팅 시각 그대로\)/u);
  // 하향("…로 보입니다")은 추론하는 절에만 걸린다 — 관측 사실까지 흐리면 정보량이 준다.
  assert.match(narrate(short).body, /자동으로 다시 시작된 것으로 보입니다\./u);
  assert.match(narrate(short).body, /정상 종료 신호를 받은 흔적이 없습니다\./u);
});

test("restart-intended: 손실이 있으면 무엇이 지나갔는지 이름을 댄다", () => {
  const base = {
    cause: "restart-intended" as const,
    severity: "사고" as const,
    gapMinutes: 32,
    gapStart: "2026-08-02T07:40:00+09:00",
    gapEnd: "2026-08-02T08:12:00+09:00",
    evidence: evidence({ prevBeaconMode: "stopping" as const, sameProcess: false, currentPid: 4242 }),
  };
  const withLoss = narrate(input({ ...base, missed: [slot()] }));
  assert.equal(withLoss.headline, "업데이트로 32분 동안 수집이 멈췄습니다.");
  assert.match(withLoss.body, /업데이트하느라 프로그램을 잠깐 껐다 켰습니다. 맥은 계속 켜져 있었습니다/u);
  assert.match(withLoss.body, /그 사이에 뉴스 수집 시각이 지나갔습니다/u);
  assert.match(withLoss.reasonLine, /종료 신호\(SIGTERM\/SIGINT\) 마커 있음/u);

  const noLoss = narrate(input({ ...base, severity: "무시", missed: [] }));
  assert.equal(noLoss.headline, "업데이트로 32분 동안 수집이 멈췄습니다. (사고 아님)");
  assert.ok(!noLoss.body.includes("지나갔습니다"), noLoss.body);
});

// ────────────────────────────────────────────────────────────────────────────
// 8. 손실 0건 / N건 분기 · 복구 상태 문장 (§8.4, §8.5)
// ────────────────────────────────────────────────────────────────────────────

test("놓친 것 요약: 0건 / N건 / 지난 날짜(evaluated:false) 세 갈래", () => {
  assert.equal(narrateMissedSummary([]), "없음 — 이 구간에 예정된 자동 수집이 없었습니다.");

  const three = [
    slot(),
    slot({ tab: "youtube", label: "유튜브 소식", slot: "09:00" }),
    slot({ tab: "events", label: "팝업·전시", slot: "10:00" }),
  ];
  assert.equal(
    narrateMissedSummary(three),
    "뉴스 08:00 · 유튜브 소식 09:00 · 팝업·전시 10:00 — 3건"
  );

  // 자정을 넘는 공백의 어제 슬롯은 개수에서 빠지고 따로 적힌다(§8.4).
  const mixed = [
    slot(),
    slot({
      tab: "lotto",
      label: "로또",
      slot: "일요일 10:00",
      date: "2026-08-01",
      evaluated: false,
      note: "지난 날짜라 보충 대상이 아닙니다",
    }),
  ];
  const text = narrateMissedSummary(mixed);
  assert.match(text, /뉴스 08:00 — 1건/u);
  assert.match(text, /그 밖에 로또 일요일 10:00 1건이 공백에 걸쳐 있었지만, 지난 날짜라 보충 대상이 아닙니다\./u);
  assert.ok(!text.includes("— 2건"), text);

  // 보충된 항목은 받아온 시각을 한국어로 병기한다.
  const recovered = narrateMissedSummary([
    slot({ recovered: true, recoveredAt: "2026-08-02T11:21:00+09:00" }),
  ]);
  assert.equal(recovered, "뉴스 08:00(오전 11시 21분에 받아옴) — 1건");
});

test("지금 상태: recoveryState 4종 문장 (§8.5)", () => {
  const three = [
    slot(),
    slot({ tab: "youtube", label: "유튜브 소식", slot: "09:00" }),
    slot({ tab: "lotto", label: "로또", slot: "일요일 10:00" }),
  ];
  const withState = (state: NarrationInput["recoveryState"], missed: MissedSlot[]) =>
    narrateRecoveryLine(sleepIncident({ recoveryState: state, missed }));

  assert.equal(
    withState("복구중", three),
    "깨어난 직후 누락 점검이 자동으로 시작됐습니다. 화면이 비어 있어도 잠시 뒤 채워집니다."
  );
  assert.equal(
    withState("복구완료", three.map((m) => ({ ...m, recovered: true }))),
    "놓친 3건을 모두 다시 받아왔습니다."
  );
  assert.equal(
    withState("일부복구", [
      { ...three[0]!, recovered: true },
      { ...three[1]!, recovered: true },
      three[2]!,
    ]),
    "3건 중 2건을 다시 받아왔고, 로또 1건은 아직 받아오지 못했습니다."
  );
  assert.equal(withState("복구없음", three), "아직 보충되지 않았습니다. 잠시 뒤 다시 확인해 주세요.");
  // 손실 0이면 recoveryState 와 무관하게 안심시키는 한 줄.
  assert.equal(withState("복구중", []), "정상입니다. 확인하실 것 없습니다.");
});

test("알림 줄: 발송 완료 / 조용시간 대기 / 사고 아님 / 미설정", () => {
  assert.equal(
    narrateNotifyLine({ imessage: true, at: "2026-08-02T11:15:00+09:00", queuedUntil: null }, "사고"),
    "iMessage 발송 완료 11:15"
  );
  assert.equal(
    narrateNotifyLine(
      { imessage: false, at: null, queuedUntil: "2026-08-02T07:00:00+09:00" },
      "사고"
    ),
    "대기(조용시간, 07:00 이후 발송)"
  );
  assert.equal(
    narrateNotifyLine({ imessage: false, at: null, queuedUntil: null }, "기록만"),
    "보내지 않음(사고 아님)"
  );
  assert.equal(
    narrateNotifyLine({ imessage: false, at: null, queuedUntil: null }, "사고", false),
    "미설정"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// 9. 일지 파일 (§5.3 / §6.1)
// ────────────────────────────────────────────────────────────────────────────

test("일지 헤더에 ★ 멘탈모델 교정 문장(충전기를 뽑아도 배터리로 동작)이 들어 있다 (§6.4)", () => {
  assert.match(DOWNTIME_JOURNAL_HEADER, /^# 가동 중단 기록 —/u);
  assert.match(DOWNTIME_JOURNAL_HEADER, /충전기를 뽑아도 맥북은 배터리로 계속 동작합니다/u);
  assert.match(DOWNTIME_JOURNAL_HEADER, /배터리가 47% 아래로/u);
  assert.match(DOWNTIME_JOURNAL_HEADER, /덮개를 닫아 맥북이 잠들었을 때입니다/u);
  assert.match(DOWNTIME_JOURNAL_HEADER, /'배터리 방전'이라고 따로 적습니다/u);
  // 헤더의 모든 줄은 주석(#)이어야 파서·사람 눈 양쪽에서 항목과 구분된다.
  for (const line of DOWNTIME_JOURNAL_HEADER.trimEnd().split("\n")) {
    assert.ok(line.startsWith("#"), `헤더 줄이 주석이 아니다: ${line}`);
  }
});

test("일지 항목 포맷: 고정 5줄 라벨 + 절대 시각 + 되읽기 가능", () => {
  const entry = renderJournalEntry(
    journalInput(sleepIncident(), {
      notified: { imessage: true, at: "2026-08-02T11:15:00+09:00", queuedUntil: null },
    })
  );

  assert.match(entry, /^\[2026-08-02 11:15 KST\] 절전 — 새벽 0시 29분부터/u);
  for (const label of ["무슨 일:", "놓친 것:", "지금 상태:", "판정근거:", "알림:"]) {
    assert.ok(entry.includes(`  ${label} `), `일지에 '${label}' 줄이 없다:\n${entry}`);
  }
  // "판정근거: 판정근거: …" 중복이 없어야 한다(§5.2 와 §6.1 의 충돌 해소 지점).
  assert.ok(!entry.includes("판정근거: 판정근거:"), entry);
  assert.match(entry, /알림: iMessage 발송 완료 11:15/u);
  assert.ok(entry.endsWith("\n\n"), "항목은 빈 줄 하나로 끝나야 한다");

  // 항목 시작 줄만 열 0에서 '['로 시작하고 나머지는 들여쓰기 — store 의 절삭이 이 규약에 기댄다.
  const lines = entry.trimEnd().split("\n");
  assert.ok(lines[0]!.startsWith("["));
  for (const l of lines.slice(1)) assert.ok(l.startsWith("  "), `들여쓰기 위반: ${l}`);
});

test("splitJournalEntries: 헤더를 버리고 항목 단위로 정확히 되읽는다 (200건 절삭의 전제)", () => {
  const a = renderJournalEntry(journalInput(sleepIncident()));
  const b = renderJournalEntry(
    journalInput(
      input({
        cause: "reboot-clean",
        severity: "기록만",
        gapMinutes: 4,
        gapStart: "2026-07-28T22:20:05+09:00",
        gapEnd: "2026-07-28T22:24:10+09:00",
        evidence: evidence({ bootChanged: true, sameProcess: false, currentPid: 4242 }),
      })
    )
  );
  const file = DOWNTIME_JOURNAL_HEADER + "\n" + a + b;
  const parsed = splitJournalEntries(file);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0], a);
  assert.equal(parsed[1], b);
  assert.ok(!parsed.join("").includes("#"), "헤더가 항목으로 새어 들어갔다");
});

// ────────────────────────────────────────────────────────────────────────────
// 10. stdout 병기 (§6.2) — ★ 이 기능에서 가장 값싸고 가장 중요한 산출물
// ────────────────────────────────────────────────────────────────────────────

const JOURNAL = "/Users/daegun/Workspace/price/data/downtime.log";

test("★ stdout 경고: 'LLM 장애가 아니라 절전' 과 일지 절대경로가 반드시 들어간다", () => {
  const { level, text } = narrateStdout(sleepIncident(), JOURNAL);

  assert.equal(level, "warn");
  assert.match(text, /^가동 공백 10시간 45분 — 절전\(덮개 닫힘, 배터리 80%→48%\)\. 08-02 00:29 ~ 11:15 KST\./u);
  assert.match(text, /뉴스 08:00 · 유튜브 소식 09:00 · 팝업·전시 10:00 이 예정 시각에 돌지 못했습니다/u);
  assert.ok(
    text.includes('※ 이 구간의 "응답 시간 초과" 오류는 LLM 장애가 아니라 위 절전 때문입니다.'),
    `stdout 에 LLM 알리바이가 없다:\n${text}`
  );
  assert.ok(text.includes(`자세히: ${JOURNAL}`), text);
  // ★ 폰·다른 터미널에서 그대로 열 수 있어야 하므로 절대경로여야 한다.
  assert.match(text, /자세히: \//u);
  // log.warn 이 접두사를 붙이므로 여기서 또 붙이면 "⚠️ ⚠️" 가 된다.
  assert.ok(!text.startsWith("⚠️"), text);
});

test("stdout: severity '무시' 는 info 한 줄로만 남긴다 (§3.5)", () => {
  const n = input({
    cause: "sleep",
    severity: "무시",
    gapMinutes: 5,
    gapEnd: "2026-08-02T00:34:10+09:00",
    evidence: evidence({ pmsetLines: CLAMSHELL_LINES }),
  });
  const { level, text } = narrateStdout(n, JOURNAL);
  assert.equal(level, "info");
  assert.equal(text.split("\n").length, 1);
  assert.match(text, /놓친 수집이 없어 사건으로 올리지 않습니다/u);
});

test("stdout: 프로세스가 죽은 사건에는 LLM 알리바이를 붙이지 않는다", () => {
  const n = input({
    cause: "power-cut",
    severity: "기록만",
    gapMinutes: 328,
    evidence: evidence({ bootChanged: true, sameProcess: false, currentPid: 4242 }),
  });
  const { text } = narrateStdout(n, JOURNAL);
  assert.ok(!text.includes("LLM 장애"), text);
});

// ────────────────────────────────────────────────────────────────────────────
// 11. iMessage (§6.3)
// ────────────────────────────────────────────────────────────────────────────

test("iMessage: 원인·구간·못 돈 것·절대경로·대시보드 주소가 모두 들어간다", () => {
  const text = narrateIMessage(sleepIncident(), {
    journalPath: JOURNAL,
    dashboardUrl: "http://localhost:7777",
  });

  assert.match(text, /^\[대시보드\] 수집이 10시간 45분 멈췄습니다\n\n/u);
  assert.match(text, /원인: 맥북 절전 \(덮개 닫힘\) — 전원이 나간 것은 아닙니다/u);
  assert.match(text, /구간: 8\/2 00:29 → 11:15/u);
  assert.match(text, /못 돈 것: 뉴스 08:00, 유튜브 소식 09:00, 팝업·전시 10:00/u);
  assert.match(text, /지금: 깨어난 직후 누락 점검이 자동으로 시작됐습니다/u);
  assert.ok(text.includes(`자세한 기록: ${JOURNAL}`), text);
  assert.ok(text.includes("화면: http://localhost:7777"), text);
  // ★ 상대경로는 폰에서 열 수 없다 — 절대경로가 아니면 알림이 도달해도 정보엔 도달 못 한다.
  assert.match(text, /자세한 기록: \//u);
});

test("iMessage: unknown 은 문자에서도 전원 차단을 단정하지 않는다", () => {
  const n = input({
    cause: "unknown",
    confidence: "불명",
    severity: "기록만",
    evidence: evidence({ bootChanged: true, shutdownLogParsed: false, sameProcess: false, currentPid: 4242 }),
  });
  const text = narrateIMessage(n, { journalPath: JOURNAL });
  assert.match(text, /원인: 원인 확인 불가 — 전원이 나갔다고 단정하지 않겠습니다/u);
  assert.ok(text.includes("화면: http://localhost:7777"), "대시보드 주소 기본값");
});

// ────────────────────────────────────────────────────────────────────────────
// 12. 경로 헬퍼
// ────────────────────────────────────────────────────────────────────────────

test("downtimeIMessageText: 인자 하나로 불러도 절대경로·대시보드 주소가 채워진다 (notify.ts 계약)", () => {
  // notify.ts 는 `downtimeIMessageText(ev)` 로 부른다. narrate 는 config 를 못 읽으므로
  // 저장소 구조에서 역산한 기본 경로가 들어가야 한다 — 여기서 비면 문자가 정보에 도달 못 한다.
  const text = downtimeIMessageText(sleepIncident());
  assert.match(text, /자세한 기록: \/.*\/data\/downtime\.log$/mu);
  assert.ok(text.includes("화면: http://localhost:7777"), text);
  // 두 번째 인자로 덮어쓸 수 있어야 한다(DB_PATH/PORT 를 바꾼 환경).
  const custom = downtimeIMessageText(sleepIncident(), {
    journalPath: "/tmp/x/downtime.log",
    dashboardUrl: "http://localhost:8123",
  });
  assert.ok(custom.includes("자세한 기록: /tmp/x/downtime.log"), custom);
  assert.ok(custom.includes("화면: http://localhost:8123"), custom);
});

test("journalHeader(): store.ts 의 DowntimeNarrator.journalHeader 에 그대로 꽂힌다", () => {
  assert.equal(journalHeader(), DOWNTIME_JOURNAL_HEADER);
});

test("resolveJournalPath: dbPath 옆의 downtime.log 를 항상 절대경로로 돌려준다", () => {
  assert.equal(
    resolveJournalPath("/Users/daegun/Workspace/price/data/price.db"),
    "/Users/daegun/Workspace/price/data/downtime.log"
  );
  // DB_PATH 에 상대경로가 들어와도 절대경로가 나와야 한다.
  assert.ok(resolveJournalPath("data/price.db").startsWith("/"));
  assert.ok(resolveJournalPath("data/price.db").endsWith("/data/downtime.log"));
});
