/**
 * 가동 중단 사후 보고 — 서버/프론트 공용 타입과 **판정 상수**.
 *
 * ## 왜 이 파일이 있는가
 * 2026-08-02 새벽 0시 29분부터 오전 11시 15분까지 10시간 45분 동안 맥북이 클램셸 슬립에
 * 빠져 전 탭 수집이 실패했다. 그런데 `logs/stdout.log` 에 남은 것은 "Codex 응답 시간 초과"
 * 뿐이어서 **LLM 장애로 오진**했고, 원인이 절전이었다는 사실을 밝히는 데 조사 에이전트가
 * 셋 필요했다. 이 모듈이 지탱하는 것은 하나다 — *나중에 사용자가 열어봤을 때 "그때 맥이
 * 잠들어 있어서 안 돌았습니다" 라고 한국어로 읽히게 하는 것*.
 *
 * ## 이 파일에 무엇을 두고 무엇을 두지 않는가
 * - **둔다**: 순수 타입, 순수 상수, 순수 술어(임계값 비교 뿐인 함수).
 * - **두지 않는다**: `fs` / `child_process` / `os` 등 Node 전용 API. 이 파일은 web/ 번들에도
 *   그대로 들어가므로(`@shared/uptime`) Node import 가 하나라도 섞이면 프론트 빌드가 깨진다.
 * - **두지 않는다**: 사용자에게 보이는 문장 조립. 그건 `src/uptime/narrate.ts` 의 몫이다.
 *   예외는 §6.4 멘탈모델 교정 문장 하나뿐인데, 그것만은 서버(일지 헤더)와 프론트(P1 이력
 *   화면 하단) **양쪽에서 같은 문장이어야** 하기 때문이다.
 *
 * ## 상수를 여기 모아 둔 이유 (shared/lotto.ts 의 전례와 같다)
 * 판정 임계값(90초 하한, 부팅시각 5초 허용오차, 절전 윈도 120초 여유…)은 최소 두 모듈이
 * 함께 본다. 예를 들어 `MIN_GAP_MS` 는 하트비트 틱(감지)과 판정 트리(Q0)가 동시에 쓰고,
 * `BOOT_EPOCH_TOLERANCE_SEC` 는 증거 수집(`bootChanged` 필드 채우기)과 판정 트리(1차 관문)가
 * 함께 본다. 복제되면 **어느 쪽이 옳은지 로그를 보기 전엔 모르는 방식으로** 조용히 갈라진다.
 *
 * 명세: `downtime-spec.md` §3(판정) §4(증거) §5(스키마) §6(문구) §8(놓친 슬롯).
 */

// ────────────────────────────────────────────────────────────────────────────
// 1. 상태 · 등급 (§3.1, §3.5)
// ────────────────────────────────────────────────────────────────────────────

/**
 * 구분하는 중단 원인 8종.
 *
 * ⚠️ 이름을 뭉개면 안 된다. "전원이 나갔어요" 한 덩어리로 부르는 순간 이번 사고(절전을
 * LLM 장애로 오인)가 이름만 바꿔 재발한다. 실측상 이 맥에서 8개월간 일어난 것은
 * `sleep` 과 `reboot-clean` 뿐이고(`.panic` 0건, 긴급 종료 0건), `power-cut` 은 한 번도
 * 관측된 적이 없다 — 그래도 남기는 이유는 §12.3(요구사항 원문)에 적혀 있다.
 */
export type DowntimeCause =
  | "sleep"
  | "restart-intended"
  | "app-gap"
  | "reboot-clean"
  | "power-cut"
  | "battery-dead"
  | "panic"
  | "unknown";

/**
 * cause → 사용자에게 보이는 한국어 라벨(§3.1 표 그대로).
 * 일지(`data/downtime.log`)의 `[시각] <라벨> — …` 자리와 P1 배너·배지가 같은 값을 쓴다.
 */
export const DOWNTIME_CAUSE_LABEL: Record<DowntimeCause, string> = {
  sleep: "절전",
  "restart-intended": "서비스 재시작",
  "app-gap": "프로그램 비정상 종료",
  "reboot-clean": "맥 정상 종료·재시작",
  "power-cut": "비정상 종료",
  "battery-dead": "배터리 방전",
  panic: "예기치 않은 재시작",
  unknown: "원인 확인 불가",
};

/**
 * 판정 확신도 3단계.
 *
 * 이 값은 장식이 아니라 **문체를 바꾸는 스위치**다. "확실" 이면 단정형("잠들어 있었습니다"),
 * 그 아래면 "…로 보입니다" 계열로 내려간다(§3.4). 증거가 없을 때 단정하는 것이 이 기능이
 * 신뢰를 잃는 가장 빠른 길이다 — 한 번 틀리면 사용자는 다시 읽지 않는다.
 */
export type DowntimeConfidence = "확실" | "추정" | "불명";

/** 확신도를 한 단계 내린다. 확실→추정→불명(불명은 바닥). §3.2 공통 후처리 · §3.4. */
export function downgradeConfidence(c: DowntimeConfidence): DowntimeConfidence {
  return c === "확실" ? "추정" : "불명";
}

/**
 * 노출 등급 3단계 — **표시 여부를 여기서 전부 통제한다**(§3.5).
 *
 * - `사고`   : 실제로 놓친 슬롯이 있다 → 일지 + stdout warn + iMessage + (P1)배너·배지
 * - `기록만` : 손실은 0이지만 그냥 넘기면 안 되는 원인이거나 6시간 이상 → 일지 + stdout warn + (P1)배지
 * - `무시`   : 정상 원인 + 손실 0 → 사용자에게 아무것도 보이지 않는다(원장 JSON 에만 남는다)
 *
 * `무시` 도 원장에는 남긴다. 나중에 "이 기능이 오탐하고 있나"를 반증하려면 **안 보여준 것도**
 * 남아 있어야 하기 때문이다.
 */
export type DowntimeSeverity = "사고" | "기록만" | "무시";

/** 사건을 만든 경로. `tick` = 60초 하트비트(T1, 절전), `boot` = 기동 부검(T2, 재시작). §1. */
export type DowntimeSource = "tick" | "boot";

/** 놓친 슬롯의 보충 진행 상태(§8.5). 재평가 3회(+5·+15·+45분) 뒤 확정된다. */
export type DowntimeRecoveryState = "복구중" | "복구완료" | "일부복구" | "복구없음";

// ────────────────────────────────────────────────────────────────────────────
// 2. 판정 상수 (§3.2, §3.5, §3.6, §4)
// ────────────────────────────────────────────────────────────────────────────

/**
 * 사건으로 치는 최소 공백. 이보다 짧으면 아무것도 만들지 않는다(§3.2 Q0).
 *
 * 90초인 이유: `launchctl kickstart -k` 재시작이 실측 3~10초라 여기서 전부 걸러진다.
 * 즉 **정상 배포가 "프로그램 비정상 종료"로 뜨는 것을 막는 1차 하한**이다(§3.7-3).
 * 대가로 90초 미만 중단은 영영 기록되지 않는다(§12.1-3).
 */
export const MIN_GAP_MS = 90_000;

/**
 * 하트비트 틱 간격. **이 값이 곧 사건 시각의 해상도**다(§12.1-5, 최대 60초 이르게 보인다).
 *
 * `setInterval` 은 시스템이 자는 동안 발화하지 않고 깨어나면 밀린 발화를 1회로 합쳐 낸다
 * (`src/scheduler/scheduler.ts:766-777` 의 실측 주석). 그래서 여기서 보이는 델타가 곧
 * '맥이 자고 있던 시간'이고, 그것이 T1 감지의 전부다.
 */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * `kern.boottime` 동일 판정 허용 오차(초).
 *
 * 절전 ↔ 재부팅을 가르는 **유일한** 신호이고, 4.5일·71회 sleep/wake 후에도 usec 단위까지
 * 불변임을 실측 확인했다. 그래도 5초를 두는 이유는 fallback 경로(`Date.now()/1000 -
 * os.uptime()`)가 초 단위 반올림으로 흔들리기 때문이다.
 */
export const BOOT_EPOCH_TOLERANCE_SEC = 5;

/** 절전 윈도가 공백을 "덮는다"고 볼 때의 양끝 여유(초). §4.4. */
export const SLEEP_COVER_TOLERANCE_SEC = 120;

/** 정상 종료 기록이 공백 시작보다 이만큼 앞서 있어도 같은 사건으로 본다(초). §3.2 Q2c. */
export const CLEAN_SHUTDOWN_BEFORE_SEC = 120;

/** 정상 종료 기록이 새 부팅 시각보다 이만큼 뒤여도 같은 사건으로 본다(초). §3.2 Q2c. */
export const CLEAN_SHUTDOWN_AFTER_SEC = 60;

/**
 * 시계 점프 의심 임계(ms). |벽시계 델타 − os.uptime 델타| 가 이보다 크면 `clockSuspect`.
 *
 * ⚠️ **미검증**: macOS 에서 NTP 대점프 시 `kern.boottime` 이 함께 보정되는지 확인하지
 * 못했다. 그래서 이 신호는 **분류를 바꾸지 않고 confidence 만 낮추고, 공백 길이 표기를
 * 포기한다**(`gapExact = false`). §4.5.
 */
export const CLOCK_SUSPECT_THRESHOLD_MS = 60_000;

/** `battery-dead` 로 보는 잔량 상한(%). 이 이하 + 배터리 전원일 때만. §3.2 Q2d. */
export const BATTERY_DEAD_PERCENT = 10;

/**
 * 사건 병합 창(ms). 이 안에서 같은 cause 로 다시 공백이 나면 **직전 사건에 병합**한다(§3.6).
 *
 * 두 가지를 한 메커니즘으로 막는다:
 * - **DarkWake 파편화**: 이번 사고 구간에 DarkWake 가 68회 있었다. 60초 틱이 그 사이에
 *   산발적으로 발화하면 10시간 공백 하나가 사건 20개로 쪼개진다.
 * - **크래시 루프**: launchd `KeepAlive=true` + `minimum runtime = 10` 이라 배포가 실패하면
 *   분당 6건꼴로 사건이 생긴다.
 */
export const MERGE_WINDOW_MS = 15 * 60_000;

/** 손실이 0이어도 `기록만` 으로 남기는 공백 길이 하한(ms). §3.5. */
export const RECORD_ONLY_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * 손실이 0이어도 반드시 남기는 원인들(§3.5, §12.3-3).
 *
 * 사용자 요구의 핵심은 "전원이 나갔으면 그 사실을 알고 싶다"이므로, 손실 게이트가 그것까지
 * 삼키면 요구를 배신한다. 그래서 이 넷만은 손실과 무관하게 일지·stdout·(P1)배지에 나간다.
 */
export const RECORD_ONLY_CAUSES: readonly DowntimeCause[] = [
  "power-cut",
  "battery-dead",
  "panic",
  "app-gap",
];

/**
 * 이보다 짧은 `app-gap` 에는 "직접 재시작하셨다면 무시하셔도 됩니다" 를 덧붙인다(§3.2 Q1d).
 * `kill -9` 로 재시작하면 배포가 `app-gap` 으로 뜨는 알려진 오분류의 완화책이다(§12.2-7).
 */
export const SHORT_GAP_HINT_MS = 10 * 60_000;

/** 사건 원장 보관 상한 — 건수(§5.2). 건당 ~1.5KB 라 상한 약 150KB. */
export const LEDGER_MAX_EVENTS = 100;

/** 사건 원장 보관 상한 — 일수(§5.2). 건수·일수 중 먼저 걸리는 쪽으로 절삭. */
export const LEDGER_MAX_AGE_DAYS = 180;

/** 사람이 읽는 일지(`data/downtime.log`) 보관 항목 수(§5.3). */
export const JOURNAL_MAX_ENTRIES = 200;

/**
 * 사건 생성 후 재평가 시점(ms). §8.5.
 *
 * 스케줄러의 `runCatchupSweep` 에 훅을 걸지 **않는** 대신 쓰는 자체 타이머다. 훅을 걸면
 * `scheduler.ts → uptime/store → uptime/missed → scheduler.ts` 순환 임포트가 생긴다.
 */
export const REEVAL_DELAYS_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 45 * 60_000];

/**
 * 알림을 최종 상태로 1통만 보내기 위한 복구 유예 회차(§7-6).
 * 이 회차에 도달하거나 `recoveryState !== "복구중"` 이 되는 시점 중 **먼저 오는 쪽**에 발송.
 */
export const NOTIFY_AFTER_REEVAL_ROUND = 2;

/**
 * `startUptimeWatch()` 의 총 시간 예산(ms). 초과하면 사건을 `unknown/불명` 으로 낮춰 기록하고
 * 즉시 반환한다(§9.3). **진단 기능이 서비스 기동을 막으면 본말전도다.**
 */
export const UPTIME_STARTUP_BUDGET_MS = 10_000;

// ── 파일 이름 (디렉터리는 `path.dirname(config.dbPath)` = `data/`. §5) ──
//
// `logs/` 는 launchd 소유라 앱이 쓰지 않는다. 비컨을 거기 두면 로그 정리 한 번에 다음 사고
// **전체**를 놓친다. 그리고 `data/` 안에서 파일을 unlink 하는 코드는 만들지 않는다 —
// price.db 와 20여 개 스냅샷이 같은 디렉터리에 산다(§5.2 경고).

/** 하트비트 비컨(1레코드, 60초마다 덮어씀). */
export const UPTIME_BEACON_FILE = "uptime-beacon.json";
/** 사건 원장(기계용 JSON). */
export const DOWNTIME_EVENTS_FILE = "downtime-events.json";
/** 사람이 읽는 한국어 일지(UTF-8 텍스트). 파일명을 ASCII 로 둔 이유는 §5.3. */
export const DOWNTIME_JOURNAL_FILE = "downtime.log";

/** 비컨 레코드 스키마 버전. */
export const UPTIME_BEACON_VERSION = 1;
/** 사건 원장 스키마 버전. */
export const DOWNTIME_LEDGER_VERSION = 1;

/**
 * 멘탈모델 교정 문장(§6.4) — P0 은 일지 헤더, P1 은 이력 화면 하단에 **같은 문장**으로.
 *
 * 이 문장이 없으면 사용자는 영영 안 뜨는 "전원이 나갔어요" 배너를 기다리다가 "내가 요청한
 * 기능이 아닌데" 라고 느낀다. 실측 근거: 클램셸 슬립 중 배터리 소모 3.07%/h(100%에서 약
 * 32시간), 14일 관측 최저 잔량 47%, 저전력·긴급종료 이벤트 0건. 즉 **충전기를 뽑는 것은
 * 이 맥에서 사건이 아니다.**
 */
export const DOWNTIME_MENTAL_MODEL_NOTE =
  "참고 — 충전기를 뽑아도 맥북은 배터리로 계속 동작합니다. 최근 2주 동안 배터리가 47% 아래로\n" +
  "내려간 적이 한 번도 없었어요. 수집이 멈추는 건 거의 전부 덮개를 닫아 맥북이 잠들었을 때입니다.\n" +
  "배터리가 정말 다 떨어져 꺼진 경우에는 '배터리 방전'이라고 따로 적습니다.";

// ────────────────────────────────────────────────────────────────────────────
// 3. 비컨 (§5.1)
// ────────────────────────────────────────────────────────────────────────────

/** 비컨의 생존 모드. `stopping` 은 SIGTERM/SIGINT 를 받고 남긴 **의도된 종료 마커**다. */
export type BeaconMode = "alive" | "stopping";

/** 의도된 종료의 신호원. `launchctl kickstart -k` 는 실측상 SIGTERM 을 준다(§3.7-2). */
export type BeaconStopReason = "SIGTERM" | "SIGINT";

/**
 * `data/uptime-beacon.json` — 하트비트 1레코드. 60초마다 덮어쓴다(tmp + rename + **fsync**).
 *
 * fsync 가 필수인 이유: 안 켜면 전원 차단 시 마지막 기록이 페이지캐시에서 유실돼 **사망
 * 시각이 실제보다 과거로 보인다** — 공백이 실제보다 길게 잡히고 없던 손실이 생긴다.
 * 실측 쓰기 4.19ms, 60초 간격이면 duty 0.007%.
 */
export interface UptimeBeacon {
  v: number;
  /** 마지막 생존(epoch ms). **공백 계산은 이 필드로만 한다.** */
  atMs: number;
  /** 사람이 파일을 열어봤을 때용 ISO 문자열. 비교에 쓰지 않는다. */
  at: string;
  pid: number;
  startedAtMs: number;
  /** 기동 시 1회 읽어 캐시한 `kern.boottime`(초). 절전으로 변하지 않으므로 매 틱 읽지 않는다. */
  bootEpoch: number | null;
  mode: BeaconMode;
  stopReason: BeaconStopReason | null;
  /** `process.cpuUsage()` user+system 누적(초). 공백 구간 실가동률의 재료(§6.1 판정근거). */
  cpuSeconds: number;
  /** `process.uptime()`(초). */
  procUptime: number;
  /** `os.uptime()`(초). 벽시계와 함께 봐서 시계 점프를 의심한다(§4.5). */
  osUptime: number;
  /** 누적 쓰기 실패 횟수. >0 이면 confidence 하향 + 문체를 "…로 보입니다" 로(§3.4). */
  writeFailures: number;
}

// ────────────────────────────────────────────────────────────────────────────
// 4. 증거 (§4, §5.2)
// ────────────────────────────────────────────────────────────────────────────

/** `pmset -g log` 에서 남기는 줄 종류. 이 4종 외 라인 타입은 전부 버린다(§4.4). */
export type PmsetKind = "Sleep" | "Wake" | "DarkWake" | "Start";

/** 전원 계통. `pmset` 의 `Using Batt|AC`. */
export type PmsetPowerSource = "Batt" | "AC";

/**
 * `pmset -g log` 한 줄의 **화이트리스트 재조립본**. 원문 문자열은 절대 담지 않는다.
 *
 * ★ 프라이버시 조항(§4.4). 14일 31,818줄 중 30,724줄(96.5%)이 `Wake Requests` /
 * `Assertions` / `Notification` / `ThermalEvent` / `PM Client Acks` / `HibernateStats` /
 * `sleepservices.*` 라 통째로 버린다. 남기는 4종 라인에서도
 * `description=com.apple.usb.externaldevice…owner=MR550`(USB 기기명),
 * `info="com.apple.alarm…calaccessd.travelEngine"`(캘린더 알람), `com.apple.dasd:501:…`
 * (사용자 UID) 는 아래 5개 필드 **어디에도** 담기지 않는다. 이건 테스트로 못박혀 있다(§10.4).
 *
 * 이 배열이 사건 원장에 동결 사본으로 들어가는 이유: `pmset -g log` 는 14일만 보존되므로
 * 나중에 사건을 다시 들여다볼 때 원본이 이미 사라져 있다(§12.2-10).
 */
export interface PmsetLine {
  /** epoch(초). */
  at: number;
  kind: PmsetKind;
  /** 작은따옴표 안의 사유 최대 40자(예: `Clamshell Sleep`). 없으면 null. */
  reason: string | null;
  power: PmsetPowerSource | null;
  /** 배터리 잔량 %. 없으면 null. */
  charge: number | null;
}

/**
 * 절전 윈도 하나 — `Sleep` 라인부터 다음 `Wake` 라인까지(§4.4).
 * `DarkWake` 는 윈도를 닫지 않고 카운트만 올린다(`DowntimeEvidence.darkWakeCount`).
 */
export interface SleepWindow {
  startSec: number;
  /**
   * 닫는 `Wake` 를 못 찾았으면 null.
   * ★ 계약: null 인 윈도는 "공백을 덮는다" 판정에서 **항상 false** 로 취급한다
   *   (`sleepWindowCoversGap`). 증거가 반쪽인데 확신도를 올리면 안 된다.
   */
  endSec: number | null;
  /** 잠든 사유(예: `Clamshell Sleep`). */
  reason: string | null;
  power: PmsetPowerSource | null;
  /** 잠들 때 잔량 %. */
  chargeStart: number | null;
  /** 깰 때 잔량 %. 문구의 "배터리 80% → 48%" 가 여기서 나온다. */
  chargeEnd: number | null;
}

/** 공백 시작 직전에 확인된 배터리 상태(§4.4). 상시 `pmset -g batt` 샘플링을 대체한다. */
export interface BatterySample {
  percent: number | null;
  /** 배터리 전원이었는지. 모르면 null — **모른다를 false 로 뭉개지 않는다**(§3.2 Q2d). */
  onBattery: boolean | null;
}

/**
 * 사건에 **동결 저장**되는 증거(§5.2 `evidence` 키 그대로).
 *
 * 판정 결과만 남기고 증거를 버리면 나중에 "이 판정이 맞았나"를 되짚을 수 없다. 특히
 * `pmsetLines` 는 14일 뒤 원본이 사라지므로 여기 있는 사본이 유일한 기록이 된다.
 */
export interface DowntimeEvidence {
  /** 공백 직전 비컨이 들고 있던 `kern.boottime`(초). null 이면 첫 기록(§3.2 Q0b). */
  bootEpochBefore: number | null;
  /** 지금 읽은 `kern.boottime`(초). null 이면 confidence 를 "불명" 으로 떨어뜨린다. */
  bootEpochNow: number | null;
  /** `isBootChanged(bootEpochBefore, bootEpochNow)` 의 결과를 그대로 저장한 것. */
  bootChanged: boolean;
  /** sysctl 실패로 `Date.now()/1000 - os.uptime()` 폴백을 썼는지(§4.1). true 면 confidence 하향. */
  bootFromFallback: boolean;
  prevPid: number | null;
  currentPid: number;
  /**
   * 프로세스가 그대로인지. **T1(인프로세스 감지)의 정체**다 — 프로세스가 살아 있는데
   * 벽시계만 뛴 것은 절전 외 원인이 사실상 없다(§3.2 Q1a).
   */
  sameProcess: boolean;
  /** 직전 비컨의 모드. `stopping` 이면 의도된 재시작(§3.2 Q1b). */
  prevBeaconMode: BeaconMode | null;
  /** `/var/db/diagnostics/shutdown.*.log` 의 `SIGTERM: [epoch]` 최댓값(§4.3). */
  lastCleanShutdownEpoch: number | null;
  /**
   * 종료 기록 파일을 읽고 매치까지 성공했는지.
   * ★ false 면 판정은 무조건 `unknown/불명` 이다(§3.2 Q2b, fail-open). macOS 업그레이드로
   *   형식이 바뀌었을 때 **모든 재부팅을 정전으로 오보하는 것**을 막는 유일한 방어선이다.
   */
  shutdownLogParsed: boolean;
  /** 공백 구간에 생성된 `.panic` 파일의 mtime(초). 없으면 null(§4.2). */
  panicAtEpoch: number | null;
  /** 진단 리포트 디렉터리를 읽을 수 있었는지. **읽기 실패를 "패닉 없음"으로 단정하지 않는다.** */
  panicDirReadable: boolean;
  /** `pmset -g log` 파싱 성공 여부. false 면 confidence 를 한 단계 낮춘다(판정은 유지). */
  pmsetParsed: boolean;
  /** 화이트리스트 재조립본(§4.4). 원문 저장 금지. */
  pmsetLines: PmsetLine[];
  /** 공백 구간의 짧은 깨어남 횟수. 이번 사고에서 68회였다. */
  darkWakeCount: number;
  batteryAtGapStart: BatterySample;
  /**
   * 공백 구간에 실제로 CPU 를 쓴 시간(초). T1 에서만 계산 가능(T2 는 null).
   *
   * ⚠️ **트리거로 쓰지 않는다.** 실측상 정상 유휴 서비스의 duty 가 0.0057%, 사고 구간이
   * 0.046% 로 **사고 쪽이 8배 높았다.** 판별 방향 자체가 보장되지 않으므로 문장용 증거로만
   * 쓴다("10시간 45분 중 실제로 일한 시간은 27.8초(0.07%)뿐입니다").
   */
  cpuSecondsInGap: number | null;
  /** 위 값을 공백 길이로 나눈 백분율. 같은 이유로 문장용 전용. */
  dutyPercent: number | null;
  /** 비컨 쓰기 누적 실패 횟수. >0 이면 confidence 하향(§3.4). */
  beaconWriteFailures: number;
  /** 시계 점프 의심(§4.5). 분류는 그대로 두고 confidence 와 길이 표기만 낮춘다. */
  clockSuspect: boolean;
}

/**
 * 판정 트리(`classify`)의 입력 = 동결 증거 + **공백 자체의 시간축 + 절전 윈도**.
 *
 * 동결 증거(`DowntimeEvidence`)와 분리한 이유: 공백 구간과 `sleepWindows` 는 `pmsetLines`
 * 에서 파생되는 값이라 원장에 두 번 저장할 이유가 없다. 반대로 판정에는 반드시 필요하다.
 *
 * ★ `classify(ev: Evidence): Verdict | null` 은 **순수 함수다. I/O 금지.** 이것이 테스트의
 *   1급 대상이고(§10.1 13케이스), 이번 사고의 회귀 방지선이다.
 */
export interface Evidence extends DowntimeEvidence {
  /** 공백 길이(ms). `MIN_GAP_MS` 미만이면 판정 자체를 하지 않는다(§3.2 Q0). */
  gapMs: number;
  /** 공백 시작(epoch 초). */
  gapStartSec: number;
  /** 공백 끝 = 감지 시각(epoch 초). */
  gapEndSec: number;
  /** `pmsetLines` 에서 조립한 절전 윈도들(§4.4). */
  sleepWindows: SleepWindow[];
}

/** 판정 결과. severity 는 여기서 정하지 않는다 — 손실 게이트(§3.5)의 몫이다. */
export interface Verdict {
  cause: DowntimeCause;
  confidence: DowntimeConfidence;
  /**
   * 공백 길이를 그대로 문장에 써도 되는지. `clockSuspect` 면 false 가 되고, 문구는 길이 대신
   * "정확한 길이를 알 수 없습니다" 로 대체된다(§4.5).
   */
  gapExact: boolean;
}

// ── 순수 술어 (증거 수집·판정이 같은 규칙을 보게 묶어 둔다) ──

/**
 * 부팅 세션이 바뀌었는가 = **맥이 꺼졌다 켜졌는가**(§3.2 BOOT_CHANGED).
 *
 * ★ 판정 트리의 1차 관문이자 "정상 재시작 오인 방지" 5중 방어의 첫 겹이다(§3.7-1).
 *   false 면 `power-cut` / `battery-dead` / `panic` 분기에 **코드 경로상 진입할 수 없다**.
 *   `launchctl kickstart -k` 는 100% 여기 걸린다.
 *
 * 어느 한쪽이라도 null 이면 false 다 — 모르는 것을 "바뀌었다"로 읽으면 전원 계열로 떨어진다.
 */
export function isBootChanged(before: number | null, now: number | null): boolean {
  return before != null && now != null && Math.abs(now - before) > BOOT_EPOCH_TOLERANCE_SEC;
}

/**
 * 절전 윈도 조립(§4.4). **순수 함수.**
 *
 * 규칙: `Sleep` 이 윈도를 열고 다음 `Wake` 가 닫는다. `DarkWake` 는 닫지 않는다.
 *
 * ★ 명세가 말하지 않은 한 가지를 확정한다: **이미 열린 윈도가 있으면 새 `Sleep` 은 윈도를
 *   열지 않는다.** 근거는 실측이다 — 2026-08-02 사고 구간에는 'Clamshell Sleep' 한 번 뒤로
 *   'Maintenance Sleep' 이 69번 더 찍혀 있었다(DarkWake 로 잠깐 깨었다 다시 자는 사이클).
 *   매번 새 윈도를 열면 10시간 45분짜리 절전이 70개 조각으로 보이고, 무엇보다
 *   **문구의 "배터리 80% → 48%" 가 마지막 조각의 "79% → 48%" 로 바뀐다.**
 *   사용자가 알고 싶은 것은 "언제부터 자기 시작했나"이므로 **가장 이른 Sleep 을 시작으로**
 *   삼는 것이 맞다. `sleepWindowsCoverGap()` 이 `.some()` 이라 조각내도 커버 판정 자체는
 *   되지만, 그 경우 시작 시각과 시작 잔량이 전부 틀린 값이 된다.
 *
 * ⚠️ **이 함수를 다른 곳에 복사하지 마라.** evidence(판정용)와 narrate(문구용)가 각자
 *   조립하던 때, narrate 쪽만 "새 Sleep 이 열린 윈도를 닫는다"로 갈라져 있었다. 실제 pmset
 *   로그로 돌리면 윈도가 조각나 **덮는 윈도 0개**가 되고, 헤드라인은 '절전/확실'인데
 *   판정근거에는 "이 구간을 덮는 절전 없음"이 찍히는 자기모순이 났다(2026-08-02 검증 실측).
 *   합성 픽스처로는 두 규칙의 차이가 드러나지 않아 테스트도 놓쳤다. 그래서 shared 로 올려
 *   한 벌만 남긴다 — 판정과 문구가 같은 윈도를 보는 것이 이 기능의 신뢰도 그 자체다.
 */
export function buildSleepWindows(lines: readonly PmsetLine[]): SleepWindow[] {
  const windows: SleepWindow[] = [];
  const sorted = [...lines].sort((a, b) => a.at - b.at);
  let open: SleepWindow | null = null;
  for (const l of sorted) {
    if (l.kind === "Sleep") {
      if (open != null) continue; // ★ 위 주석: 열린 윈도가 있으면 새로 열지 않는다.
      open = {
        startSec: l.at,
        endSec: null,
        reason: l.reason,
        power: l.power,
        chargeStart: l.charge,
        chargeEnd: null,
      };
      windows.push(open);
    } else if (l.kind === "Wake") {
      if (open == null) continue;
      open.endSec = l.at;
      open.chargeEnd = l.charge;
      open = null;
    }
    // DarkWake / Start 는 윈도를 닫지 않는다(§4.4).
  }
  return windows;
}

/**
 * 절전 윈도 하나가 공백을 덮는가(§4.4의 정의 그대로).
 * `window.start <= gapStart + 120초 && window.end >= gapEnd - 120초`.
 */
export function sleepWindowCoversGap(
  w: SleepWindow,
  gapStartSec: number,
  gapEndSec: number
): boolean {
  if (w.endSec == null) return false;
  return (
    w.startSec <= gapStartSec + SLEEP_COVER_TOLERANCE_SEC &&
    w.endSec >= gapEndSec - SLEEP_COVER_TOLERANCE_SEC
  );
}

/** 절전 윈도 중 하나라도 공백을 덮는가. 판정 트리 Q1a/Q1c 가 쓰는 술어. */
export function sleepWindowsCoverGap(
  windows: readonly SleepWindow[],
  gapStartSec: number,
  gapEndSec: number
): boolean {
  return windows.some((w) => sleepWindowCoversGap(w, gapStartSec, gapEndSec));
}

// ────────────────────────────────────────────────────────────────────────────
// 5. 놓친 슬롯 (§5.4, §8)
// ────────────────────────────────────────────────────────────────────────────

/**
 * 손실을 셀 수 있는 탭.
 *
 * ⚠️ **증시 펄스(`stockPulse`)는 영구 제외다.** `scheduler.ts:760-765`: "펄스에는 catch-up 이
 * 없다 … 서버가 4시간 꺼져 있었다면 그 4개 슬롯은 그냥 없던 일이다." 보고하면 1시간 절전마다
 * 4건씩 **거짓 손실**이 생긴다. 그래서 이 유니온에 아예 넣지 않는다 — 타입 차원에서 막는다.
 */
export type MissedTab = "events" | "news" | "youtube" | "stockKr" | "stockUs" | "lotto";

/** 탭 → 사용자에게 보이는 한국어 라벨(§5.4 주석 그대로). */
export const MISSED_TAB_LABEL: Record<MissedTab, string> = {
  events: "팝업·전시",
  news: "뉴스",
  youtube: "유튜브 소식",
  stockKr: "증시(한국장)",
  stockUs: "증시(미국장)",
  lotto: "로또",
};

/**
 * 공백에 걸려 제 시각에 돌지 못한 슬롯 1건.
 *
 * ★ 이 목록이 한 번이라도 틀리면 사용자는 다시 읽지 않는다. 실제로 초안 설계는 2026-08-02
 *   (일요일, 한국장 휴장)에 "증시(kr) 08:00 못 돌았습니다"라고 적었다 — config 의 HH:mm 만
 *   보고 판정한 대가다. 그래서 `describeMissedSlots()` 는 스케줄러의 커버 술어를 그대로
 *   재사용하고 휴장을 걸러낸다(§8.3).
 */
export interface MissedSlot {
  tab: MissedTab;
  /** `MISSED_TAB_LABEL[tab]`. 프론트가 매번 매핑하지 않도록 값으로 굳혀 내려보낸다. */
  label: string;
  /** 예정 시각 표기. `"08:00"` 또는 로또의 `"일요일 10:00"`. */
  slot: string;
  /** 예정된 로컬 날짜 `YYYY-MM-DD`. */
  date: string;
  /** 예정 시각 ISO(+09:00). */
  scheduledAt: string;
  /**
   * 커버 여부를 실제로 검증했는지(§8.4).
   *
   * 커버 판정 술어는 전부 "오늘" 기준이라 자정을 넘는 공백의 **어제 슬롯은 검증할 수 없다.**
   * 그때는 `evaluated: false` + note 로 목록에는 남기되(그 시각이 공백 안에 있었다는 사실은
   * 참이므로) **severity 계산에서는 빼서** 검증 못 한 것으로 사고 등급을 올리지 않는다.
   */
  evaluated: boolean;
  recovered: boolean;
  recoveredAt: string | null;
  /** 예: "지난 날짜라 보충 대상이 아닙니다". */
  note: string | null;
}

/** `evaluated: true` 인 손실 건수 = **severity 계산에 쓰는 유일한 개수**(§8.4). */
export function countEvaluatedMissed(missed: readonly MissedSlot[]): number {
  return missed.reduce((n, m) => n + (m.evaluated ? 1 : 0), 0);
}

/**
 * 손실 게이트(§3.5) — 사건을 사용자에게 보여줄지 정하는 **단 하나의 규칙**.
 *
 * 여기 두는 이유는 shared/lotto.ts 의 채점 규칙과 같다: 이 규칙이 복제되면 일지에는 뜨는데
 * 배너에는 안 뜨는(또는 그 반대) 상태가 조용히 생긴다. 그리고 이 표가 "정상 재시작 오인
 * 방지"의 **최종 방어선**이다 — 원인 판정이 틀려도 손실이 0이면 사용자를 방해하지 않는다.
 */
export function severityFor(
  cause: DowntimeCause,
  gapMs: number,
  missed: readonly MissedSlot[]
): DowntimeSeverity {
  if (countEvaluatedMissed(missed) >= 1) return "사고";
  if (RECORD_ONLY_CAUSES.includes(cause) || gapMs >= RECORD_ONLY_GAP_MS) return "기록만";
  return "무시";
}

// ────────────────────────────────────────────────────────────────────────────
// 6. 사건 · 원장 · 화면 (§5.2, §5.4, §6.5)
// ────────────────────────────────────────────────────────────────────────────

/** 알림 상태. 사건 id 기준 멱등의 근거이자, 조용시간 보류의 대기표(§7). */
export interface DowntimeNotifyState {
  /** 이미 보냈는지. `KeepAlive=true` 라 이게 없으면 크래시 루프에서 알림 폭탄이 된다. */
  imessage: boolean;
  /** 발송 시각 ISO. */
  at: string | null;
  /** 조용시간(기본 23~07시)에 걸려 보류한 경우 발송 예정 시각 ISO. */
  queuedUntil: string | null;
}

/** 사건 1건(§5.2 스키마 그대로). */
export interface DowntimeEvent {
  /**
   * gapStart 기준 안정 키(ISO +09:00). **멱등·병합의 기준**이라 병합해도 바뀌지 않는다.
   * 예: `"2026-08-02T00:29:10+09:00"`.
   */
  id: string;
  /** 로컬 날짜 `YYYY-MM-DD`(저장소의 `localDate()` 관례). */
  date: string;
  updatedAt: string;
  source: DowntimeSource;
  severity: DowntimeSeverity;
  cause: DowntimeCause;
  confidence: DowntimeConfidence;
  /** 공백 시작 ISO(+09:00). */
  gapStart: string;
  /** 공백 끝 ISO(+09:00). 병합 시 뒤로 연장된다(§3.6). */
  gapEnd: string;
  gapMinutes: number;
  /** false 면 문구에서 길이를 쓰지 않는다(§4.5). */
  gapExact: boolean;
  /** ★ 서버에서 완성한 한국어 한 줄. 프론트는 조립하지 않는다. */
  headline: string;
  /** 여러 줄 본문(§6.1 "무슨 일"). */
  body: string;
  /** "판정근거: …" 한 줄. 상시 병기한다 — 판정이 틀렸을 때 사용자가 반증할 수 있어야 한다. */
  reasonLine: string;
  missed: MissedSlot[];
  recoveryState: DowntimeRecoveryState;
  /** 재평가 수행 횟수(0..REEVAL_DELAYS_MS.length). 알림 유예 판단에도 쓰인다(§7-6). */
  reevalCount: number;
  evidence: DowntimeEvidence;
  notified: DowntimeNotifyState;
  /**
   * 사용자가 화면에서 [확인했어요] 를 누른 시각 ISO.
   *
   * 닫기를 서버에 저장하는 이유: 기존 두 배너는 다음 수집 성공 시 자동으로 사라지지만,
   * 사후 보고는 **과거의 사실**이라 저절로 사라질 조건이 없다.
   */
  ackedAt: string | null;
  /** 사람이 나중에 덧붙이는 메모(자동 기록 없음). */
  notes: string | null;
}

/** `data/downtime-events.json` 전체(§5.2). 최신이 앞. */
export interface DowntimeLedger {
  v: number;
  events: DowntimeEvent[];
}

/**
 * 대시보드가 한 번에 받아 가는 상태(§5.4). `GET /api/downtime`.
 *
 * `current` 는 "지금 보여줄 배너 1건"이고 `unackedCount` 는 헤더 배지 숫자다. 둘을 나눈 이유:
 * 이 맥의 전력 설정이 `Battery: sleep 1`(유휴 1분)이라 밤샘 절전이 아침 슬롯을 덮는 게
 * 기본값일 수 있어서, **연속 발생 시 배지 숫자만 올리고 배너는 하루 1회로 제한**한다(§6.5).
 * 매일 [확인했어요]를 누르게 만들면 3일 안에 배경으로 학습된다.
 */
export interface DowntimeView {
  current: DowntimeEvent | null;
  unackedCount: number;
}
