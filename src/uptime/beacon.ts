import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.ts";
import { systemAwakeMs } from "../util/deadline.ts";
import { log } from "../util/log.ts";
import {
  CLOCK_SUSPECT_THRESHOLD_MS,
  HEARTBEAT_INTERVAL_MS,
  MIN_GAP_MS,
  UPTIME_BEACON_FILE,
  UPTIME_BEACON_VERSION,
  type BeaconMode,
  type BeaconStopReason,
  type DowntimeSource,
  type UptimeBeacon,
} from "../../shared/uptime.ts";

/**
 * 가동 비컨 — 60초 하트비트 + **T1 인프로세스 공백 감지** + 정상종료 마커.
 *
 * ## ★ 이 파일이 왜 이번 설계의 핵심 수정인가
 * 초안 설계 셋은 전부 감지를 `src/index.ts` 기동 훅 1회(= T2 기동 부검)에 걸었다. 그런데
 * **2026-08-02 사고에서 프로세스는 죽지 않았다** — pid 91880 이 그대로 유지된 채 ELAPSED 가
 * 16h46m 이었고, 그 안에서 10시간 45분 동안 맥이 클램셸 슬립에 빠져 있었다. 기동이 없으니
 * 기동 훅은 발화하지 않고, 다음 배포 때는 "마지막 생존"이 이미 갱신돼 있어 공백이 0으로
 * 보인다. 즉 초안 셋은 **이 기능이 존재해야 할 바로 그 사건을 통째로 놓친다.**
 *
 * 그래서 주 경로를 기동 훅이 아니라 **60초 `setInterval` 틱**으로 옮겼다(명세 §1 T1).
 *
 * ## T1 이 성립하는 근거 (이 저장소가 이미 실측해 둔 것)
 * `src/scheduler/scheduler.ts:1055-1070` 주석:
 * > `setInterval` 은 시스템이 자는 동안 발화하지 않고, 깨어나면 밀린 발화를 **1회로 합쳐** 낸다.
 * > 즉 여기서 보이는 델타가 곧 '맥이 자고 있던 시간'이다.
 *
 * 스케줄러는 이 술어를 30분 틱에 쓰고 로그 한 줄을 남긴다. 우리는 같은 술어를 **60초 틱**에
 * 적용해 해상도를 올리고, 그 델타를 사건으로 확정한다. `sleepGapMessage`(scheduler.ts) 는
 * **건드리지 않는다** — 절전 감지기를 하나로 합치려고 스케줄러를 침습하는 것보다 로그 한 줄
 * 중복이 훨씬 싸다(명세 §1).
 *
 * ## NDJSON 시계열을 만들지 않는 이유
 * 초안 C 가 하루 2,880줄짜리 append 시계열을 둔 유일한 이유는 "재시작 없이 닫힌 공백을 나중에
 * 되짚기 위해서"였다. T1 이 그 공백을 **실시간으로** 잡아 사건으로 확정하므로 되짚을 대상이
 * 남지 않는다. 그래서 여기에는 **단일 레코드 하나뿐**이고, append 서브시스템·회전·용량 관리가
 * 전부 사라졌다(명세 §1 마지막 문단).
 *
 * ## 이 파일의 경계
 * - **소유**: 비컨 파일 read/write, 60초 틱, T1 공백 감지, SIGTERM/SIGINT 마커, `writeFailures`.
 * - **비소유**: 증거 수집(`evidence.ts`), 판정(`classify.ts`), 문장(`narrate.ts`),
 *   사건 저장·알림(`store.ts`/`notify.ts`), 기동 부검 T2 의 조립(`index.ts`).
 *   여기서는 **판정을 한 글자도 하지 않는다.** 공백이 있었다는 사실과 그 시간축·부수 계측만
 *   `BeaconGap` 으로 넘긴다.
 *
 * ## 절대 규칙
 * 이 모듈은 **절대 throw 하지 않는다.** 진단 기능이 서비스를 죽이면 본말전도다. 모든 실패는
 * 삼키고 로그만 남긴다(파일 I/O 실패, 콜백 예외, 시그널 경로 전부).
 *
 * 명세: `downtime-spec.md` §1(트리거) §3.4(기록 실패) §4.5(시계 점프) §5.1(비컨 스키마) §9.4(시그널).
 */

// ────────────────────────────────────────────────────────────────────────────
// 0. 경로
// ────────────────────────────────────────────────────────────────────────────

/**
 * 비컨은 `data/` 에 둔다 — `logs/` 가 아니다(명세 §5).
 *
 * `logs/` 는 launchd 소유(plist 의 `StandardOutPath`/`StandardErrorPath`)라 로그 정리 한 번에
 * 비컨이 함께 지워진다. 그러면 **다음 사고 전체를 놓친다** — 비컨이 없으면 T2 는 "첫 기록"
 * 으로 떨어지고(§3.2 Q0b) 공백을 계산할 기준점 자체가 사라지기 때문이다.
 */
const DEFAULT_BEACON_PATH = path.join(path.dirname(config.dbPath), UPTIME_BEACON_FILE);

/** 테스트에서만 갈아끼운다(`__testing.setBeaconPath`). 운영에서는 항상 null. */
let beaconPathOverride: string | null = null;

/** 지금 쓰는 비컨 파일의 절대경로. */
export function beaconFilePath(): string {
  return beaconPathOverride ?? DEFAULT_BEACON_PATH;
}

// ────────────────────────────────────────────────────────────────────────────
// 1. 모듈 상태
// ────────────────────────────────────────────────────────────────────────────

/**
 * 프로세스가 실제로 시작된 시각(epoch ms).
 *
 * `startUptimeBeacon()` 호출 시각이 아니라 **프로세스 시작 시각**을 쓴다. 비컨의
 * `startedAtMs` 는 "이 세대가 언제부터 살아 있었나"를 뜻하고, 기동 부검(T2)에서 앞 세대의
 * 수명을 읽는 값이라 훅 등록 시점이 섞이면 안 된다.
 */
const PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1000);

/**
 * 기동 시 1회 읽어 캐시한 `kern.boottime`(초). 절전으로 변하지 않는 값이므로 매 틱마다
 * sysctl 을 부르지 않는다(명세 §4.1). 값의 출처는 `evidence.ts` 이고, 여기서는 받아만 둔다 —
 * sysctl 파싱을 두 곳에 복제하면 폴백 경로(`bootFromFallback`)가 조용히 갈라진다.
 */
let cachedBootEpoch: number | null = null;

/**
 * 누적 쓰기 실패 횟수(§3.4). **메모리 카운터**이고 프로세스마다 0에서 시작한다.
 *
 * 앞 세대의 실패 횟수는 앞 세대가 남긴 레코드의 `writeFailures` 안에 들어 있으므로(마지막
 * 성공 쓰기에 실려 나간다) T2 는 그쪽을 보면 된다. 여기서 이어받으면 한 번 실패한 맥은
 * 영원히 confidence 가 깎인 채로 산다.
 *
 * 이 값이 0보다 크면 판정 confidence 를 한 단계 내리고 문체를 "…로 보입니다" 로 바꾼다.
 * "기록이 없다"와 "기록에 실패했다"를 사용자 문장 수준에서 구분하기 위한 장치다.
 */
let writeFailures = 0;

/** 쓰기 실패 로그 폭주 방지 카운터. 디스크가 가득 차면 하루 1,440회 경고가 찍힌다. */
let writeFailLogCount = 0;
/** 첫 실패 + 이후 60회(≈1시간)마다 한 줄. */
const WRITE_FAIL_LOG_EVERY = 60;

/** 마지막으로 조립한 비컨 레코드(쓰기 성공 여부와 무관). T1 의 `prev` 로 나간다. */
let lastRecord: UptimeBeacon | null = null;

/** 직전 틱의 계측 스냅샷. **T1 공백 판정의 기준점**이다. */
interface TickMark {
  /** `Date.now()` — 벽시계. */
  wallMs: number;
  /** `os.uptime()` — 초. 벽시계와 나란히 봐서 시계 점프를 의심한다(§4.5). */
  osUptimeSec: number;
  /** `process.cpuUsage()` user+system 누적(초). 공백 구간 실가동률의 재료. */
  cpuSeconds: number;
  /**
   * `systemAwakeMs()`(`src/util/deadline.ts`) — **시스템이 깨어 있던 누적 ms**. 측정 불가면 null.
   * `os.uptime()` 과 달리 **절전 중에는 멈춘다**. 이 둘의 차이가 곧 잔 시간이다.
   */
  awakeMs: number | null;
}
let lastTick: TickMark | null = null;

let timer: NodeJS.Timeout | null = null;
let started = false;
let stopping = false;
let signalHandlersInstalled = false;
let onGapCallback: ((gap: BeaconGap) => void) | null = null;

/** 앞 세대 비컨의 1회성 래치. `readPreviousBeacon()` 참고. */
let prevBeaconLatched = false;
let prevBeaconMemo: UptimeBeacon | null = null;

// ────────────────────────────────────────────────────────────────────────────
// 2. T1 이 넘기는 것
// ────────────────────────────────────────────────────────────────────────────

/**
 * 60초 틱이 잡아낸 **인프로세스 공백** 1건(T1).
 *
 * 여기에는 판정이 없다. 비컨만이 알 수 있는 사실 — 공백의 시간축, 앞 순간의 비컨 레코드,
 * 공백 구간의 CPU 소비, 시계 점프 의심 — 만 담아 `uptime/index.ts` 로 넘기고, 거기서
 * `evidence.ts` → `classify.ts` → `store.ts` 로 흘러간다.
 */
export interface BeaconGap {
  /** 항상 `"tick"`. T2(기동 부검)는 `uptime/index.ts` 가 `"boot"` 로 만든다. */
  source: DowntimeSource;
  /** 공백 길이(ms) = `gapEndMs - gapStartMs`. `MIN_GAP_MS` 이상일 때만 발화한다. */
  gapMs: number;
  /**
   * 공백 시작(epoch ms) = **직전 틱이 실제로 발화한 시각**.
   *
   * 프로세스는 이 시각 이후 최대 60초까지도 살아 있었을 수 있지만 그걸 증명할 수단이 없다.
   * 그래서 공백은 최대 60초 길게(=사건 시각이 최대 60초 이르게) 잡힌다. 보수적 방향이라
   * 무해하다는 것이 명세의 결정이다(§12.1-5).
   */
  gapStartMs: number;
  /** 공백 끝 = 감지 시각(epoch ms). 판정 트리의 `nowSec` 와 같은 순간이다. */
  gapEndMs: number;
  /**
   * 공백 직전의 마지막 생존 레코드(메모리 사본).
   *
   * ★ 디스크 파일이 아니라 **메모리 사본**이다. 쓰기가 실패해 파일이 낡아 있어도 이 값은
   *   정확하다 — T1 은 "이 프로세스가 그 순간 확실히 살아 있었다"는 사실만 쓰기 때문이다.
   */
  prev: UptimeBeacon;
  /**
   * 공백 구간에 실제로 CPU 를 쓴 시간(초). T1 에서만 계산할 수 있다(T2 는 null).
   *
   * ⚠️ **트리거로 쓰지 않는다.** 실측상 정상 유휴 서비스의 duty 가 0.0057%, 사고 구간이
   * 0.046% 로 **사고 쪽이 8배 높았다**(deadline.ts 주석의 반례와 같은 함정). 판별 방향이
   * 보장되지 않으므로 문장용 증거로만 쓴다 — "10시간 45분 중 실제로 일한 시간은 27.8초뿐".
   */
  cpuSecondsInGap: number;
  /** 위 값을 공백 길이로 나눈 백분율. 표시 전용이라 소수 2자리로 굳혀 보낸다. */
  dutyPercent: number;
  /** 시계 점프 의심(§4.5). 분류는 그대로 두고 confidence 와 길이 표기만 낮춘다. */
  clockSuspect: boolean;
  /** 감지 시점의 누적 쓰기 실패 횟수(§3.4). */
  writeFailures: number;
  /**
   * ★ 공백 중 **시스템이 실제로 자고 있던 ms**. 측정 불가 환경이면 null.
   *
   * ## 왜 이 필드를 명세에 없는데 추가했나
   * 오늘 만든 `src/util/deadline.ts` 의 `systemAwakeMs()` 를 그대로 재사용한 값이다
   * (`os.cpus()` 의 코어별 누적 틱 합 ÷ 코어 수 — 절전 중에는 증가하지 않는다). 같은 파일이
   * 실측해 둔 정확도가 이 기능이 원하는 바로 그것이다:
   * - 사고 구간(2026-08-02) 벽시계 111h25m27s vs 이 시계 100h40m4s → 격차 **10h45m23s**
   * - 같은 구간 `pmset -g log` 실측 합계 10h46m14s → **오차 51초(0.014%)**
   *
   * 즉 `pmset` 파싱과 **완전히 독립된 두 번째 절전 증거**를 공짜로(1회 16.7µs) 얻는다.
   * pmset 은 14일만 보존되고 파서가 macOS 업그레이드에 취약한데(§12.2-8·10), 이 값은 둘 다에
   * 해당하지 않는다. 또 판정 트리가 구분하지 못하는 한 가지 —
   * **"맥은 깨어 있었는데 우리 이벤트 루프만 멈춘 경우"** — 를 유일하게 반증할 수 있다
   * (그 경우 `systemSleptMs ≈ 0` 인데 §3.2 Q1a 는 여전히 `sleep` 이라고 부른다).
   *
   * ⚠️ **판정에는 아직 쓰이지 않는다.** `shared/uptime.ts` 의 `DowntimeEvidence` 계약이 이미
   *   확정돼 8개 모듈이 병렬 작성 중이라, 이 단계에서 필드를 밀어 넣으면 남의 작업을 깬다.
   *   그래서 여기서는 **감지 로그와 `BeaconGap`** 에만 싣는다. `narrate.ts` 가 판정근거 한 줄에
   *   쓰고 싶다면 `index.ts` 가 그대로 전달하면 되고, 아무도 안 쓰면 비용은 0이다.
   */
  systemSleptMs: number | null;
}

// ────────────────────────────────────────────────────────────────────────────
// 3. 읽기 — 앞 세대 비컨 (T2 기동 부검의 입력)
// ────────────────────────────────────────────────────────────────────────────

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function numOr(v: unknown, def: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}

/**
 * 비컨 파일을 읽어 검증·정규화한다. 없거나 깨졌거나 버전이 다르면 null.
 *
 * null 의 뜻은 판정 트리에서 **"첫 기록"**(§3.2 Q0b)이다 — 사건을 만들지 않고 조용히 지나간다.
 * 깨진 파일을 어떻게든 살려 쓰려 하지 않는 이유: 반쪽 레코드로 만든 `atMs` 는 공백 길이를
 * 직접 왜곡하고, 그 결과는 "없던 손실"을 사용자에게 보고하는 것이다. 한 번이라도 틀리면
 * 사용자는 이 기능을 다시 읽지 않는다.
 */
function loadBeaconFile(): UptimeBeacon | null {
  const file = beaconFilePath();
  let raw: string;
  try {
    if (!fs.existsSync(file)) return null;
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    log.warn(`가동 비컨 읽기 실패(${file}): ${(e as Error).message}`);
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("객체가 아님");
    parsed = v as Record<string, unknown>;
  } catch (e) {
    log.warn(`가동 비컨 형식 오류 — 첫 기록으로 취급합니다: ${(e as Error).message}`);
    return null;
  }

  if (numOrNull(parsed.v) !== UPTIME_BEACON_VERSION) {
    log.info(
      `가동 비컨 버전이 다릅니다(파일 ${String(parsed.v)} / 기대 ${UPTIME_BEACON_VERSION}) — ` +
        "이번 구간은 판정하지 않고 새로 기록을 시작합니다."
    );
    return null;
  }

  const atMs = numOrNull(parsed.atMs);
  if (atMs === null || atMs <= 0) {
    log.warn("가동 비컨에 마지막 생존 시각(atMs)이 없습니다 — 첫 기록으로 취급합니다.");
    return null;
  }

  return {
    v: UPTIME_BEACON_VERSION,
    atMs,
    at: typeof parsed.at === "string" ? parsed.at : new Date(atMs).toISOString(),
    pid: numOr(parsed.pid, 0),
    startedAtMs: numOr(parsed.startedAtMs, atMs),
    bootEpoch: numOrNull(parsed.bootEpoch),
    // ★ 모드가 없으면 "alive" 로 읽는다. `stopping` 은 **적극적으로 남긴 마커**이므로,
    //   없다는 것은 곧 "정상 종료 흔적이 없다"는 뜻이다. 반대로 뭉개면(없으면 stopping 으로
    //   간주) 진짜 크래시가 "서비스 재시작"으로 은폐된다.
    mode: parsed.mode === "stopping" ? "stopping" : "alive",
    stopReason:
      parsed.stopReason === "SIGTERM" || parsed.stopReason === "SIGINT"
        ? parsed.stopReason
        : null,
    cpuSeconds: numOr(parsed.cpuSeconds, 0),
    procUptime: numOr(parsed.procUptime, 0),
    osUptime: numOr(parsed.osUptime, 0),
    writeFailures: numOr(parsed.writeFailures, 0),
  };
}

/**
 * **앞 세대가 남긴 비컨**을 돌려준다. 첫 호출에서 디스크를 읽고 그 값을 영구 래치한다.
 *
 * ★ 래치가 방어하는 것: 이 프로세스가 비컨을 한 번이라도 쓰면 앞 세대의 기록은 사라진다.
 *   즉 T2 기동 부검은 **반드시 첫 쓰기 전에** 이 값을 읽어야 하는데, 그 순서 제약이 호출부
 *   (`uptime/index.ts`)에 암묵적으로 걸려 있으면 언젠가 리팩터 한 번에 조용히 깨지고,
 *   깨진 사실은 다음 정전 때까지 아무도 모른다. 그래서 `startUptimeBeacon()` 이 첫 쓰기 직전에
 *   이 함수를 스스로 부르고, 값은 메모에 얼려 둔다 — **호출 순서를 틀려도 결과가 같다.**
 *
 * 반환 null = 첫 설치이거나 파일이 깨졌다 → 사건을 만들지 않는다(§3.2 Q0b, §12.1-2).
 */
export function readPreviousBeacon(): UptimeBeacon | null {
  if (prevBeaconLatched) return prevBeaconMemo;
  prevBeaconLatched = true;
  prevBeaconMemo = loadBeaconFile();
  return prevBeaconMemo;
}

// ────────────────────────────────────────────────────────────────────────────
// 4. 쓰기 — tmp + fsync + rename
// ────────────────────────────────────────────────────────────────────────────

/** `process.cpuUsage()` user+system 누적(초). µs 단위를 초로 접는다. */
function cpuSecondsNow(): number {
  const u = process.cpuUsage();
  return round1((u.user + u.system) / 1_000_000);
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * 표시 전용 백분율. 소수 2자리로 굳힌다(명세 §5.2 예시의 `dutyPercent: 0.07` 과 같은 자릿수).
 *
 * 정밀도를 더 두지 않는 이유: 이 값은 **판정에 절대 쓰이지 않는다**(§0 에서 duty 트리거는
 * 실측 반증으로 폐기됐다). 오직 "10시간 45분 중 실제로 일한 시간은 27.8초(0.07%)뿐입니다"
 * 라는 문장 한 줄의 재료이므로, 자릿수를 늘리면 문장만 지저분해진다.
 */
const round2 = (n: number): number => Math.round(n * 100) / 100;

function composeBeacon(nowMs: number, mode: BeaconMode, stopReason: BeaconStopReason | null): UptimeBeacon {
  return {
    v: UPTIME_BEACON_VERSION,
    atMs: nowMs,
    at: new Date(nowMs).toISOString(),
    pid: process.pid,
    startedAtMs: PROCESS_STARTED_AT_MS,
    bootEpoch: cachedBootEpoch,
    mode,
    stopReason,
    cpuSeconds: cpuSecondsNow(),
    procUptime: round1(process.uptime()),
    osUptime: Math.round(os.uptime()),
    // ★ 이 레코드에 실리는 값은 **이번 쓰기 직전까지의** 실패 횟수다(§3.4 "다음 성공 쓰기에
    //   실어 보낸다"). 즉 파일에 남은 숫자는 "이 기록이 나오기까지 몇 번 실패했는가"이다.
    writeFailures,
  };
}

/**
 * 비컨 1레코드를 원자적으로 덮어쓴다. **성공 여부를 boolean 으로 돌려주고 절대 throw 하지 않는다.**
 *
 * ## 왜 fsync 가 필수인가 (명세 §5.1)
 * 안 켜면 전원 차단 시 마지막 기록이 페이지캐시에 남은 채 유실돼 **사망 시각이 실제보다
 * 과거로 보인다**. 그러면 공백이 실제보다 길게 잡히고, 그 길이만큼 "없던 손실"이 사용자에게
 * 보고된다. 이 기능이 신뢰를 잃는 가장 빠른 경로다.
 *
 * ## 실측 (2026-08-02, 이 맥, 50회 평균)
 * - `open + write + fsync + rename` = **4.47ms** (명세의 4.19ms 와 일치)
 * - 여기에 디렉터리 fsync 까지 더하면 **8.94ms** — 정확히 2배.
 *
 * 디렉터리 fsync 는 **채택하지 않았다.** 그것이 추가로 지켜 주는 것은 "rename 자체의 내구성"
 * 인데, 그게 깨졌을 때의 손실은 *직전 60초 레코드로 되돌아가는 것*뿐이라 우리가 이미 명시적으로
 * 감수한 60초 해상도(§12.1-5) 안에 들어간다. 비용을 2배로 내고 사는 값이 아니다.
 *
 * ⚠️ 그리고 macOS 의 `fsync(2)` 는 데이터를 드라이브까지 밀어낼 뿐 플래터/셀 기록까지 보장하지
 *   않는다(그건 `F_FULLFSYNC` 인데 Node 가 노출하지 않는다). 우리가 막으려던 것은 "페이지캐시
 *   유실"이므로 목적은 달성되지만, **완전한 전원차단 내구성은 Node 에서 불가능**하다는 사실을
 *   여기 남긴다.
 */
function writeBeaconSync(rec: UptimeBeacon): boolean {
  const file = beaconFilePath();
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(rec, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    writeFailures += 1;
    // 디스크 가득참·권한 오류는 매 틱 재현되므로, 그대로 두면 stdout.log 에 하루 1,440줄이
    // 쌓여 정작 사고 당일의 한국어 보고를 덮어 버린다. 첫 실패 + 이후 1시간마다 한 줄만 남긴다.
    if (writeFailLogCount % WRITE_FAIL_LOG_EVERY === 0) {
      log.warn(
        `가동 비컨 기록 실패(누적 ${writeFailures}회, ${file}): ${(e as Error).message} — ` +
          "이 구간의 중단 판정은 확신도를 낮춰 보고합니다."
      );
    }
    writeFailLogCount += 1;
    // ⚠️ 남은 `.tmp` 를 unlink 하지 않는다. `data/` 에는 price.db 와 20여 개 스냅샷이 함께
    //    살고, 이 디렉터리에서 파일을 지우는 코드는 만들지 않기로 했다(명세 §5.2 경고).
    //    다음 쓰기의 `open(..., "w")` 가 어차피 truncate 하므로 방치해도 누적되지 않는다.
    return false;
  }
}

/** 지금까지의 누적 비컨 쓰기 실패 횟수(§3.4). T1 증거의 `beaconWriteFailures`. */
export function getBeaconWriteFailures(): number {
  return writeFailures;
}

/**
 * 이 프로세스의 기동 시각(epoch ms) — 비컨의 `startedAtMs` 와 **같은 상수**.
 *
 * `evidence.ts` 의 `GapContext.startedAtMs` 가 요구하는 값이다(pid 재사용 방어). 호출부가
 * `Date.now() - process.uptime()*1000` 을 그때그때 다시 계산하면 읽는 시점마다 수십 ms 씩
 * 흔들리는데, 그 값이 비컨에 적힌 값과 어긋나는 순간 `sameProcess` 판정이 **같은 프로세스를
 * 다른 프로세스로** 읽는다. 그래서 계산은 모듈 적재 시 1회로 고정하고 여기로만 꺼내 준다.
 */
export function processStartedAtMs(): number {
  return PROCESS_STARTED_AT_MS;
}

// ────────────────────────────────────────────────────────────────────────────
// 5. T1 — 60초 하트비트 틱
// ────────────────────────────────────────────────────────────────────────────

/**
 * 한 틱. **절대 throw 하지 않는다** — `setInterval` 콜백에서 예외가 새면 uncaughtException 으로
 * 프로세스가 죽고, 그건 이 기능이 막으려던 사고보다 훨씬 나쁘다.
 *
 * ## 상시 비용 실측 (2026-08-02, 190초 라이브 실행)
 * 틱 3회 동안 CPU 누적 **0.2초**(duty 0.11%), 비컨 `atMs` 는 180초 정확히 전진, 쓰기 실패 0회,
 * **오탐 공백 0건**. 즉 평상시에는 60초마다 4.5ms 짜리 쓰기 한 번이 전부다.
 */
function tick(): void {
  try {
    const prev = lastTick;
    const prevRecord = lastRecord;
    const nowMs = Date.now();
    const osUptimeSec = os.uptime();
    const cpuSeconds = cpuSecondsNow();
    const awakeMs = systemAwakeMs();

    // 다음 틱의 기준점을 **먼저** 갱신한다. 아래에서 무슨 일이 생겨도 기준점이 낡은 채로
    // 남아 다음 틱이 같은 공백을 두 번 보고하는 일은 없어야 한다.
    lastTick = { wallMs: nowMs, osUptimeSec, cpuSeconds, awakeMs };

    const record = composeBeacon(nowMs, "alive", null);
    writeBeaconSync(record);
    lastRecord = record;

    if (!prev || !prevRecord) return;

    const wallDelta = nowMs - prev.wallMs;
    const osDelta = (osUptimeSec - prev.osUptimeSec) * 1000;

    /**
     * ## 시계 점프 의심 (§4.5)
     *
     * macOS 의 `os.uptime()` 은 `time(NULL) - kern.boottime.tv_sec` 이다 — 오늘 실측으로
     * 확인했다: `os.uptime() = 415941`, `Math.floor(Date.now()/1000) - boottime = 415941`
     * (완전 일치). 즉 **절전 시간까지 포함해서** 벽시계와 나란히 흐른다. 그래서 절전 구간에서는
     * `wallDelta ≈ osDelta` 가 되어 여기서 걸리지 않는다 — 절전을 시계 점프로 오인하지 않는다.
     *
     * 반대로 NTP 대점프·수동 시각 변경으로 `kern.boottime` 이 함께 보정되면 `osDelta` 만
     * 연속을 유지하고 `wallDelta` 가 튀어 둘이 벌어진다. 그게 우리가 잡으려는 것이다.
     *
     * ⚠️ **미검증 사항**: macOS 가 대점프 시 `kern.boottime` 을 함께 보정하는지 확인하지
     *   못했다. 보정하지 않는다면 두 값이 같이 튀어 이 신호는 **발화하지 않는다**(오탐이 아니라
     *   미탐이다). 그래서 이 신호는 **분류를 바꾸지 않고 confidence 만 낮추고 길이 표기를
     *   포기하는 데에만** 쓴다. 판정을 여기에 걸면 검증 못 한 가정 위에 결론을 쌓는 셈이 된다.
     */
    const clockSuspect = Math.abs(wallDelta - osDelta) > CLOCK_SUSPECT_THRESHOLD_MS;

    if (wallDelta < MIN_GAP_MS) {
      // 공백은 아니지만 시계가 튄 것 같으면 한 줄 남긴다. 사건이 안 만들어지는 경로라
      // 이 로그가 없으면 나중에 "왜 저 구간 판정이 이상하지"를 되짚을 근거가 아무 데도 없다.
      if (clockSuspect) {
        log.warn(
          `시스템 시계 점프 의심 — 벽시계 ${Math.round(wallDelta / 1000)}초 / ` +
            `가동시계 ${Math.round(osDelta / 1000)}초 (틱 간격 ${HEARTBEAT_INTERVAL_MS / 1000}초). ` +
            "이 구간에 중단이 잡히면 길이 표기를 생략합니다."
        );
      }
      return;
    }

    const cpuSecondsInGap = Math.max(0, round1(cpuSeconds - prev.cpuSeconds));

    /**
     * 공백 중 실제로 잔 시간 = 벽시계 − (깨어 있던 시계의 증가분).
     *
     * 깨어 있던 시계가 벽시계를 근소하게 앞지르는 구간이 실측된다(부팅 후 111시간 누적에서
     * 51초, 0.014%). 그래서 증가분을 벽시계로 클램프해 음수가 나오지 않게 한다.
     * 잡음 하한을 따로 두지 않는 이유: 이 값은 판정이 아니라 **표시·근거용**이라, 몇 백 ms 의
     * 잔여가 붙어도 해가 없고 오히려 임계값을 하나 더 발명하는 쪽이 나중에 갈라진다.
     */
    const awakeDelta =
      prev.awakeMs !== null && awakeMs !== null ? Math.max(0, awakeMs - prev.awakeMs) : null;
    const systemSleptMs =
      awakeDelta === null ? null : Math.round(wallDelta - Math.min(awakeDelta, wallDelta));

    const gap: BeaconGap = {
      source: "tick",
      gapMs: wallDelta,
      gapStartMs: prev.wallMs,
      gapEndMs: nowMs,
      prev: prevRecord,
      cpuSecondsInGap,
      dutyPercent: round2((cpuSecondsInGap * 1000 * 100) / wallDelta),
      clockSuspect,
      writeFailures,
      systemSleptMs,
    };

    /**
     * 감지 자체의 기술 로그 한 줄. 사용자에게 보이는 §6.2 의 한국어 경고(`log.warn`)와는
     * **다른 줄**이다 — 저쪽은 손실 게이트(§3.5)를 통과한 사건만 나가므로, `severity: "무시"`
     * 로 걸러진 공백은 저기 안 뜬다. 그러면 "T1 이 도는지"를 확인할 방법이 로그 어디에도 없다.
     * 이 한 줄이 감지기 자신의 생존 증명이고, 공백 1건당 정확히 1회만 찍힌다.
     */
    log.info(
      `가동 공백 감지(틱) — ${Math.round(wallDelta / 1000)}초 ` +
        `(${new Date(prev.wallMs).toISOString()} → ${new Date(nowMs).toISOString()}), ` +
        `프로세스 생존(pid ${process.pid}), 그 사이 CPU ${cpuSecondsInGap}초` +
        (systemSleptMs === null
          ? ""
          : `, 시스템 절전 ${Math.round(systemSleptMs / 1000)}초`)
    );

    const cb = onGapCallback;
    if (!cb) return;
    /**
     * ★ 콜백은 **다음 이벤트 루프 턴**으로 미룬다.
     *
     * 이 콜백은 `evidence.ts` 를 타고 `execFileSync("/usr/bin/pmset", ["-g","log"])`(예산 8초)
     * 까지 내려간다 — 즉 **동기 블로킹이 수 초** 걸릴 수 있다. 틱 안에서 그대로 부르면 그
     * 시간만큼 하트비트가 밀리고, 최악의 경우 다음 틱이 스스로 "공백"으로 오인된다.
     * 비컨 쓰기와 틱 기준점 갱신은 이미 위에서 끝났으므로 여기서 넘겨도 안전하다.
     */
    setImmediate(() => {
      try {
        cb(gap);
      } catch (e) {
        log.error(`가동 공백 처리 중 오류(무시하고 계속): ${(e as Error).message}`);
      }
    });
  } catch (e) {
    log.error(`가동 비컨 틱 오류(무시하고 계속): ${(e as Error).message}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 6. 정상종료 마커 (§9.4)
// ────────────────────────────────────────────────────────────────────────────

/**
 * SIGTERM/SIGINT 를 받고 **동기로** `mode:"stopping"` 마커를 남긴 뒤 즉시 종료한다.
 *
 * ## 왜 반드시 `process.exit(0)` 인가
 * 이 저장소에는 지금까지 `process.on(` 이 0건이었다. Node 는 `SIGTERM` 핸들러를 등록하는
 * 순간 **기본 종료 동작을 없앤다.** 핸들러가 늘어지면 launchd 의 exit timeout(5초) 뒤 SIGKILL
 * 이 되어 **매 배포가 5초 지연 + 강제 종료**가 되고, 그 순간 마커도 못 남긴다. 그래서 핸들러는
 * 전부 동기이고 반드시 즉시 종료한다 — await·네트워크·비동기 작업 금지.
 *
 * ## 종료 코드가 143 → 0 으로 바뀌는 것에 대해
 * 두 가지 이유로 안전하다:
 * 1. 우리는 `launchctl print` 의 last exit code 를 판정에 쓰지 않는다(명세 §0 에서 폐기).
 * 2. `service/com.daegun.dailyprice.plist.template` 의 `KeepAlive` 가 **무조건 true** 다
 *    (`SuccessfulExit` 조건부가 아니다). 실제 파일을 확인했다 — 종료 코드와 무관하게 되살아난다.
 *    만약 언젠가 `KeepAlive` 를 `{SuccessfulExit: false}` 로 바꾸면 **이 exit(0) 이 서비스를
 *    영구 정지시킨다.** 그때는 이 주석을 근거로 여기부터 고쳐야 한다.
 *
 * ## 실측 (2026-08-02, 실제 자식 프로세스에 실제 시그널을 보내 확인)
 * `kill -TERM` → 마커 기록 → 프로세스 종료까지 **6ms**(SIGINT 7ms), 종료 코드 **0**.
 * launchd 의 exit timeout 5,000ms 대비 **0.1%** 다. 즉 이 핸들러는 배포 경로를 열화시키지
 * 않는다 — 위 문단이 경고한 "5초 지연 + SIGKILL" 은 발생하지 않는다.
 */
function onStop(sig: BeaconStopReason): void {
  if (stopping) {
    process.exit(0);
    return;
  }
  stopping = true;
  try {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    /**
     * ★ 기준선을 세우기 전(= `lastRecord === null`)에는 **아무것도 쓰지 않는다.**
     *
     * 핸들러는 `startUptimeBeacon()` 안에서만 등록되므로 정상 경로에서는 항상 기준선이 있다.
     * 그래도 이 가드를 두는 이유: 여기서 `bootEpoch: null` 짜리 마커를 쓰면 앞 세대의 레코드를
     * 덮어써 버리는데, 그 순간 다음 기동의 판정 트리는 `bootEpochBefore == null` 이라
     * Q0b("첫 기록")로 떨어져 **공백을 통째로 잃는다.** 마커 하나를 얻자고 사건 하나를
     * 통째로 지우는 거래다 — 앞 세대 기록을 그대로 두는 편이 언제나 낫다.
     */
    if (lastRecord !== null) {
      writeBeaconSync(composeBeacon(Date.now(), "stopping", sig));
    }
  } catch {
    // 마커를 못 남기면 다음 기동이 이 재시작을 `app-gap`(프로그램 비정상 종료)으로 읽는다.
    // 오보이긴 하지만 손실 게이트가 대개 삼키고, 여기서 지연되는 것이 훨씬 나쁘다.
  }
  process.exit(0);
}

function installStopHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  process.on("SIGTERM", () => onStop("SIGTERM"));
  process.on("SIGINT", () => onStop("SIGINT"));
}

// ────────────────────────────────────────────────────────────────────────────
// 7. 공개 진입점
// ────────────────────────────────────────────────────────────────────────────

export interface UptimeBeaconOptions {
  /**
   * 기동 시 1회 읽은 `kern.boottime`(초). `evidence.ts` 가 읽어서 넘긴다.
   *
   * **필수 인자로 둔 이유**: 옵셔널로 두면 언젠가 빠뜨린 채 배포되고, 그때부터 비컨의
   * `bootEpoch` 가 영원히 null 이 되어 다음 세대의 판정 트리가 통째로 Q0b("첫 기록")로
   * 떨어진다. 즉 **T2 가 조용히 꺼진다.** 값을 모를 때(sysctl 실패)는 null 을 명시적으로
   * 넘겨라 — 그건 정보이고, 빠뜨림은 사고다.
   */
  bootEpoch: number | null;
  /** T1 공백을 넘겨받을 콜백. 블로킹 작업을 해도 되지만 throw 는 삼켜진다. */
  onGap: (gap: BeaconGap) => void;
}

/**
 * 비컨을 켠다 — 시그널 마커 등록 → 첫 레코드 기록 → 60초 틱 시작.
 *
 * 호출 순서 계약: `uptime/index.ts` 의 기동 부검(T2)이 `readPreviousBeacon()` 을 먼저 부르는
 * 것이 자연스럽지만, **틀려도 결과가 같다.** 이 함수가 첫 쓰기 직전에 래치를 강제하기 때문이다.
 *
 * 두 번 불러도 안전하다(두 번째는 경고 한 줄 남기고 무시).
 */
export function startUptimeBeacon(opts: UptimeBeaconOptions): void {
  if (started) {
    log.warn("가동 비컨이 이미 실행 중입니다 — 중복 시작을 무시합니다.");
    return;
  }
  started = true;

  // ★ 앞 세대 기록을 아래 첫 쓰기가 덮기 전에 메모리로 건져 둔다(readPreviousBeacon 주석 참고).
  readPreviousBeacon();

  cachedBootEpoch = opts.bootEpoch;
  onGapCallback = opts.onGap;
  if (opts.bootEpoch === null) {
    log.warn(
      "부팅 시각(kern.boottime)을 알지 못한 채 가동 비컨을 시작합니다 — " +
        "다음 기동의 절전/재부팅 구분 정확도가 떨어집니다."
    );
  }

  installStopHandlers();

  const nowMs = Date.now();
  const record = composeBeacon(nowMs, "alive", null);
  writeBeaconSync(record);
  lastRecord = record;
  lastTick = {
    wallMs: nowMs,
    osUptimeSec: record.osUptime,
    cpuSeconds: record.cpuSeconds,
    awakeMs: systemAwakeMs(),
  };

  timer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  /**
   * `unref()` — 이 타이머가 이벤트 루프를 붙잡아 프로세스가 안 죽는 사고를 막는다.
   * `src/util/deadline.ts:167-172` 가 같은 이유로 같은 처리를 한다. 진단용 타이머가 종료를
   * 가로막는 순간, 이 기능은 자기가 진단하려던 것보다 큰 사고가 된다.
   * 프로세스를 살려 두는 것은 express 서버와 cron 의 몫이다.
   */
  timer.unref?.();

  log.info(
    `가동 기록 시작 — 비컨 ${beaconFilePath()} (${HEARTBEAT_INTERVAL_MS / 1000}초 간격, pid ${process.pid})`
  );
}

/**
 * 틱만 멈춘다(마커는 남기지 않는다). 테스트와 예외적인 정리 경로용이며, 정상 종료 경로는
 * 시그널 핸들러가 담당한다 — 거기서는 `mode:"stopping"` 마커를 남겨야 하기 때문이다.
 */
export function stopUptimeBeacon(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
  onGapCallback = null;
}

// ────────────────────────────────────────────────────────────────────────────
// 8. 테스트 훅 (`scheduler.ts` 의 `__testing` 전례를 따른다)
// ────────────────────────────────────────────────────────────────────────────

/** 단위 테스트 전용 훅. 프로덕션 코드에서 import 하지 말 것. */
export const __testing = {
  /**
   * 비컨 경로를 임시 디렉터리로 갈아끼운다. null 이면 기본(`data/`)으로 복귀.
   * ★ 테스트는 반드시 이걸 먼저 불러라 — 실제 `data/` 를 오염시키면 운영 중인 판정이 깨진다.
   */
  setBeaconPath(p: string | null): void {
    beaconPathOverride = p;
  },
  /** 모듈 상태 초기화(경로 오버라이드는 유지). 시그널 핸들러는 등록된 채로 둔다. */
  reset(): void {
    stopUptimeBeacon();
    stopping = false;
    writeFailures = 0;
    writeFailLogCount = 0;
    cachedBootEpoch = null;
    lastRecord = null;
    lastTick = null;
    prevBeaconLatched = false;
    prevBeaconMemo = null;
  },
  /** 60초를 기다리지 않고 틱 1회를 강제 발화한다. */
  tickOnce: tick,
  /**
   * 틱 기준점을 과거로 밀어 공백 N ms 를 합성한다.
   *
   * `systemAwake: false`(기본) = **절전** 재현 — 깨어 있던 시계는 그대로 두므로 다음 틱에서
   * `systemSleptMs ≈ ms` 가 된다. `systemAwake: true` = **맥은 깨어 있는데 우리 프로세스만
   * 멈춘** 경우 재현 — `systemSleptMs ≈ 0` 이 나와야 한다.
   */
  rewindLastTick(ms: number, opts: { systemAwake?: boolean } = {}): void {
    if (!lastTick) return;
    lastTick = {
      ...lastTick,
      wallMs: lastTick.wallMs - ms,
      osUptimeSec: lastTick.osUptimeSec - ms / 1000,
      awakeMs:
        opts.systemAwake && lastTick.awakeMs !== null ? lastTick.awakeMs - ms : lastTick.awakeMs,
    };
    if (lastRecord) lastRecord = { ...lastRecord, atMs: lastRecord.atMs - ms };
  },
  composeBeacon,
  loadBeaconFile,
  writeBeaconSync,
};
