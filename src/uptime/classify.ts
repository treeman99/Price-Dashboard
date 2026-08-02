import {
  BATTERY_DEAD_PERCENT,
  CLEAN_SHUTDOWN_AFTER_SEC,
  CLEAN_SHUTDOWN_BEFORE_SEC,
  MIN_GAP_MS,
  downgradeConfidence,
  isBootChanged,
  sleepWindowsCoverGap,
} from "../../shared/uptime.ts";
import type {
  DowntimeCause,
  DowntimeConfidence,
  Evidence,
  Verdict,
} from "../../shared/uptime.ts";

/**
 * 가동 공백의 **원인 판정** — 이 기능 전체에서 유일하게 "무슨 일이 있었는가"를 정하는 곳.
 *
 * ── ★ 이 파일의 계약 ──
 * **순수 함수다. I/O 가 0이다.** `fs` / `child_process` / `Date.now()` / `os` 어느 것도 쓰지
 * 않는다. 들어온 `Evidence` 만 보고 `Verdict` 를 낸다. 이유는 두 가지다:
 *  1) 이 판정이 이 기능의 **유일한 회귀 방지 대상**이다. 2026-08-02 사고(10시간 45분 클램셸
 *     슬립을 "Codex 응답 시간 초과"로 오진)의 재현 테스트가 여기 걸려 있다. I/O 가 섞이면
 *     그 테스트를 맥의 상태에 의존하게 만들어 사실상 못 돌린다.
 *  2) 증거 수집(`evidence.ts`)은 실패해도 되지만 **판정은 실패하면 안 된다.** 증거가 반쪽이면
 *     confidence 를 낮출 뿐, 예외를 던지거나 없는 사실을 지어내지 않는다.
 *
 * ── ★ 이 파일이 지키는 두 가지 (나머지는 다 부차적이다) ──
 * **(1) 정상 재시작 오인 방지 1차 관문.** 부팅 시각(`kern.boottime`)이 그대로면 맥은 꺼진 적이
 * 없으므로 `power-cut` / `battery-dead` / `panic` 은 **코드 경로상 진입 자체가 불가능**해야
 * 한다. 여기서는 그 요구를 주석이 아니라 **타입**으로 못박았다 — `classifySameBoot()` 의 반환
 * 타입 `SameBootCause` 에 전원 계열 3종이 애초에 없어서, 실수로 그 분기를 넣으면 컴파일이
 * 깨진다. `launchctl kickstart -k`(실측 3~10초) 는 사실 그 앞의 Q0 에서 이미 걸리지만,
 * 배포가 90초를 넘긴 날에도 "비정상 종료" 문자가 가면 이 기능은 그날로 신뢰를 잃는다.
 *
 * **(2) Q2b fail-open.** 종료 기록(`shutdown.*.log`)을 못 읽으면 `unknown/불명` 이다. **절대
 * `power-cut` 으로 단정하지 않는다.** macOS 업그레이드로 형식·경로가 바뀌면 이 파일 하나
 * 때문에 **모든 재부팅이 "전원이 나갔습니다"로 오보**된다. "Shutdown Cause" 항목이 Apple
 * Silicon + macOS 26 에서 통째로 사라진 전례가 실제로 있다(31,818줄 전수 0건).
 *
 * 명세: `downtime-spec.md` §3.2(판정 트리) / §3.3(증거 우선순위) / §3.7(5중 방어) / §10.1(13 케이스).
 */

// ────────────────────────────────────────────────────────────────────────────
// 분기별 원인 집합 — ★ "코드 경로상 진입 불가"를 타입으로 강제한다
// ────────────────────────────────────────────────────────────────────────────

/**
 * 부팅 세션이 **그대로일 때**(§3.2 Q1) 나올 수 있는 원인.
 *
 * ★ `power-cut` / `battery-dead` / `panic` 이 이 유니온에 **없다.** 맥이 꺼진 적이 없는데
 *   "전원이 끊겼습니다" 라고 말할 방법이 타입 차원에서 존재하지 않게 한 것이다.
 *   (주석으로만 적어 두면 다음 사람이 "여기서도 배터리를 보면 좋지 않나" 하며 넣는다.)
 */
type SameBootCause = Extract<DowntimeCause, "sleep" | "restart-intended" | "app-gap">;

/** 부팅 세션이 **바뀌었을 때**(§3.2 Q2) 나올 수 있는 원인. 여기엔 반대로 `sleep` 이 없다. */
type RebootedCause = Extract<
  DowntimeCause,
  "panic" | "unknown" | "reboot-clean" | "battery-dead" | "power-cut"
>;

/**
 * 분기 판정의 중간 결과. `gapExact` 가 없는 이유: 공백 길이를 믿을 수 있는지는 분기와 무관한
 * 공통 후처리(시계 점프)에서만 정해진다.
 */
interface BranchVerdict<C extends DowntimeCause> {
  cause: C;
  confidence: DowntimeConfidence;
}

// ────────────────────────────────────────────────────────────────────────────
// 공개 진입점
// ────────────────────────────────────────────────────────────────────────────

/**
 * 판정 트리(§3.2). **순서 고정, 첫 일치에서 멈춘다. 예외 없음.**
 *
 * ```
 * Q0  gapMs < 90초                → null (사건 아님)
 * Q0b bootEpochBefore == null     → null (첫 기록. log.info 만)
 * Q1  부팅 시각 불변 ── 맥은 꺼진 적이 없다 (전원 계열 진입 불가)
 * Q2  부팅 시각 변경 ── 맥이 꺼졌다 켜졌다
 * 공통 후처리 ── confidence 하향 / gapExact
 * ```
 *
 * `null` 은 "사건을 아예 만들지 않는다"는 뜻이다. 원장에도 남기지 않는다 — 90초 미만의 공백을
 * 남기기 시작하면 배포·크래시 재기동이 전부 기록돼 원장이 잡음으로 가득 찬다(§12.1-3).
 */
export function classify(ev: Evidence): Verdict | null {
  // ── Q0. 90초 미만은 사건이 아니다 ─────────────────────────────────────────
  // 이 하한이 "정상 재시작 오인 방지" 5중 방어의 세 번째 겹이다(§3.7-3). `launchctl
  // kickstart -k` 재시작은 실측 3~10초라 여기서 전부 조용히 걸러진다.
  if (ev.gapMs < MIN_GAP_MS) return null;

  // ── Q0b. 비컨이 없던 구간은 재구성하지 않는다 ────────────────────────────
  // 첫 기동(또는 구버전 비컨)이다. 공백처럼 보이는 것은 "설치 이전"일 뿐이므로 사건으로
  // 만들면 100% 오보다. 부르는 쪽이 `log.info("가동 기록을 시작합니다")` 만 남긴다(§12.1-2).
  if (ev.bootEpochBefore == null) return null;

  // ── 1차 관문. 이 한 줄이 전원 계열 오보를 통째로 막는다(§3.3-1, §3.7-1) ──
  //
  // ⚠️ `ev.bootChanged`(원장에 동결 저장된 사본)를 쓰지 않고 **여기서 다시 계산한다.**
  //    같은 규칙이 두 군데서 계산되면 언젠가 갈라지는데, 갈라진 쪽이 이 관문이면 정상
  //    재시작이 "비정상 종료"로 나간다. 저장 사본은 사후 열람용이고, 판정의 정본은 이것이다.
  //    (`kern.boottime` 은 4.5일·71회 sleep/wake 후에도 usec 까지 불변임을 실측 확인했다.)
  const rebooted = isBootChanged(ev.bootEpochBefore, ev.bootEpochNow);

  const branch: BranchVerdict<DowntimeCause> = rebooted
    ? classifyRebooted(ev)
    : classifySameBoot(ev);

  return finalize(ev, branch);
}

// ────────────────────────────────────────────────────────────────────────────
// Q1 — 부팅 시각 불변: 맥은 꺼진 적이 없다
// ────────────────────────────────────────────────────────────────────────────

/**
 * §3.2 Q1a~Q1d. 반환 타입에 전원 계열이 없다는 것 자체가 이 함수의 존재 이유다.
 */
function classifySameBoot(ev: Evidence): BranchVerdict<SameBootCause> {
  const covered = sleepWindowsCoverGap(ev.sleepWindows, ev.gapStartSec, ev.gapEndSec);

  // ── Q1a. 프로세스가 살아 있는데 벽시계만 뛰었다 = T1 인프로세스 감지 ──────
  // 이번 사고의 형태다. 프로세스가 죽지 않았는데(pid 91880 유지) 60초 틱이 10시간 45분 만에
  // 발화했다면 절전 외의 원인이 사실상 없다 — `setInterval` 은 시스템이 자는 동안 발화하지
  // 않고 깨어나면 밀린 발화를 1회로 합쳐 내기 때문이다(`scheduler.ts:766-777` 실측 주석).
  // pmset 절전 윈도가 같은 구간을 덮으면 "확실", 못 덮으면(pmset 실패·14일 소멸) "추정".
  if (ev.sameProcess) {
    return { cause: "sleep", confidence: covered ? "확실" : "추정" };
  }

  // ── Q1b. 의도된 종료 마커가 남아 있다 ────────────────────────────────────
  // SIGTERM/SIGINT 를 받고 비컨에 `stopping` 을 찍어 두고 죽은 경우 = 배포·수동 재시작.
  // `launchctl kickstart -k` 가 실제로 SIGTERM 을 준다는 것은 임시 LaunchAgent 로 실측
  // 확인했다(§3.7-2). 5중 방어의 두 번째 겹.
  if (ev.prevBeaconMode === "stopping") {
    return { cause: "restart-intended", confidence: "확실" };
  }

  // ── Q1c. 절전 중/직후에 프로세스가 새로 떴다 ─────────────────────────────
  // pid 는 바뀌었지만 pmset 이 같은 구간의 절전을 증언한다. 사용자에게 중요한 사실은
  // "프로세스가 왜 바뀌었나"가 아니라 "그동안 맥이 자고 있었다"이므로 절전으로 부른다.
  // 다만 프로세스 교체를 절전만으로는 설명 못 하므로 "확실"은 주지 않는다.
  if (covered) {
    return { cause: "sleep", confidence: "추정" };
  }

  // ── Q1d. 맥은 켜져 있었고, 정상 종료 신호도 없었다 ───────────────────────
  // launchd `KeepAlive` 가 되살린 비정상 종료. "추정"인 이유는 `kill -9` 로 직접 재시작한
  // 경우가 여기로 떨어지기 때문이다(git HEAD 지문을 의도적으로 버린 대가, §12.2-7).
  // 완화책인 "직접 재시작하셨다면 무시하셔도 됩니다" 문구는 `narrate.ts` 가
  // `SHORT_GAP_HINT_MS`(10분) 로 판단해 붙인다 — 판정은 여기서 끝난다.
  return { cause: "app-gap", confidence: "추정" };
}

// ────────────────────────────────────────────────────────────────────────────
// Q2 — 부팅 시각 변경: 맥이 꺼졌다 켜졌다
// ────────────────────────────────────────────────────────────────────────────

/** §3.2 Q2a~Q2d. */
function classifyRebooted(ev: Evidence): BranchVerdict<RebootedCause> {
  // ── Q2a. 공백 구간에 `.panic` 파일이 생겼다 ──────────────────────────────
  // 종료 기록보다 **먼저** 본다. 패닉 재시작에도 종료 기록이 남는 경우가 있어서, 순서를
  // 뒤집으면 커널 패닉이 "정상 재시작"으로 조용히 삼켜진다. 구간은 [공백 시작, 감지 시각]
  // 양끝 포함이다(`gapEndSec` = §3.2 의 `nowSec`).
  const panicAt = ev.panicAtEpoch;
  if (panicAt != null && panicAt >= ev.gapStartSec && panicAt <= ev.gapEndSec) {
    return { cause: "panic", confidence: "확실" };
  }

  // ── Q2b. ★ fail-open — 이 파일에서 가장 중요한 다섯 줄 ───────────────────
  //
  // 종료 기록을 **읽지 못했으면 모른다고 말한다.** 절대 `power-cut` 으로 내려가지 않는다.
  // 이유: `/var/db/diagnostics/shutdown.*.log` 는 Apple 의 내부 형식이고 보장된 API 가
  // 아니다. macOS 업그레이드로 형식이나 경로가 바뀌면 파싱이 통째로 실패하는데, 그때
  // "기록이 없으니 비정상"이라고 읽으면 **정상 재부팅 전부가 정전으로 오보**된다.
  // 오보 한 번이면 사용자는 이 기능을 다시 읽지 않는다. 정보를 잃는 쪽이 훨씬 싸다(§12.2-8).
  //
  // `lastCleanShutdownEpoch == null` 까지 여기서 함께 막는 것은 명세 §3.2 의 문자보다 한 겹
  // 넓다(명세는 `!shutdownLogParsed` 만 적었다). 근거: `shutdownLogParsed === true` 인데
  // 값이 null 인 것은 증거 수집기의 계약 위반인데, 그 상태로 Q2c 를 지나가면 범위 비교가
  // 그냥 실패해 **Q2d 의 `power-cut/확실` 로 떨어진다.** 계약이 깨졌을 때 가장 강한 단정으로
  // 착지하는 것은 fail-open 의 정반대이므로, 같은 출구로 합류시킨다.
  // `bootEpochNow == null` 도 같은 줄에 둔다 — Q2 에 들어온 이상 논리적으로 non-null 이지만
  // (`isBootChanged` 가 양쪽 non-null 을 요구한다), Q2c 의 상한이 이 값이라 방어가 필요하다.
  const bootNow = ev.bootEpochNow;
  if (!ev.shutdownLogParsed || ev.lastCleanShutdownEpoch == null || bootNow == null) {
    return { cause: "unknown", confidence: "불명" };
  }

  // ── Q2c. 정상 종료 기록이 이 공백 안에 있다 ──────────────────────────────
  // "공백 시작 120초 전 ~ 새 부팅 60초 후" 안에 `SIGTERM: [epoch]` 이 있으면 사용자가 맥을
  // 정상적으로 껐다 켠 것이다. 앞뒤 여유를 두는 이유: 비컨은 60초 해상도라 마지막 생존이
  // 실제 종료보다 최대 60초 과거이고, 종료 직후 곧바로 부팅되면 두 시각이 역전돼 보인다.
  const clean = ev.lastCleanShutdownEpoch;
  if (
    clean >= ev.gapStartSec - CLEAN_SHUTDOWN_BEFORE_SEC &&
    clean <= bootNow + CLEAN_SHUTDOWN_AFTER_SEC
  ) {
    return { cause: "reboot-clean", confidence: "확실" };
  }

  // ── Q2d. 정상 종료 기록이 직전 부팅보다 과거다 = 종료 기록 없이 부팅했다 ──
  // 여기가 사용자가 원문에서 말한 "전원이 뽑혔다"에 해당하는 유일한 자리다.
  // (실측: 이 맥에서 8개월간 관측 0건. 그래도 남기는 이유는 §12.3.)
  const battery = ev.batteryAtGapStart;
  if (
    battery.percent != null &&
    battery.percent <= BATTERY_DEAD_PERCENT &&
    battery.onBattery === true
  ) {
    // "추정" 인 이유: 마지막으로 **기록된** 잔량일 뿐이다. 급방전이면 마지막 기록이 높게
    // 남아 `power-cut` 으로 오분류된다(§12.2-9). `onBattery === true` 를 명시 비교하는 것도
    // 같은 정직성이다 — `null`(모름)을 배터리 전원으로 뭉개면 AC 상태의 정전이 방전이 된다.
    return { cause: "battery-dead", confidence: "추정" };
  }
  return { cause: "power-cut", confidence: "확실" };
}

// ────────────────────────────────────────────────────────────────────────────
// 공통 후처리 — 원인은 그대로 두고 **확신도와 길이 표기만** 낮춘다
// ────────────────────────────────────────────────────────────────────────────

/**
 * §3.2 공통 후처리.
 *
 * ★ 여기서는 **cause 를 절대 바꾸지 않는다.** 증거가 부실하다고 원인을 갈아치우면 판정
 *   트리의 순서 고정이 무의미해진다. 부실함은 confidence(문체 스위치)와 `gapExact`(길이를
 *   말할지 여부)로만 표현한다. §3.3-3: "pmset 은 판정 뒤집기 금지, confidence 조정과 문장
 *   재료로만."
 *
 * 순서가 결과를 바꾼다(하향은 확실→추정→불명 로 누적되고, pmset 규칙만 "확실일 때만"
 * 발화하기 때문이다). 그래서 명세가 적은 순서를 그대로 지킨다.
 */
function finalize(ev: Evidence, branch: BranchVerdict<DowntimeCause>): Verdict {
  let confidence = branch.confidence;
  let gapExact = true;

  // (a) 시계 점프 의심 — 공백 "길이"를 포기한다.
  //
  // 명세는 이 규칙을 Q1a 안에 ※ 로 적었지만 여기 공통 후처리로 올렸다. 근거:
  //  - §4.5 의 정의 자체가 분기와 무관하다("|벽시계 델타 − os.uptime 델타| > 60초").
  //  - 시계가 튀었으면 **어느 분기든** 공백 길이가 거짓이다. 길이를 그대로 문장에 쓰면
  //    "5시간 28분 동안 맥이 꺼져 있었습니다" 같은 확정형 거짓말이 나간다. 한 번 틀리면
  //    사용자는 다시 읽지 않는다.
  //  - 실무적으로 `clockSuspect` 는 T1 틱(= sameProcess, 곧 Q1a)에서만 계산 가능하므로
  //    다른 분기에서는 항상 false 다. 즉 이 확장은 명세 대비 **동작 차이가 사실상 없고**,
  //    앞으로 T2 에서도 계산하게 될 때를 위한 안전판이다.
  //
  // ⚠️ 미검증 사항(§4.5): macOS 에서 NTP 대점프 시 `kern.boottime` 이 함께 보정되는지 확인하지
  //    못했다. 그래서 이 신호는 **분류를 바꾸지 않는다.** 보정된다면 1차 관문이 흔들려
  //    판정 전체를 신뢰할 수 없는데(§12.2-12), 그 경우까지 여기서 흉내 낼 수는 없다.
  if (ev.clockSuspect) {
    confidence = downgradeConfidence(confidence);
    gapExact = false;
  }

  // (b) 비컨 쓰기 실패 — "기록이 없다"와 "기록에 실패했다"를 구분한다(§3.4).
  // 디스크 가득참·권한 문제로 하트비트가 안 써지면 멀쩡한 구간이 공백으로 보인다(§12.2-11).
  // 오탐 자체를 없앨 수는 없으니 문체를 단정형에서 "…로 보입니다" 로 내린다.
  if (ev.beaconWriteFailures > 0) {
    confidence = downgradeConfidence(confidence);
  }

  // (c) pmset 실패 — 한 단계만, 그것도 "확실"일 때만.
  // pmset 은 3순위 보강 증거일 뿐이라(§3.3) 없다고 "불명"까지 내리면 boot/shutdown 이라는
  // 1·2순위 증거를 스스로 부정하는 셈이 된다. 그래서 이 규칙만 비대칭이다.
  if (!ev.pmsetParsed && confidence === "확실") {
    confidence = "추정";
  }

  // (d) 부팅 시각을 폴백으로 얻었다 — 1순위 증거의 정확도가 떨어진 상태다.
  //
  // 명세 §3.2 의 공통 후처리 목록에는 없지만 §4.1 이 "sysctl 실패 시 fallback …
  // `bootFromFallback = true`, confidence 하향" 이라고 못박았고, `shared/uptime.ts` 의
  // 필드 주석도 "true 면 confidence 하향"이라고 계약으로 적어 두었다. confidence 를 만드는
  // 곳이 이 파일뿐이므로 여기 두는 것 외에 이행할 자리가 없다.
  // 폴백은 `Date.now()/1000 - os.uptime()` 이라 초 단위 반올림으로 흔들리고, 그 흔들림이
  // 하필 1차 관문(±5초)의 입력이다 — 판정이 통째로 뒤집힐 수 있는 값이니 단정하지 않는다.
  if (ev.bootFromFallback) {
    confidence = downgradeConfidence(confidence);
  }

  // (e) 지금 부팅 시각을 아예 못 읽었다 — 무조건 "불명".
  // 이 경우 `isBootChanged` 가 false 가 되어 Q1 로 떨어지므로 전원 계열로는 가지 않는다.
  // 원인은 그럴듯하게 나오지만 근거의 1순위가 통째로 비어 있으므로 바닥으로 내린다.
  if (ev.bootEpochNow == null) {
    confidence = "불명";
  }

  return { cause: branch.cause, confidence, gapExact };
}
