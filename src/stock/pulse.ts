import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { localDate } from "../util/date.ts";
import { runStockAgent, extractJson } from "./agent.ts";
import { buildPulsePrompt, normalizePulse } from "./pulse-prompt.ts";
import { decide, isQuietHour, prioritize, type GateCounts } from "./pulse-gate.ts";
import { fetchSavetickerNews } from "./saveticker.ts";
import { summarizeHoldings } from "./holdings.ts";
import {
  countPulseSentToday,
  insertPulseAlert,
  listQueuedPulseAlerts,
  markPulseAlertsFailed,
  markPulseAlertsSent,
  recentPulseAlerts,
} from "../db/repo.ts";
import {
  isPulseNotifyEnabled,
  pulseThreshold,
  PULSE_CAPS,
  sendPulseDigest,
  sendPulseIMessage,
} from "../notify/pulse-imessage.ts";
import type { PulseRunResult, StockHoldingSummary } from "../../shared/types.ts";

/**
 * 시간당 펄스 오케스트레이션: 보유 조회 → 속보 수집 → 에이전트 판정 → 게이트 → 문자.
 *
 * ## 설계 원칙
 * 1. **catch-up 하지 않는다.** 지나간 시각의 '실시간' 취합은 보충할 가치가 없고, 보충하면
 *    서버 재시작 직후 밀린 시각만큼 연쇄 실행되어 토큰만 태운다(브리핑과 정반대의 판단이다 —
 *    브리핑은 하루치 결과물이라 놓치면 보충해야 하지만, 펄스는 순간의 감시다).
 * 2. **실패는 그 슬롯을 버린다.** 다음 정시가 한 시간 뒤라 재시도 가치가 낮다. 대신 연속
 *    실패를 세어 백오프한다(유튜브 수집과 같은 패턴).
 * 3. **판정은 전부 원장에 남긴다.** 문턱 미달('below')도 기록한다 — 화면·이메일이 없으므로
 *    일일 브리핑의 24시간 요약이 그것들의 **유일한 회수 경로**다.
 */

/** 최근 이슈를 프롬프트에 몇 건까지 알려줄지. 너무 많으면 프롬프트가 부풀고 판정이 흐려진다. */
const RECENT_HEADLINE_LIMIT = 12;

let running = false;

/** 연속 실패 백오프. 펄스는 catch-up 이 없으므로 정시 실행 자체를 건너뛰는 방식으로 쉰다. */
let failStreak = 0;
let retryAfter = 0; // epoch ms
const BACKOFF_BASE_MS = 60 * 60 * 1000; // 1시간(= 정시 1회 건너뜀)
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

let lastRun: PulseRunResult | null = null;

export function getLastPulseRun(): PulseRunResult | null {
  return lastRun;
}

export function isPulseRunning(): boolean {
  return running;
}

function nowLabel(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${localDate(d)} ${hh}:${mm}`;
}

function noteOutcome(ok: boolean): void {
  if (ok) {
    if (failStreak > 0) log.info("펄스 정상화 — 백오프 해제");
    failStreak = 0;
    retryAfter = 0;
    return;
  }
  failStreak += 1;
  const wait = Math.min(BACKOFF_BASE_MS * 2 ** (failStreak - 1), BACKOFF_MAX_MS);
  retryAfter = Date.now() + wait;
  log.warn(
    `펄스 연속 실패 ${failStreak}회 → 다음 ${Math.round(wait / 60000)}분 동안 정시 실행 건너뜀`
  );
}

export interface RunPulseOptions {
  /** 귀속 슬롯("HH:mm"). 정시 실행은 cron 이 아는 값을 넘긴다. */
  slot: string;
  trigger: string;
  /** false 면 판정만 하고 문자를 보내지 않는다(수동 점검용). */
  notify?: boolean;
  /** true 면 백오프 게이트를 무시한다(사용자가 직접 누른 실행). */
  force?: boolean;
}

/**
 * 펄스 1회 실행.
 *
 * 어떤 경우에도 throw 하지 않는다 — 스케줄러가 부르는 함수라 예외가 새면 다음 정시까지의
 * 상태(running 플래그)가 오염될 수 있다. 실패는 결과 객체의 `ok:false` 로 표현한다.
 */
export async function runPulse(opts: RunPulseOptions): Promise<PulseRunResult> {
  const startedAt = new Date();
  const date = localDate(startedAt);
  const base: PulseRunResult = {
    slot: opts.slot,
    date,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    ok: false,
    impacts: 0,
    sent: 0,
    queued: 0,
    suppressed: 0,
    error: null,
  };

  if (running) {
    log.warn(`펄스 실행 중 → ${opts.trigger}(${opts.slot}) 건너뜀`);
    return { ...base, error: "이미 실행 중" };
  }
  if (!opts.force && Date.now() < retryAfter) {
    log.info(`펄스 백오프 중 → ${opts.slot} 건너뜀`);
    return { ...base, error: "백오프 중" };
  }
  // 출력 채널이 문자 하나뿐이다. 꺼져 있으면 매시간 LLM 을 돌릴 이유가 없다.
  if (!isPulseNotifyEnabled()) {
    log.info(`iMessage 미설정 → 펄스(${opts.slot}) 건너뜀 (NOTIFY_IMESSAGE/IMESSAGE_TO 확인)`);
    return { ...base, error: "iMessage 미설정" };
  }

  running = true;
  try {
    // ── 1. 보유 종목 (없으면 실행할 이유가 없다) ──
    let holdings: StockHoldingSummary[] = [];
    try {
      holdings = await summarizeHoldings();
    } catch (e) {
      log.warn(`펄스: 보유 종목 조회 실패 — ${(e as Error).message}`);
    }
    if (!holdings.length) {
      log.info(`보유 종목 0건 → 펄스(${opts.slot}) 건너뜀 (보유 종목 탭에서 등록하세요)`);
      return { ...base, ok: true, error: null };
    }

    // ── 2. 결정론적 속보 (실패해도 계속 — 웹검색만으로 진행) ──
    const breaking = await fetchSavetickerNews({ withinHours: 6, limit: 20 });

    // ── 3. 최근 이슈 (프롬프트 단계 중복 억제) ──
    const recent = recentPulseAlerts(config.stockPulse.dedupHours);
    const recentHeadlines = recent.slice(0, RECENT_HEADLINE_LIMIT).map((r) => r.impact.headline);

    // ── 4. 에이전트 판정 ──
    const prompt = buildPulsePrompt({
      now: nowLabel(startedAt),
      slot: opts.slot,
      holdings,
      breaking,
      recentHeadlines,
    });
    const text = await runStockAgent({ mode: "pulse", prompt, label: opts.slot });

    const knownSymbols = new Set(holdings.map((h) => h.symbol.toUpperCase()));
    const parsed = normalizePulse(extractJson(text), knownSymbols);
    if (parsed.dropped) {
      log.warn(`펄스(${opts.slot}): 근거·출처 누락으로 ${parsed.dropped}건 폐기`);
    }
    if (parsed.strippedActions.length) {
      // 프롬프트로 막았는데도 샜다는 뜻이다. 잦아지면 프롬프트를 손봐야 하므로 반드시 남긴다.
      log.warn(
        `펄스(${opts.slot}): 투자 권유 표현 ${parsed.strippedActions.length}건 제거 — ` +
          parsed.strippedActions.slice(0, 5).join(", ")
      );
    }

    // ── 5. 게이트 → 발송 ──
    const counts: GateCounts = countPulseSentToday(date);
    const caps = PULSE_CAPS();
    const threshold = pulseThreshold();
    const quiet = isQuietHour(
      startedAt.getHours(),
      config.stockPulse.quietStartHour,
      config.stockPulse.quietEndHour
    );
    const sendable = opts.notify !== false;

    let sent = 0;
    let queued = 0;
    let suppressed = 0;

    // 강도 높은 순으로 처리한다 — 상한이 있는 이상 순서가 곧 우선순위다(prioritize 주석).
    for (const candidate of prioritize(parsed.impacts)) {
      // 시장 태그는 LLM 값이 아니라 **보유 원장**에서 채운다(판정이 아니라 사실이다).
      const owned = candidate.impact.symbol
        ? holdings.find((h) => h.symbol.toUpperCase() === candidate.impact.symbol)
        : null;
      if (owned) candidate.impact.market = owned.market;

      const decision = decide({ candidate, recent, counts, caps, threshold, quiet });

      if (decision.status === "sent" && sendable) {
        const ok = await sendPulseIMessage(candidate.impact);
        const rec = insertPulseAlert({
          fingerprint: candidate.fingerprint,
          date,
          slot: opts.slot,
          impact: candidate.impact,
          status: ok ? "sent" : "failed",
          sentAt: ok ? new Date().toISOString() : null,
        });
        if (ok) {
          sent++;
          // 같은 실행 안에서 상한·중복이 즉시 반영돼야 한다. 반영하지 않으면 한 번의 펄스가
          // 상한을 무시하고 판정 전부를 발송한다(counts 는 실행 시작 시점의 스냅샷이므로).
          bump(counts, candidate.impact.symbol);
          recent.unshift(rec);
        }
        continue;
      }

      // notify=false(수동 점검·드라이런)면 **어떤 판정도 발송 경로에 올리지 않는다.**
      //
      // ⚠️ 'sent' 만 'below' 로 바꾸면 부족하다. 야간 드라이런에서 'queued' 가 그대로 기록되면
      //    07:00 플러시가 그것들을 **진짜로 발송한다** — 사용자는 보내지 말라고 했는데 몇 시간
      //    뒤에 문자가 오는, 가장 나쁜 종류의 위반이다. 큐잉도 함께 막는다.
      // 'below' 로 기록하는 이유: 이 상태는 중복 판정(recentPulseAlerts)과 상한 집계에서
      //    모두 제외되므로, 드라이런이 이후의 진짜 발송을 가로막지 않는다.
      const status =
        !sendable && (decision.status === "sent" || decision.status === "queued")
          ? "below"
          : decision.status;
      const rec = insertPulseAlert({
        fingerprint: candidate.fingerprint,
        date,
        slot: opts.slot,
        impact: candidate.impact,
        status,
      });
      if (status === "queued") {
        queued++;
        // 보류분도 예산을 쓴다 — 07:00 에 반드시 나가기 때문이다(countPulseSentToday 주석).
        bump(counts, candidate.impact.symbol);
        recent.unshift(rec);
      } else {
        suppressed++;
      }
      // 드라이런이면 사유가 게이트 판정("발송")과 어긋나 보인다 — 그대로 찍으면
      // "[below] … — 발송" 이라는 자기모순 로그가 남아 나중에 원인 추적을 방해한다.
      const why =
        !sendable && decision.status === "sent"
          ? "드라이런(notify=false) — 발송 없이 기록만"
          : decision.reason;
      log.info(`펄스 판정 보류/억제 [${status}] ${candidate.impact.symbol ?? "macro"} — ${why}`);
    }

    const finishedAt = new Date();
    const result: PulseRunResult = {
      ...base,
      finishedAt: finishedAt.toISOString(),
      ok: true,
      impacts: parsed.impacts.length,
      sent,
      queued,
      suppressed,
      error: null,
    };
    lastRun = result;
    noteOutcome(true);
    log.info(
      `펄스 완료 [${opts.trigger}] ${opts.slot} — 판정 ${parsed.impacts.length} / ` +
        `발송 ${sent} / 보류 ${queued} / 억제 ${suppressed}` +
        `${quiet ? " (야간 모드)" : ""} · 속보 ${breaking.length}건 참조`
    );
    return result;
  } catch (e) {
    const msg = (e as Error).message;
    const result: PulseRunResult = {
      ...base,
      finishedAt: new Date().toISOString(),
      ok: false,
      error: msg,
    };
    lastRun = result;
    noteOutcome(false);
    log.error(`펄스 실패 [${opts.trigger}] ${opts.slot}: ${msg}`);
    return result;
  } finally {
    running = false;
  }
}

/** 상한 카운터 증가. 심볼이 null 이면 거시 예산. */
function bump(counts: GateCounts, symbol: string | null): void {
  if (symbol) {
    counts.bySymbol[symbol] = (counts.bySymbol[symbol] ?? 0) + 1;
    counts.total += 1;
  } else {
    counts.macro += 1;
  }
}

/**
 * 야간 보류분 묶음 발송(기본 07:00).
 *
 * 실패한 건은 'failed' 로 표시해 **큐에서 뺀다.** 남겨두면 매일 아침 같은 실패를 재시도하며
 * 며칠 지난 뉴스를 계속 보내려 든다 — 알림 피로의 가장 나쁜 형태다.
 */
export async function flushPulseQueue(trigger: string): Promise<number> {
  const queued = listQueuedPulseAlerts();
  if (!queued.length) return 0;
  if (!isPulseNotifyEnabled()) {
    log.warn(`펄스 묶음 발송 불가(iMessage 미설정) — 보류 ${queued.length}건 유지`);
    return 0;
  }
  const ok = await sendPulseDigest(queued);
  const ids = queued.map((q) => q.id);
  if (ok) markPulseAlertsSent(ids);
  else markPulseAlertsFailed(ids);
  log.info(`펄스 야간 보류 플러시 [${trigger}] ${queued.length}건 → ${ok ? "발송" : "실패"}`);
  return ok ? queued.length : 0;
}
