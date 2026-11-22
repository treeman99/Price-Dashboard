import { log } from "../util/log.ts";
import { getTabSettings } from "../settings/tab-settings.ts";
import { localDate } from "../util/date.ts";
import { runStockAgent, extractJson } from "./agent.ts";
import { buildPulsePrompt, normalizePulse } from "./pulse-prompt.ts";
import { decide, isQuietHour, prioritize, type GateCounts } from "./pulse-gate.ts";
import { gatePulseLanguage } from "./language-gate.ts";
import { fetchSavetickerNews } from "./saveticker.ts";
import { summarizeHoldings } from "./holdings.ts";
import { countPulseSentToday, insertPulseAlert, recentPulseAlerts } from "../db/repo.ts";
import { pulseThreshold, PULSE_CAPS } from "./pulse-policy.ts";
import type { PulseRunResult, StockHoldingSummary } from "../../shared/types.ts";

/**
 * 시간당 펄스 오케스트레이션: 보유 조회 → 속보 수집 → 에이전트 판정 → 게이트 → 원장 기록.
 *
 * 2026-11-22: 메일·문자 발송 기능을 제거했다. 예전에는 게이트를 통과한 판정을 iMessage 로 보내고
 * 야간분은 큐에 보류했다가 아침에 묶어 보냈지만, 지금은 **어떤 판정도 발송하지 않는다.** 발송 대상이던
 * 판정은 'muted'(판정만 기록)로 원장에 남아 일일 브리핑의 '지난 24시간 펄스 요약'을 계속 채운다.
 * 실행 on/off 의 정본은 대시보드 스케줄(stockPulse enabled)이다.
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
    // 정책 값은 실행 시작 시점에 한 번 읽는다(저장 즉시 반영 + 한 실행 안에서는 일관).
    const policy = getTabSettings().stockPulse;
    const recent = recentPulseAlerts(policy.dedupHours);
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

    // 외국 문자 검사. 게이트·원장·발송이 전부 이 뒤라서 나가는 문구는 모두 여기를 지난다.
    await gatePulseLanguage(parsed, opts.slot);

    // ── 5. 게이트 → 원장 기록(발송 없음) ──
    const counts: GateCounts = countPulseSentToday(date);
    const caps = PULSE_CAPS();
    const threshold = pulseThreshold();
    const quiet = isQuietHour(startedAt.getHours(), policy.quietStartHour, policy.quietEndHour);

    let suppressed = 0;
    let muted = 0;

    // 강도 높은 순으로 처리한다 — 상한이 있는 이상 순서가 곧 우선순위다(prioritize 주석).
    for (const candidate of prioritize(parsed.impacts)) {
      // 시장 태그는 LLM 값이 아니라 **보유 원장**에서 채운다(판정이 아니라 사실이다).
      const owned = candidate.impact.symbol
        ? holdings.find((h) => h.symbol.toUpperCase() === candidate.impact.symbol)
        : null;
      if (owned) candidate.impact.market = owned.market;

      const decision = decide({
        candidate,
        recent,
        counts,
        caps,
        threshold,
        quiet,
        dedupHours: policy.dedupHours,
      });

      // 예전 발송·보류 대상('sent'·'queued')은 전부 'muted' 로 남긴다. muted 는 상한·중복 집계에서
      // 빠지므로 판정이 이후 판정을 가로막지 않고, 큐에도 들어가지 않아 나중에 몰아 보낼 것이 없다.
      const wouldReach = decision.status === "sent" || decision.status === "queued";
      const status = wouldReach ? "muted" : decision.status;
      insertPulseAlert({
        fingerprint: candidate.fingerprint,
        date,
        slot: opts.slot,
        impact: candidate.impact,
        status,
      });
      suppressed++;
      if (status === "muted") muted++;
      const why = status === "muted" ? `발송 기능 제거 — 판정만 기록 (게이트: ${decision.reason})` : decision.reason;
      log.info(`펄스 판정 기록 [${status}] ${candidate.impact.symbol ?? "macro"} — ${why}`);
    }

    const finishedAt = new Date();
    const result: PulseRunResult = {
      ...base,
      finishedAt: finishedAt.toISOString(),
      ok: true,
      impacts: parsed.impacts.length,
      sent: 0,
      queued: 0,
      suppressed,
      error: null,
    };
    lastRun = result;
    noteOutcome(true);
    log.info(
      `펄스 완료 [${opts.trigger}] ${opts.slot} — 판정 ${parsed.impacts.length} / ` +
        `기록 ${suppressed}(발송 대상이던 판정 ${muted})` +
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
