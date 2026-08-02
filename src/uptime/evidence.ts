/**
 * 가동 중단 사후 보고 — **증거 수집**(명세 §4 전부).
 *
 * ## 이 파일의 한 줄 요약
 * "공백이 감지됐다"는 사실만 들고 와서, macOS 가 이미 남겨 둔 흔적 네 가지(`kern.boottime` /
 * `shutdown.*.log` / `.panic` / `pmset -g log`)를 긁어 `Evidence` 한 덩어리로 조립한다.
 * 판정(`classify.ts`)은 여기서 나온 값만 보고 순수 함수로 결론을 낸다.
 *
 * ## ★ 절대 규칙 셋 (어기면 이 기능이 서비스를 죽인다)
 * 1. **모든 외부 호출에 타임아웃.** `execFileSync` 는 timeout 을 안 주면 영원히 매달린다.
 *    진단 기능이 멎어서 `startUptimeWatch()` 가 반환하지 못하면 그 뒤의 `startScheduler()`
 *    까지 막힌다 — 사고를 설명하려다 사고를 만드는 셈이다(명세 §9.3).
 * 2. **모든 실패를 삼킨다.** 이 파일에서 밖으로 던지는 예외는 0건이다. 실패는 전부
 *    `null` + `*Parsed/*Readable = false` 로 표현하고, 판정 트리가 그걸 보고 fail-open
 *    (`unknown/불명`)으로 내려간다(§3.2 Q2b). **"못 읽었다"를 "없었다"로 뭉개지 않는다.**
 * 3. **프라이버시 화이트리스트.** `pmset -g log` 원문은 어떤 필드에도 담기지 않는다(§4.4).
 *    남기는 것은 `at/kind/reason/power/charge` 다섯 개뿐이다.
 *
 * ## 호출 시점
 * **공백이 감지됐을 때만** 부른다. 무사고 경로 비용은 0이다(하트비트 틱은 비컨만 쓴다).
 * 유일한 예외가 `getBootEpoch()` 인데, 이건 프로세스 기동 시 1회 읽어 캐시한다(§4.1).
 *
 * 실측 환경: macOS 26 / Apple Silicon / 2026-08-02. 이 파일의 모든 수치 주석은 이 맥에서
 * 직접 실행해 확인한 값이다.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLOCK_SUSPECT_THRESHOLD_MS,
  buildSleepWindows,
  isBootChanged,
  type BatterySample,
  type Evidence,
  type PmsetKind,
  type PmsetLine,
  type PmsetPowerSource,
  type UptimeBeacon,
} from "../../shared/uptime.ts";

// ────────────────────────────────────────────────────────────────────────────
// 0. 상수 — 경로·타임아웃·크기 한도
// ────────────────────────────────────────────────────────────────────────────

/**
 * 절대경로만 쓴다. launchd 로 뜬 프로세스의 `PATH` 는 로그인 셸과 다르므로
 * (`src/util/power.ts` 가 `/usr/bin/caffeinate` 를 절대경로로 쓰는 것과 같은 이유)
 * 이름만 넘기면 배포 환경에서만 조용히 실패한다.
 */
const SYSCTL_BIN = "/usr/sbin/sysctl";
const PMSET_BIN = "/usr/bin/pmset";

/** 정상 종료 기록이 사는 곳. `drwxr-x--- root:admin` 이고 이 계정은 admin 이라 sudo 불필요(실측). */
const DIAGNOSTICS_DIR = "/var/db/diagnostics";

/**
 * 커널 패닉 리포트 디렉터리. `drwxrwx--- root:_analyticsusers` 이고 이 계정은 그 그룹에
 * 속해 있어 읽을 수 있다(실측 `id` 로 확인).
 *
 * `Retired/` 를 같이 보는 이유는 아래 `readPanicReports()` 주석에 적었다.
 */
const PANIC_DIRS = [
  "/Library/Logs/DiagnosticReports",
  "/Library/Logs/DiagnosticReports/Retired",
];

/** `sysctl kern.boottime` 타임아웃(ms). 실측 5ms 미만. 2초면 사실상 무한대다. */
const SYSCTL_TIMEOUT_MS = 2_000;

/** `pmset -g log` 타임아웃(ms). 실측 0.91초 / 6.8MB / 31,234줄. 8초는 9배 여유. */
const PMSET_TIMEOUT_MS = 8_000;

/** `pmset -g log` 출력 상한. 실측 6.8MB 라 32MB 는 5배 여유. 초과하면 execFileSync 가 던지고 우리는 삼킨다. */
const PMSET_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * 종료 로그에서 읽는 꼬리 크기.
 *
 * 실측 근거: `shutdown.0.log` 는 442,975바이트에 8개월치 종료 20건이 들어 있고,
 * **마지막 `SIGTERM: [...]` 이 파일 끝에서 42바이트 지점**에 있다(종료 시퀀스의 마지막
 * 기록이라 구조적으로 항상 그렇다). 종료 1건당 평균 22KB 이므로 64KB 면 최근 2~3건을 덮는다.
 * `strings` 자식 프로세스를 띄우지 않는다 — Node 내장 read 로 실측 1ms 다.
 */
const SHUTDOWN_TAIL_BYTES = 64 * 1024;

/**
 * 사건 원장에 **동결 저장**할 pmset 라인을 고를 때 쓰는 앞뒤 여유(초).
 *
 * 공백 시작 1시간 전까지 보는 이유: `batteryAtGapStart`(공백 직전 잔량)의 근거 라인이
 * 공백 시작보다 한참 앞설 수 있기 때문이다.
 */
const PMSET_FREEZE_MARGIN_SEC = 3600;

/**
 * 동결 사본의 표본 개수. 실측으로 정한 값이다.
 *
 * 2026-08-02 사고 구간(10시간 45분)의 화이트리스트 라인은 141건이었다(Sleep 70 / DarkWake 69 /
 * Wake 2). 전부 동결하면 사건 1건이 11KB 가 되어 명세 §5.2 의 "건당 ~1.5KB" 예산을 7배
 * 초과한다. 그런데 그 70건의 Sleep 은 전부 같은 절전 구간 안의 'Maintenance Sleep' 반복이고,
 * DarkWake 69건은 이미 `darkWakeCount` 숫자로 요약돼 있어 개별 라인의 정보 가치가 0에 가깝다.
 *
 * 그래서 **공백 앞/안/뒤로 나눠 양끝만 표본으로 남긴다.** 이 규칙이 지키는 불변식 두 가지:
 * - 공백을 덮는 절전 윈도의 **여는 Sleep** 은 "공백 직전 마지막 라인" 또는 "공백 안 첫 라인"
 *   둘 중 하나이므로 반드시 남는다.
 * - **닫는 Wake** 는 아래 `FREEZE_KEEP_ALL_KINDS` 로 전량 보존한다(14일에 4건뿐인 희소 이벤트).
 * 즉 동결 사본만으로도 `buildSleepWindows()` 가 원본과 같은 커버 윈도를 재구성한다.
 * (실측 검증: 사고 구간을 이 규칙으로 잘라도 00:29:10 'Clamshell Sleep' 80% → 11:14:35 48%
 *  윈도가 그대로 복원된다.)
 */
const FREEZE_BEFORE_COUNT = 3;
const FREEZE_INSIDE_HEAD_COUNT = 6;
const FREEZE_INSIDE_TAIL_COUNT = 6;
const FREEZE_AFTER_COUNT = 2;
const FREEZE_HARD_CAP = 40;

/**
 * 표본 추출과 무관하게 **전량 보존**하는 종류.
 * `Wake`(14일 4건)와 `Start`(14일 1건)는 희소하면서 판정·문구에 직접 쓰인다.
 */
const FREEZE_KEEP_ALL_KINDS: readonly PmsetKind[] = ["Wake", "Start"];

// ────────────────────────────────────────────────────────────────────────────
// 1. 반환 타입 (다른 모듈이 부분 수집만 하고 싶을 때를 위해 공개한다)
// ────────────────────────────────────────────────────────────────────────────

/** `kern.boottime` 읽기 결과. `fromFallback` 이면 confidence 를 낮춰야 한다(§4.1). */
export interface BootEpochReading {
  epoch: number | null;
  fromFallback: boolean;
}

/** 정상 종료 기록 읽기 결과. `parsed === false` 면 판정은 무조건 `unknown/불명`(§3.2 Q2b). */
export interface CleanShutdownReading {
  epoch: number | null;
  parsed: boolean;
}

/** 패닉 조회 결과. `dirReadable === false` 를 "패닉 없음"으로 단정하지 않는다(§4.2). */
export interface PanicReading {
  panicAtEpoch: number | null;
  panicDirReadable: boolean;
}

/** `pmset -g log` 파싱 결과. 실패해도 판정은 계속 진행한다(confidence 만 하향). */
export interface PmsetReading {
  parsed: boolean;
  lines: PmsetLine[];
}

/**
 * `collectEvidence()` 입력 — **호출자(beacon.ts / index.ts)만 알 수 있는 것들**.
 *
 * 이 파일은 "지금 몇 시인가", "직전 비컨이 무엇이었나", "우리가 CPU 를 얼마나 썼나"를
 * 스스로 알 수 없다. 그건 하트비트를 소유한 쪽의 지식이므로 인자로 받는다.
 */
export interface GapContext {
  /** 공백 시작(epoch ms) = 직전 비컨의 `atMs`. */
  gapStartMs: number;
  /** 공백 끝(epoch ms) = 감지 시각. `Evidence.gapEndSec` = §3.2 의 `nowSec` 와 같은 값이다. */
  gapEndMs: number;
  /** 직전 비컨. 없으면(첫 기록/파손) null → `bootEpochBefore = null` → 판정 트리 Q0b 로 빠진다. */
  prevBeacon: UptimeBeacon | null;
  /** 지금 프로세스의 pid. 기본값 `process.pid`. 테스트에서 주입할 수 있게 열어 둔다. */
  currentPid?: number;
  /**
   * 지금 프로세스의 기동 시각(epoch ms). 주면 `sameProcess` 판정에 **pid 재사용 방어**가 붙는다.
   * beacon.ts 가 비컨에 쓰는 `startedAtMs` 와 **같은 상수**를 넘겨야 한다(매 틱 재계산 금지).
   */
  startedAtMs?: number;
  /** 비컨 쓰기 누적 실패 횟수(§3.4). >0 이면 confidence 하향. */
  beaconWriteFailures?: number;
  /** 공백 구간에 실제로 쓴 CPU 시간(초). T1 에서만 계산 가능하고 T2 는 null(§5.2). */
  cpuSecondsInGap?: number | null;
  /**
   * 실가동률(%). 주면 그대로 쓰고, 안 주면 `cpuSecondsInGap / gapMs` 로 계산한다.
   *
   * 받는 통로를 열어 둔 이유: `beacon.ts` 의 `BeaconGap` 이 이미 같은 값을 소수 2자리로
   * 굳혀 내려보낸다. 여기서 또 계산하면 **같은 사건의 같은 숫자가 로그(0.05)와 원장(0.046)에
   * 다르게 남는다.** 반올림 규칙이 둘로 갈리는 것을 원천 차단한다.
   */
  dutyPercent?: number | null;
  /**
   * 시계 점프 의심(§4.5). 주지 않으면 직전 비컨의 `osUptime` 과 대조해 자체 판단한다.
   * 재부팅이 끼면 `os.uptime()` 이 리셋되므로 그때는 판단하지 않고 false 로 둔다.
   */
  clockSuspect?: boolean;
  /** `pmset -g log` 를 이미 읽어 뒀다면 재사용(재평가 루프에서 중복 호출 방지). */
  pmset?: PmsetReading;
}

// ────────────────────────────────────────────────────────────────────────────
// 2. §4.1 부팅 시각 — 절전 ↔ 재부팅을 가르는 유일한 신호
// ────────────────────────────────────────────────────────────────────────────

/**
 * `sysctl -n kern.boottime` 출력에서 epoch(초)를 뽑는다. **순수 함수.**
 *
 * 실측 출력: `{ sec = 1785245048, usec = 802017 } Tue Jul 28 22:24:08 2026`
 * usec 는 버린다 — 우리가 쓰는 허용 오차가 5초(`BOOT_EPOCH_TOLERANCE_SEC`)라 무의미하고,
 * 폴백 경로는 애초에 초 단위 해상도밖에 없다.
 */
export function parseBootEpochFromSysctl(raw: string): number | null {
  const m = /sec\s*=\s*(\d+)/.exec(raw ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 지금 커널의 부팅 시각(초)을 읽는다. 캐시하지 않는 원본 읽기.
 *
 * 실패 폴백은 `Date.now()/1000 - os.uptime()` 이다.
 * 실측(2026-08-02): 부팅 4.8일 뒤·sleep/wake 71회 뒤에 폴백값이 sysctl 값과 **초 단위로 정확히
 * 일치**했다(둘 다 1785245048). 즉 macOS 의 `os.uptime()` 은 절전 시간을 포함하며 폴백은
 * 허용 오차 5초 안에 든다. 그래도 `fromFallback` 을 세워 올려보내는 이유는 이게 **문서화된
 * 보장이 아니라 관측**이기 때문이다 — 판정 트리는 confidence 를 한 단계 낮춘다(§4.1).
 */
export function readBootEpoch(): BootEpochReading {
  if (process.platform === "darwin") {
    try {
      const out = execFileSync(SYSCTL_BIN, ["-n", "kern.boottime"], {
        timeout: SYSCTL_TIMEOUT_MS,
        encoding: "utf8",
        // stderr 를 상속하면 sysctl 경고가 그대로 logs/stdout.log 에 섞인다. 삼킨다.
        stdio: ["ignore", "pipe", "ignore"],
      });
      const epoch = parseBootEpochFromSysctl(out);
      if (epoch != null) return { epoch, fromFallback: false };
    } catch {
      // 타임아웃·비정상 종료·바이너리 부재 — 전부 폴백으로 내려간다.
    }
  }
  try {
    const up = os.uptime();
    if (Number.isFinite(up) && up >= 0) {
      return { epoch: Math.floor(Date.now() / 1000 - up), fromFallback: true };
    }
  } catch {
    /* os.uptime() 이 던지는 플랫폼은 없지만 계약상 삼킨다. */
  }
  return { epoch: null, fromFallback: false };
}

/**
 * 기동 시 1회 읽어 캐시한 부팅 시각(§4.1).
 *
 * 절전으로 변하지 않는 값이므로 60초마다 자식 프로세스를 띄울 이유가 없다
 * (하루 1,440회 × sysctl = 순수 낭비). 재부팅하면 프로세스도 새로 뜨므로 캐시가 낡을 수 없다.
 */
let cachedBootEpoch: BootEpochReading | null = null;

/** 캐시된 부팅 시각. 첫 호출에서만 sysctl 을 실행한다. */
export function getBootEpoch(): BootEpochReading {
  if (cachedBootEpoch == null) cachedBootEpoch = readBootEpoch();
  return cachedBootEpoch;
}

/** 테스트 전용 — 캐시를 비운다. 운영 코드에서 부르지 말 것. */
export function resetBootEpochCache(): void {
  cachedBootEpoch = null;
}

// ────────────────────────────────────────────────────────────────────────────
// 3. §4.2 커널 패닉
// ────────────────────────────────────────────────────────────────────────────

/**
 * `.panic` 리포트들의 생성 시각(초) 목록.
 *
 * `Retired/` 를 같이 보는 이유(명세에는 없는 추가): 진단 리포트가 많이 쌓이면 macOS 가 오래된
 * 것을 `Retired/` 로 옮긴다(이 맥에 실제로 존재하고 파일이 들어 있다). 패닉을 놓치면 판정이
 * `panic` 이 아니라 **`power-cut / 확실`** 로 떨어진다 — 즉 "전원이 나갔습니다"라고 자신 있게
 * 오보한다. 디렉터리 하나 더 읽는 비용으로 그 오보를 막을 수 있으면 사는 게 맞다.
 * 없는 디렉터리는 조용히 건너뛴다.
 *
 * `dirReadable` 은 **주 디렉터리** 기준이다. 읽기 실패를 "패닉 없음"으로 단정하지 않는다.
 */
export function readPanicReports(): { epochs: number[]; dirReadable: boolean } {
  const epochs: number[] = [];
  let dirReadable = false;
  for (let i = 0; i < PANIC_DIRS.length; i++) {
    const dir = PANIC_DIRS[i];
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // 주 디렉터리 실패면 dirReadable 이 false 로 남는다.
    }
    if (i === 0) dirReadable = true;
    for (const name of names) {
      if (!name.endsWith(".panic")) continue;
      try {
        const st = fs.statSync(path.join(dir, name));
        const sec = Math.floor(st.mtimeMs / 1000);
        if (Number.isFinite(sec)) epochs.push(sec);
      } catch {
        /* 개별 파일 stat 실패는 그 파일만 건너뛴다. */
      }
    }
  }
  return { epochs, dirReadable };
}

/**
 * 공백 구간 `[gapStartSec, gapEndSec]` 안에 생긴 패닉의 **최댓값**(§3.2 Q2a).
 *
 * 실측: 이 맥에는 `.panic` 이 0건이다(8개월). 그래도 구현하는 이유는 §3.1 —
 * 원인을 뭉개지 않기 위해서다. 패닉을 `power-cut` 으로 부르면 "전원이 나갔다"는 오보가 된다.
 */
export function findPanicInGap(gapStartSec: number, gapEndSec: number): PanicReading {
  const { epochs, dirReadable } = readPanicReports();
  let best: number | null = null;
  for (const e of epochs) {
    if (e < gapStartSec || e > gapEndSec) continue;
    if (best == null || e > best) best = e;
  }
  return { panicAtEpoch: best, panicDirReadable: dirReadable };
}

// ────────────────────────────────────────────────────────────────────────────
// 4. §4.3 정상 종료 기록 — 판정의 1차 소스
// ────────────────────────────────────────────────────────────────────────────

/**
 * 종료 로그 꼬리 텍스트에서 마지막 정상 종료 epoch(초)를 뽑는다. **순수 함수.**
 *
 * 실측 라인: `SIGTERM: [1785244805] All buffers flushed`
 * — logd 가 종료 시퀀스 **마지막**에 남기는 줄이라, 이게 있으면 "정상 종료 절차를 밟았다"는
 * 뜻이다. 8개월치 20건이 전부 이 형태였다.
 *
 * ★ "Shutdown Cause" 는 쓰지 않는다. macOS 26 / Apple Silicon 에 **존재하지 않는다**
 *   (31,818줄 전수 조사 0건). 인터넷 문서를 따라 그걸 찾으면 영원히 못 찾는다.
 */
export function parseCleanShutdownEpoch(tailText: string): number | null {
  let best: number | null = null;
  const re = /SIGTERM:\s*\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tailText)) != null) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (best == null || n > best) best = n;
  }
  return best;
}

/** 파일의 마지막 `maxBytes` 만 읽어 latin1 로 디코드한다. 실패하면 null. */
function readTail(file: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size <= 0) return null;
    const len = Math.min(maxBytes, st.size);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, len, st.size - len);
    // latin1 은 어떤 바이트열에도 던지지 않는다. 이 로그는 바이너리가 섞일 수 있고
    // 우리가 찾는 것은 ASCII 패턴 하나뿐이라 디코드 정확성은 필요 없다.
    return buf.toString("latin1");
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 무시 */
      }
    }
  }
}

/**
 * `/var/db/diagnostics/shutdown.*.log` 전체를 글롭해 마지막 정상 종료 시각을 구한다.
 *
 * ★ 반드시 글롭한다. 지금은 `shutdown.0.log` 하나뿐이지만 `.0` 이라는 이름 자체가
 *   "`.1` 이 생길 수 있다"는 뜻이다. 회전이 일어난 날 하드코딩한 코드는 조용히 죽는다.
 *
 * ★ `parsed === false` 의 의미가 이 기능 전체에서 가장 무겁다. macOS 업그레이드로 형식이
 *   바뀌면 여기가 false 가 되고 판정은 `unknown/불명` 으로 떨어진다(§3.2 Q2b, fail-open).
 *   **비정상으로 단정하면 모든 재부팅이 정전 오보가 된다. 절대 금지.**
 */
export function readLastCleanShutdown(): CleanShutdownReading {
  let names: string[];
  try {
    names = fs.readdirSync(DIAGNOSTICS_DIR);
  } catch {
    return { epoch: null, parsed: false };
  }
  const files = names.filter((n) => n.startsWith("shutdown.") && n.endsWith(".log"));
  if (files.length === 0) return { epoch: null, parsed: false };

  let best: number | null = null;
  for (const name of files) {
    const tail = readTail(path.join(DIAGNOSTICS_DIR, name), SHUTDOWN_TAIL_BYTES);
    if (tail == null) continue;
    const e = parseCleanShutdownEpoch(tail);
    if (e != null && (best == null || e > best)) best = e;
  }
  // 파일은 있었는데 매치가 0건 → 형식이 바뀌었다는 뜻이므로 parsed=false 로 정직하게 내린다.
  return best == null ? { epoch: null, parsed: false } : { epoch: best, parsed: true };
}

// ────────────────────────────────────────────────────────────────────────────
// 5. §4.4 절전 구간 + 배터리 (`pmset -g log`) — ★ 프라이버시 화이트리스트
// ────────────────────────────────────────────────────────────────────────────

/**
 * 남기는 줄 종류 4종. **정확히 일치**해야 한다.
 *
 * ★★ 여기가 이 파일에서 가장 미묘한 곳이다. 명세 §4.4 의 정규식은
 *    `\s+(Sleep|Wake|DarkWake|Start)\b` 인데, 실측 로그에는 **`Wake Requests` 라는 별도
 *    라인 종류가 14일간 71건** 있다. `\b` 는 `Wake` 와 뒤따르는 공백 사이에서 성립하므로
 *    그 정규식은 `Wake Requests` 를 전부 `Wake` 로 잘못 읽는다.
 *
 *    결과가 얼마나 나쁜가: 2026-08-02 사고에서 `Sleep`(00:29:10) 2초 뒤에 `Wake Requests`
 *    (00:29:12)가 있다. 그걸 Wake 로 읽으면 절전 윈도가 **2초짜리**가 되어 10시간 45분 공백을
 *    덮지 못하고, 판정이 `sleep/확실` → `sleep/추정` 으로 떨어지며, 재시작이 낀 경로(Q1c)에서는
 *    아예 `app-gap`(프로그램 비정상 종료)으로 오분류된다. **이 기능이 존재해야 할 바로 그
 *    사건을 오답한다.**
 *
 *    그래서 실제 컬럼 구조를 쓴다: `<날짜> <시각> <오프셋> <종류…패딩>\t<상세>`.
 *    탭 앞 컬럼을 trim 해서 **정확히** 4종과 대조한다(실측 컬럼 분포: Assertions 28,482 /
 *    ThermalEvent 1,537 / Kernel Client Acks 146 / Notification 143 / WakeDetails 74 /
 *    HibernateStats 74 / Sleep 72 / WakeTime 71 / **Wake Requests 71** / PM Client Acks 71 /
 *    sleepservices.* 140 / DarkWake 70 / Wake 4 / Start 1).
 */
const PMSET_KINDS: readonly PmsetKind[] = ["Sleep", "Wake", "DarkWake", "Start"];

/**
 * pmset 로그 한 줄의 뼈대.
 * `2026-08-02 00:29:10 +0900 Sleep               \tEntering Sleep state due to 'Clamshell Sleep':…`
 */
const PMSET_LINE_RE =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})\s+([^\t]*)(?:\t([\s\S]*))?$/;

/**
 * 사유 캡처 — 작은따옴표 안 최대 40자(§4.4 그대로).
 * 실측으로 나오는 값은 4종뿐이다: `Maintenance Sleep`(40) / `Sleep Service Back to Sleep`(28) /
 * `Clamshell Sleep`(3) / `Notification Wake Back to Sleep`(1).
 */
const PMSET_REASON_RE = /'([^']{1,40})'/;

/**
 * 사유 문자 화이트리스트(명세를 넘어선 **방어 심층화**).
 *
 * 위 4종은 전부 영문·공백이다. 그런데 미래의 macOS 가 따옴표 안에 식별자를 넣기 시작하면
 * 명세 §10.4 가 금지한 문자열(`owner=`, `com.apple.`, `:501:`)이 원장에 흘러들 수 있다.
 * 정규식 하나로 그 가능성 자체를 없앤다 — 통과 못 하면 `reason = null` 이다.
 * (정보를 조금 잃는 대신, 유출은 0이 된다. 이 교환은 명세 §4.4 의 정신 그대로다.)
 */
const PMSET_REASON_SAFE_RE = /^[A-Za-z][A-Za-z0-9 .\-/()]{0,39}$/;

/** 위 화이트리스트를 통과해도 이 조각들이 보이면 버린다(이중 방어). */
const PMSET_REASON_DENY = ["com.apple.", "owner=", "=", "@", ":"];

/** `Using Batt` / `Using BATT` / `Using AC` — ★ 대소문자 혼용이 실측으로 확인됐다. */
const PMSET_POWER_RE = /Using\s+(Batt|BATT|AC)\b/i;

/** `(Charge:80%)` */
const PMSET_CHARGE_RE = /Charge:\s*(\d{1,3})%/;

/** `2026-08-02` + `00:29:10` + `+0900` → epoch(초). 실패 시 null. */
function toEpochSec(date: string, time: string, offset: string): number | null {
  // 로그가 오프셋을 들고 있으므로 **로컬 타임존을 가정하지 않는다.** 여름/겨울 시간이나
  // 여행 중 타임존 변경이 있어도 이 방식이면 흔들리지 않는다.
  const iso = `${date}T${time}${offset.slice(0, 3)}:${offset.slice(3, 5)}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * `pmset -g log` 전문을 **화이트리스트 5필드**로 재조립한다. **순수 함수.**
 *
 * 버리는 것(실측 유출 항목): `Wake Requests` / `Assertions` / `Notification` / `ThermalEvent` /
 * `PM Client Acks` / `Kernel Client Acks` / `HibernateStats` / `WakeDetails` / `WakeTime` /
 * `com.apple.sleepservices.*` **라인 타입 전체** — 14일 31,234줄 중 31,087줄(99.5%)이다.
 * 남기는 4종(147줄)에서도 원문 문자열은 단 한 글자도 저장하지 않는다.
 */
export function parsePmsetLog(text: string): PmsetLine[] {
  const out: PmsetLine[] = [];
  if (!text) return out;
  for (const raw of text.split("\n")) {
    const m = PMSET_LINE_RE.exec(raw);
    if (m == null) continue;
    const kindRaw = (m[4] ?? "").trim();
    if (!(PMSET_KINDS as readonly string[]).includes(kindRaw)) continue;
    const at = toEpochSec(m[1], m[2], m[3]);
    if (at == null) continue;
    const detail = m[5] ?? "";

    // ── reason: 따옴표 안 40자 → 문자 화이트리스트 → 조각 거부(3중) ──
    let reason: string | null = null;
    const rm = PMSET_REASON_RE.exec(detail);
    if (rm != null) {
      const cand = rm[1];
      if (PMSET_REASON_SAFE_RE.test(cand) && !PMSET_REASON_DENY.some((d) => cand.includes(d))) {
        reason = cand;
      }
    }

    // ── power: 대소문자 무시 후 정규 표기로 되돌린다 ──
    let power: PmsetPowerSource | null = null;
    const pm = PMSET_POWER_RE.exec(detail);
    if (pm != null) power = pm[1].toUpperCase() === "AC" ? "AC" : "Batt";

    // ── charge: 0~100 범위만 ──
    let charge: number | null = null;
    const cm = PMSET_CHARGE_RE.exec(detail);
    if (cm != null) {
      const n = Number(cm[1]);
      if (Number.isFinite(n) && n >= 0 && n <= 100) charge = n;
    }

    out.push({ at, kind: kindRaw as PmsetKind, reason, power, charge });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * `pmset -g log` 를 실행해 화이트리스트 라인만 돌려준다.
 * 실패/타임아웃이면 `parsed: false` — 판정은 계속하고 confidence 만 내려간다(§4.4).
 */
export function readPmsetLog(): PmsetReading {
  if (process.platform !== "darwin") return { parsed: false, lines: [] };
  let out: string;
  try {
    out = execFileSync(PMSET_BIN, ["-g", "log"], {
      timeout: PMSET_TIMEOUT_MS,
      maxBuffer: PMSET_MAX_BUFFER,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return { parsed: false, lines: [] };
  }
  const lines = parsePmsetLog(out);
  // 실행은 됐는데 화이트리스트 매치가 0건 = 출력 형식이 바뀌었다는 뜻이다. 정직하게 false.
  return { parsed: lines.length > 0, lines };
}

/** 공백 구간의 짧은 깨어남 횟수. 실측 사고 구간에서 69회였다. **순수 함수.** */
export function countDarkWakesInGap(
  lines: readonly PmsetLine[],
  gapStartSec: number,
  gapEndSec: number
): number {
  let n = 0;
  for (const l of lines) {
    if (l.kind === "DarkWake" && l.at >= gapStartSec && l.at <= gapEndSec) n++;
  }
  return n;
}

/**
 * 공백 시작 **직전**에 확인된 배터리 상태(§4.4). **순수 함수.**
 * 이 값 하나가 상시 `pmset -g batt` 샘플링(하루 288회 자식 프로세스)을 통째로 대체한다.
 *
 * `percent` 와 `onBattery` 를 각각 독립적으로 뒤로 훑는 이유: 한 줄이 둘 다 갖고 있다는
 * 보장이 없다(예: `Start` 라인은 둘 다 없다). 모르면 **null 로 남긴다 — false 로 뭉개면
 * `battery-dead` 판정(§3.2 Q2d)이 조용히 죽는다.**
 */
export function batteryAtGapStart(
  lines: readonly PmsetLine[],
  gapStartSec: number
): BatterySample {
  let percent: number | null = null;
  let onBattery: boolean | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.at > gapStartSec) continue;
    if (percent == null && l.charge != null) percent = l.charge;
    if (onBattery == null && l.power != null) onBattery = l.power === "Batt";
    if (percent != null && onBattery != null) break;
  }
  return { percent, onBattery };
}

/**
 * 원장에 동결할 표본을 고른다(위 `FREEZE_*` 상수 주석 참고). **순수 함수.**
 * 반환은 항상 시간 오름차순이고 중복이 없다.
 */
export function freezePmsetLines(
  lines: readonly PmsetLine[],
  gapStartSec: number,
  gapEndSec: number
): PmsetLine[] {
  const lo = gapStartSec - PMSET_FREEZE_MARGIN_SEC;
  const hi = gapEndSec + PMSET_FREEZE_MARGIN_SEC;
  const win = lines.filter((l) => l.at >= lo && l.at <= hi);

  const before = win.filter((l) => l.at < gapStartSec);
  const inside = win.filter((l) => l.at >= gapStartSec && l.at <= gapEndSec);
  const after = win.filter((l) => l.at > gapEndSec);

  const picked = new Set<PmsetLine>();
  const add = (arr: PmsetLine[]) => arr.forEach((l) => picked.add(l));

  add(before.slice(-FREEZE_BEFORE_COUNT));
  add(inside.slice(0, FREEZE_INSIDE_HEAD_COUNT));
  add(inside.slice(-FREEZE_INSIDE_TAIL_COUNT));
  add(after.slice(0, FREEZE_AFTER_COUNT));
  // 희소하면서 판정·문구에 직접 쓰이는 종류는 표본과 무관하게 전량 보존한다.
  add(win.filter((l) => FREEZE_KEEP_ALL_KINDS.includes(l.kind)));

  const out = [...picked].sort((a, b) => a.at - b.at);
  if (out.length <= FREEZE_HARD_CAP) return out;
  // 하드캡: 양끝(= 공백 경계 근처)이 정보 밀도가 높으므로 가운데를 버린다.
  const head = Math.ceil(FREEZE_HARD_CAP / 2);
  return [...out.slice(0, head), ...out.slice(out.length - (FREEZE_HARD_CAP - head))];
}

// ────────────────────────────────────────────────────────────────────────────
// 6. §4.5 시계 점프 의심
// ────────────────────────────────────────────────────────────────────────────

/**
 * 벽시계 델타와 `os.uptime()` 델타가 어긋나면 시계 점프를 의심한다. **순수 함수.**
 *
 * ⚠️ **미검증 사항(명세 §4.5 원문 그대로 남긴다)**: macOS 에서 NTP 대점프가 일어날 때
 *    `kern.boottime` 이 함께 보정되는지 확인하지 못했다. 따라서 이 신호는 **분류를 바꾸지
 *    않는다.** confidence 만 낮추고 `gapExact = false` 로 공백 길이 표기를 포기한다.
 *    분류까지 뒤집으면, 검증되지 않은 가설로 사용자에게 다른 원인을 말하게 된다.
 *
 * 재부팅이 낀 구간에서는 `os.uptime()` 이 0으로 리셋되므로 이 비교 자체가 무의미하다.
 * 그래서 호출부(`collectEvidence`)는 `bootChanged` 일 때 아예 부르지 않는다.
 */
export function isClockSuspect(wallDeltaMs: number, osUptimeDeltaMs: number): boolean {
  if (!Number.isFinite(wallDeltaMs) || !Number.isFinite(osUptimeDeltaMs)) return false;
  return Math.abs(wallDeltaMs - osUptimeDeltaMs) > CLOCK_SUSPECT_THRESHOLD_MS;
}

// ────────────────────────────────────────────────────────────────────────────
// 7. 조립 — `collectEvidence()`
// ────────────────────────────────────────────────────────────────────────────

/**
 * 공백 하나에 대한 증거 일습을 모아 `classify()` 입력으로 넘길 `Evidence` 를 만든다.
 *
 * ★ **절대 던지지 않는다.** 내부의 모든 I/O 는 각 함수에서 이미 삼켜져 있고, 여기서 추가로
 *   전체를 try 로 감싸지 않는 이유는 남은 코드가 순수 계산뿐이기 때문이다. 그래도 호출부
 *   (`index.ts`)는 §9.3 대로 전체를 try/catch 로 감싸야 한다 — 예산 초과 대비다.
 *
 * 비용: `pmset -g log` 0.91초 + sysctl(캐시 히트라 0) + 종료 로그 1ms + 패닉 readdir 1ms.
 * **공백이 감지됐을 때만** 부르므로 평시 비용은 0이다.
 */
export function collectEvidence(ctx: GapContext): Evidence {
  const gapStartSec = Math.floor(ctx.gapStartMs / 1000);
  const gapEndSec = Math.floor(ctx.gapEndMs / 1000);
  const gapMs = Math.max(0, ctx.gapEndMs - ctx.gapStartMs);

  const prev = ctx.prevBeacon;
  const currentPid = ctx.currentPid ?? process.pid;

  // ── 부팅 세션 ──
  const bootNow = getBootEpoch();
  const bootEpochBefore = prev?.bootEpoch ?? null;
  const bootChanged = isBootChanged(bootEpochBefore, bootNow.epoch);

  // ── 프로세스 동일성(T1 의 정체) ──
  // pid 만으로 보면 재사용(pid wrap) 시 남의 프로세스를 우리라고 착각할 수 있다. 호출부가
  // `startedAtMs` 를 주면 기동 시각까지 대조해 그 가능성을 없앤다.
  const prevPid = prev?.pid ?? null;
  const sameProcess =
    prev != null &&
    prevPid === currentPid &&
    (ctx.startedAtMs == null || prev.startedAtMs === ctx.startedAtMs);

  // ── 정상 종료 / 패닉 ──
  const shutdown = readLastCleanShutdown();
  const panic = findPanicInGap(gapStartSec, gapEndSec);

  // ── pmset ──
  const pmset = ctx.pmset ?? readPmsetLog();
  const sleepWindows = buildSleepWindows(pmset.lines);
  const darkWakeCount = countDarkWakesInGap(pmset.lines, gapStartSec, gapEndSec);
  const battery = batteryAtGapStart(pmset.lines, gapStartSec);

  // ── 시계 점프 ──
  let clockSuspect = ctx.clockSuspect ?? false;
  if (ctx.clockSuspect == null && prev != null && !bootChanged) {
    // 재부팅이 없었으면 os.uptime() 은 프로세스가 바뀌어도 연속이므로 T1/T2 모두 유효하다.
    let osNow: number | null = null;
    try {
      osNow = os.uptime();
    } catch {
      osNow = null;
    }
    if (osNow != null) {
      clockSuspect = isClockSuspect(gapMs, (osNow - prev.osUptime) * 1000);
    }
  }

  // ── 실가동률(문장 전용. 트리거로 쓰지 않는다 — §0 "의도적으로 버린 것") ──
  const cpuSecondsInGap = ctx.cpuSecondsInGap ?? null;
  const dutyPercent =
    ctx.dutyPercent != null
      ? ctx.dutyPercent
      : cpuSecondsInGap != null && gapMs > 0
        ? Math.round((cpuSecondsInGap / (gapMs / 1000)) * 100 * 1000) / 1000
        : null;

  return {
    // §5.2 evidence 20필드
    bootEpochBefore,
    bootEpochNow: bootNow.epoch,
    bootChanged,
    bootFromFallback: bootNow.fromFallback,
    prevPid,
    currentPid,
    sameProcess,
    prevBeaconMode: prev?.mode ?? null,
    lastCleanShutdownEpoch: shutdown.epoch,
    shutdownLogParsed: shutdown.parsed,
    panicAtEpoch: panic.panicAtEpoch,
    panicDirReadable: panic.panicDirReadable,
    pmsetParsed: pmset.parsed,
    pmsetLines: freezePmsetLines(pmset.lines, gapStartSec, gapEndSec),
    darkWakeCount,
    batteryAtGapStart: battery,
    cpuSecondsInGap,
    dutyPercent,
    beaconWriteFailures: ctx.beaconWriteFailures ?? prev?.writeFailures ?? 0,
    clockSuspect,
    // classify 전용 4필드
    gapMs,
    gapStartSec,
    gapEndSec,
    sleepWindows,
  };
}
