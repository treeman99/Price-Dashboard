import cron from "node-cron";
import { AsyncLocalStorage } from "node:async_hooks";
import { parseCollectTime } from "../config.ts";
import { getSchedule } from "./schedule-store.ts";
import { log } from "../util/log.ts";
import { withWakeLock } from "../util/power.ts";
import { pruneOldData } from "../db/repo.ts";
import {
  refreshEvents,
  getEventsSnapshot,
  getEventsLastAttempt,
  isEventsCollecting,
} from "../events/events.ts";
import { refreshNews, getNewsSnapshot, getNewsLastAttempt, isNewsCollecting } from "../news/news.ts";
import {
  refreshYoutube,
  getYoutubeSnapshot,
  getYoutubeLastAttempt,
  isYoutubeCollecting,
} from "../youtube/youtube.ts";
import { refreshStock, snapshotForSlot, isStockCollecting } from "../stock/stock.ts";
import { runPulse, flushPulseQueue } from "../stock/pulse.ts";
import { isQuietHour } from "../stock/pulse-gate.ts";
import { config } from "../config.ts";
import { describeSlotRoles } from "../stock/slot-role.ts";
import { slotHandled, slotNeedsCatchup } from "../stock/notify-ledger.ts";
import { localDate } from "../util/date.ts";
import {
  LOTTO_CYCLE_CRON,
  LOTTO_CYCLE_LABEL,
  catchUpWeeklyCycle,
  isCycleRunning,
  runWeeklyCycle,
  shouldRunCycle,
} from "../lotto/cycle.ts";
import { getLottoState, getUpcoming } from "../lotto/store.ts";
import type { StockMarket } from "../../shared/types.ts";

function today(): string {
  return localDate();
}

/** 보존 정책 실행 시각. 어느 탭 수집과도 겹치지 않는 새벽으로 둔다. */
const RETENTION_LABEL = "04:30";
const RETENTION_CRON = "30 4 * * *";

/** 보존 정책 1회. DB 오류가 스케줄러를 죽이지 않게 감싼다. */
function safePruneOldData() {
  try {
    const pruned = pruneOldData(config.historyRetentionDays);
    if (pruned > 0) log.info(`보존 정책: 오래된 증시 시계열 ${pruned}개 삭제`);
  } catch (e) {
    log.error(`보존 정책 실행 오류: ${(e as Error).message}`);
  }
}

/** 지금 시각이 주어진 예정 시각(HH:mm)을 지났는지 */
function pastTime(hhmm: string): boolean {
  const { hour, minute } = parseCollectTime(hhmm);
  const now = new Date();
  return now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
}

/** 로그용 소요 시간 표기. 초 단위 반올림 — 스케줄러 로그에 ms 정밀도는 소음이다. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}초`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}분` : `${m}분 ${s}초`;
}

// ── LLM 큐레이션 전역 세마포어 (동시 1) ──────────────────────────────────────
//
// 2026-08-02 사고: 맥이 10시간 45분 잠든 뒤 깨어나자, 누락 감지 catch-up 6종이 전부 `void` 로
// **동시 발사**돼 LLM 세션 3개가 겹쳤다. 탭별 running 불리언은 *같은 탭의* 중복만 막을 뿐,
// 뉴스·유튜브·이벤트가 나란히 도는 것은 아무것도 막지 않았다.
//
// 동시성이 그 사고의 주원인은 아니었다 — 뉴스는 32분을 **단독으로** 돌고도 실패했다. 하지만
// 확실한 증폭기였다: 같은 CPU·같은 네트워크·같은 모델 한도를 셋이 나눠 쓰면 각자가 느려지고,
// 느려지면 타임아웃에 걸리고, 타임아웃에 걸리면 다음 틱에 셋이 **다시 동시에** 재시도한다.
//
// 그래서 **LLM 을 길게 쓰는 작업만** 전역 동시 1개로 직렬화한다.
//   대상 : 뉴스 · 유튜브 · 팝업/전시 · 증시 브리핑 · 로또 주간 사이클
//   제외 : 증시 펄스(매시간 도는 10분짜리다 — 앞의 20분 작업에 막히면 그 슬롯이 통째로 죽는다.
//          직렬화가 오히려 해롭다), 보류 큐 플러시·보존 정책 같은 비-LLM 작업, 순수 HTTP 수집.
//
// ⚠️ **큐 대기 시간은 타임아웃 예산을 먹지 않는다.** 타임아웃 시계는 큐레이터 안에서
// runAgentQueryText 가 켜고(src/util/agent-query.ts), 그 호출은 여기서 슬롯을 얻은 **뒤에야**
// 일어난다 — 대기 30분 + 실행 20분이면 타임아웃 판정에 쓰이는 값은 20분뿐이다. 이 순서가 이
// 설계의 핵심이라, 스케줄러 레벨에서 작업 전체를 Promise.race 로 감싸는 식의 리팩터링을 하면
// "큐에서 기다리다 타임아웃 나는 작업"이 조용히 생긴다. 타임아웃은 반드시 큐 **안쪽**에 둘 것.

/** 큐의 꼬리. 각 대기자는 이 프라미스를 기다리고, 자기 완료 프라미스를 새 꼬리로 잇는다. */
let llmQueueTail: Promise<void> = Promise.resolve();
/**
 * 줄에 있는 작업 수(실행 중 1건 + 대기 중 전부). 로그 전용.
 *
 * ⚠️ 이 카운터를 쓰는 이유: 사고 재현처럼 여러 작업이 **같은 틱에** 출발하면 그 순간
 * llmCurrent 는 아직 null 이다(첫 작업조차 마이크로태스크 뒤에야 시작한다). llmCurrent 만
 * 보고 "대기 시작" 로그를 남기면, 정작 겹침이 가장 심한 순간에 로그가 한 줄도 안 남는다.
 */
let llmPending = 0;
/** 지금 슬롯을 쥔 작업. "느린 건지 대기 중인지"를 로그만 보고 구분하기 위한 정보다. */
let llmCurrent: { label: string; since: number } | null = null;

/**
 * 재진입 감지용 컨텍스트.
 *
 * 슬롯을 쥔 비동기 흐름 안에서 같은 슬롯을 또 잡으면 **자기 자신의 완료를 기다리게 되어 영구
 * 교착**이다 — 그 순간 스케줄러의 모든 LLM 작업이 조용히 멈춘다(재시작 전까지 복구 불가).
 * 실제로 위험한 경로가 있다: `catchUpWeeklyCycle()` 이 내부에서 `runWeeklyCycle()` 을 부른다.
 * 지금은 스케줄러 래퍼 두 곳 중 **한 곳에서만** 슬롯을 잡아 안전하지만, 나중에 누가 안쪽
 * 함수에도 슬롯을 붙이면 그날로 교착이다. AsyncLocalStorage 로 보유 여부를 들고 다니며
 * 재진입이면 큐를 건너뛰게 해, 최악이 "직렬화 한 겹 약해짐"에 그치도록 만든다.
 */
const llmSlotHolder = new AsyncLocalStorage<string>();

// ── 큐 대기 상한 ───────────────────────────────────────────────────────────
//
// 2026-08-02 후속: 직렬화만 넣고 **대기에 상한을 두지 않은 것**이 두 번째 사고였다.
// 무제한 대기는 "느린 작업 1건"을 "스케줄러 전체 동결"로 승격시킨다 — 08:30 누락 점검 스윕이
// 앞선 정시 런들의 뒤에 줄을 서면, 스윕이 끝날 때까지 30분 틱이 6회 연속 스킵된다.
//
// 상한을 넘긴 작업은 **이번 차례를 포기**하고 조용히 빠진다. 잃는 것이 없기 때문이다:
//   - 정시 런이 포기해도 그 슬롯은 누락 점검(catch-up)이 그대로 다시 잡는다(게이트는 스냅샷·
//     원장 기반이라 '실행했는가'가 아니라 '결과가 있는가'를 본다).
//   - catch-up 런이 포기해도 다음 30분 틱이 같은 판정을 다시 한다.
// 그래서 포기는 **실패가 아니다** — 백오프에 집계하지 않는다(아래 TabRunOutcome 참고).
//
// 값의 근거:
//   - 정시 런 45분: 탭 1건의 최악 실행 시간(타임아웃 20분 + 폴백 예산 20분)보다 조금 길다.
//     앞 작업 하나는 끝까지 기다려 주되, 두 건이 밀린 상황에서는 catch-up 에 넘긴다.
//   - catch-up 런 10분: 스윕은 어차피 30분마다 다시 온다. 10분 넘게 못 들어갔다면 큐가 막힌
//     것이고, 그 자리에서 더 기다려 봐야 스윕만 얼어붙는다.
const LLM_QUEUE_WAIT_SCHEDULED_MS = 45 * 60 * 1000;
const LLM_QUEUE_WAIT_CATCHUP_MS = 10 * 60 * 1000;

/**
 * 누락 점검 스윕 1회의 컨텍스트. **스윕 안에서 시작된 LLM 작업만** 짧은 대기 상한을 쓰도록
 * AsyncLocalStorage 로 흘려보낸다(정시 cron 콜백은 이 컨텍스트 밖이라 자동으로 45분을 쓴다).
 *
 * 인자로 넘기지 않는 이유: 상한을 쓰는 지점이 checkXCatchup → safeRefreshX → runLlmJob 로 세 겹
 * 아래라, 여섯 갈래 시그니처를 전부 오염시켜야 한다. 재진입 가드가 이미 같은 방식이라 패턴도
 * 일치한다.
 */
interface SweepContext {
  /** 이 스윕에서 큐 대기 상한을 초과한 작업이 있었는가. 있으면 남은 단계를 중단한다. */
  gaveUp: boolean;
}
const sweepContext = new AsyncLocalStorage<SweepContext>();

/** 이번 호출에 허용할 큐 대기 상한. 스윕 안이면 짧게, 정시 런이면 길게. */
function llmQueueWaitMs(): number {
  return sweepContext.getStore() ? LLM_QUEUE_WAIT_CATCHUP_MS : LLM_QUEUE_WAIT_SCHEDULED_MS;
}

/** LLM 작업 1건의 결말. `ran: false` 는 **큐 대기 상한 초과**뿐이다(실행 중 실패는 예외로 나간다). */
type LlmJobResult<T> = { ran: true; value: T } | { ran: false; waited: number };

/**
 * 내 차례를 기다리되 상한을 둔다. 상한을 넘기면 false.
 *
 * ⚠️ 여기서 false 로 빠져나가도 **큐 꼬리는 멀쩡해야 한다**. 꼬리는 이미
 * `myTurn.then(() => held)` 로 연장돼 있으므로, 호출부가 finally 에서 release()(= held 해소)를
 * 부르면 앞 작업이 끝나는 즉시 뒷사람이 이어받는다. 이 불변식이 깨지면 큐가 영구히 막힌다.
 */
function waitForTurn(turn: Promise<void>, maxWaitMs: number): Promise<boolean> {
  if (!Number.isFinite(maxWaitMs)) return turn.then(() => true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, maxWaitMs));
    // 대기 타이머가 이벤트 루프를 붙잡아 프로세스 종료를 막지 않게 한다.
    timer.unref?.();
    void turn.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
    // ⚠️ 상한이 0 이하여도 **큐가 비어 있으면 즉시 실행된다** — 이미 해소된 turn 의 .then 은
    // 마이크로태스크라 setTimeout(0)(매크로태스크)보다 항상 먼저 돈다. "할 일은 있는데 예산이
    // 0 이라 못 돈다"는 상황을 만들지 않기 위한 순서다.
  });
}

/**
 * LLM 장시간 작업 1건 실행: **큐 통과 → 전원 어서션 → 본작업** 순.
 *
 * ⚠️ 순서가 중요하다. 어서션(caffeinate)을 큐 대기 중에 잡으면, 아무 일도 하지 않고 줄만 서 있는
 * 작업 때문에 맥이 깨어 있게 된다 — 최악의 경우 대기 3건이 각자 어서션을 들고 밤새 시스템을
 * 붙잡는다. 반드시 슬롯을 얻은 뒤 잡고, 끝나면(성공·실패·예외 무관) 놓는다.
 * 놓는 책임은 withWakeLock 안의 finally 에 있다(src/util/power.ts).
 */
async function runLlmJob<T>(
  label: string,
  fn: () => Promise<T>,
  maxWaitMs: number = llmQueueWaitMs()
): Promise<LlmJobResult<T>> {
  const holder = llmSlotHolder.getStore();
  if (holder) {
    log.warn(`LLM 슬롯 재진입 [${label}] (보유: ${holder}) — 교착 방지를 위해 큐를 건너뜁니다`);
    // 어서션은 참조 카운트라 바깥 보유분 위에 한 겹 더 쌓여도 무해하다(균형만 맞으면 된다).
    return { ran: true, value: await withWakeLock(label, fn) };
  }

  // 큐에 줄을 선다. release 를 부르기 전까지 뒤 작업은 시작하지 못한다.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const myTurn = llmQueueTail;
  llmQueueTail = llmQueueTail.then(() => held);

  const queuedAt = Date.now();
  const ahead = llmPending; // 내 앞에 몇 건이 줄에 있는가(실행 중 1건 포함)
  llmPending += 1;
  if (ahead > 0) {
    const running = llmCurrent
      ? `실행 중: ${llmCurrent.label}, ${formatDuration(queuedAt - llmCurrent.since)}째`
      : "앞 작업이 아직 시작 전";
    const cap = Number.isFinite(maxWaitMs) ? formatDuration(maxWaitMs) : "무제한";
    log.info(`LLM 큐 대기 시작 [${label}] — 앞에 ${ahead}건 (${running}), 대기 상한 ${cap}`);
  }
  // ⚠️ 바깥 try/finally 는 **release 를 반드시 부르기 위한 것**이다. 어떤 경로로든 여기를
  // 빠져나가면서 release 를 빠뜨리면 큐 꼬리가 영원히 풀리지 않아, 이후 모든 LLM 수집이
  // 조용히 멈춘다(재시작 전까지 복구 불가). 큐 자체보다 이 한 줄이 더 위험한 코드다.
  try {
    if (!(await waitForTurn(myTurn, maxWaitMs))) {
      const waited = Date.now() - queuedAt;
      const sweepCtx = sweepContext.getStore();
      if (sweepCtx) sweepCtx.gaveUp = true; // 스윕은 이 신호를 보고 남은 단계를 다음 틱에 넘긴다
      log.warn(
        `LLM 큐 대기 상한 초과 [${label}] — ${formatDuration(waited)} 기다렸으나 슬롯을 얻지 못해 ` +
          `이번 차례를 포기합니다(실패 아님 · 다음 누락 점검에서 재시도).`
      );
      return { ran: false, waited };
    }

    const waited = Date.now() - queuedAt;
    const startedAt = Date.now();
    llmCurrent = { label, since: startedAt };
    // 줄을 섰던 작업은 대기가 0초여도 남긴다 — "대기 시작"과 짝이 맞아야 로그만 보고 큐 흐름을
    // 되짚을 수 있다. 큐가 비어 있던 작업은 조용히 시작한다(정상 경로의 소음 제거).
    if (ahead > 0) log.info(`LLM 큐 통과 [${label}] — ${formatDuration(waited)} 대기 후 시작`);
    try {
      // 전원 어서션은 **큐를 통과한 뒤에만** 잡는다(위 주석). 재진입 가드용 컨텍스트도 여기서 연다.
      const value = await llmSlotHolder.run(label, () => withWakeLock(label, fn));
      return { ran: true, value };
    } finally {
      llmCurrent = null;
      const ran = Date.now() - startedAt;
      const left = llmPending - 1; // 아직 자기 자신이 포함돼 있다(감소는 바깥 finally)
      log.info(
        `LLM 슬롯 반납 [${label}] — 실행 ${formatDuration(ran)}` +
          (ahead > 0 ? ` (대기 ${formatDuration(waited)})` : "") +
          (left > 0 ? `, 대기 ${left}건 남음` : "")
      );
    }
  } finally {
    llmPending -= 1;
    release();
  }
}

/**
 * LLM 전역 슬롯을 잡고 fn 을 실행한다. 대기 시간은 fn 의 타임아웃 예산에 포함되지 않는다.
 *
 * 스케줄러 **밖**(수동 '지금 갱신' 라우트 등)에서 쓰는 공개 진입점이다. 이 경로로만 들어오면
 * ①전역 동시 1개 직렬화 ②큐 통과 후 전원 어서션 ③재진입 교착 회피가 한꺼번에 보장된다.
 * 라우트가 refreshX 를 직접 부르면 셋 다 우회돼 LLM 세션이 겹친다(2026-08-02 실측).
 *
 * ⚠️ 스케줄러 내부 런과 달리 **대기 상한이 없다**. 사용자가 버튼을 누른 요청은 "지금은 바쁘니
 * 다음에"로 조용히 사라지면 안 되고, 포기 사실을 알려 줄 반환 통로도 이 시그니처에는 없다.
 * 상한이 필요한 자동 런은 내부 runLlmJob 을 쓴다.
 */
export async function withLlmSlot<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const result = await runLlmJob(label, fn, Number.POSITIVE_INFINITY);
  // 무제한 대기라 포기 경로가 없다. 타입을 좁히기 위한 가드이자, 위 불변식이 깨지면 조용히
  // undefined 를 흘리는 대신 시끄럽게 터지도록 하는 방어선이다.
  if (!result.ran) throw new Error(`LLM 슬롯 획득 실패 [${label}] — 무제한 대기에서는 불가능한 경로`);
  return result.value;
}

// ── catch-up 재시도 백오프 (뉴스 · 유튜브 · 팝업/전시 공용) ────────────────────
//
// 수집이 실패하면 그 슬롯의 catch-up 조건은 계속 참이라 30분마다 무한 재시도가 돈다. 큐레이션
// 1회가 최대 20분짜리 LLM 작업이라, 실패가 이어지면 하루 종일 같은 실패를 반복하며 시간·비용만
// 태운다(실측: 유튜브가 반나절 동안 8회). 연속 실패마다 다음 catch-up 을 미뤄 간격을 벌린다.
//
// 정시 cron 과 수동 '지금 갱신'은 이 게이트를 타지 않는다 — 사용자가 직접 누른 갱신까지 막으면
// 그게 진짜 먹통이다.
//
// ⚠️ 알려진 약점: 상태가 **메모리에만** 있어 launchd 재시작으로 리셋된다. 서비스가 자주 죽는
// 상황에서는 백오프가 사실상 꺼진 것과 같다. 디스크 영속화는 후속 과제로 남긴다(재시작 자체가
// 드물고, 리셋의 최악값이 '한 번 더 시도'라 지금은 감수할 만하다).
const CATCHUP_BACKOFF_BASE_MS = 30 * 60 * 1000;
const CATCHUP_BACKOFF_MAX_MS = 4 * 60 * 60 * 1000;

/** 연속 실패 n회째의 대기 시간. 30 → 60 → 120 → 240분(상한). */
function backoffWaitMs(failStreak: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** (Math.max(1, failStreak) - 1), maxMs);
}

interface Backoff {
  /** 연속 실패로 대기 중이면 true(= 이번 catch-up 을 건너뛴다). */
  blocked(): boolean;
  /** 이번 시도의 성패를 반영. 성공이면 즉시 해제, 실패면 다음 시도를 지수적으로 미룬다. */
  note(ok: boolean): void;
}

function createBackoff(label: string, baseMs: number, maxMs: number): Backoff {
  let failStreak = 0;
  let retryAfter = 0; // epoch ms. 이 시각 전에는 catch-up 을 건너뛴다.
  return {
    blocked: () => Date.now() < retryAfter,
    note(ok: boolean) {
      if (ok) {
        if (failStreak > 0) log.info(`${label} 수집 정상화 — catch-up 백오프 해제`);
        failStreak = 0;
        retryAfter = 0;
        return;
      }
      failStreak += 1;
      const wait = backoffWaitMs(failStreak, baseMs, maxMs);
      retryAfter = Date.now() + wait;
      log.warn(
        `${label} 수집 연속 실패 ${failStreak}회 → catch-up 재시도를 ${Math.round(wait / 60000)}분 뒤로 미룸`
      );
    },
  };
}

// ── '건너뜀'과 '실패'의 구분 ─────────────────────────────────────────────────
//
// ⚠️ 이 구분이 없으면 백오프가 **아무 일도 하지 않은 런**을 실패로 집계한다. 실제로 걸린 함정:
// 수동 '지금 갱신'이 도는 중에 정시/catch-up 런이 큐를 통과하면, 수집 모듈 안쪽의 중복 방지
// 가드(news.ts `running` 등)에 막혀 **시도 기록을 남기지 않고** 곧바로 돌아온다. 그런데 성패
// 판정은 `attemptSucceededSince(getXLastAttempt(), runStartedAt)` — 런 시작 이후 기록이 없으니
// 무조건 false → 멀쩡한 탭에 30분 백오프가 걸린다. 유튜브는 이 직렬화 도입 전에는 없던 회귀다.
//
// 그래서 결말을 세 갈래로 나누고, **시도한 런만** 백오프에 넘긴다.
type TabRunOutcome =
  /** 수집 함수를 실제로 불렀다(성패는 시도 기록이 말한다). */
  | "attempted"
  /** 다른 런(수동 갱신 등)이 이미 돌고 있어 아무것도 하지 않았다. */
  | "skipped-duplicate"
  /** 큐 대기 상한을 넘겨 이번 차례를 포기했다. */
  | "skipped-queue";

/** 백오프에 집계할 결말인가. 건너뜀은 실패가 아니다. */
function shouldNoteBackoff(outcome: TabRunOutcome): boolean {
  return outcome === "attempted";
}

/**
 * 결말에 따라 백오프를 갱신한다. 건너뜀이면 손대지 않는다(카운터 증가도, 해제도 없다).
 * `ok` 는 게으르게 받는다 — 건너뛴 런에서는 성패 판정 자체를 하지 않아야 하기 때문이다.
 */
function noteTabOutcome(label: string, backoff: Backoff, outcome: TabRunOutcome, ok: () => boolean) {
  if (!shouldNoteBackoff(outcome)) {
    log.info(`${label} — 실행하지 않고 건너뜀(${outcome}) · 백오프 집계 대상 아님`);
    return;
  }
  backoff.note(ok());
}

// ── catch-up 게이트 판정(순수 함수) ──────────────────────────────────────────
//
// 뉴스·유튜브·팝업/전시가 같은 모양이라 한 곳으로 모았다. 순수 함수로 떼어 둔 이유는 하나다:
// **백오프가 catch-up 에만 걸린다**는 성질(정시 cron 과 수동 갱신은 이 함수를 아예 타지 않는다)을
// 테스트로 못박기 위해서다. 그 성질이 깨지면 사용자가 버튼을 눌러도 먹통이 된다.
type CatchupDecision =
  | { run: false; reason: "running" | "backoff" | "covered" }
  | { run: true; slot: string };

function decideCatchup(input: {
  /** 같은 탭의 런이 이미 진행 중인가 */
  running: boolean;
  /** 연속 실패 백오프로 대기 중인가 */
  blocked: boolean;
  /** 오늘 예정된 시각들 */
  slots: string[];
  /** 그 시각이 이미 지났는가 */
  past: (t: string) => boolean;
  /** 그 시각이 정상 결과물로 커버돼 있는가 */
  covered: (t: string) => boolean;
}): CatchupDecision {
  if (input.running) return { run: false, reason: "running" };
  if (input.blocked) return { run: false, reason: "backoff" };
  for (const t of input.slots) {
    if (!input.past(t)) continue;
    if (input.covered(t)) continue;
    return { run: true, slot: t };
  }
  return { run: false, reason: "covered" };
}

const eventsBackoff = createBackoff("팝업/전시", CATCHUP_BACKOFF_BASE_MS, CATCHUP_BACKOFF_MAX_MS);
const newsBackoff = createBackoff("뉴스", CATCHUP_BACKOFF_BASE_MS, CATCHUP_BACKOFF_MAX_MS);
const youtubeBackoff = createBackoff("유튜브", CATCHUP_BACKOFF_BASE_MS, CATCHUP_BACKOFF_MAX_MS);

/** 시도 기록(ISO 문자열)이 오늘 것인지. 어제 성공은 오늘의 커버가 아니다. */
function attemptIsToday(at: string | undefined): boolean {
  if (!at) return false;
  const d = new Date(at);
  return !Number.isNaN(d.getTime()) && localDate(d) === today();
}

/** 기록 시각과 런 시작 시각 사이의 밀리초 단위 오차를 흡수하는 여유. */
const ATTEMPT_CLOCK_SLACK_MS = 1000;

/**
 * **이번 런이** 성공했는지. `since` 는 런을 시작하며 찍은 epoch ms.
 *
 * ⚠️ 시도 기록은 디스크에 남는다(news.ts / events.ts). 그래서 `getXLastAttempt()?.ok` 를 그대로
 * 믿으면, 이번 런이 기록을 남기지 못하고 죽었을 때 **어제(혹은 오늘 아침)의 성공**이 이번 실패를
 * 덮어버린다 — 백오프가 영영 안 걸리고 30분마다 무한 재시도가 그대로 돌아온다. 런 시작 이후에
 * 찍힌 기록만 이번 런의 것으로 인정하고, 기록이 없으면 실패로 접는다(안전한 방향).
 */
function attemptSucceededSince(attempt: { ok: boolean; at: string } | null, since: number): boolean {
  if (!attempt?.ok) return false;
  const at = new Date(attempt.at).getTime();
  return Number.isFinite(at) && at >= since - ATTEMPT_CLOCK_SLACK_MS;
}

// ── 팝업/전시 이벤트 스케줄 ──
let eventsRunning = false;
async function safeRefreshEvents(trigger: string, notify: boolean) {
  if (eventsRunning) {
    log.warn(`이벤트 수집 진행 중 → ${trigger} 건너뜀`);
    return;
  }
  eventsRunning = true;
  // 결말 기본값이 "skipped-queue" 인 이유: 아래 콜백에 **진입조차 못 한** 경우가 정확히 그 상황
  // (큐 대기 상한 초과)이기 때문이다. 진입하면 첫 줄에서 곧바로 다른 값으로 덮인다.
  let outcome: TabRunOutcome = "skipped-queue";
  try {
    await runLlmJob(`팝업/전시[${trigger}]`, async () => {
      // ★ 슬롯을 얻은 **직후, 호출 직전**에 본다. 이 줄과 refreshEvents 사이에 await 가 없어
      //   판정과 호출이 원자적이다 — 그 틈에 수동 갱신이 끼어들 수 없다.
      if (isEventsCollecting()) {
        log.warn(`팝업/전시 수집이 이미 진행 중(수동 갱신 등) → ${trigger} 건너뜀`);
        outcome = "skipped-duplicate";
        return;
      }
      outcome = "attempted";
      await refreshEvents({ trigger, notify });
    });
  } catch (e) {
    log.error(`이벤트 수집 오류 [${trigger}]: ${(e as Error).message}`);
  } finally {
    eventsRunning = false;
    // 뉴스·유튜브와 달리 '런 시작 이후 기록'을 따지지 않는다. 팝업/전시는 게이트와 백오프가
    // **같은 술어**(eventsCoveredToday)를 쓰기 때문이다 — 커버됐다고 판정되면 catch-up 게이트도
    // 곧바로 막히므로, 오래된 성공이 백오프를 풀어도 무한 재시도가 생기지 않는다.
    noteTabOutcome(`팝업/전시[${trigger}]`, eventsBackoff, outcome, eventsCoveredToday);
  }
}

/**
 * 오늘치 팝업/전시가 **성공적으로** 커버됐는지.
 *
 * ⚠️ 예전에는 `hasTodaySnapshot()`(= 스냅샷 날짜만 비교)이 이 판정을 했다. 그런데 LLM 큐레이션이
 * 실패하면 events.ts 는 네이버 검색 원본을 그대로 담은 폴백 스냅샷(source="naver-raw")을 오늘
 * 날짜로 저장한다 — 날짜만 보는 게이트는 그걸 **성공으로 오인**해 catch-up 을 영원히 막았다.
 * 사용자는 하루 종일 제목 노이즈만 잔뜩 든 목록을 보게 되고, 로그에는 아무 이상도 남지 않는다.
 *
 * 판정 근거는 두 겹이다.
 *  1) 오늘자 시도 기록이 있으면 그 `ok` 가 1차 근거다(events.ts 가 디스크에 남기고, 기록
 *     파일이 없는 첫 회차에는 스냅샷에서 유도해 준다).
 *  2) 시도 기록이 아예 없으면(수집을 한 번도 못 돌린 상태) 디스크 스냅샷으로 판정한다.
 *     이 폴백이 없으면 멀쩡한 날에도 기동 직후 catch-up 이 한 번 더 돈다.
 * 두 근거가 모두 있으면 **AND** 로 본다 — 시도는 성공했다는데 디스크에 남은 게 naver-raw 면
 * 그건 성공이 아니다. 두 판정의 'ok' 정의가 나중에 어긋나도 안전한 쪽(재시도)으로 접힌다.
 */
function eventsCoveredToday(): boolean {
  const snap = getEventsSnapshot();
  const snapshotOk = snap?.date === today() && snap.source === "llm";
  const attempt = getEventsLastAttempt();
  if (attempt && attemptIsToday(attempt.at)) return attempt.ok && snapshotOk;
  return snapshotOk;
}

async function checkEventsCatchup() {
  // 커버 판정이 슬롯과 무관한 '오늘 하루' 단위라, covered 는 인자를 무시한다(동작 불변).
  const d = decideCatchup({
    running: eventsRunning,
    blocked: eventsBackoff.blocked(), // 연속 실패 백오프 중
    slots: getSchedule().events,
    past: pastTime,
    covered: () => eventsCoveredToday(),
  });
  if (!d.run) return;
  log.info(`오늘(${today()}) 팝업/전시 갱신 누락 감지 → catch-up 실행`);
  await safeRefreshEvents("catchup", true);
}

// ── 데일리 뉴스 다이제스트 스케줄 ──
let newsRunning = false;
async function safeRefreshNews(trigger: string, notify: boolean) {
  if (newsRunning) {
    log.warn(`뉴스 수집 진행 중 → ${trigger} 건너뜀`);
    return;
  }
  newsRunning = true;
  // ⚠️ 큐 대기 **전에** 찍는다. 이 시각 이후의 기록만 이번 런의 성패로 인정한다.
  const runStartedAt = Date.now();
  // 결말 기본값이 "skipped-queue" 인 이유: 아래 콜백에 **진입조차 못 한** 경우가 정확히 그 상황
  // (큐 대기 상한 초과)이기 때문이다. 진입하면 첫 줄에서 곧바로 다른 값으로 덮인다.
  let outcome: TabRunOutcome = "skipped-queue";
  try {
    await runLlmJob(`뉴스[${trigger}]`, async () => {
      // ★ 판정과 호출 사이에 await 가 없다(원자적). 수동 갱신이 도는 중이면 refreshNews 는
      //   시도 기록 없이 되돌아오므로, 그대로 두면 성패 판정이 '실패'로 오판한다.
      if (isNewsCollecting()) {
        log.warn(`뉴스 수집이 이미 진행 중(수동 갱신 등) → ${trigger} 건너뜀`);
        outcome = "skipped-duplicate";
        return;
      }
      outcome = "attempted";
      await refreshNews({ trigger, notify });
    });
  } catch (e) {
    log.error(`뉴스 수집 오류 [${trigger}]: ${(e as Error).message}`);
  } finally {
    newsRunning = false;
    // 성패 판정은 news.ts 의 시도 기록이 근거다(계약: getNewsLastAttempt).
    noteTabOutcome(`뉴스[${trigger}]`, newsBackoff, outcome, () =>
      attemptSucceededSince(getNewsLastAttempt(), runStartedAt)
    );
  }
}

/**
 * 해당 예정 시각(scheduled)을 커버하는 **정상** 스냅샷이 있는지.
 *
 * ⚠️ `source === "llm"` 조건이 핵심이다. 큐레이션이 실패하면 news.ts 는 오늘 날짜 + 지금
 * updatedAt 을 단 빈 스냅샷(source="empty")을 저장할 수 있는데, 날짜·시각만 보는 예전 게이트는
 * 그걸 커버로 인정해 **그날의 뉴스를 통째로 포기**했다(실패 후 재시도가 한 번도 안 돌았다).
 * 이제는 실패가 커버로 안 잡히므로 catch-up 이 다시 돈다 — 무한 재시도는 위쪽 백오프가 막는다.
 */
function newsCoveredAt(scheduled: Date): boolean {
  const snap = getNewsSnapshot();
  if (snap?.date !== today()) return false;
  if (snap.source !== "llm") return false;
  // updatedAt 이 없는 스냅샷은 이론상 없지만, 있다면 '언제 갱신됐는지 모름'이다.
  // 그 경우는 커버로 본다 — 모른다는 이유로 30분마다 20분짜리 LLM 작업을 돌릴 수는 없다.
  if (!snap.updatedAt) return true;
  const at = new Date(snap.updatedAt);
  return Number.isNaN(at.getTime()) ? true : at >= scheduled;
}

/** HH:mm → 오늘 그 시각의 Date */
function scheduledToday(hhmm: string): Date {
  const { hour, minute } = parseCollectTime(hhmm);
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

/**
 * 뉴스 catch-up: 오늘 예정된 시간 중 하나라도 지났는데 그 시각을 커버하는 정상 스냅샷이
 * 없으면 보충한다.
 */
async function checkNewsCatchup() {
  const d = decideCatchup({
    running: newsRunning,
    blocked: newsBackoff.blocked(), // 연속 실패 백오프 중
    slots: getSchedule().news,
    past: pastTime,
    covered: (t) => newsCoveredAt(scheduledToday(t)),
  });
  if (!d.run) return;
  log.info(`오늘(${today()}) ${d.slot} 뉴스 다이제스트 갱신 누락 감지 → catch-up 실행`);
  await safeRefreshNews("catchup", true);
}

// ── 유튜브 소식 스케줄 ──
//
// 백오프는 원래 여기에만 있었다(유튜브가 반나절 동안 8회 실패한 실측 사례에서 나왔다).
// 뉴스·팝업/전시도 같은 실패 모양을 가지므로, 3벌 복붙 대신 위쪽 createBackoff 로 공통화했다.
let youtubeRunning = false;

async function safeRefreshYoutube(trigger: string, notify: boolean) {
  if (youtubeRunning) {
    log.warn(`유튜브 수집 진행 중 → ${trigger} 건너뜀`);
    return;
  }
  youtubeRunning = true;
  const runStartedAt = Date.now(); // 큐 대기 전. 이 시각 이후의 기록만 이번 런의 것이다.
  // 결말 기본값이 "skipped-queue" 인 이유: 아래 콜백에 **진입조차 못 한** 경우가 정확히 그 상황
  // (큐 대기 상한 초과)이기 때문이다. 진입하면 첫 줄에서 곧바로 다른 값으로 덮인다.
  let outcome: TabRunOutcome = "skipped-queue";
  try {
    await runLlmJob(`유튜브[${trigger}]`, async () => {
      if (isYoutubeCollecting()) {
        log.warn(`유튜브 수집이 이미 진행 중(수동 갱신 등) → ${trigger} 건너뜀`);
        outcome = "skipped-duplicate";
        return;
      }
      outcome = "attempted";
      await refreshYoutube({ trigger, notify });
    });
  } catch (e) {
    log.error(`유튜브 수집 오류 [${trigger}]: ${(e as Error).message}`);
  } finally {
    youtubeRunning = false;
    // 시도 기록이 없으면(기동 후 첫 예외 등) 실패로 접는다 — 기존 noteYoutubeOutcome 과 같은 판정.
    // 단 **시도한 런에 한해서다** — 건너뛴 런까지 실패로 세면 백오프가 유령 실패로 걸린다.
    noteTabOutcome(`유튜브[${trigger}]`, youtubeBackoff, outcome, () =>
      attemptSucceededSince(getYoutubeLastAttempt(), runStartedAt)
    );
  }
}

/**
 * 해당 예정 시각을 커버하는 **정상** 유튜브 스냅샷이 있는지.
 *
 * 뉴스와 같은 이유로 `source === "llm"` 을 요구한다. 유튜브는 실패 시 보통 기존 스냅샷을
 * 유지하지만(youtube.ts: 빈 결과로 덮어쓰지 않음), **이전 스냅샷이 아예 없는 날**에는 빈
 * 스냅샷(source="empty")이 오늘 날짜로 저장된다 — 날짜만 보는 게이트는 그 하루를 통째로
 * 포기했다. 조용한 구멍이라 여기서 막는다.
 */
function youtubeCoveredAt(scheduled: Date): boolean {
  const snap = getYoutubeSnapshot();
  if (snap?.date !== today()) return false;
  if (snap.source !== "llm") return false;
  if (!snap.updatedAt) return true; // 뉴스와 동일: '모름'은 커버로 본다
  const at = new Date(snap.updatedAt);
  return Number.isNaN(at.getTime()) ? true : at >= scheduled;
}

/**
 * 유튜브 catch-up: 오늘 예정된 시간 중 하나라도 지났는데 그 시각을 커버하는 정상 스냅샷이
 * 없으면 보충한다. (뉴스와 동일 패턴)
 */
async function checkYoutubeCatchup() {
  const d = decideCatchup({
    running: youtubeRunning,
    blocked: youtubeBackoff.blocked(), // 연속 실패 백오프 중 — **catch-up 만** 막는다
    slots: getSchedule().youtube,
    past: pastTime,
    covered: (t) => youtubeCoveredAt(scheduledToday(t)),
  });
  if (!d.run) return;
  log.info(`오늘(${today()}) ${d.slot} 유튜브 소식 갱신 누락 감지 → catch-up 실행`);
  await safeRefreshYoutube("catchup", true);
}

// ── 증시 브리핑 스케줄 (한국장 08:00 / 미국장 18:00) ──
// 시장별 독립 플래그. 한쪽이 도는 중에도 다른 쪽은 돌 수 있다(수집 시각이 10시간 떨어져 있어
// 실제로 겹치진 않지만, 수동 갱신이 겹칠 수 있으므로 시장별로 잠근다).
const stockRunning: Record<StockMarket, boolean> = { kr: false, us: false };

// slot 은 알림 멱등 키의 일부다(notify-ledger 참고). 정시 런은 cron 클로저의 시각,
// catch-up 런은 '어느 슬롯을 보충하는지'를 그대로 넘긴다 — 역산이 아니라 확정 정보다.
async function safeRefreshStock(
  market: StockMarket,
  trigger: string,
  notify: boolean,
  slot?: string
) {
  if (stockRunning[market]) {
    log.warn(`증시(${market}) 수집 진행 중 → ${trigger} 건너뜀`);
    return;
  }
  stockRunning[market] = true;
  try {
    await runLlmJob(`증시(${market})[${trigger}${slot ? ` ${slot}` : ""}]`, async () => {
      // 증시는 백오프가 없어 오판 위험은 없지만, 수동 갱신이 도는 중이면 refreshStock 이 곧바로
      // 되돌아온다 — 그 20분짜리 슬롯을 남에게 넘겨주는 것이 옳다.
      if (isStockCollecting(market)) {
        log.warn(`증시(${market}) 수집이 이미 진행 중(수동 갱신 등) → ${trigger} 건너뜀`);
        return;
      }
      await refreshStock({ market, trigger, notify, slot });
    });
  } catch (e) {
    log.error(`증시(${market}) 수집 오류 [${trigger}]: ${(e as Error).message}`);
  } finally {
    stockRunning[market] = false;
  }
}

/**
 * 증시 catch-up. 뉴스/유튜브와 동일 패턴.
 *
 * 휴장일 안전성의 **1차 근거는 원장**이다: refreshStock 이 휴장 런마다 그 슬롯을 SLOT_HANDLED 로
 * 닫고(mergeNotified 로 다른 슬롯 기록은 보존), 아래 두 게이트가 그 기록을 존중한다.
 * 스냅샷은 근거가 되지 못한다 — 휴장 스냅샷은 both 경로 한 곳에만 쓰이므로 슬롯이 2개인 날은
 * 두 슬롯이 동시에 커버될 수 없다(아래 slotHandled 주석).
 */
async function checkStockCatchup(market: StockMarket) {
  if (stockRunning[market]) return;
  const times = market === "kr" ? getSchedule().stockKr : getSchedule().stockUs;
  // ⚠️ 순회는 **시각 오름차순**으로 한다(저장 순서는 건드리지 않는다).
  // schedule-store 어디에도 정렬이 없고 실제 저장값이 ["17:00","08:00"] 이라, 두 슬롯이
  // 동시에 밀린 날(서비스 재시작 등)에 배열 순서대로 돌면 오후 프리뷰가 먼저 나가고
  // 아침 결산이 30분 뒤에 온다 — 역할이 생긴 뒤로는 사용자에게 시간 역순으로 보인다.
  const ordered = [...times].sort((a, b) => {
    const min = (t: string) => {
      try {
        const { hour, minute } = parseCollectTime(t);
        return hour * 60 + minute;
      } catch {
        return Number.MAX_SAFE_INTEGER; // 형식 오류 항목은 뒤로
      }
    };
    return min(a) - min(b);
  });

  for (const t of ordered) {
    if (!pastTime(t)) continue;

    // ⚠️ 1차 게이트는 **슬롯 기준**이다(hasSnapshotForSlot). 예전처럼 시장당 스냅샷 1개를
    // 전제로 `snapshotDate !== today()` 를 쓰면, 역할별 파일로 쪼갠 뒤에는 아침 결산만
    // 성공한 날 오후 프리뷰 슬롯이 '오늘 스냅샷 있음'으로 걸러져 **영구 누락**된다.
    // 반대로 파일만 나누고 게이트를 그대로 두면 30분마다 무한 catch-up 이 돈다.
    // 두 실패 모두 조용하므로 단위 테스트로 못박아 두었다.
    const slotSnapshot = snapshotForSlot(market, today(), t);
    if (!slotSnapshot) {
      // ⚠️ 스냅샷 부재만으로 발화하면 **휴장일에 30분마다 무한 핑퐁**이 돈다.
      // 휴장 스냅샷은 역할 파일 오염을 피하려고 항상 both 경로 한 곳에 저장되므로(stock.ts
      // HOLIDAY_STORAGE_ROLE) slot 필드를 하나만 담는다 → 슬롯이 2개인 날은 나중 런이 앞선
      // 런의 slot 을 덮어써, 어떤 상태에서도 두 슬롯이 동시에 커버되지 못한다. 그러면
      // 08:00 발화 → both.slot=08:00 → 다음 틱에 17:00 이 미커버 → 발화 → … 가 자정까지 반복된다.
      // 원장은 슬롯별 맵이라 이 상황에서도 정확하다. 명시적으로 닫힌 슬롯이면 보충할 것이 없다.
      // (원장이 아예 없는 날 — 서버가 죽어 그날 런이 0건 — 은 slotHandled 가 false 라 그대로 발화한다.)
      if (slotHandled(today(), market, t)) continue;
      log.info(`오늘(${today()}) ${t} 증시(${market}) 브리핑 누락 감지 → catch-up 실행`);
      await safeRefreshStock(market, "catchup", true, t);
      return;
    }
    // 신선도 비교도 **이 슬롯을 커버하는 스냅샷** 기준이어야 한다. 세 파일 중 '가장 최신'을
    // 쓰면 오후 프리뷰의 updatedAt 이 아침 결산 슬롯의 누락을 가려버린다.
    const snapshotTime = slotSnapshot.updatedAt ? new Date(slotSnapshot.updatedAt) : null;

    // 원장이 1차 근거다. 스냅샷이 신선해도(=아래 시각 비교가 거짓이어도) 그 슬롯의 알림이
    // 나가지 않았을 수 있다 — 슬롯 시각을 넘겨서 끝난 런이 정시 cron 을 running 가드로
    // 밀어낸 경우, 실패해서 빈 스냅샷만 저장하고 updatedAt 을 밀어놓은 경우.
    // 두 경우 모두 예전 게이트로는 영구 누락이었다(slotNeedsCatchup 주석 참고).
    if (slotNeedsCatchup(today(), market, t)) {
      log.info(`오늘(${today()}) ${t} 증시(${market}) 알림 원장 미기록 → catch-up 실행`);
      await safeRefreshStock(market, "catchup", true, t);
      return;
    }

    if (snapshotTime) {
      const { hour, minute } = parseCollectTime(t);
      const scheduled = new Date();
      scheduled.setHours(hour, minute, 0, 0);
      if (snapshotTime < scheduled) {
        log.info(`오늘(${today()}) ${t} 증시(${market}) 갱신 누락 감지 → catch-up 실행`);
        await safeRefreshStock(market, "catchup", true, t);
        return;
      }
    }
  }
}

// ── 시간당 펄스 (실시간 취합 → 문자) ──
//
// ⚠️ 펄스에는 **catch-up 이 없다.** 다른 탭과 다른 유일한 항목이라 여기 이유를 남긴다:
// 나머지 탭은 '그날의 결과물'이라 놓치면 보충해야 하지만, 펄스는 '그 시각의 감시'다.
// 세 시간 전 시장 상황을 지금 문자로 받는 것은 가치가 없을 뿐 아니라 해롭다(이미 지나간
// 재료에 반응하게 만든다). 서버가 4시간 꺼져 있었다면 그 4개 슬롯은 그냥 없던 일이다.
// 동시 실행 방지·백오프는 runPulse 안에 있으므로 여기서는 래핑만 한다.
async function safeRunPulse(slot: string, trigger: string) {
  try {
    await runPulse({ slot, trigger, notify: true });
  } catch (e) {
    // runPulse 는 throw 하지 않도록 만들었지만, 계약이 깨져도 스케줄러는 죽지 않아야 한다.
    log.error(`펄스 실행 오류 [${trigger}] ${slot}: ${(e as Error).message}`);
  }
}

/**
 * 야간 보류분 묶음 발송. 조용 시간 종료 시각(기본 07:00) 정각 1회.
 *
 * 펄스 정시와 **분리된 별도 cron** 인 이유: 07:00 은 기본 펄스 시각 목록에 없다
 * (06~08시는 비워 둔 구간이다). 펄스 실행에 얹으면 사용자가 시간대를 바꿨을 때
 * 보류분이 영영 안 나가는 조합이 생긴다.
 */
async function safeFlushPulseQueue(trigger: string) {
  try {
    await flushPulseQueue(trigger);
  } catch (e) {
    log.error(`펄스 보류 플러시 오류 [${trigger}]: ${(e as Error).message}`);
  }
}

// ── 로또 주간 사이클 ──
//
// 다른 탭과 다른 점은 **주 1회**라는 것뿐이다 — 추첨이 토요일 20:45경 한 번뿐이라 매일 도는 건
// 무의미한 요청이다. 사이클 하나가 수집·채점·전략 갱신·다음 회차 번호 확정을 전부 한다
// (`src/lotto/cycle.ts`). 시각(일요일 10:00)은 사용자 지시이고, cron 식은 cycle.ts 가 소유한다 —
// 경계 계산(놓친 실행 판정)이 같은 상수를 봐야 하기 때문이다.

async function safeRunLottoCycle(trigger: string) {
  try {
    await runLlmJob(`로또 사이클[${trigger}]`, async () => {
      if (isCycleRunning()) {
        log.warn(`로또 주간 사이클이 이미 진행 중 → ${trigger} 건너뜀`);
        return;
      }
      await runWeeklyCycle(trigger);
    });
  } catch (e) {
    // runWeeklyCycle 은 스스로 예외를 삼키지만, 그 약속이 깨져도 스케줄러가 죽지 않게 한 겹 더.
    log.error(`로또 주간 사이클 오류 [${trigger}]: ${(e as Error).message}`);
  }
}

/**
 * 놓친 사이클 보충. 일요일 10:00 에 맥이 자고 있었으면 cron 이 통째로 사라지므로, 다른 탭과
 * 같은 catch-up 을 붙인다(기동 직후 + 30분마다). 실패해 예약된 재시도도 여기서 걸린다.
 */
async function safeCatchUpLottoCycle() {
  try {
    // ★★ **보충할 것이 없으면 슬롯을 잡지 않는다.**
    //
    // 예전에는 판정을 catchUpWeeklyCycle 안쪽에 맡기고 슬롯부터 잡았다. 그 결과 주 6일 × 하루
    // 48틱, 즉 거의 모든 호출이 "슬롯을 얻어 → 할 일 없음을 확인 → 즉시 반납"이었다
    // (프로덕션 로그: `LLM 슬롯 반납 [로또 사이클[catchup]] — 실행 0초`). 실행이 0초라 해롭지
    // 않아 보이지만 **줄을 서는 시간은 0초가 아니다** — 앞에 20분짜리 수집이 있으면 스윕의
    // 마지막 단계가 20분을 통째로 기다리고, 그동안 30분 틱이 스킵된다. 판정을 큐 **앞**으로
    // 끌어내면 그 20분이 통째로 사라진다.
    //
    // 게이트의 정본은 cycle.ts 다(catchUpWeeklyCycle 이 슬롯 안에서 같은 판정을 한 번 더 한다).
    // 여기 것은 그 정본을 그대로 미리 부르는 사본이라, 둘이 어긋나도 최악은 '옛날처럼 빈 슬롯을
    // 한 번 잡는 것'이지 실행 누락이 아니다.
    if (isCycleRunning()) return;
    if (!shouldRunCycle(new Date(), getLottoState(), getUpcoming() !== null)) return;

    // ⚠️ 슬롯은 **여기서 한 번만** 잡는다. catchUpWeeklyCycle 은 내부에서 runWeeklyCycle 을
    // 부르므로, 그 안쪽에도 슬롯을 걸면 자기 자신을 기다리는 교착이 된다(runLlmJob 주석의
    // 재진입 가드가 최후 방어선이지만, 애초에 그 상황을 만들지 않는 게 옳다).
    await runLlmJob("로또 사이클[catchup]", () => catchUpWeeklyCycle());
  } catch (e) {
    log.error(`로또 사이클 보충 점검 오류: ${(e as Error).message}`);
  }
}

/** HH:mm → 매일 실행 cron 식. */
function cronExpr(hhmm: string): string {
  const { hour, minute } = parseCollectTime(hhmm);
  return `${minute} ${hour} * * *`;
}

// 등록된 cron 작업들(재등록 시 중지 대상). 모듈 싱글턴이라 startScheduler/rescheduleAll 이 공유.
let tasks: ReturnType<typeof cron.schedule>[] = [];

/**
 * 한 탭의 여러 시각을 cron 으로 등록. name 을 (kind,index)로 고정해, 재등록 시
 * node-cron 전역 레지스트리 항목이 무한 누적되지 않고 같은 키로 덮어써지게 한다(누수 방지).
 */
// run 은 슬롯 시각 t 를 받는다. 증시만 이 값을 알림 멱등 키로 쓰고(notify-ledger),
// 나머지 탭은 `() => ...` 그대로 두면 TS 함수 타입 호환으로 인자를 무시한다(동작 불변).
function scheduleGroup(kind: string, times: string[], label: string, run: (t: string) => void): void {
  times.forEach((t, i) => {
    tasks.push(
      cron.schedule(
        cronExpr(t),
        () => {
          log.info(`정시 ${label} 수집 (${t})`);
          run(t);
        },
        { name: `dp-${kind}-${i}` }
      )
    );
    log.info(`스케줄러: ${label} 매일 ${t}`);
  });
}

/**
 * 현재 스케줄 설정으로 모든 정시 cron 을 등록(전 탭 복수 시각).
 *
 * 정시 cron 은 그대로 `void` 로 던진다 — 여기서 직렬화 코드를 따로 쓸 필요가 없다. LLM 탭의
 * safeRefreshX 가 이미 전역 슬롯(runLlmJob)을 타므로, 같은 시각에 걸린 작업들은 스스로 줄을
 * 선다(실제로 기본 설정의 08:00 에는 뉴스·증시(kr)·펄스가 함께 걸려 있다).
 * **펄스만 예외로 슬롯을 타지 않는다** — 매시간 도는 10분짜리라, 앞의 20분 작업에 막히면 그
 * 슬롯의 감시가 통째로 죽는다. 늦은 펄스는 보충 가치가 없으므로(아래 펄스 주석) 막지 않는다.
 */
function registerCrons() {
  const s = getSchedule();
  scheduleGroup("events", s.events, "팝업/전시", () => void safeRefreshEvents("schedule", true));
  scheduleGroup("news", s.news, "뉴스 다이제스트", () => void safeRefreshNews("schedule", true));
  scheduleGroup("youtube", s.youtube, "유튜브 소식", () => void safeRefreshYoutube("schedule", true));
  scheduleGroup("stock-kr", s.stockKr, "증시(한국장)", (t) => void safeRefreshStock("kr", "schedule", true, t));
  scheduleGroup("stock-us", s.stockUs, "증시(미국장)", (t) => void safeRefreshStock("us", "schedule", true, t));
  // 역할 분리 구성을 남긴다. '슬롯을 하나로 줄이거나 같은 밴드에 몰아넣으면 분리가 조용히
  // 꺼진다'는 비자명 동작의 유일한 가시화 수단이라 옵션이 아니다(slot-role.ts 참고).
  log.info(describeSlotRoles("us", s.stockUs));

  // 펄스는 시각이 16개라 scheduleGroup 의 시각별 로그가 로그를 뒤덮는다 → 한 줄로 요약한다.
  s.stockPulse.forEach((t, i) => {
    tasks.push(
      cron.schedule(cronExpr(t), () => void safeRunPulse(t, "schedule"), {
        name: `dp-stock-pulse-${i}`,
      })
    );
  });
  log.info(`스케줄러: 증시 펄스 매일 ${s.stockPulse.length}회 (${s.stockPulse.join(", ")})`);

  // 야간 보류분 묶음 발송(조용 시간 종료 정각).
  const flushAt = `${String(config.stockPulse.quietEndHour).padStart(2, "0")}:00`;
  tasks.push(
    cron.schedule(cronExpr(flushAt), () => void safeFlushPulseQueue("schedule"), {
      name: "dp-stock-pulse-flush",
    })
  );
  log.info(`스케줄러: 증시 펄스 야간 보류 묶음 발송 매일 ${flushAt}`);

  // 보존 정책. 예전에는 가격 수집이 끝날 때마다 pruneOldData 를 불렀는데, 가격 탭을 제거하면서
  // (2026-08-01) 그 유일한 호출자가 사라졌다 — 그대로 뒀다면 증시 시계열과 펄스 원장이 영원히
  // 누적된다. 어느 탭에도 매달지 않고 독립 cron 으로 둔다(수집이 없는 새벽 시간).
  tasks.push(
    cron.schedule(RETENTION_CRON, () => safePruneOldData(), { name: "dp-retention" })
  );
  log.info(
    `스케줄러: 보존 정책 매일 ${RETENTION_LABEL} (증시 ${config.historyRetentionDays}일 초과분 정리)`
  );

  // ⚠️ 수집 모델 '주간 복귀' cron 은 없다(2026-08-01 제거). Codex 복귀를 요일에 고정하니
  // 그 시각에 맥이 꺼져 있거나 Codex 가 예정과 다르게 살아나면 어긋났다. 지금은 실행할 때마다
  // Codex 를 확인해 그 실행만 대체하므로(agent-query.ts) 되돌릴 스케줄 자체가 필요 없다.

  // 로또 주간 사이클(주 1회). 채점 → 전략 갱신 → 다음 회차 번호 확정까지 한 번에 한다.
  tasks.push(
    cron.schedule(LOTTO_CYCLE_CRON, () => void safeRunLottoCycle("schedule"), {
      name: "dp-lotto-cycle",
    })
  );
  log.info(`스케줄러: 로또 주간 사이클 매주 ${LOTTO_CYCLE_LABEL}`);
}

/**
 * 스케줄 설정 변경 후 즉시 cron 을 갈아끼운다(재시작 없이 반영).
 * 기존 작업을 모두 중지하고 최신 설정으로 재등록한다.
 */
export function rescheduleAll() {
  for (const t of tasks) {
    try {
      t.stop();
    } catch {
      /* 이미 중지된 작업 무시 */
    }
  }
  tasks = [];
  registerCrons();
  log.info("스케줄러: 설정 변경으로 cron 재등록 완료");
}

// ── 누락 점검 스윕 ────────────────────────────────────────────────────────
//
// 예전에는 6종을 전부 `void` 로 던졌다. 맥이 10시간 45분 자다 깨면 여섯 개가 **동시에** 출발하고,
// 그중 LLM 작업 3~4개가 나란히 돌았다(2026-08-02 사고). 지금은 순차 await 로 한 줄로 세운다.
//
// 순서는 이제 **의미가 있다** — 앞의 작업이 20분 걸리면 뒤는 20분 늦게 시작한다. 기존 순서를
// 그대로 유지하되(행동 변화 최소화), 각 작업이 얼마나 기다렸는지 로그에 남겨 "왜 이 탭이
// 늦었나"를 로그만으로 답할 수 있게 한다.
//
// ⚠️ **순차 실행을 다시 병렬로 되돌리지 말 것.** 스윕이 느린 근본 원인은 직렬화가 아니라 탭당
// 실행 시간(타임아웃 20분 + 폴백 20분)이며, 그걸 병렬로 줄이면 2026-08-02 사고가 그대로
// 재현된다. 지연은 아래 두 가지로 잡는다: ①할 일 없는 단계는 큐에 아예 들어가지 않는다
// ②큐 대기에 상한을 두고, 상한을 넘기면 그 스윕을 끝내고 다음 틱에 넘긴다.
// 실제로 시간을 잡아먹던 것은 '기다리기'였지 '일하기'가 아니었다.
//
// ⚠️ 각 단계를 개별 try/catch 로 감싼다. 예전에는 `void` 라 하나가 던져도 나머지가 돌았지만,
// 순차 await 로 바꾼 지금은 게이트 계산(getSchedule 파싱 등)에서 튀어나온 예외 하나가
// **뒤의 모든 점검을 통째로 취소**시킨다. 조용한 전면 정지라 반드시 막아야 한다.
const CATCHUP_STEPS: { label: string; run: () => Promise<void> }[] = [
  { label: "팝업/전시", run: checkEventsCatchup },
  { label: "뉴스", run: checkNewsCatchup },
  { label: "유튜브", run: checkYoutubeCatchup },
  { label: "증시(kr)", run: () => checkStockCatchup("kr") },
  { label: "증시(us)", run: () => checkStockCatchup("us") },
  // 모델 복귀 catch-up 은 없다 — 복귀가 시각이 아니라 '다음 실행의 Codex 확인'에 달려 있어
  // 서버가 꺼져 있던 구간에 놓칠 이벤트 자체가 없다.
  // 로또: 놓친 일요일 사이클(맥이 자고 있었던 경우)과 예약된 재시도를 확인한다.
  // 다음 회차 추천 번호가 아직 없는 상태(배포 직후)도 여기서 채워진다.
  { label: "로또", run: safeCatchUpLottoCycle },
];

/**
 * 스윕이 겹치지 않게 하는 가드 + 진행 상황. 직렬화 이후 스윕 1회가 30분 틱을 넘길 수 있어,
 * "지금 무엇을 얼마나 하고 있는가"를 스킵 로그에 그대로 실어 준다(예전 로그는 그냥 '진행 중'
 * 한 줄이라, 6번 연속 스킵돼도 원인을 알 수 없었다).
 */
let activeSweep: { startedAt: number; step: string; reason: string } | null = null;

/**
 * 스윕이 이 시간을 넘겨 돌고 있으면 error 로 올린다.
 *
 * 스윕이 영원히 안 끝나면 `activeSweep !== null` 이 계속 참이라 **모든 catch-up 이 조용히 죽는다**.
 * 각 LLM 작업에 자체 타임아웃이 있어 정상 경로에서는 일어나지 않지만, 조용한 전면 정지는
 * 반드시 시끄럽게 만들어 둔다. 실제 최악값(6단계 × 탭당 40분대)보다 넉넉히 위에 둔다.
 */
const SWEEP_STUCK_WARN_MS = 5 * 60 * 60 * 1000;

async function runCatchupSweep(reason: string): Promise<void> {
  if (activeSweep) {
    // 이전 스윕이 아직 LLM 큐를 소화하는 중이다. 여기서 또 던지면 직렬화의 의미가 사라진다.
    // ⚠️ **틱을 막지 않고 즉시 반환한다.** 이 함수는 setInterval 콜백에서 `void` 로 불리므로
    // 30분 틱 자체는 계속 뛰고, 절전 감지도 정상 동작한다. 스킵되는 것은 '이번 점검'뿐이다.
    const elapsed = Date.now() - activeSweep.startedAt;
    const msg =
      `이전 누락 점검 스윕 진행 중 → ${reason} 스윕 건너뜀 ` +
      `(시작 ${activeSweep.reason} · ${formatDuration(elapsed)}째 · 현재 단계: ${activeSweep.step}). ` +
      `이번 틱은 즉시 반환한다 — 남은 항목은 진행 중 스윕이 그대로 이어서 본다.`;
    if (elapsed >= SWEEP_STUCK_WARN_MS) log.error(`${msg} ⚠️ 비정상적으로 깁니다.`);
    else log.warn(msg);
    return;
  }
  const sweepStart = Date.now();
  activeSweep = { startedAt: sweepStart, step: CATCHUP_STEPS[0].label, reason };
  try {
    // 스윕 안에서 시작되는 LLM 작업은 **짧은 큐 대기 상한**을 쓴다(llmQueueWaitMs).
    // 한 단계라도 상한을 넘겨 포기하면 큐가 막혔다는 뜻이므로 그 자리에서 스윕을 끝낸다 —
    // 남은 단계도 같은 벽에 부딪혀 10분씩 헛기다릴 뿐이고, 그 사이 틱만 계속 스킵된다.
    const ctx: SweepContext = { gaveUp: false };
    await sweepContext.run(ctx, async () => {
      for (const [i, step] of CATCHUP_STEPS.entries()) {
        activeSweep = { startedAt: sweepStart, step: step.label, reason };
        const waited = Date.now() - sweepStart;
        // 1분 이상 밀렸을 때만 남긴다 — 대부분의 스윕은 전부 '보충할 것 없음'으로 즉시 끝난다.
        if (waited >= 60_000) {
          log.info(`누락 점검 [${step.label}] — 앞선 작업 ${formatDuration(waited)} 대기 후 시작`);
        }
        try {
          await step.run();
        } catch (e) {
          log.error(`누락 점검 오류 [${step.label}]: ${(e as Error).message}`);
        }
        if (ctx.gaveUp) {
          const rest = CATCHUP_STEPS.slice(i + 1).map((s) => s.label);
          log.warn(
            `누락 점검 스윕 중단 [${reason}] — [${step.label}] 이 큐 대기 상한을 넘겨 큐가 막힌 상태로 판단. ` +
              (rest.length > 0
                ? `남은 항목(${rest.join(", ")})은 다음 30분 틱이 같은 판정으로 다시 본다(누락되지 않는다).`
                : `마지막 단계였다 — 다음 30분 틱이 처음부터 다시 본다.`)
          );
          break;
        }
      }
    });
  } finally {
    activeSweep = null;
    const total = Date.now() - sweepStart;
    if (total >= 60_000) log.info(`누락 점검 스윕 완료 [${reason}] — 총 ${formatDuration(total)}`);
  }
}

/** 누락 점검 주기. 잠자기 복귀·정시 cron 유실을 보충하는 유일한 그물이다. */
const CATCHUP_TICK_MS = 30 * 60 * 1000;

/**
 * 틱 간격이 예상보다 크게 벌어졌으면 절전 복귀로 보고 한 줄 남긴다(아니면 null).
 *
 * setInterval 은 시스템이 자는 동안 발화하지 않고, 깨어나면 밀린 발화를 **1회로 합쳐** 낸다.
 * 즉 여기서 보이는 델타가 곧 '맥이 자고 있던 시간'이다. 2026-08-02 사고 때 이 한 줄이 없어,
 * "왜 6개가 동시에 튀었나"를 되짚는 데 워커 3개가 붙었다. 로그 한 줄이면 끝날 일이었다.
 */
function sleepGapMessage(deltaMs: number, expectedMs: number): string | null {
  if (deltaMs <= expectedMs * 2) return null;
  const skipped = Math.round((deltaMs - expectedMs) / 60000);
  return (
    `시스템 절전 감지 — 약 ${skipped}분 건너뜀 ` +
    `(누락 점검 틱 간격 예상 ${Math.round(expectedMs / 60000)}분 / 실제 ${Math.round(deltaMs / 60000)}분). ` +
    `이 구간의 정시 cron 은 발화하지 않았으므로 아래 누락 점검이 그만큼을 보충합니다.`
  );
}

export function startScheduler() {
  registerCrons();

  // 기동 직후 1회 + 30분마다 누락 점검 (잠자기 복귀 대응)
  void runCatchupSweep("기동");
  // 펄스 자체는 catch-up 하지 않지만(위 주석) **보류 큐는 다르다.** 큐에 있는 건 이미 판정이
  // 끝나 "아침에 보내겠다"고 약속한 알림이라, 07:00 에 서버가 꺼져 있었다면 반드시 보충해야
  // 한다. 그러지 않으면 밤사이 판정이 디스크에 영원히 갇힌다.
  // 조용 시간 중이면 건너뛴다 — 지금 보내면 그게 바로 새벽 문자다.
  // (LLM 큐를 타지 않는다: 발송뿐이라 짧고, 스윕 뒤로 줄 세울 이유가 없다.)
  if (
    !isQuietHour(
      new Date().getHours(),
      config.stockPulse.quietStartHour,
      config.stockPulse.quietEndHour
    )
  ) {
    void safeFlushPulseQueue("startup");
  }

  let lastTickAt = Date.now();
  setInterval(() => {
    const now = Date.now();
    const gap = sleepGapMessage(now - lastTickAt, CATCHUP_TICK_MS);
    lastTickAt = now;
    if (gap) log.warn(gap);
    void runCatchupSweep("30분 틱");
  }, CATCHUP_TICK_MS);
}

/** 단위 테스트 전용 훅. 프로덕션 코드에서 import 하지 말 것. */
export const __testing = {
  withLlmSlot,
  runLlmJob,
  createBackoff,
  backoffWaitMs,
  decideCatchup,
  shouldNoteBackoff,
  sleepGapMessage,
  formatDuration,
  attemptSucceededSince,
  CATCHUP_BACKOFF_BASE_MS,
  CATCHUP_BACKOFF_MAX_MS,
  LLM_QUEUE_WAIT_SCHEDULED_MS,
  LLM_QUEUE_WAIT_CATCHUP_MS,
};
