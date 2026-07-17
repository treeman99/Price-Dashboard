import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { localDate } from "../util/date.ts";
import { ensureSeedTickers, listStocks } from "./tickers.ts";
import { upsertStockPoints, startStockRun, finishStockRun, getStockRun } from "../db/repo.ts";
import { searchTicker, fetchHistory, fetchIndexHistory, fetchExchangeRate } from "./quote.ts";
import {
  isMarketClosed,
  lastUsSessionDate,
  nextKrSessionDate,
  markClosedIfNoSession,
} from "./calendar.ts";
import {
  curateStock,
  emptySnapshot,
  holidaySnapshot,
  type StockQuoteRow,
  type IndexQuoteRow,
} from "./curate.ts";
import { sendStockEmail, sendStockIMessage } from "../notify/stock-email.ts";
import type { StockMarket, StockSnapshot, StockPoint, StockWatchItem } from "../../shared/types.ts";

/** 차트·이동평균에 쓰는 거래일 수. */
const HISTORY_DAYS = 20;

/**
 * 스냅샷은 **시장별로 분리 저장**한다.
 * 단일 파일이면 18:00 미국장 런이 같은 날 08:00 한국장 브리핑을 덮어써서 사라진다.
 */
function snapshotPath(market: StockMarket): string {
  return path.join(path.dirname(config.dbPath), `stock-${market}-latest.json`);
}

const memo = new Map<StockMarket, StockSnapshot>();
const running = new Map<StockMarket, boolean>();

function loadFromDisk(market: StockMarket): StockSnapshot | null {
  try {
    const p = snapshotPath(market);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")) as StockSnapshot;
  } catch (e) {
    log.warn(`증시 스냅샷 로드 실패 [${market}]: ${(e as Error).message}`);
  }
  return null;
}

function saveToDisk(s: StockSnapshot): void {
  try {
    const p = snapshotPath(s.market);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
  } catch (e) {
    log.warn(`증시 스냅샷 저장 실패 [${s.market}]: ${(e as Error).message}`);
  }
}

/** 현재 캐시된 스냅샷 (메모리 우선, 없으면 디스크) */
export function getStockSnapshot(market: StockMarket): StockSnapshot | null {
  const m = memo.get(market);
  if (m) return m;
  const d = loadFromDisk(market);
  if (d) memo.set(market, d);
  return d;
}

/** 오늘자 스냅샷이 이미 있는지 (catch-up 판단). 휴장 스냅샷도 '있음'으로 친다. */
export function hasTodayStockSnapshot(market: StockMarket): boolean {
  return getStockSnapshot(market)?.date === localDate();
}

/** 현재 해당 시장 수집이 진행 중인지 (API가 '수집 중' 안내에 사용) */
export function isStockCollecting(market: StockMarket): boolean {
  return running.get(market) === true;
}

// ── 시세 파생 지표 (전부 quote.ts 가 가져온 점에서 계산 — LLM 미개입) ──

/** 최근 n거래일 종가 단순이동평균. 점이 부족하거나 종가가 없으면 null. */
function movingAverage(points: StockPoint[], n: number): number | null {
  const closes = points
    .slice(-n)
    .map((p) => p.close)
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  if (closes.length < n) return null;
  return closes.reduce((a, b) => a + b, 0) / closes.length;
}

/** 5거래일 등락률. 6개 점(오늘 + 5거래일 전)이 있어야 계산 가능. */
function weekChange(points: StockPoint[]): number | null {
  if (points.length < 6) return null;
  const last = points[points.length - 1]?.close;
  const base = points[points.length - 6]?.close;
  if (typeof last !== "number" || typeof base !== "number" || base === 0) return null;
  return ((last - base) / base) * 100;
}

function lastPoint(points: StockPoint[]): StockPoint | null {
  return points.length ? points[points.length - 1] : null;
}

interface Gathered {
  quotes: StockQuoteRow[];
  histories: Map<string, StockPoint[]>;
  indices: IndexQuoteRow[];
  indexHistories: Map<string, StockPoint[]>;
  exchangeRate: { value: number; changePct: number | null } | null;
  /** 지수 시계열 중 하나라도 확보했는지 — 실증 휴장 폴백 판정에 쓴다. */
  indexPoints: StockPoint[];
}

/**
 * 등록 종목·지수·환율의 확정 시세를 모은다.
 * 종목별 try/catch 로 **실패를 격리**한다 — 한 종목이 죽어도 브리핑 전체가 날아가면 안 된다.
 * quote.ts 가 호출마다 config.stockFetchDelayMs 를 sleep 하므로 여기서는 순차 호출만 지킨다.
 */
async function gather(market: StockMarket): Promise<Gathered> {
  const tickers = listStocks(market);
  const quotes: StockQuoteRow[] = [];
  const histories = new Map<string, StockPoint[]>();

  for (const t of tickers) {
    let points: StockPoint[] = [];
    try {
      points = await fetchHistory(t.quoteCode, market, HISTORY_DAYS);
      if (points.length) {
        // 저장은 종목별로 — upsertStockPoints 가 자체 트랜잭션을 열기 때문에
        // 여러 종목을 하나의 큰 트랜잭션으로 묶으면 중첩 BEGIN 으로 throw 한다.
        upsertStockPoints(t.id, points, "naver");
      }
    } catch (e) {
      log.warn(`증시 시세 조회 실패 [${market}] ${t.name}(${t.symbol}): ${(e as Error).message}`);
      points = [];
    }
    const last = lastPoint(points);
    histories.set(t.symbol.toUpperCase(), points);
    quotes.push({
      symbol: t.symbol,
      name: t.name,
      quoteCode: t.quoteCode,
      exchange: t.exchange,
      close: last?.close ?? null,
      changePct: last?.changePct ?? null,
      weekChangePct: weekChange(points),
      ma5: movingAverage(points, 5),
      ma20: movingAverage(points, 20),
      currency: last?.currency ?? (market === "kr" ? "KRW" : "USD"),
    });
  }

  const indices: IndexQuoteRow[] = [];
  const indexHistories = new Map<string, StockPoint[]>();
  let indexPoints: StockPoint[] = [];
  try {
    for (const idx of await fetchIndexHistory(market, HISTORY_DAYS)) {
      const last = lastPoint(idx.points);
      indexHistories.set(idx.name, idx.points);
      if (idx.points.length > indexPoints.length) indexPoints = idx.points;
      indices.push({
        name: idx.name,
        value: last?.close ?? null,
        changePct: last?.changePct ?? null,
      });
    }
  } catch (e) {
    log.warn(`증시 지수 조회 실패 [${market}]: ${(e as Error).message}`);
  }

  // 환율은 한국장 브리핑의 핵심 지표지만, 실패해도 브리핑은 낸다.
  let exchangeRate: { value: number; changePct: number | null } | null = null;
  try {
    exchangeRate = await fetchExchangeRate();
  } catch (e) {
    log.warn(`환율 조회 실패: ${(e as Error).message}`);
  }

  return { quotes, histories, indices, indexHistories, exchangeRate, indexPoints };
}

/**
 * watchlist 종목의 시세를 사후 조회해 채운다.
 * ⚠️ **실패해도 항목을 드롭하지 않는다** — 시세를 못 붙였을 뿐 "시장에서 거론된다"는
 * 사실 자체는 유효하다. verified=false 로 남겨 화면이 '시세 미검증'을 표시하게 한다.
 */
async function verifyWatchlist(
  items: StockWatchItem[],
  market: StockMarket
): Promise<StockWatchItem[]> {
  const out: StockWatchItem[] = [];
  for (const w of items) {
    try {
      const candidates = await searchTicker(w.symbol || w.name);
      const inMarket = candidates.filter((c) => c.market === market);
      // 심볼이 정확히 일치할 때만 채택한다. "같은 시장의 첫 후보"로 폴백하면 LLM 이 심볼을
      // 틀렸을 때 **엉뚱한 종목의 시세**가 붙는데, 표시명까지 조회 결과로 교체되므로
      // 화면상으로는 앞뒤가 맞아 보여 아무도 눈치채지 못한다. 지어낸 숫자를 막으려고 만든
      // 검증 계층이 정반대로 동작하는 최악의 경로라, 확신이 없으면 시세를 붙이지 않는다.
      // 심볼 없이 이름만 온 경우에 한해 이름 완전일치를 허용한다.
      const hit = w.symbol
        ? inMarket.find((c) => c.symbol.toUpperCase() === w.symbol.toUpperCase())
        : inMarket.find((c) => c.name === w.name);
      if (!hit) {
        log.info(
          `관심 종목 시세 미검증 [${market}] ${w.name}(${w.symbol}): 심볼 일치 후보 없음 ` +
            `(후보: ${inMarket.map((c) => c.symbol).join(",") || "없음"})`
        );
        out.push(w);
        continue;
      }
      const points = await fetchHistory(hit.quoteCode, market, HISTORY_DAYS);
      const last = lastPoint(points);
      if (!last) {
        out.push({ ...w, symbol: hit.symbol, name: hit.name || w.name, quoteCode: hit.quoteCode });
        continue;
      }
      out.push({
        ...w,
        symbol: hit.symbol,
        name: hit.name || w.name,
        quoteCode: hit.quoteCode,
        close: last.close,
        changePct: last.changePct,
        weekChangePct: weekChange(points),
        currency: last.currency,
        history: points,
        ma5: movingAverage(points, 5),
        ma20: movingAverage(points, 20),
        verified: last.close != null,
      });
    } catch (e) {
      // searchTicker 는 실패 시 throw 한다(quote.ts 계약) — 우아한 저하.
      log.info(`관심 종목 시세 미검증 [${market}] ${w.name}(${w.symbol}): ${(e as Error).message}`);
      out.push(w);
    }
  }
  return out;
}

/** 알림 발송 원장(stock_runs.detail)에 기록된 채널별 발송 여부. */
function priorNotified(date: string, market: StockMarket): { email: boolean; imessage: boolean } {
  const d = getStockRun(date, market)?.detail as
    | { notified?: { email?: boolean; imessage?: boolean } }
    | null
    | undefined;
  return { email: d?.notified?.email === true, imessage: d?.notified?.imessage === true };
}

export interface RefreshStockOptions {
  market: StockMarket;
  trigger: string;
  notify?: boolean;
}

/**
 * 증시 브리핑 수집: 휴장 체크 → 확정 시세 수집 → LLM 서술 → 시세 덮어쓰기 → 저장 → 알림.
 * 이력은 저장하지 않고 시장별 최신 스냅샷만 덮어쓴다(시계열은 stock_points 에 별도 저장).
 */
export async function refreshStock(opts: RefreshStockOptions): Promise<StockSnapshot> {
  const { market, trigger } = opts;
  if (running.get(market)) {
    log.warn(`증시 수집 진행 중 [${market}] → ${trigger} 중복 방지`);
    return getStockSnapshot(market) ?? emptySnapshot(market, localDate(), "아직 수집되지 않았습니다.");
  }
  running.set(market, true);
  try {
    const now = new Date();
    const today = localDate(now);
    const prev = getStockSnapshot(market);
    startStockRun(today, market);
    ensureSeedTickers();

    // ── 1. 휴장 체크 (LLM 호출 전에 — 휴장이면 토큰을 한 푼도 쓰지 않는다) ──
    const closed = await resolveSession(market, now, today);
    if (closed.holiday) {
      // ⚠️ 휴장 스냅샷의 date 는 반드시 **오늘**(수집일)이다. sessionDate 를 넣으면
      // hasTodayStockSnapshot()이 계속 false 라 30분 catch-up 이 무한 재시도한다.
      const snap = holidaySnapshot(market, today, closed.sessionDate, closed.reason);
      memo.set(market, snap);
      saveToDisk(snap);
      finishStockRun(today, market, true, {
        closed: true,
        reason: closed.reason,
        notified: { email: false, imessage: false },
      });
      log.info(`증시 휴장 [${market}] ${today} — ${closed.reason ?? "사유 미상"} (LLM·알림 생략)`);
      return snap;
    }
    const sessionDate = closed.sessionDate;

    // ── 2. 확정 시세 수집 ──
    const g = await gather(market);

    // ── 2-b. 실증 휴장 폴백 (달력이 놓친 휴장의 마지막 방어선) ──
    // 미국장에만 적용한다. 한국장 08:00 브리핑은 **개장 전**이라 오늘 세션 데이터가
    // 아직 존재하지 않는 게 정상이고, 여기에 이 판정을 걸면 매일 휴장으로 오판한다.
    if (market === "us" && g.indexPoints.length && sessionDate) {
      if (markClosedIfNoSession(market, sessionDate, g.indexPoints)) {
        const snap = holidaySnapshot(market, today, sessionDate, "휴장(시세 없음)");
        memo.set(market, snap);
        saveToDisk(snap);
        finishStockRun(today, market, true, {
          closed: true,
          reason: "휴장(시세 없음)",
          notified: { email: false, imessage: false },
        });
        log.info(`증시 실증 휴장 [${market}] ${sessionDate} 세션 데이터 없음 → 브리핑 생략`);
        return snap;
      }
    }

    // ── 3. LLM 서술 (숫자는 전부 g 에서 나온다) ──
    const curated = await curateStock({
      market,
      today,
      sessionDate,
      now: nowLabel(now),
      quotes: g.quotes,
      indices: g.indices,
      exchangeRate: g.exchangeRate,
      histories: g.histories,
      indexHistories: g.indexHistories,
    });

    // ── 4. 검증: watchlist 시세 사후 조회 ──
    const snapshot: StockSnapshot =
      curated.source === "llm"
        ? { ...curated, watchlist: await verifyWatchlist(curated.watchlist, market) }
        : curated;

    // ── 5. 저장 (후퇴 방지 가드) ──
    // 수집 실패(source="empty")로 정상 브리핑을 빈 화면으로 덮어쓰지 않는다.
    // "holiday"는 이 조건에 걸리지 않아 정상 저장된다(휴장은 실패가 아니라 정상 결과).
    if (snapshot.source === "empty" && prev?.source === "llm") {
      log.warn(`증시 수집 실패 [${market}] → 기존 스냅샷 유지 (${snapshot.notes ?? "원인 미상"})`);
      finishStockRun(today, market, false, {
        error: snapshot.notes,
        notified: priorNotified(today, market),
      });
      return prev;
    }
    memo.set(market, snapshot);
    saveToDisk(snapshot);

    // ── 6. 알림 (stock_runs 원장으로 채널별 멱등 — 같은 날 재실행 시 재발송 금지) ──
    const ok = snapshot.source === "llm";
    let { email: emailed, imessage: imessaged } = priorNotified(today, market);
    const hasContent =
      snapshot.indices.length + snapshot.news.length + snapshot.analyses.length > 0;
    if (opts.notify && ok && hasContent && (!emailed || !imessaged)) {
      if (!emailed) {
        emailed = await sendStockEmail(snapshot).catch((e) => {
          log.warn(`증시 이메일 발송 예외 [${market}]: ${(e as Error).message}`);
          return false;
        });
      }
      if (!imessaged) {
        imessaged = await sendStockIMessage(snapshot).catch((e) => {
          log.warn(`증시 iMessage 발송 예외 [${market}]: ${(e as Error).message}`);
          return false;
        });
      }
    } else if (opts.notify && ok && !hasContent) {
      log.info(`증시 브리핑 내용 0건 [${market}] → 알림 발송 생략`);
    }

    finishStockRun(today, market, ok, {
      sessionDate,
      source: snapshot.source,
      notified: { email: emailed, imessage: imessaged },
    });
    log.info(
      `증시 수집 완료 [${trigger}] [${market}] ${today} (거래일 ${sessionDate ?? "미상"}, ` +
        `source=${snapshot.source}, 분석 ${snapshot.analyses.length} / 관심 ${snapshot.watchlist.length})`
    );
    return snapshot;
  } finally {
    running.set(market, false);
  }
}

/**
 * 대상 거래일과 휴장 여부를 정한다.
 *
 * - 한국장(08:00, 개장 전 프리뷰): 대상은 **오늘 세션**. nextKrSessionDate 가 오늘이 아닌 날을
 *   돌려주면 오늘은 거래일이 아니다 → 휴장.
 * - 미국장(18:00 KST = 뉴욕 당일 04~05시): 결산 대상은 직전 거래일(lastUsSessionDate),
 *   프리뷰 대상은 **오늘 밤 세션**(뉴욕 날짜 = KST 날짜, 이 수집 시각에서만 성립).
 *   오늘 밤 세션이 없으면(주말·휴장) 프리뷰할 게 없으므로 휴장 처리한다. 직전 거래일 결산은
 *   다음 거래일 런이 이어받으므로 누락되지 않는다(예: 금요일 마감 → 월요일 18:00 런이 결산).
 */
async function resolveSession(
  market: StockMarket,
  now: Date,
  today: string
): Promise<{ holiday: boolean; sessionDate: string | null; reason: string | null }> {
  if (market === "kr") {
    const next = await nextKrSessionDate(now);
    if (next === today) return { holiday: false, sessionDate: today, reason: null };
    const { reason } = await isMarketClosed("kr", today);
    return { holiday: true, sessionDate: next, reason: reason ?? "휴장" };
  }
  const tonight = await isMarketClosed("us", today);
  const last = await lastUsSessionDate(now);
  if (tonight.closed) return { holiday: true, sessionDate: last, reason: tonight.reason ?? "휴장" };
  return { holiday: false, sessionDate: last, reason: null };
}

/** 현재 시각 라벨 "YYYY-MM-DD HH:mm" (뉴스/유튜브 큐레이터와 동일 포맷). */
function nowLabel(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${localDate(d)} ${hh}:${mm}`;
}
