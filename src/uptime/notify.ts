/**
 * 가동 중단 알림 — iMessage 게이트 (명세 §7).
 *
 * ## 이 파일의 책임은 "보낼지 말지" 하나뿐이다
 * 문구는 `narrate.ts`(§6.3)가, 저장은 `store.ts`(§5.2)가, 사건 생성·재평가는 `index.ts`가 한다.
 * 여기서 문구를 만들면 일지(`data/downtime.log`)와 문자가 조용히 갈라진다 — 사용자는 두 곳을
 * 나란히 놓고 볼 일이 없으니 갈라진 것도 영영 모른다. 그래서 본문은 **반드시** narrate 에서 온다.
 *
 * ## 왜 게이트가 이렇게 두꺼운가 (실패 모드가 전부 조용하기 때문이다)
 * 이 기능의 알림은 두 방향으로 망가질 수 있고 **둘 다 사용자가 신고해 주지 않는다**:
 *  - 너무 많이 보냄: launchd `KeepAlive=true` + `minimum runtime 10초` 라 배포가 깨지면 프로세스가
 *    분당 6회 되살아난다. 기동마다 같은 사건으로 문자를 보내면 그건 알림이 아니라 공격이다.
 *    (이 맥의 전력 설정이 `Battery: sleep 1` 이라 밤샘 절전이 아침 슬롯을 덮는 건 **기본값**에
 *    가깝다. 매일 새벽 문자가 오면 사용자는 3일 안에 알림을 통째로 끈다.)
 *  - 너무 적게 보냄: P0 에는 대시보드가 없어서(§12.1-6) 문자가 **유일한 능동 통보 경로**다.
 *    여기서 삼키면 사용자는 다음에 우연히 화면을 열 때까지 아무것도 모른다.
 *
 * ## 절대 규칙
 * - **throw 금지.** 정전 직후엔 네트워크·Messages.app 이 아직 안 올라와 있을 수 있고, 알림 실패가
 *   사건 기록 자체를 막으면 이 기능의 목적(나중에 볼 수 있는 기록)이 통째로 사라진다.
 *   모든 경로는 결과 객체로 돌아오고 실패는 로그로만 남는다.
 * - **severity 게이트(§3.5) 준수.** `사고`(= evaluated 손실 ≥ 1건)만 문자로 나간다.
 *   `기록만`·`무시`는 일지/원장에만 남는다. 손실 0건인 절전에 문자를 보내면 위 "너무 많이 보냄"이다.
 * - **사건 id 기준 멱등.** id 는 gapStart 기반 안정 키라 병합·재평가·재기동을 거쳐도 불변이다.
 *
 * 명세: §7(알림 정책) · §3.5(손실 게이트) · §6.3(문자 본문) · §5.2(notified 스키마).
 */

import { config } from "../config.ts";
import { isIMessageConfigured, sendIMessage } from "../notify/imessage.ts";
import { isQuietHour } from "../stock/pulse-gate.ts";
import { log } from "../util/log.ts";
import { downtimeIMessageText } from "./narrate.ts";
import {
  NOTIFY_AFTER_REEVAL_ROUND,
  REEVAL_DELAYS_MS,
  type DowntimeEvent,
  type DowntimeNotifyState,
} from "../../shared/uptime.ts";

// ────────────────────────────────────────────────────────────────────────────
// 0. 프로세스 수명 내 안전장치
// ────────────────────────────────────────────────────────────────────────────

/**
 * 한 프로세스 안에서 같은 사건에 허용하는 **발송 시도** 횟수 상한.
 *
 * 왜 필요한가: 호출자(index.ts)는 하트비트 틱마다(60초) 보류분을 훑는다. Messages.app 이
 * TCC 미승인(-1743)이거나 정전 직후처럼 계속 실패하는 상태면, 상한이 없을 때 **60초마다
 * osascript 자식 프로세스를 영원히 띄운다.** 실패는 stdout 에만 쌓이고 사용자는 모른다.
 * 3회면 일시적 실패(부팅 직후 Messages 미기동)는 충분히 넘기고, 영구 실패는 조용히 포기한다.
 * (포기해도 일지·원장·stdout warn 은 그대로 남으므로 기록 요구는 배신하지 않는다.)
 */
const MAX_SEND_ATTEMPTS_PER_PROCESS = 3;

/**
 * 사건 id → 이 프로세스에서의 발송 이력. **저장이 실패해도 중복 발송을 막는 2차 방어선**이다.
 *
 * 1차 방어선은 원장에 영속되는 `event.notified.imessage` 지만, 그건 호출자가 저장에 성공해야
 * 성립한다. 디스크가 가득 찼거나 저장 직전에 프로세스가 죽으면 1차선이 무너지는데, 그때
 * 되살아난 프로세스가 같은 사건 객체를 다시 읽어 또 보낸다. 이 Map 은 **같은 프로세스 안에서의**
 * 반복(재평가 타이머 3회 + 매 틱 플러시)을 막는다. 프로세스가 죽으면 사라지는 것이 한계다.
 */
const attemptsById = new Map<string, { attempts: number; sent: boolean }>();

/**
 * Map 상한. 이 프로세스는 몇 달씩 살아 있고 사건 id 는 계속 새로 생긴다(원장은 100건에서
 * 절삭되지만 이 Map 은 절삭 신호를 못 받는다). 삽입 순서 Map 의 앞에서부터 버린다 —
 * 오래된 사건이 다시 발송 후보가 되는 일은 구조적으로 없다(이미 notified 가 영속돼 있다).
 */
const ATTEMPT_MAP_MAX = 200;

function attemptStateOf(id: string): { attempts: number; sent: boolean } {
  let s = attemptsById.get(id);
  if (!s) {
    s = { attempts: 0, sent: false };
    attemptsById.set(id, s);
    while (attemptsById.size > ATTEMPT_MAP_MAX) {
      const oldest = attemptsById.keys().next();
      if (oldest.done) break;
      attemptsById.delete(oldest.value);
    }
  }
  return s;
}

/** 테스트 전용 — 프로세스 내 멱등 캐시를 비운다. 운영 코드에서 부르지 말 것. */
export function __resetDowntimeNotifyState(): void {
  attemptsById.clear();
}

// ────────────────────────────────────────────────────────────────────────────
// 1. 판정 (순수 함수 — I/O 0)
// ────────────────────────────────────────────────────────────────────────────

/**
 * 지금 이 사건에 대해 무엇을 할 것인가.
 *
 * - `send`  : 지금 보낸다
 * - `queue` : 조용시간이라 보류한다(`queuedUntil` 에 발송 예정 시각)
 * - `wait`  : 아직 이르다(복구 유예). 상태를 바꾸지 않고 다음 호출을 기다린다
 * - `skip`  : 이 사건은 문자로 나가지 않는다(사고 아님/이미 발송/확인함/미설정)
 */
export type DowntimeNotifyAction = "send" | "queue" | "wait" | "skip";

export interface DowntimeNotifyDecision {
  action: DowntimeNotifyAction;
  /** 로그·일지에 그대로 실을 수 있는 한국어 사유. */
  reason: string;
  /** `action === "queue"` 일 때만 채워진다(로컬 ISO, 예: `2026-08-02T07:00:00+09:00`). */
  queuedUntil: string | null;
}

/**
 * §7 발송 조건 6개를 **순서대로** 검사한다. 순수 함수라 테스트 대상이 된다.
 *
 * 순서에 이유가 있다(pulse-gate.ts `decide()` 의 전례와 같은 사고방식):
 *  1. **severity** 를 맨 앞에 — 이게 §3.5 손실 게이트의 최종 방어선이다. 원인 판정이 틀려도
 *     손실이 0이면 사용자를 방해하지 않는다. 뒤로 미루면 나머지 검사가 무의미하게 돌고,
 *     더 나쁘게는 "사고 아님"인 사건에 `queuedUntil` 같은 상태가 붙는다.
 *  2. **ackedAt** — 사용자가 화면에서 이미 봤으면 문자는 소음이다. 보류 중이던 것도 여기서 취소된다.
 *  3. **멱등(이미 발송)** — 재평가 타이머·틱 플러시·재기동이 같은 사건을 몇 번이고 들고 온다.
 *  4. **미설정** — 여기까지 와서야 판단한다. 앞으로 당기면 일지의 "알림: 미설정" 이 사고가
 *     아닌 사건에도 붙어 사용자가 "알림이 안 왔어야 하는 건가"를 구분하지 못한다.
 *  5. **복구 유예** — "안 돌았습니다" 3분 뒤 "돌았습니다" 두 통을 막는다(§7-6).
 *  6. **조용시간** — 맨 마지막. 야간 보류는 '안 보냄'이 아니라 '나중에 보냄'이라, 다른 모든
 *     관문을 통과한 뒤 시각만 미루는 것이어야 한다.
 */
export function decideDowntimeNotify(
  ev: DowntimeEvent,
  now: Date,
  configured: boolean
): DowntimeNotifyDecision {
  // 1. severity 게이트 (§3.5) — `사고` 만 문자로 나간다.
  if (ev.severity !== "사고") {
    return { action: "skip", reason: `사고 아님(${ev.severity})`, queuedUntil: null };
  }

  // 2. 이미 화면에서 확인함 (§7-4)
  if (ev.ackedAt) {
    return { action: "skip", reason: "화면에서 이미 확인함", queuedUntil: null };
  }

  // 3. 사건 id 기준 멱등 (§7-3)
  if (ev.notified.imessage) {
    return { action: "skip", reason: "이미 발송함", queuedUntil: null };
  }

  // 4. 채널 미설정 (§7-2)
  if (!configured) {
    return { action: "skip", reason: "iMessage 미설정", queuedUntil: null };
  }

  // 5. 복구 유예 (§7-6) — 재평가 2회차(+15분)에 도달했거나, 그 전에 복구 상태가 확정되면 발송.
  //    ★ 둘 중 **먼저 오는 쪽**이다. 3건 중 3건이 5분 만에 보충되면 굳이 15분을 기다리지 않고
  //      "다 받아왔습니다"까지 담은 한 통을 보낸다.
  //
  //    ⚠️ 벽시계 상한을 함께 본다. 재평가 사슬은 **프로세스 안의 setTimeout** 이라 재기동하면
  //      사라지는데, 무장은 새 공백을 처리할 때만 일어난다. 그래서 사건 생성 15분 안에
  //      배포·크래시·KeepAlive 부활로 재시작되면 그 사건은 `reevalCount 0~1 / 복구중` 으로
  //      디스크에 남고 **영원히 wait** 이 된다 — P0 에서 문자는 유일한 능동 통보 경로인데
  //      그게 조용히 삼켜지고, pending 이 비지 않아 60초 스윕 타이머도 영영 안 꺼진다
  //      (2026-08-02 적대적 검증 실측). 재평가가 다 돌았을 시간이 지났으면 유예를 푼다.
  const reevalDeadlineMs = REEVAL_DELAYS_MS[REEVAL_DELAYS_MS.length - 1] ?? 45 * 60_000;
  const sinceGapEndMs = now.getTime() - Date.parse(ev.gapEnd);
  const 유예시간남음 = !Number.isFinite(sinceGapEndMs) || sinceGapEndMs <= reevalDeadlineMs;
  if (ev.reevalCount < NOTIFY_AFTER_REEVAL_ROUND && ev.recoveryState === "복구중" && 유예시간남음) {
    return {
      action: "wait",
      reason: `복구 유예(재평가 ${ev.reevalCount}/${NOTIFY_AFTER_REEVAL_ROUND}회, 아직 복구중)`,
      queuedUntil: null,
    };
  }

  // 6. 조용시간 게이트 (§7-5) — 기본 23~07시. 10시간 자다 새벽 3시에 깨어나면 그게 새벽 문자다.
  const { quietStartHour, quietEndHour } = config.stockPulse;
  if (isQuietHour(now.getHours(), quietStartHour, quietEndHour)) {
    const until = nextQuietEnd(now, quietEndHour);
    return {
      action: "queue",
      reason: `조용시간(${quietStartHour}시~${quietEndHour}시) 보류`,
      queuedUntil: localIsoSeconds(until),
    };
  }

  return { action: "send", reason: "발송", queuedUntil: null };
}

/**
 * 조용시간이 끝나는 다음 시각(로컬). 오늘의 종료 시각이 이미 지났으면 내일 같은 시각.
 *
 * `isQuietHour` 가 자정을 넘는 창(23→7)을 지원하므로 여기도 그 경우를 견뎌야 한다:
 * 23:30 에 판정하면 오늘 07:00 은 과거라 내일 07:00 이 되고, 03:00 이면 오늘 07:00 이 된다.
 * KST 는 서머타임이 없어 `setHours` 로 충분하다.
 */
function nextQuietEnd(now: Date, endHour: number): Date {
  const d = new Date(now.getTime());
  d.setHours(endHour, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * 로컬 오프셋을 붙인 ISO(초 단위, 예: `2026-08-02T11:15:03+09:00`).
 *
 * `toISOString()`(UTC Z)을 쓰지 않는 이유: `notified.at` / `queuedUntil` 은 사용자에게
 * "발송 완료 11:15" / "07:00 이후 발송" 으로 읽히는 값이라, 원장을 사람이 직접 열어봤을 때
 * 9시간 어긋난 숫자가 보이면 안 된다. §5.2 의 `gapStart`/`gapEnd`(+09:00)와 같은 표기다.
 *
 * ⚠️ 이 헬퍼가 `store.ts` 에도 따로 있을 수 있다(같은 표기를 각자 만든다). 공용 위치는
 *    `shared/uptime.ts` 인데 거기엔 순수 타입·상수만 두기로 확정돼 있고, 병렬 작업 중이라
 *    남의 파일을 고칠 수 없었다. 통합은 후속 정리 대상이다.
 */
function localIsoSeconds(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const offMin = -d.getTimezoneOffset(); // 동쪽이 +. KST 는 +540
  const sign = offMin >= 0 ? "+" : "-";
  const offAbs = Math.abs(offMin);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(offAbs / 60))}:${p(offAbs % 60)}`
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 2. 실행
// ────────────────────────────────────────────────────────────────────────────

/** 실행 결과. `changed` 가 true 면 **호출자가 원장을 저장해야 한다**. */
export type DowntimeNotifyOutcome = "sent" | "queued" | "waiting" | "skipped" | "failed";

export interface DowntimeNotifyResult {
  outcome: DowntimeNotifyOutcome;
  reason: string;
  /**
   * `ev.notified`(또는 그 하위 필드)가 이번 호출로 바뀌었는가.
   *
   * ★ 이 모듈은 **원장을 직접 쓰지 않는다.** store.ts 와 파일 소유권이 갈려 있고, 여기서
   *   저장까지 하면 `store → notify → store` 순환 임포트가 생긴다. 대신 사건 객체를 제자리에서
   *   갱신하고 이 플래그로 "저장하라"고 알린다.
   */
  changed: boolean;
}

/** 테스트·특수 호출용 주입점. 운영에서는 전부 기본값을 쓴다. */
export interface DowntimeNotifyDeps {
  /** 판정 기준 시각. 기본 `new Date()`. */
  now?: Date;
  /** 실제 발송기. 기본 `sendIMessage`. */
  send?: (text: string) => Promise<void>;
  /** 채널 설정 여부. 기본 `isIMessageConfigured`. */
  configured?: () => boolean;
}

/**
 * 사건 1건을 §7 규칙으로 처리한다. **절대 throw 하지 않는다.**
 *
 * 부작용은 딱 두 가지다:
 *  - `ev.notified` 제자리 갱신 (저장은 호출자 몫 — `result.changed` 참조)
 *  - iMessage 발송 시도 1회
 *
 * 발송 순서는 **보내고 → 곧바로 표시**다. 반대(먼저 표시 → 보내기)로 하면 발송이 실패했을 때
 * "보냈다"고 영구 기록돼 사용자가 영영 모른다. 지금 순서의 대가는 발송 직후~저장 직전에
 * 프로세스가 죽으면 재기동 시 1회 중복 발송될 수 있다는 것인데, 그 창은 밀리초 단위이고
 * 프로세스 내 `attemptsById` 가 같은 프로세스 안에서의 반복은 이미 막는다.
 */
export async function notifyDowntimeEvent(
  ev: DowntimeEvent,
  deps: DowntimeNotifyDeps = {}
): Promise<DowntimeNotifyResult> {
  try {
    const now = deps.now ?? new Date();
    const configured = (deps.configured ?? isIMessageConfigured)();
    const decision = decideDowntimeNotify(ev, now, configured);

    if (decision.action === "skip") {
      // 보류표가 남아 있으면 지운다. [확인했어요] 를 눌러 취소된 알림이 원장에 영원히
      // "07:00 이후 발송 예정"으로 남아 있으면 화면·일지가 거짓말을 하게 된다(§11-12 ack 조항).
      if (ev.notified.queuedUntil) {
        ev.notified = { ...ev.notified, queuedUntil: null };
        return { outcome: "skipped", reason: decision.reason, changed: true };
      }
      return { outcome: "skipped", reason: decision.reason, changed: false };
    }

    if (decision.action === "wait") {
      return { outcome: "waiting", reason: decision.reason, changed: false };
    }

    if (decision.action === "queue") {
      // 같은 예정 시각을 매 틱 다시 쓰지 않는다(불필요한 원장 저장 = 디스크 쓰기 낭비).
      if (ev.notified.queuedUntil === decision.queuedUntil) {
        return { outcome: "queued", reason: decision.reason, changed: false };
      }
      ev.notified = { ...ev.notified, queuedUntil: decision.queuedUntil };
      log.info(
        `가동 중단 알림 보류 — ${decision.reason}, ${decision.queuedUntil} 이후 발송 (사건 ${ev.id})`
      );
      return { outcome: "queued", reason: decision.reason, changed: true };
    }

    // ── action === "send" ──
    const state = attemptStateOf(ev.id);
    if (state.sent) {
      // 원장 저장이 실패했거나 호출자가 사본을 다시 읽어 온 경우. 2차 방어선.
      return { outcome: "skipped", reason: "이미 발송함(프로세스 내 기록)", changed: false };
    }
    if (state.attempts >= MAX_SEND_ATTEMPTS_PER_PROCESS) {
      return {
        outcome: "failed",
        reason: `발송 실패 ${state.attempts}회로 이 프로세스에서는 재시도하지 않습니다`,
        changed: false,
      };
    }

    // 본문은 narrate 소유(§6.3). 여기서 만들지 않는다 — 만들면 일지와 문자가 갈라진다.
    // narrate 가 던지면 그건 버그이므로 대체 문구로 덮지 않고 드러낸다(발송만 실패).
    let text: string;
    try {
      text = downtimeIMessageText(ev);
    } catch (e) {
      log.error(`가동 중단 문자 본문 생성 실패 (사건 ${ev.id}): ${(e as Error).message}`);
      return { outcome: "failed", reason: "문구 생성 실패", changed: false };
    }
    if (!text.trim()) {
      log.error(`가동 중단 문자 본문이 비어 있습니다 (사건 ${ev.id})`);
      return { outcome: "failed", reason: "문구가 비어 있음", changed: false };
    }

    state.attempts += 1;
    try {
      await (deps.send ?? sendIMessage)(text);
    } catch (e) {
      // 정전 직후엔 Messages.app·네트워크가 아직 안 올라와 있을 수 있다. 실패는 로그만 남기고
      // 원장은 건드리지 않는다 → 다음 틱에 다시 후보가 된다(상한 3회).
      log.warn(
        `가동 중단 iMessage 발송 실패 (사건 ${ev.id}, 시도 ${state.attempts}/${MAX_SEND_ATTEMPTS_PER_PROCESS}): ${(e as Error).message}`
      );
      return { outcome: "failed", reason: "발송 실패", changed: false };
    }

    state.sent = true;
    const at = localIsoSeconds(now);
    const next: DowntimeNotifyState = { imessage: true, at, queuedUntil: null };
    ev.notified = next;
    log.info(`가동 중단 iMessage 발송 완료 — ${ev.cause}/${ev.gapMinutes}분 (사건 ${ev.id})`);
    return { outcome: "sent", reason: "발송", changed: true };
  } catch (e) {
    // ★ 최후 방어. 여기까지 오면 우리 코드의 버그지만, 그래도 사건 기록을 막아서는 안 된다.
    log.error(`가동 중단 알림 처리 중 예외 (사건 ${ev?.id ?? "?"}): ${(e as Error).message}`);
    return { outcome: "failed", reason: "내부 오류", changed: false };
  }
}

/**
 * 원장 전체를 훑어 보낼 것을 보낸다. 하트비트 틱(60초)과 기동 부검 직후에 호출한다.
 *
 * **조용시간 보류분이 풀리는 지점이 바로 여기다** — 새벽 3시에 깨어나 보류된 문자는 07:00 이후
 * 첫 틱에서 나간다. 별도 타이머를 두지 않는 이유: 타이머는 절전 중 발화하지 않아 정확히
 * 이 기능이 필요한 상황에서 늦게 깨어난다(§1 T1 과 같은 함정).
 *
 * 발송은 **순차**다. osascript 자식 프로세스를 동시에 여러 개 띄우면 Messages.app 이 흔들리고,
 * 어차피 동시에 여러 건이 후보가 되는 상황 자체가 비정상이다.
 *
 * @returns `notified` 가 바뀐 사건들. 비어 있지 않으면 호출자가 원장을 저장해야 한다.
 */
export async function notifyDowntimeEvents(
  events: DowntimeEvent[],
  deps: DowntimeNotifyDeps = {}
): Promise<DowntimeEvent[]> {
  const changed: DowntimeEvent[] = [];
  for (const ev of events) {
    const r = await notifyDowntimeEvent(ev, deps);
    if (r.changed) changed.push(ev);
  }
  return changed;
}

/**
 * §7 서두가 명시한 `Promise<boolean>` 형태의 얇은 래퍼 — "이번 호출로 문자가 나갔는가".
 *
 * 주 API 를 결과 객체로 넓힌 이유는 boolean 하나로는 `보류`·`아직 이르다`·`이미 보냄`·`실패` 가
 * 전부 `false` 로 뭉개져서 **호출자가 원장을 저장해야 하는지 알 수 없기** 때문이다.
 * 저장 여부를 모르면 조용시간 보류표(`queuedUntil`)가 디스크에 남지 않아, 재기동 한 번으로
 * 보류 사실 자체가 증발한다.
 */
export async function notifyDowntime(
  ev: DowntimeEvent,
  deps: DowntimeNotifyDeps = {}
): Promise<boolean> {
  return (await notifyDowntimeEvent(ev, deps)).outcome === "sent";
}
