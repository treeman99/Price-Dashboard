/**
 * 가동 중단 사후 보고 — **합성 루트**(명세 §9.3, §11-10).
 *
 * 이 파일이 하는 일은 판단이 아니라 **배선**이다. 8개 모듈이 각자 하나씩만 알고 있는 사실을
 * 순서대로 이어 붙여 "공백 1건 → 사건 1건 → 사용자에게 도달"까지를 완성한다.
 *
 * ```
 *   [T1] beacon.ts 60초 틱 ─┐
 *                           ├─→ missed.ts (놓친 슬롯)  ─┐
 *   [T2] 기동 부검 (이 파일)─┘                          ├─→ store.ts (원장 + 일지)
 *                             evidence.ts (증거) ─┐     │        ↓
 *                                                 ├─ classify.ts (판정)  narrate.ts (문구)
 *                                                 ┘     │        ↓
 *                                                       └─→ log.warn (§6.2 stdout 병기)
 *                                                           notify.ts (§7 iMessage)
 *                                                           재평가 타이머 ×3 (§8.5)
 * ```
 *
 * ## 공개 API 는 두 개뿐 (명세 §9.1 마지막 줄)
 * - `startUptimeWatch()` — `src/index.ts` 가 부르는 유일한 진입점
 * - `getDowntimeView()`  — P1 의 `GET /api/downtime` 이 그대로 쓴다
 *
 * ## ★ 이 파일의 절대 규칙 — 절대 throw 하지 않는다
 * 진단 기능이 서비스 기동을 막으면 본말전도다(§9.3). 그래서
 * (a) `startUptimeWatch()` 전체가 try/catch 이고,
 * (b) 그 안의 모든 단계가 다시 개별 try/catch 이며,
 * (c) 기동 부검은 `UPTIME_STARTUP_BUDGET_MS`(10초) 예산과 경주해서 **초과하면 백그라운드로
 *     떼어내고 먼저 반환**한다. 대시보드와 스케줄러가 진단 때문에 늦게 뜨는 일은 없다.
 */

import path from "node:path";
import { log } from "../util/log.ts";
import { isIMessageConfigured } from "../notify/imessage.ts";
import {
  MIN_GAP_MS,
  REEVAL_DELAYS_MS,
  UPTIME_STARTUP_BUDGET_MS,
  countEvaluatedMissed,
} from "../../shared/uptime.ts";
import type {
  DowntimeEvent,
  DowntimeEvidence,
  DowntimeRecoveryState,
  DowntimeSource,
  DowntimeView,
  Evidence,
  MissedSlot,
  UptimeBeacon,
  Verdict,
} from "../../shared/uptime.ts";

import {
  type BeaconGap,
  processStartedAtMs,
  readPreviousBeacon,
  startUptimeBeacon,
} from "./beacon.ts";
import { collectEvidence, getBootEpoch } from "./evidence.ts";
import { classify } from "./classify.ts";
import { describeMissedSlots } from "./missed.ts";
import {
  DEFAULT_JOURNAL_PATH,
  DOWNTIME_JOURNAL_HEADER,
  narrate,
  narrateStdout,
  renderJournalEntry,
  splitJournalEntries,
} from "./narrate.ts";
import {
  DOWNTIME_JOURNAL_PATH,
  type DowntimeNarrator,
  getDowntimeEvent,
  getDowntimeView as loadDowntimeView,
  listDowntimeEvents,
  markDowntimeNotified,
  patchDowntimeEvent,
  recordDowntimeEvent,
} from "./store.ts";
import { notifyDowntimeEvent } from "./notify.ts";

// ────────────────────────────────────────────────────────────────────────────
// 0. 문구 주입 (store.ts 가 요구한 계약 그대로)
// ────────────────────────────────────────────────────────────────────────────

/**
 * `store.ts` 는 `narrate.ts` 를 **하드 임포트하지 않는다.** 이유는 그 파일 주석에 적힌 대로
 * 두 가지다: (1) 문구 규칙이 두 파일로 복제되는 것을 막고, (2) `renderJournalEntry` 의 두
 * 번째 인자가 `isIMessageConfigured()` 를 요구해서 하드 임포트하면 저장 계층이 알림 계층까지
 * 끌고 온다. 그 배선을 **합성 루트인 이 파일이** 담당한다.
 *
 * `isIMessageConfigured()` 를 매번 부르는 이유: `.env` 를 고쳐 재시작하지 않아도 다음 사건의
 * 일지 "알림:" 줄이 따라오게 하기 위해서다. 비용은 문자열 비교 한 번이다.
 */
const narrator: DowntimeNarrator = {
  narrate: (e) => narrate(e),
  journalEntry: (e) => renderJournalEntry(e, isIMessageConfigured()),
  journalHeader: () => DOWNTIME_JOURNAL_HEADER,
  splitEntries: (t) => splitJournalEntries(t),
};

/**
 * stdout·문자에 병기할 **일지 절대경로**(§6.2 / §6.3).
 *
 * `DB_PATH` 를 상대경로로 지정한 환경에서도 절대경로가 되도록 한 번 더 `resolve` 한다 —
 * 상대경로는 폰에서 열 수 없어 알림이 도달해도 정보에 도달하지 못한다(§6.3).
 */
const JOURNAL_PATH = path.resolve(DOWNTIME_JOURNAL_PATH);

// ────────────────────────────────────────────────────────────────────────────
// 1. 직렬화 — 원장을 동시에 두 곳에서 고치지 않는다
// ────────────────────────────────────────────────────────────────────────────

/**
 * 원장을 바꾸는 모든 작업(사건 기록 / 재평가 패치 / 알림 상태 갱신)을 **한 줄로 세운다.**
 *
 * ## 왜 필요한가
 * `store.ts` 는 매번 "파일 읽기 → 수정 → 통째 쓰기"다(메모리 캐시를 일부러 두지 않았다).
 * 그런데 이 파일에는 원장을 건드리는 주체가 셋이다 — 하트비트 공백 콜백, 재평가 타이머 3개,
 * 알림 스윕. 둘이 겹치면 **나중에 끝난 쪽이 먼저 끝난 쪽의 수정을 통째로 덮는다**(lost update).
 * 실제로 겹치기 쉬운 조합이 있다: 사건 생성 5분 뒤 1차 재평가가 도는데, 그 시각에 절전에서
 * 막 깨어나 새 공백 콜백이 들어오는 경우다.
 *
 * 큐는 프로세스 하나 안에서만 유효하다(파일 락이 아니다). 이 앱은 launchd 가 단일 인스턴스로
 * 띄우므로 그걸로 충분하고, 파일 락은 죽은 락을 청소하는 문제를 새로 만든다.
 */
let chain: Promise<void> = Promise.resolve();

function queue(task: () => Promise<void> | void): Promise<void> {
  chain = chain.then(async () => {
    try {
      await task();
    } catch (e) {
      // 큐가 한 번의 실패로 끊기면 이후 모든 사후 보고가 조용히 사라진다. 반드시 삼킨다.
      log.error(`가동 중단 처리 중 오류(무시하고 계속): ${(e as Error).message}`);
    }
  });
  return chain;
}

// ────────────────────────────────────────────────────────────────────────────
// 2. 공백 1건 처리 — T1(틱)과 T2(기동 부검)가 공유하는 본체
// ────────────────────────────────────────────────────────────────────────────

/** 두 트리거가 이 파일 안에서 공통으로 넘기는 것. `evidence.GapContext` 로 그대로 흘러간다. */
interface GapInput {
  source: DowntimeSource;
  gapStartMs: number;
  gapEndMs: number;
  prevBeacon: UptimeBeacon | null;
  cpuSecondsInGap: number | null;
  dutyPercent?: number | null;
  /** T1 만 넘긴다. T2 는 넘기지 않아야 evidence 가 직전 비컨의 `osUptime` 과 대조해 자체 판단한다. */
  clockSuspect?: boolean;
  beaconWriteFailures: number;
}

/**
 * `Evidence`(classify 입력) → `DowntimeEvidence`(원장 동결본).
 *
 * 뒤 4개(`gapMs`/`gapStartSec`/`gapEndSec`/`sleepWindows`)는 **원장에 저장하지 않는다.**
 * 앞 셋은 `gapStart`/`gapEnd` 에서 다시 계산되고, `sleepWindows` 는 `pmsetLines` 에서
 * `buildSleepWindows()` 로 복원된다(evidence.ts 가 잘라낸 표본만으로도 원본과 동일한 커버
 * 윈도가 나옴을 실측 검증했다). 이중 저장하면 건당 예산 ~1.5KB 를 갉아먹고, 두 사본이
 * 갈라졌을 때 어느 쪽이 참인지 알 수 없어진다.
 */
function freezeEvidence(ev: Evidence): DowntimeEvidence {
  // rest 구조분해의 형제 변수는 `noUnusedLocals` 가 의도적으로 봐준다(TS 3.0+). 필드를
  // 20개 나열해 옮기는 것보다 이쪽이 안전하다 — 나열하면 필드가 하나 늘 때 조용히 빠진다.
  const { gapMs, gapStartSec, gapEndSec, sleepWindows, ...frozen } = ev;
  return frozen;
}

/**
 * 증거 수집이 통째로 실패했을 때 쓰는 최소 증거(§9.3 "초과하면 `unknown/불명` 으로 낮춰 기록").
 *
 * `collectEvidence()` 는 내부 I/O 를 전부 삼키도록 만들어져 있어 여기 올 일이 사실상 없지만,
 * 그래도 비워 두지 않는 이유는 명확하다 — **증거를 못 모았다는 것과 사건이 없었다는 것은
 * 완전히 다른 사실**이고, 후자로 접으면 이 기능이 존재해야 할 순간에 침묵한다.
 */
function fallbackEvidence(input: GapInput): DowntimeEvidence {
  const prev = input.prevBeacon;
  return {
    bootEpochBefore: prev?.bootEpoch ?? null,
    bootEpochNow: null,
    bootChanged: false,
    bootFromFallback: false,
    prevPid: prev?.pid ?? null,
    currentPid: process.pid,
    sameProcess: false,
    prevBeaconMode: prev?.mode ?? null,
    lastCleanShutdownEpoch: null,
    shutdownLogParsed: false,
    panicAtEpoch: null,
    panicDirReadable: false,
    pmsetParsed: false,
    pmsetLines: [],
    darkWakeCount: 0,
    batteryAtGapStart: { percent: null, onBattery: null },
    cpuSecondsInGap: input.cpuSecondsInGap,
    dutyPercent: input.dutyPercent ?? null,
    beaconWriteFailures: input.beaconWriteFailures,
    clockSuspect: input.clockSuspect ?? false,
  };
}

/**
 * 공백 1건을 사건으로 만든다. **이 함수의 단계 순서가 이 파일의 유일한 설계 결정이다.**
 *
 * ## ★ 왜 `describeMissedSlots()` 를 증거 수집보다 **먼저** 부르는가 (명세 §11 순서와 다름)
 * 명세 §9.3 은 훅을 `startScheduler()` **앞**에 두라고 못박았다. 스케줄러가 기동 즉시
 * `runCatchupSweep("기동")` 을 던지기 때문이다(`scheduler.ts:784`) — 그 스윕이 놓친 슬롯을
 * 보충해 버리면 "무엇이 안 돌았는지"를 **영영 물어볼 수 없게 된다.** 그 창을 지키는 것이
 * 이 기능 전체의 정확도를 결정한다.
 *
 * 그런데 증거 수집은 `pmset -g log` 하나만으로 실측 0.91초가 걸린다. 그걸 먼저 하면 손실
 * 목록을 읽는 시점이 1초 늦어진다. 지금은 그 1초 안에 스케줄러가 돌지 않지만(우리가 그
 * 앞에 있으므로), **T1(틱) 경로에서는 스케줄러가 이미 돌고 있다.** 절전에서 깨어난 직후
 * 30분 틱과 60초 틱이 나란히 발화하면 실제로 경합한다. 그래서 순서를 뒤집었다:
 * **시간에 민감한 읽기(손실 목록)를 먼저 얼리고, 시간에 둔감한 읽기(증거)를 나중에 한다.**
 * 두 경로에 같은 순서를 쓰는 편이 "왜 T2 만 다르지"를 나중에 되짚지 않아도 된다.
 *
 * 대가: 90초 미만 공백에서도 손실 목록을 한 번 읽는다. `describeMissedSlots` 는 부작용 0의
 * 읽기 전용이고 실측 수 ms 라 무해하다 — 고 말하려다, 그건 공짜가 아니라서 아래 Q0 조기
 * 반환을 손실 목록 **앞**에 뒀다. 즉 이 대가는 실제로는 지불하지 않는다.
 */
async function handleGap(input: GapInput): Promise<void> {
  const gapMs = input.gapEndMs - input.gapStartMs;

  // Q0(§3.2) 선반영 — classify 가 어차피 null 을 주지만, 여기서 먼저 걸러야 90초짜리
  // 배포 재기동에 pmset 자식 프로세스를 띄우지 않는다. 판정 결과는 완전히 동일하다.
  if (!Number.isFinite(gapMs) || gapMs < MIN_GAP_MS) return;

  // Q0b(§3.2) 선반영 — 비컨이 없으면(첫 설치/파손) 사건을 만들지 않는다. classify 도 같은
  // 답을 내지만, 그 전에 pmset·손실목록을 읽는 것은 순전한 낭비다.
  if (input.prevBeacon == null || input.prevBeacon.bootEpoch == null) {
    log.info("가동 기록을 시작합니다 — 이전 기록이 없어 이번 구간은 판정하지 않습니다.");
    return;
  }

  // ── 1) 손실 목록 (시간에 민감. 위 주석 참고) ────────────────────────────────
  const missed = await describeMissedSlots(new Date(input.gapStartMs), new Date(input.gapEndMs));

  // ── 2) 증거 → 판정 ─────────────────────────────────────────────────────────
  let evidence: Evidence | null = null;
  try {
    evidence = collectEvidence({
      gapStartMs: input.gapStartMs,
      gapEndMs: input.gapEndMs,
      prevBeacon: input.prevBeacon,
      startedAtMs: processStartedAtMs(),
      beaconWriteFailures: input.beaconWriteFailures,
      cpuSecondsInGap: input.cpuSecondsInGap,
      dutyPercent: input.dutyPercent ?? null,
      // ★ `clockSuspect` 는 T1 만 넘긴다. T2 에서 넘기지 않아야 evidence 가 직전 비컨의
      //    `osUptime` 과 대조해 자체 판단하고, 재부팅이 끼면 자동으로 false 가 된다.
      ...(input.clockSuspect === undefined ? {} : { clockSuspect: input.clockSuspect }),
    });
  } catch (e) {
    log.warn(`가동 중단 증거 수집 실패 — 원인 미상으로 기록합니다: ${(e as Error).message}`);
  }

  let verdict: Verdict | null;
  let frozen: DowntimeEvidence;
  if (evidence) {
    verdict = classify(evidence);
    frozen = freezeEvidence(evidence);
  } else {
    // §9.3 그대로 — 증거를 못 모았으면 `unknown/불명`. **전원이 나갔다고 단정하지 않는다.**
    verdict = { cause: "unknown", confidence: "불명", gapExact: false };
    frozen = fallbackEvidence(input);
  }
  if (!verdict) return; // classify 가 사건 아님이라고 답했다(Q0/Q0b). 원장에도 넣지 않는다.

  // ── 3) 원장 + 일지 ─────────────────────────────────────────────────────────
  const recorded = recordDowntimeEvent(
    {
      source: input.source,
      verdict,
      gapStartMs: input.gapStartMs,
      gapEndMs: input.gapEndMs,
      evidence: frozen,
      sleepWindows: evidence?.sleepWindows,
      missed,
      // 놓친 게 없으면 보충할 것도 없다. `복구중` 으로 두면 재평가 타이머 3개가 아무 일도
      // 하지 않으려고 45분간 살아 있게 된다. (문구는 `narrateRecoveryLine` 이 손실 0건일 때
      // recoveryState 와 무관하게 "정상입니다"로 접으므로 표시에는 영향이 없다.)
      recoveryState: countEvaluatedMissed(missed) === 0 ? "복구완료" : "복구중",
    },
    narrator
  );
  if (!recorded) return; // store 의 마지막 문지기에 걸렸다(gapMs 재검증).

  const { event, merged } = recorded;

  // ── 4) ★ stdout 병기 (§6.2) — 이 기능에서 가장 값싸고 가장 중요한 산출물 ───────
  //
  // ⚠️ 병합된 파편에는 다시 찍지 않는다. 원장은 1건으로 합치는데 여기서만 매번 찍으면
  //    같은 4줄 블록이 파편 수만큼 쌓인다 — §3.6 이 상정한 DarkWake 20조각이면 20번이다.
  //    이 기능은 로그 소음을 줄이려고 만든 것인데 스스로 소음을 만들게 된다
  //    (2026-08-02 적대적 검증에서 3시간 사건 + 5분 파편에 두 번 찍히는 것을 실측).
  if (!merged) emitStdout(event);

  // ── 5) 알림(§7) · 재평가(§8.5) ─────────────────────────────────────────────
  await notifyOne(event);
  if (!merged) scheduleReevaluations(event.id);
}

/**
 * §6.2 `logs/stdout.log` 병기.
 *
 * ★ 이 줄이 붙는 곳이 정확히 "Codex 응답 시간 초과(3600s)" 바로 옆이다. 2026-08-02 사고에서
 *   사용자와 조사 에이전트 3명이 반사적으로 연 곳이 거기였고, 거기에 절전을 알리는 줄이
 *   한 줄만 있었으면 오진도 조사 에이전트 3개도 없었다.
 *
 * `narrateStdout()` 이 이미 `level` 을 정해서 준다(§3.5 손실 게이트: `무시` 는 `info`).
 * `log.ts` 가 `[ISO] ⚠️` 접두사를 붙이므로 여기서는 텍스트를 **그대로** 넘긴다.
 */
function emitStdout(event: DowntimeEvent): void {
  try {
    const out = narrateStdout(event, JOURNAL_PATH);
    if (out.level === "warn") log.warn(out.text);
    else log.info(out.text);
  } catch (e) {
    // 문구가 실패해도 사건은 이미 원장·일지에 남아 있다. 최소한의 사실만이라도 남긴다.
    log.warn(
      `가동 공백 ${event.gapMinutes}분 (${event.cause}/${event.severity}) — ` +
        `문구 생성 실패(${(e as Error).message}). 자세히: ${JOURNAL_PATH}`
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 3. 알림 (§7) — 발송은 notify.ts, **저장은 이 파일**
// ────────────────────────────────────────────────────────────────────────────

/**
 * `notify.ts` 는 원장을 쓰지 않는다(`store → notify → store` 순환 임포트를 피하려고 일부러
 * 그렇게 뒀다). 대신 `ev.notified` 를 제자리 갱신하고 `changed` 로 신호한다 — **그 신호를
 * 받아 디스크에 남기는 것이 이 함수의 존재 이유다.**
 *
 * 저장하지 않으면 조용시간 보류표(`queuedUntil`)가 디스크에 남지 않아, 재기동 한 번으로
 * "새벽 3시에 깨어나 07:00 에 보내기로 한" 약속 자체가 증발한다.
 */
async function notifyOne(event: DowntimeEvent): Promise<void> {
  try {
    const r = await notifyDowntimeEvent(event);
    if (r.changed) markDowntimeNotified(event.id, event.notified, narrator);
    // 아직 못 보낸 사건이 남았으면 60초 스윕을 켠다(조용시간 해제·복구 유예 만료 대기).
    if (r.outcome === "queued" || r.outcome === "waiting") armNotifySweep();
  } catch (e) {
    log.error(`가동 중단 알림 처리 실패 (사건 ${event.id}): ${(e as Error).message}`);
  }
}

/**
 * 보류된 알림을 풀어 주는 60초 스윕.
 *
 * ## 왜 `setTimeout(다음 07:00)` 이 아니라 반복 스윕인가 (notify.ts 의 요구 사항)
 * 조용시간 보류의 전형적인 시나리오가 "10시간 자다가 새벽 3시에 잠깐 깨어남" 이다. 그런데
 * **타이머는 절전 중에 발화하지 않는다** — 이 기능이 존재하는 이유가 바로 그 사실이다(§1).
 * 07:00 을 겨냥한 타이머는 정확히 필요한 상황에서 늦게 깨어난다. 주기 스윕은 깨어난 직후
 * 첫 틱에서 조용시간이 끝났는지 다시 물어보므로 그 함정에 빠지지 않는다.
 *
 * ## 평시 비용 0 — 필요할 때만 타이머를 켠다
 * 보낼 것이 없으면 인터벌 자체를 **끈다.** 무사고 상태에서 원장 파일(≤150KB)을 1분마다
 * 읽는 것은 아무것도 사지 못하는 비용이다. 다시 필요해지면 `armNotifySweep()` 이 켠다.
 */
let notifySweepTimer: ReturnType<typeof setInterval> | null = null;

function armNotifySweep(): void {
  if (notifySweepTimer !== null) return;
  notifySweepTimer = setInterval(() => void queue(runNotifySweep), 60_000);
  // 진단용 타이머가 프로세스 종료를 가로막는 순간, 이 기능은 자기가 진단하려던 것보다 큰
  // 사고가 된다(`beacon.ts` 가 같은 이유로 같은 처리를 한다).
  notifySweepTimer.unref?.();
}

function disarmNotifySweep(): void {
  if (notifySweepTimer === null) return;
  clearInterval(notifySweepTimer);
  notifySweepTimer = null;
}

async function runNotifySweep(): Promise<void> {
  // 설정 자체가 없으면 아무리 돌려도 보낼 수 없다. 스윕을 끄고 조용히 물러난다
  // (일지·stdout·원장에는 이미 남아 있으므로 기록 요구는 배신하지 않는다).
  if (!isIMessageConfigured()) {
    disarmNotifySweep();
    return;
  }
  const pending = listDowntimeEvents().filter(
    (e) => e.severity === "사고" && !e.notified.imessage && e.ackedAt == null
  );
  if (pending.length === 0) {
    disarmNotifySweep();
    return;
  }
  for (const ev of pending) {
    const r = await notifyDowntimeEvent(ev);
    if (r.changed) markDowntimeNotified(ev.id, ev.notified, narrator);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 4. 재평가 (§8.5) — 스케줄러를 건드리지 않고 복구를 추적한다
// ────────────────────────────────────────────────────────────────────────────

/**
 * 이미 재평가 사슬이 걸려 있는 사건 id.
 *
 * 병합(§3.6)이 있어서 필요하다. DarkWake 파편화로 같은 사건에 조각이 20번 들어오면 타이머가
 * 60개 걸린다. `recordDowntimeEvent()` 가 `merged` 를 돌려주므로 새 사건일 때만 거는 것이
 * 1차 방어이고, 이 Set 은 재기동 없이 같은 id 가 다시 새 사건으로 잡히는 경우까지 막는다.
 */
const reevalArmed = new Set<string>();

/**
 * 사건 직후 `+5분 / +15분 / +45분` 에 손실 목록을 다시 물어 복구를 추적한다(§8.5).
 *
 * ★ `runCatchupSweep` 에 훅을 걸지 않는다 — `scheduler.ts → uptime/store → uptime/missed →
 *   scheduler.ts` 순환 임포트가 생기기 때문이다(명세 §8.5). 스케줄러는 자기 일을 하고,
 *   우리는 결과만 다시 읽는다. 이 방향이면 스케줄러 쪽에 변경이 0줄이다.
 *
 * 타이머는 절전 중 발화하지 않고 깨어날 때 몰아서 늦게 터진다. 그건 여기서는 **문제가 아니다** —
 * 재평가는 "지금 보충됐는가"를 묻는 것이라 늦게 물어도 답이 더 정확해질 뿐이다.
 */
function scheduleReevaluations(eventId: string): void {
  if (reevalArmed.has(eventId)) return;
  reevalArmed.add(eventId);
  REEVAL_DELAYS_MS.forEach((delay, i) => {
    const round = i + 1;
    const t = setTimeout(() => {
      void queue(() => reevaluate(eventId, round));
    }, delay);
    t.unref?.();
  });
}

/** `missed` 항목의 동일성 키. store.ts 의 `missedKey` 와 같은 규칙이다(같은 탭·날짜·슬롯). */
const missedKey = (m: MissedSlot): string => `${m.tab}|${m.date}|${m.slot}`;

/**
 * §8.5 확정 규칙. **순수 함수가 아니라서** `shared/uptime.ts` 에 두지 않았다(그쪽 담당자가
 * 같은 이유로 `recoveryStateFor()` 를 일부러 비워 뒀다) — 판정이 `round`(시간 축)에 얽혀 있다.
 *
 * 마지막 회차 전에는 아직 보충 중일 수 있으므로 `복구중` 을 유지하고, 3회를 다 쓰고도 남아
 * 있으면 그때 `일부복구`/`복구없음` 으로 확정한다. 다만 **전부 복구된 순간에는 회차와 무관하게
 * 즉시 `복구완료`** 다 — 그게 §7-6 의 알림 유예를 푸는 두 조건 중 하나이고("재평가 2회차
 * 또는 recoveryState !== 복구중 중 먼저 오는 쪽"), 좋은 소식을 45분 뒤에 보낼 이유가 없다.
 */
function recoveryStateFor(missed: readonly MissedSlot[], round: number): DowntimeRecoveryState {
  const evaluated = missed.filter((m) => m.evaluated);
  if (evaluated.length === 0) return "복구완료"; // 보충할 것이 애초에 없다
  const recovered = evaluated.filter((m) => m.recovered).length;
  if (recovered === evaluated.length) return "복구완료";
  if (round < REEVAL_DELAYS_MS.length) return "복구중";
  return recovered > 0 ? "일부복구" : "복구없음";
}

/**
 * 재평가 1회차.
 *
 * ## 복구 판정 = `1차 목록 − N차 목록` 차집합 (missed.ts 가 요구한 계약)
 * `describeMissedSlots()` 는 `recovered` 를 **언제나 false** 로 돌려준다. 같은 창으로 다시
 * 부르면 보충이 끝난 슬롯은 목록에서 **사라진다.** 그래서 "사라짐 = 복구됨"이다.
 *
 * ## ★ 사라지지 않은 항목의 필드를 새 결과로 덮지 않는다
 * 자정을 넘겨 재평가가 돌면 어제였던 슬롯이 `evaluated: true → false` 로 바뀐다(§8.4 는
 * "오늘 것만 검증 가능"이다). 새 결과로 덮으면 그 순간 `severityFor()` 의 손실 개수가 0이 되어
 * **사건이 `사고` 에서 `무시` 로 강등되고 배너·배지가 사라진다.** 실제로 일어난 손실이
 * 시계가 자정을 넘었다는 이유로 없던 일이 되는 것이라, 1차 판정을 정본으로 유지한다.
 */
async function reevaluate(eventId: string, round: number): Promise<void> {
  const cur = getDowntimeEvent(eventId);
  if (!cur) return;
  if (cur.reevalCount >= round) return; // 이미 지나간(또는 병합으로 승계된) 회차
  if (cur.ackedAt != null) return; // 사용자가 이미 확인했다 — 더 고쳐 쓰지 않는다

  const startMs = Date.parse(cur.gapStart);
  const endMs = Date.parse(cur.gapEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;

  const fresh = await describeMissedSlots(new Date(startMs), new Date(endMs));
  const stillMissing = new Set(fresh.map(missedKey));
  const at = new Date().toISOString();

  const next: MissedSlot[] = cur.missed.map((m) =>
    stillMissing.has(missedKey(m)) || m.recovered
      ? m
      : { ...m, recovered: true, recoveredAt: m.recoveredAt ?? at }
  );
  // 병합으로 창이 넓어져 새 슬롯이 들어온 경우만 추가된다(보통은 0건).
  const known = new Set(cur.missed.map(missedKey));
  for (const f of fresh) if (!known.has(missedKey(f))) next.push(f);

  const state = recoveryStateFor(next, round);
  const patched = patchDowntimeEvent(
    eventId,
    { missed: next, recoveryState: state, reevalCount: round },
    narrator
  );
  if (!patched) return;

  // §7-6 복구 유예가 이 시점에 풀릴 수 있다("재평가 2회차" 또는 "recoveryState !== 복구중").
  // 최종 상태로 1통만 나가게 하려고 사건 생성 직후가 아니라 여기서 다시 태운다.
  await notifyOne(patched);

  if (round >= REEVAL_DELAYS_MS.length) reevalArmed.delete(eventId);
}

// ────────────────────────────────────────────────────────────────────────────
// 5. T2 — 기동 부검
// ────────────────────────────────────────────────────────────────────────────

/**
 * 프로세스가 **재시작된** 구간을 잡는다(재부팅·전원차단·패닉·앱 크래시·배포).
 *
 * 앞 세대 비컨의 `atMs`(마지막 생존)와 지금 사이의 간격이 곧 공백이다. `readPreviousBeacon()`
 * 은 1회성 래치라 `startUptimeBeacon()` 의 첫 쓰기가 파일을 덮기 전에 값을 얼려 두지만,
 * 순서를 지켜 여기서 먼저 부른다(순서가 틀려도 안전하다는 것이 beacon.ts 의 계약이다).
 */
async function bootAutopsy(): Promise<void> {
  const prev = readPreviousBeacon();
  if (!prev) {
    log.info("가동 기록을 시작합니다 — 이전 비컨이 없어 이번 기동은 부검하지 않습니다(§12.1-2).");
    return;
  }
  await handleGap({
    source: "boot",
    gapStartMs: prev.atMs,
    gapEndMs: Date.now(),
    prevBeacon: prev,
    // T1 만 계산할 수 있는 값이다. 프로세스가 바뀌었으므로 우리 `process.cpuUsage()` 는
    // 공백 구간과 아무 관계가 없다 — 0.0% 라고 적으면 그건 거짓말이다(§5.2).
    cpuSecondsInGap: null,
    // 앞 세대가 남긴 누적 실패 횟수. T1 의 현 세대 값과 서로 다른 값이고 그게 의도다.
    beaconWriteFailures: prev.writeFailures,
    // clockSuspect 를 넘기지 않는다 → evidence 가 직전 비컨의 osUptime 과 대조해 자체 판단.
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 6. 공개 진입점
// ────────────────────────────────────────────────────────────────────────────

let started = false;

/**
 * 가동 감시를 켠다 — **`src/index.ts` 가 부르는 유일한 진입점**(§9.3).
 *
 * 순서: 기동 부검(T2) → 사건 생성 → 알림 → 재평가 타이머 → 하트비트(T1) 시작.
 *
 * ## ★ 절대 throw 하지 않는다 + 10초 예산
 * `src/index.ts` 에서 `await` 되므로 여기서 던지거나 늘어지면 **스케줄러가 영영 시작되지
 * 않는다.** 그래서 두 겹으로 막는다:
 * 1. 전체 try/catch — 어떤 실패도 로그 한 줄로 끝난다.
 * 2. 부검을 `UPTIME_STARTUP_BUDGET_MS`(10초)와 경주시킨다. 초과하면 **경고를 남기고 먼저
 *    반환**하며, 부검 자체는 백그라운드에서 계속 진행돼 결국 원장·일지에 남는다.
 *    (`pmset -g log` 는 `execFileSync` 라 중간에 끊을 수 없다. 끊는 대신 기다리지 않는다.)
 *
 * 예산을 넘겨 스케줄러가 먼저 도는 경우 catch-up 스윕이 손실을 보충해 버려 보고가 조용해질
 * 수 있는데, 그건 **`handleGap` 이 손실 목록을 증거보다 먼저 읽는 이유**이기도 하다.
 * 그래도 남는 위험은 §8.3 이 정한 방향(거짓 손실 보고를 내느니 조용한 편이 낫다)과 같다.
 *
 * ## 비컨은 예산과 무관하게 반드시 켠다
 * 부검이 늦어져도 하트비트는 켜져야 한다 — 이번 사고(2026-08-02)를 잡는 것은 T2 가 아니라
 * **T1** 이기 때문이다. 그래서 비컨 시작을 부검 뒤가 아니라 `finally` 성격의 자리에서 부른다.
 */
export async function startUptimeWatch(): Promise<void> {
  if (started) {
    log.warn("가동 감시가 이미 실행 중입니다 — 중복 시작을 무시합니다.");
    return;
  }
  started = true;

  try {
    /**
     * ★ 경로 정합성 점검 — 조용히 틀리는 것을 막는 한 줄.
     *
     * `narrate.ts` 는 **순수 함수라 `config` 를 import 하지 않는다**(그러면 문구 테스트의
     * 임포트 그래프에 dotenv 가 끌려 들어온다). 그래서 문자 본문(§6.3)의 "자세한 기록:"
     * 경로는 저장소 구조에서 역산한 `DEFAULT_JOURNAL_PATH` 이고, 실제 일지는 `config.dbPath`
     * 기준이다. `DB_PATH` 를 바꾼 환경에서만 둘이 갈라진다.
     *
     * 여기서 못 고치는 이유: 본문을 만드는 곳이 `notify.ts` 안이고(`downtimeIMessageText(ev)`
     * 1인자 호출) 그 파일은 내 소유가 아니다. 대신 **갈라졌다는 사실을 로그에 남긴다** —
     * 폰에 도착한 경로가 존재하지 않는 파일을 가리키는 것이 이 기능에서 가장 조용한 실패다.
     */
    if (JOURNAL_PATH !== path.resolve(DEFAULT_JOURNAL_PATH)) {
      log.warn(
        `가동 중단 일지 실제 경로(${JOURNAL_PATH})가 문자 본문의 기본 경로` +
          `(${DEFAULT_JOURNAL_PATH})와 다릅니다 — DB_PATH 를 바꾼 환경입니다. ` +
          "일지·원장은 실제 경로에 정상 기록되며, iMessage 본문의 경로 표기만 기본값을 가리킵니다."
      );
    }

    // ── T2. 기동 부검 (10초 예산과 경주) ───────────────────────────────────
    const autopsy = queue(bootAutopsy);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const budget = new Promise<"budget">((resolve) => {
      timer = setTimeout(() => resolve("budget"), UPTIME_STARTUP_BUDGET_MS);
      timer.unref?.();
    });
    const who = await Promise.race([autopsy.then(() => "done" as const), budget]);
    if (timer) clearTimeout(timer);
    if (who === "budget") {
      log.warn(
        `기동 부검이 ${UPTIME_STARTUP_BUDGET_MS / 1000}초를 넘겨 백그라운드로 넘깁니다 — ` +
          "대시보드와 수집 스케줄은 예정대로 시작합니다."
      );
    }

    // ── 재기동 시 남아 있는 보류 알림 이어받기 ──────────────────────────────
    // 조용시간에 보류된 문자는 `queuedUntil` 로 원장에만 남아 있다. 프로세스가 다시 뜨면
    // 메모리의 스윕 상태는 사라지므로 여기서 한 번 켜 준다(보낼 게 없으면 첫 스윕이 끈다).
    armNotifySweep();

    // ── T1. 하트비트 (주 경로) ─────────────────────────────────────────────
    startUptimeBeacon({
      // 값의 출처는 evidence.ts 다(sysctl 실패 시 명시적으로 null 을 넘긴다 — 빠뜨림이 아니라
      // 정보라는 것이 beacon.ts 가 이 인자를 필수로 만든 이유다).
      bootEpoch: getBootEpoch().epoch,
      onGap: (gap: BeaconGap) => {
        void queue(() =>
          handleGap({
            source: gap.source,
            gapStartMs: gap.gapStartMs,
            gapEndMs: gap.gapEndMs,
            prevBeacon: gap.prev,
            cpuSecondsInGap: gap.cpuSecondsInGap,
            dutyPercent: gap.dutyPercent,
            clockSuspect: gap.clockSuspect,
            // ★ T1 은 **현 세대의 인메모리 값**을 쓴다. T2 의 `prev.writeFailures`(앞 세대
            //   값)와 서로 다른 값이고, 그게 beacon.ts 가 못박은 의도다.
            beaconWriteFailures: gap.writeFailures,
          })
        );
      },
    });
  } catch (e) {
    // ★ 여기서 던지면 서비스 기동이 막힌다(§9.3). 어떤 경우에도 삼킨다.
    log.error(`가동 감시 시작 실패 — 이 기능 없이 계속 진행합니다: ${(e as Error).message}`);
  }
}

/**
 * 대시보드가 한 번에 받아 가는 상태(§5.4). P1 의 `GET /api/downtime` 이 이 함수를 그대로 쓴다.
 *
 * `store.getDowntimeView()` 를 감싸는 이유는 **API 라우트가 500 을 내지 않게** 하기 위해서다.
 * 원장 JSON 이 깨져 있을 때 사후 보고 화면 하나 때문에 대시보드 전체가 무너지면, 이 기능은
 * 자기가 진단하려던 것보다 큰 사고가 된다. 빈 뷰는 "보여줄 사건이 없다"와 같은 뜻이고,
 * 원장이 깨진 사실 자체는 store 가 `.broken` 파일 + 경고 로그로 이미 남긴다.
 *
 * @returns `{ current: DowntimeEvent | null; unackedCount: number }`
 *          - `current`      = 배너 1건(미확인 `사고` 중 최신). 없으면 `null`.
 *          - `unackedCount` = 헤더 배지 숫자(미확인 `사고` + `기록만`. `무시` 는 세지 않는다).
 */
export function getDowntimeView(): DowntimeView {
  try {
    return loadDowntimeView();
  } catch (e) {
    log.warn(`가동 중단 상태 조회 실패 — 빈 화면으로 응답합니다: ${(e as Error).message}`);
    return { current: null, unackedCount: 0 };
  }
}
