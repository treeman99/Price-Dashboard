import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./classify.ts";
import { BOOT_EPOCH_TOLERANCE_SEC, MIN_GAP_MS } from "../../shared/uptime.ts";
import type { DowntimeCause, Evidence, SleepWindow } from "../../shared/uptime.ts";

/**
 * 판정 트리 회귀 테스트(명세 §10.1).
 *
 * 이 파일이 지키는 것은 결국 두 문장이다:
 *  1) **부팅 시각이 그대로면 "전원이 나갔습니다"라고 말하지 않는다.** (정상 재시작 오인 방지)
 *  2) **종료 기록을 못 읽으면 "모른다"고 말한다.** (fail-open. 오보보다 침묵이 싸다)
 * 나머지 케이스는 전부 이 둘의 주변이다.
 *
 * 시각 값은 가능한 한 **2026-08-02 사고의 실측값**을 쓴다. 합성 숫자로 통과시키면
 * "테스트는 되는데 그날은 못 잡는" 상태를 눈치채지 못한다.
 */

// ── 실측 상수 (2026-07-28 재부팅 / 2026-08-02 클램셸 슬립) ──────────────────

/** `kern.boottime` = 2026-07-28 22:24:10 KST. 4.5일·71회 sleep/wake 후에도 불변이었다. */
const BOOT = 1785245050;
/** 같은 재부팅의 정상 종료 기록 = 2026-07-28 22:20:05 KST (부팅 245초 전). */
const CLEAN = 1785244805;
/** 사고 공백 시작 = 2026-08-02 00:29:10 KST (마지막 생존). */
const GAP_START = 1785598150;
/** 사고 공백 끝 = 2026-08-02 11:14:46 KST (덮개 열림). 645분. */
const GAP_END = 1785636886;
/** 645분 = 10시간 45분. */
const GAP_MS = (GAP_END - GAP_START) * 1000;

/** 공백 전체를 덮는 클램셸 슬립 윈도 하나(배터리 80% → 48%). */
const COVERING_WINDOW: SleepWindow = {
  startSec: GAP_START,
  endSec: GAP_END,
  reason: "Clamshell Sleep",
  power: "Batt",
  chargeStart: 80,
  chargeEnd: 48,
};

/**
 * 기본 증거 = **T1 인프로세스 감지(절전)** 상태. 부팅 시각 불변 · pid 동일 · 증거 전부 정상.
 * 각 테스트는 여기서 필요한 필드만 뒤집는다. 기본값을 "가장 흔한 사건"으로 둔 이유는,
 * 테스트 본문에 적힌 override 가 곧 "그 케이스를 그 케이스로 만드는 조건"이 되기 때문이다.
 */
function ev(over: Partial<Evidence> = {}): Evidence {
  return {
    gapMs: GAP_MS,
    gapStartSec: GAP_START,
    gapEndSec: GAP_END,
    sleepWindows: [],
    bootEpochBefore: BOOT,
    bootEpochNow: BOOT,
    bootChanged: false,
    bootFromFallback: false,
    prevPid: 91880,
    currentPid: 91880,
    sameProcess: true,
    prevBeaconMode: "alive",
    lastCleanShutdownEpoch: CLEAN,
    shutdownLogParsed: true,
    panicAtEpoch: null,
    panicDirReadable: true,
    pmsetParsed: true,
    pmsetLines: [],
    darkWakeCount: 0,
    batteryAtGapStart: { percent: 80, onBattery: true },
    cpuSecondsInGap: 27.8,
    dutyPercent: 0.07,
    beaconWriteFailures: 0,
    clockSuspect: false,
    ...over,
  };
}

/** 재부팅 케이스의 공통 뼈대 — 부팅 시각이 공백 뒤로 이동하고 프로세스가 새로 떴다. */
function rebooted(over: Partial<Evidence> = {}): Partial<Evidence> {
  return {
    bootEpochNow: GAP_END - 5,
    bootChanged: true,
    prevPid: 91880,
    currentPid: 12345,
    sameProcess: false,
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// §10.1-1,2 — 사건을 아예 만들지 않는 두 경우
// ────────────────────────────────────────────────────────────────────────────

test("Q0: 90초 미만 공백은 사건이 아니다(null)", () => {
  assert.equal(classify(ev({ gapMs: 60_000 })), null);
  // 경계: 정확히 90초는 사건이다. `<` 이지 `<=` 가 아니다.
  assert.equal(classify(ev({ gapMs: MIN_GAP_MS - 1 })), null);
  assert.notEqual(classify(ev({ gapMs: MIN_GAP_MS })), null);
});

test("Q0b: 비컨이 없던 구간(첫 기동)은 재구성하지 않는다(null)", () => {
  // 설치 이전은 공백이 아니라 '기록이 없는 시간'이다. 사건으로 만들면 100% 오보다.
  assert.equal(classify(ev({ bootEpochBefore: null })), null);
  // gapMs 가 아무리 길어도 마찬가지다.
  assert.equal(classify(ev({ bootEpochBefore: null, gapMs: 30 * 24 * 3600 * 1000 })), null);
});

// ────────────────────────────────────────────────────────────────────────────
// §10.1-3~7 — Q1 (부팅 시각 불변)
// ────────────────────────────────────────────────────────────────────────────

test("★ Q1a: 2026-08-02 사고 재현 — 프로세스 생존 + 절전 윈도가 공백을 덮음 → sleep/확실", () => {
  // 이 테스트가 §1 트리거 수정(60초 하트비트 T1)의 회귀 방지선이다.
  // 그날 프로세스는 죽지 않았고(pid 91880, ELAPSED 16h46m) 벽시계만 10시간 45분 뛰었다.
  const v = classify(ev({ sleepWindows: [COVERING_WINDOW] }));
  assert.deepEqual(v, { cause: "sleep", confidence: "확실", gapExact: true });
});

test("Q1a: 프로세스 생존 + pmset 파싱 실패 → sleep/추정 (원인은 그대로, 확신도만 하향)", () => {
  // pmset 은 3순위 보강 증거다. 없다고 판정을 뒤집지 않는다(§3.3-3).
  const v = classify(ev({ pmsetParsed: false, sleepWindows: [] }));
  assert.deepEqual(v, { cause: "sleep", confidence: "추정", gapExact: true });
});

test("Q1a: 절전 윈도가 공백 끝을 못 덮으면 확실이 아니다(120초 여유 경계)", () => {
  const inside: SleepWindow = { ...COVERING_WINDOW, endSec: GAP_END - 120 };
  assert.equal(classify(ev({ sleepWindows: [inside] }))?.confidence, "확실");
  const outside: SleepWindow = { ...COVERING_WINDOW, endSec: GAP_END - 121 };
  assert.equal(classify(ev({ sleepWindows: [outside] }))?.confidence, "추정");
  // 닫는 Wake 를 못 찾은 윈도(endSec: null)는 절대 덮지 않는다 — 반쪽 증거로 확신하지 않는다.
  const open: SleepWindow = { ...COVERING_WINDOW, endSec: null };
  assert.equal(classify(ev({ sleepWindows: [open] }))?.confidence, "추정");
});

test("Q1b: pid 변경 + 직전 비컨 mode:'stopping' → restart-intended/확실", () => {
  // `launchctl kickstart -k` 가 SIGTERM 을 준다는 것은 임시 LaunchAgent 로 실측 확인됨.
  const v = classify(
    ev({ sameProcess: false, currentPid: 12345, prevBeaconMode: "stopping" })
  );
  assert.deepEqual(v, { cause: "restart-intended", confidence: "확실", gapExact: true });
});

test("Q1b는 Q1c보다 앞선다 — 종료 마커가 있으면 절전 윈도가 있어도 서비스 재시작이다", () => {
  const v = classify(
    ev({
      sameProcess: false,
      currentPid: 12345,
      prevBeaconMode: "stopping",
      sleepWindows: [COVERING_WINDOW],
    })
  );
  assert.equal(v?.cause, "restart-intended");
});

test("Q1c: pid 변경 + mode:'alive' + 절전 윈도가 덮음 → sleep/추정", () => {
  const v = classify(
    ev({ sameProcess: false, currentPid: 12345, sleepWindows: [COVERING_WINDOW] })
  );
  assert.deepEqual(v, { cause: "sleep", confidence: "추정", gapExact: true });
});

test("Q1d: pid 변경 + mode:'alive' + 절전 흔적 없음 → app-gap/추정", () => {
  const v = classify(ev({ sameProcess: false, currentPid: 12345, sleepWindows: [] }));
  assert.deepEqual(v, { cause: "app-gap", confidence: "추정", gapExact: true });
});

// ────────────────────────────────────────────────────────────────────────────
// §10.1-8~12 — Q2 (부팅 시각 변경)
// ────────────────────────────────────────────────────────────────────────────

test("Q2c: 정상 종료 기록이 부팅 245초 전 → reboot-clean/확실 (실측값 사용)", () => {
  // 2026-07-28 22:20:05 종료 → 22:24:10 부팅. 8개월 종료 기록 20건이 전부 이 형태였다.
  const v = classify(
    ev({
      ...rebooted({ bootEpochNow: BOOT }),
      gapStartSec: CLEAN - 30,
      gapEndSec: BOOT + 10,
      gapMs: (BOOT + 10 - (CLEAN - 30)) * 1000,
      lastCleanShutdownEpoch: CLEAN,
      bootEpochBefore: BOOT - 300_000,
    })
  );
  assert.deepEqual(v, { cause: "reboot-clean", confidence: "확실", gapExact: true });
});

test("Q2c 경계: 종료 기록이 공백 시작 120초 전까지는 정상, 121초 전이면 아니다", () => {
  const base = ev({
    ...rebooted(),
    bootEpochBefore: BOOT,
    bootEpochNow: GAP_END - 5,
  });
  assert.equal(
    classify({ ...base, lastCleanShutdownEpoch: GAP_START - 120 })?.cause,
    "reboot-clean"
  );
  assert.equal(
    classify({ ...base, lastCleanShutdownEpoch: GAP_START - 121 })?.cause,
    "power-cut"
  );
  // 새 부팅 60초 뒤까지도 같은 사건으로 본다(종료·부팅이 역전돼 보이는 경우).
  assert.equal(
    classify({ ...base, lastCleanShutdownEpoch: GAP_END - 5 + 60 })?.cause,
    "reboot-clean"
  );
  assert.equal(
    classify({ ...base, lastCleanShutdownEpoch: GAP_END - 5 + 61 })?.cause,
    "power-cut"
  );
});

test("Q2d: 정상 종료 기록이 직전 부팅보다 과거 → power-cut/확실", () => {
  const v = classify(
    ev({
      ...rebooted(),
      bootEpochBefore: BOOT,
      lastCleanShutdownEpoch: CLEAN, // 07-28 기록. 08-02 공백과 무관한 과거다.
      batteryAtGapStart: { percent: 62, onBattery: false },
    })
  );
  assert.deepEqual(v, { cause: "power-cut", confidence: "확실", gapExact: true });
});

test("Q2d: 위 + 마지막 잔량 4% & 배터리 전원 → battery-dead/추정", () => {
  const v = classify(
    ev({
      ...rebooted(),
      bootEpochBefore: BOOT,
      lastCleanShutdownEpoch: CLEAN,
      batteryAtGapStart: { percent: 4, onBattery: true },
    })
  );
  assert.deepEqual(v, { cause: "battery-dead", confidence: "추정", gapExact: true });
});

test("Q2d: 잔량이 낮아도 배터리 전원이 아니거나 모르면 방전으로 부르지 않는다", () => {
  const base = ev({ ...rebooted(), bootEpochBefore: BOOT, lastCleanShutdownEpoch: CLEAN });
  // AC 였다 → 방전이 아니다
  assert.equal(
    classify({ ...base, batteryAtGapStart: { percent: 4, onBattery: false } })?.cause,
    "power-cut"
  );
  // 모른다(null) → "모름"을 배터리 전원으로 뭉개지 않는다
  assert.equal(
    classify({ ...base, batteryAtGapStart: { percent: 4, onBattery: null } })?.cause,
    "power-cut"
  );
  // 잔량 자체를 모른다 → 방전 아님
  assert.equal(
    classify({ ...base, batteryAtGapStart: { percent: null, onBattery: true } })?.cause,
    "power-cut"
  );
  // 경계: 10% 는 방전, 11% 는 아니다
  assert.equal(
    classify({ ...base, batteryAtGapStart: { percent: 10, onBattery: true } })?.cause,
    "battery-dead"
  );
  assert.equal(
    classify({ ...base, batteryAtGapStart: { percent: 11, onBattery: true } })?.cause,
    "power-cut"
  );
});

test("Q2a: 공백 구간의 .panic 은 종료 기록보다 우선한다 → panic/확실", () => {
  const v = classify(
    ev({
      ...rebooted(),
      bootEpochBefore: BOOT,
      panicAtEpoch: GAP_START + 3600,
      // 정상 종료 기록이 공백 안에 있어도(=Q2c 조건 충족) 패닉이 이긴다.
      lastCleanShutdownEpoch: GAP_START + 10,
    })
  );
  assert.deepEqual(v, { cause: "panic", confidence: "확실", gapExact: true });
  // 양끝 포함
  assert.equal(classify(ev({ ...rebooted(), panicAtEpoch: GAP_START }))?.cause, "panic");
  assert.equal(classify(ev({ ...rebooted(), panicAtEpoch: GAP_END }))?.cause, "panic");
});

test("Q2a: 공백 밖의 .panic 은 무시한다 (예전 패닉이 오늘 재부팅을 오염시키지 않는다)", () => {
  const base = ev({ ...rebooted(), bootEpochBefore: BOOT, lastCleanShutdownEpoch: CLEAN });
  assert.equal(classify({ ...base, panicAtEpoch: GAP_START - 1 })?.cause, "power-cut");
  assert.equal(classify({ ...base, panicAtEpoch: GAP_END + 1 })?.cause, "power-cut");
});

test("★ Q2b fail-open: 종료 기록을 못 읽으면 unknown/불명 — 절대 power-cut 이 아니다", () => {
  // macOS 업그레이드로 shutdown.*.log 형식이 바뀌면 여기로 떨어진다.
  // 이때 '비정상'으로 단정하면 모든 재부팅이 정전으로 오보된다. 이 테스트가 그 방어선이다.
  const v = classify(
    ev({ ...rebooted(), bootEpochBefore: BOOT, shutdownLogParsed: false })
  );
  assert.deepEqual(v, { cause: "unknown", confidence: "불명", gapExact: true });

  // 배터리가 낮아도, 파일을 못 읽었으면 방전으로도 단정하지 않는다.
  const v2 = classify(
    ev({
      ...rebooted(),
      bootEpochBefore: BOOT,
      shutdownLogParsed: false,
      batteryAtGapStart: { percent: 3, onBattery: true },
    })
  );
  assert.equal(v2?.cause, "unknown");
});

test("★ Q2b fail-open 확장: parsed=true 인데 값이 null 인 계약 위반도 unknown 으로 착지", () => {
  // 명세 문자보다 한 겹 넓힌 지점(classify.ts 주석 참고). 이 방어가 없으면 증거 수집기의
  // 버그 하나가 곧바로 `power-cut/확실` 이라는 **가장 강한 단정**으로 새어 나간다.
  const v = classify(
    ev({
      ...rebooted(),
      bootEpochBefore: BOOT,
      shutdownLogParsed: true,
      lastCleanShutdownEpoch: null,
    })
  );
  assert.deepEqual(v, { cause: "unknown", confidence: "불명", gapExact: true });
});

// ────────────────────────────────────────────────────────────────────────────
// 1차 관문 — 부팅 시각 동일/변경 경계와 ★ 전원 계열 진입 불가
// ────────────────────────────────────────────────────────────────────────────

test("부팅 시각 경계: 5초 차이는 '동일', 6초 차이는 '변경'", () => {
  const nowSame = BOOT + BOOT_EPOCH_TOLERANCE_SEC; // 5초 → 동일
  const nowDiff = BOOT + BOOT_EPOCH_TOLERANCE_SEC + 1; // 6초 → 변경
  // 동일 → Q1 (여기서는 sameProcess:false + 절전 없음 → app-gap)
  assert.equal(
    classify(ev({ bootEpochNow: nowSame, sameProcess: false, currentPid: 1 }))?.cause,
    "app-gap"
  );
  // 변경 → Q2 (종료 기록이 과거 → power-cut)
  assert.equal(
    classify(
      ev({
        bootEpochNow: nowDiff,
        sameProcess: false,
        currentPid: 1,
        lastCleanShutdownEpoch: CLEAN,
      })
    )?.cause,
    "power-cut"
  );
  // 음의 방향(시각이 과거로 이동)도 절댓값으로 본다.
  assert.equal(
    classify(
      ev({
        bootEpochNow: BOOT - BOOT_EPOCH_TOLERANCE_SEC - 1,
        sameProcess: false,
        currentPid: 1,
        lastCleanShutdownEpoch: CLEAN,
      })
    )?.cause,
    "power-cut"
  );
});

test("1차 관문은 evidence.bootChanged 사본이 아니라 부팅 시각으로 다시 계산한다", () => {
  // 동결 사본이 틀어져 있어도 판정은 흔들리지 않아야 한다. 사본이 정본이 되면
  // 증거 수집기의 버그 하나가 곧바로 '정상 재시작 → 비정상 종료' 오보가 된다.
  const v = classify(
    ev({ bootChanged: true, sleepWindows: [COVERING_WINDOW], lastCleanShutdownEpoch: CLEAN })
  );
  assert.equal(v?.cause, "sleep");
});

test("★ 부팅 시각이 그대로면 전원 계열(power-cut/battery-dead/panic)에 절대 도달하지 않는다", () => {
  // 정상 재시작 오인 방지 1차 관문의 전수 확인. 나머지 증거를 어떻게 조합해도 마찬가지다.
  const forbidden = new Set<DowntimeCause>(["power-cut", "battery-dead", "panic"]);
  const allowed = new Set<DowntimeCause>(["sleep", "restart-intended", "app-gap"]);
  let n = 0;
  for (const sameProcess of [true, false]) {
    for (const prevBeaconMode of ["alive", "stopping"] as const) {
      for (const shutdownLogParsed of [true, false]) {
        for (const panicAtEpoch of [null, GAP_START + 60]) {
          for (const percent of [3, 80]) {
            for (const windows of [[], [COVERING_WINDOW]]) {
              for (const lastCleanShutdownEpoch of [null, CLEAN, GAP_START + 10]) {
                const v = classify(
                  ev({
                    sameProcess,
                    currentPid: sameProcess ? 91880 : 12345,
                    prevBeaconMode,
                    shutdownLogParsed,
                    panicAtEpoch,
                    batteryAtGapStart: { percent, onBattery: true },
                    sleepWindows: windows,
                    lastCleanShutdownEpoch,
                  })
                );
                assert.ok(v, "90초를 넘는 공백은 항상 판정이 나와야 한다");
                assert.ok(
                  !forbidden.has(v.cause) && allowed.has(v.cause),
                  `부팅 불변인데 ${v.cause} 가 나왔다`
                );
                n += 1;
              }
            }
          }
        }
      }
    }
  }
  assert.equal(n, 2 * 2 * 2 * 2 * 2 * 2 * 3);
});

// ────────────────────────────────────────────────────────────────────────────
// 공통 후처리 — 확신도 하향과 gapExact
// ────────────────────────────────────────────────────────────────────────────

test("하향①: beaconWriteFailures > 0 이면 한 단계 내려간다", () => {
  const base = { sleepWindows: [COVERING_WINDOW] } satisfies Partial<Evidence>;
  assert.equal(classify(ev(base))?.confidence, "확실");
  assert.equal(classify(ev({ ...base, beaconWriteFailures: 2 }))?.confidence, "추정");
  // 추정에서 시작하면 불명까지 간다(바닥).
  assert.equal(
    classify(ev({ sleepWindows: [], beaconWriteFailures: 1 }))?.confidence,
    "불명"
  );
});

test("하향②: pmsetParsed === false 는 '확실'일 때만 한 단계 (판정을 뒤집지 않는다)", () => {
  // pmset 은 3순위 보강 증거라, 없다고 1·2순위(boot/shutdown) 판정까지 '불명'으로 내리지 않는다.
  assert.equal(
    classify(ev({ sleepWindows: [COVERING_WINDOW], pmsetParsed: false }))?.confidence,
    "추정"
  );
  // 이미 '추정'이면 그대로 '추정' — 여기가 다른 하향 규칙과 다른 유일한 지점이다.
  assert.equal(
    classify(ev({ sameProcess: false, currentPid: 1, pmsetParsed: false }))?.confidence,
    "추정"
  );
});

test("하향③: clockSuspect 는 확신도를 내리고 gapExact 를 포기시킨다(원인은 유지)", () => {
  const v = classify(ev({ sleepWindows: [COVERING_WINDOW], clockSuspect: true }));
  assert.deepEqual(v, { cause: "sleep", confidence: "추정", gapExact: false });
  // 시계가 튀어도 분류는 바뀌지 않는다 — kern.boottime 이 함께 보정되는지 미검증이라
  // 이 신호로 원인을 갈아치우지 않기로 했다(§4.5).
  const v2 = classify(
    ev({
      ...rebooted(),
      bootEpochBefore: BOOT,
      lastCleanShutdownEpoch: CLEAN,
      clockSuspect: true,
    })
  );
  assert.deepEqual(v2, { cause: "power-cut", confidence: "추정", gapExact: false });
});

test("하향④: bootFromFallback(sysctl 실패)도 한 단계 내려간다", () => {
  // §4.1 + shared/uptime.ts 필드 주석의 계약. confidence 를 만드는 곳이 여기뿐이라 여기서 이행한다.
  assert.equal(
    classify(ev({ sleepWindows: [COVERING_WINDOW], bootFromFallback: true }))?.confidence,
    "추정"
  );
});

test("하향은 누적된다 — 확실에서 두 겹이면 불명까지 간다", () => {
  const v = classify(
    ev({ sleepWindows: [COVERING_WINDOW], clockSuspect: true, beaconWriteFailures: 3 })
  );
  assert.deepEqual(v, { cause: "sleep", confidence: "불명", gapExact: false });
});

test("bootEpochNow 를 아예 못 읽으면 무조건 '불명'이고, Q1 로 떨어져 전원 계열이 아니다", () => {
  const v = classify(
    ev({ bootEpochNow: null, sleepWindows: [COVERING_WINDOW], lastCleanShutdownEpoch: CLEAN })
  );
  assert.deepEqual(v, { cause: "sleep", confidence: "불명", gapExact: true });
});

// ────────────────────────────────────────────────────────────────────────────
// 커버리지 — 8종 cause 가 전부 도달 가능한가
// ────────────────────────────────────────────────────────────────────────────

test("8종 cause 가 모두 실제로 도달 가능하다(죽은 분기가 없다)", () => {
  const seen = new Set<DowntimeCause>();
  const push = (e: Evidence) => {
    const v = classify(e);
    if (v) seen.add(v.cause);
  };
  push(ev({ sleepWindows: [COVERING_WINDOW] })); // sleep
  push(ev({ sameProcess: false, currentPid: 1, prevBeaconMode: "stopping" })); // restart-intended
  push(ev({ sameProcess: false, currentPid: 1 })); // app-gap
  push(ev({ ...rebooted(), lastCleanShutdownEpoch: GAP_START + 10 })); // reboot-clean
  push(ev({ ...rebooted(), lastCleanShutdownEpoch: CLEAN })); // power-cut
  push(
    ev({
      ...rebooted(),
      lastCleanShutdownEpoch: CLEAN,
      batteryAtGapStart: { percent: 4, onBattery: true },
    })
  ); // battery-dead
  push(ev({ ...rebooted(), panicAtEpoch: GAP_START + 1 })); // panic
  push(ev({ ...rebooted(), shutdownLogParsed: false })); // unknown

  assert.deepEqual(
    [...seen].sort(),
    [
      "app-gap",
      "battery-dead",
      "panic",
      "power-cut",
      "reboot-clean",
      "restart-intended",
      "sleep",
      "unknown",
    ]
  );
});

test("classify 는 입력을 변형하지 않는다(순수 함수)", () => {
  // 사건 원장에 동결 저장될 증거를 판정이 건드리면, 나중에 '이 판정이 맞았나'를 되짚을 수 없다.
  const input = ev({ sleepWindows: [COVERING_WINDOW] });
  const snapshot = JSON.stringify(input);
  classify(input);
  assert.equal(JSON.stringify(input), snapshot);
});
