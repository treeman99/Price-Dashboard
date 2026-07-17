import { config } from "../config.ts";
import { log } from "../util/log.ts";
import type { StockMarket, StockPoint, StockSearchCandidate } from "../../shared/types.ts";

/**
 * 네이버 증권 비공개 API 로 **결정론적 시세**를 가져온다.
 *
 * 이 모듈이 존재하는 이유: LLM 이 주가를 지어내는 것을 막기 위해서다.
 * 브리핑에 실리는 모든 숫자는 반드시 여기를 거친다 — LLM 은 서술만 담당한다.
 *
 * 야후 파이낸스는 쓰지 않는다(이 회선에서 HTTP 429 로 차단됨).
 */

/** 네이버 비공개 API 는 브라우저 UA 가 없으면 응답을 주지 않는다. */
const NAVER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 미국 지수: 네이버 내부 코드 ↔ 표시명. `SPI@SPX` 는 409 라 쓸 수 없다. */
const US_INDICES = [
  { name: "다우", code: ".DJI" },
  { name: "S&P 500", code: ".INX" },
  { name: "나스닥", code: ".IXIC" },
] as const;

/** 한국 지수: siseJson 의 symbol 값이 곧 코드다. */
const KR_INDICES = [
  { name: "코스피", code: "KOSPI" },
  { name: "코스닥", code: "KOSDAQ" },
] as const;

function currencyOf(market: StockMarket): string {
  return market === "kr" ? "KRW" : "USD";
}

/**
 * 네이버는 숫자를 그냥 number 로 주기도 하고 `"1,486.50"` 처럼 콤마 문자열로 주기도 한다.
 * 어느 쪽이든 유한수만 통과시키고 나머지는 null — 지어낸 값이 흘러들지 않게 하는 마지막 방어선.
 */
export function parseNaverNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/,/g, "").trim();
  // Number("") 는 0 이다 — 빈 값을 0 으로 흘리면 '가격 0원'이라는 그럴듯한 거짓이 차트에 박힌다.
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "20260617" → "2026-06-17". 형식이 어긋나면 null(거래일이 밀리는 것보다 버리는 게 낫다). */
export function parseLocalDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** 차트 API 원본 행(도메스틱/포린/지수 공통 필드만). */
interface RawChartRow {
  localDate?: unknown;
  closePrice?: unknown;
  accumulatedTradingVolume?: unknown;
}

/**
 * 차트 API 응답 → StockPoint[]. 오름차순 정렬 후 **직전 종가 대비 changePct 를 여기서 계산**한다.
 * (LLM 이나 프론트가 계산하면 값이 갈리므로 서버가 단일 진실로 확정한다.)
 */
export function normalizeChartRows(rows: RawChartRow[], currency: string): StockPoint[] {
  const points = rows
    .map((r) => ({
      date: parseLocalDate(r.localDate),
      close: parseNaverNumber(r.closePrice),
      volume: parseNaverNumber(r.accumulatedTradingVolume),
    }))
    .filter((p): p is { date: string; close: number | null; volume: number | null } => p.date != null)
    .sort((a, b) => a.date.localeCompare(b.date));

  return points.map((p, i) => withChange(p, i > 0 ? points[i - 1].close : null, currency));
}

/** 직전 종가를 붙여 changePct 를 확정한다. prev 가 0 이면 나눗셈이 무한대라 null 로 둔다. */
function withChange(
  p: { date: string; close: number | null; volume: number | null },
  prevClose: number | null,
  currency: string
): StockPoint {
  const changePct =
    p.close != null && prevClose != null && prevClose !== 0
      ? ((p.close - prevClose) / prevClose) * 100
      : null;
  return {
    date: p.date,
    close: p.close,
    prevClose,
    changePct: changePct != null && Number.isFinite(changePct) ? changePct : null,
    volume: p.volume,
    currency,
  };
}

/**
 * siseJson.naver 응답 → 행 배열.
 * **JSON 이 아니다.** 파이썬 리터럴 형태의 텍스트라 작은따옴표를 큰따옴표로 바꿔야 파싱된다.
 * 첫 행은 헤더('날짜','시가',...)라 버린다.
 */
export function parseSiseJson(text: string): Array<{ localDate: string; closePrice: number; accumulatedTradingVolume: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/'/g, '"'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Array<{ localDate: string; closePrice: number; accumulatedTradingVolume: number }> = [];
  for (const row of parsed) {
    // [날짜, 시가, 고가, 저가, 종가, 거래량, 외국인소진율] — 헤더 행은 날짜 자리가 'YYYYMMDD' 가 아니라 걸러진다.
    if (!Array.isArray(row) || row.length < 6) continue;
    const date = parseLocalDate(row[0]);
    const close = parseNaverNumber(row[4]);
    if (date == null || close == null) continue;
    out.push({
      localDate: (row[0] as string).trim(),
      closePrice: close,
      accumulatedTradingVolume: parseNaverNumber(row[5]) ?? 0,
    });
  }
  return out;
}

/** 재시도 2회. 실패는 null — 시세 한 건 때문에 브리핑 전체가 죽으면 안 된다. */
async function fetchNaver(url: string, label: string, timeoutMs = 10000): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        signal: ac.signal,
        headers: { "User-Agent": NAVER_UA, "Accept-Language": "ko-KR,ko;q=0.9" },
      });
      if (r.ok) return r;
      log.warn(`네이버 시세 ${label}: HTTP ${r.status} (시도 ${attempt + 1}/2)`);
    } catch (e) {
      log.warn(`네이버 시세 ${label}: 요청 실패 (시도 ${attempt + 1}/2) — ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (attempt === 0) await sleep(500);
  }
  return null;
}

/** 네이버 매너 — 호출 사이에 항상 쉬어 준다. */
async function politeDelay(): Promise<void> {
  if (config.stockFetchDelayMs > 0) await sleep(config.stockFetchDelayMs);
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * N거래일을 받으려면 달력일로는 훨씬 넓게 잡아야 한다(주말 2/7 + 공휴일).
 * 20거래일 ≈ 28달력일이지만 연휴가 겹칠 수 있어 2배 + 15일로 여유를 둔다.
 */
function calendarRange(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - (days * 2 + 15) * 86400000);
  return { start: ymd(start), end: ymd(end) };
}

/** 자동완성 원본 항목. */
interface RawAcItem {
  code?: unknown;
  name?: unknown;
  typeName?: unknown;
  reutersCode?: unknown;
  nationCode?: unknown;
  category?: unknown;
}

/**
 * 자동완성 응답 → 후보 목록. category="stock" 만, nationCode 로 시장을 가른다.
 * KOR/USA 외(일본·홍콩 등)는 시세 조회 경로가 없어 버린다.
 */
export function normalizeSearchItems(items: RawAcItem[]): StockSearchCandidate[] {
  const out: StockSearchCandidate[] = [];
  for (const it of items) {
    if (it.category !== "stock") continue;
    const market: StockMarket | null =
      it.nationCode === "KOR" ? "kr" : it.nationCode === "USA" ? "us" : null;
    if (market == null) continue;
    const code = typeof it.code === "string" ? it.code.trim() : "";
    const name = typeof it.name === "string" ? it.name.trim() : "";
    // quoteCode 가 없으면 시세를 못 가져오므로 후보로 내보내면 안 된다.
    const quoteCode = typeof it.reutersCode === "string" ? it.reutersCode.trim() : "";
    if (!code || !name || !quoteCode) continue;
    out.push({
      market,
      symbol: market === "us" ? code.toUpperCase() : code,
      name,
      quoteCode,
      exchange: typeof it.typeName === "string" ? it.typeName.trim() : "",
    });
  }
  return out;
}

/**
 * 종목 검색(자동완성). 종목코드·티커·종목명 아무거나 받는다.
 * 다른 함수와 달리 **throw 한다** — 호출자가 사용자에게 "검색 실패"를 보여줘야 하기 때문.
 */
export async function searchTicker(query: string): Promise<StockSearchCandidate[]> {
  const q = query.trim();
  if (!q) return [];
  const url = `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=index,stock,marketindicator`;
  const r = await fetchNaver(url, `자동완성(${q})`);
  if (!r) throw new Error(`종목 검색 실패: 네이버 자동완성에 연결할 수 없습니다 (${q})`);
  const data = (await r.json()) as { items?: RawAcItem[] };
  await politeDelay();
  return normalizeSearchItems(Array.isArray(data.items) ? data.items : []);
}

/**
 * 최근 N거래일 종가. 오름차순(오래된→최신).
 *
 * 반환 구간보다 넓게 조회해서 changePct 를 먼저 계산한 뒤 마지막 N개만 자른다 —
 * 그래야 **첫 점에도 진짜 직전 종가**가 붙는다(잘라낸 뒤 계산하면 첫 점 changePct 가 항상 null).
 */
export async function fetchHistory(
  quoteCode: string,
  market: StockMarket,
  days: number
): Promise<StockPoint[]> {
  if (days <= 0) return [];
  const { start, end } = calendarRange(days);
  const path = market === "kr" ? "domestic" : "foreign";
  const url = `https://api.stock.naver.com/chart/${path}/item/${encodeURIComponent(quoteCode)}/day?startDateTime=${start}0000&endDateTime=${end}2359`;

  const r = await fetchNaver(url, `일별차트(${quoteCode})`);
  await politeDelay();
  if (!r) return [];
  try {
    const rows = (await r.json()) as RawChartRow[];
    if (!Array.isArray(rows)) return [];
    return normalizeChartRows(rows, currencyOf(market)).slice(-days);
  } catch (e) {
    log.warn(`네이버 시세 일별차트(${quoteCode}): 응답 파싱 실패 — ${(e as Error).message}`);
    return [];
  }
}

/** 한국 지수 — siseJson(텍스트 리터럴)만이 지수 시계열을 준다. */
async function fetchKrIndexHistory(code: string, days: number): Promise<StockPoint[]> {
  const { start, end } = calendarRange(days);
  const url = `https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${start}&endTime=${end}&timeframe=day`;
  const r = await fetchNaver(url, `지수(${code})`);
  await politeDelay();
  if (!r) return [];
  const rows = parseSiseJson(await r.text());
  return normalizeChartRows(rows, "KRW").slice(-days);
}

/** 미국 지수 — /index/{code}/basic 은 현재가만 주므로 시계열은 foreign 지수 차트에서 받는다(라이브 확인함). */
async function fetchUsIndexHistory(code: string, days: number): Promise<StockPoint[]> {
  const { start, end } = calendarRange(days);
  const url = `https://api.stock.naver.com/chart/foreign/index/${encodeURIComponent(code)}/day?startDateTime=${start}0000&endDateTime=${end}2359`;
  const r = await fetchNaver(url, `지수(${code})`);
  await politeDelay();
  if (!r) return [];
  try {
    const rows = (await r.json()) as RawChartRow[];
    if (!Array.isArray(rows)) return [];
    return normalizeChartRows(rows, "USD").slice(-days);
  } catch (e) {
    log.warn(`네이버 시세 지수(${code}): 응답 파싱 실패 — ${(e as Error).message}`);
    return [];
  }
}

/** 시장별 주요 지수의 최근 N거래일. kr=코스피·코스닥, us=다우·S&P500·나스닥. */
export async function fetchIndexHistory(
  market: StockMarket,
  days: number
): Promise<Array<{ name: string; code: string; points: StockPoint[] }>> {
  const defs = market === "kr" ? KR_INDICES : US_INDICES;
  const out: Array<{ name: string; code: string; points: StockPoint[] }> = [];
  // 네이버 부하를 피해 순차 조회한다(politeDelay 가 각 호출 뒤에 들어간다).
  for (const def of defs) {
    const points =
      market === "kr"
        ? await fetchKrIndexHistory(def.code, days)
        : await fetchUsIndexHistory(def.code, days);
    if (points.length === 0) log.warn(`네이버 시세: ${def.name}(${def.code}) 시계열 비어 있음`);
    out.push({ name: def.name, code: def.code, points });
  }
  return out;
}

/** 원달러 환율(하나은행 고시). 실패 시 null. */
export async function fetchExchangeRate(): Promise<{ value: number; changePct: number | null } | null> {
  const r = await fetchNaver("https://api.stock.naver.com/marketindex/exchange/FX_USDKRW", "환율");
  await politeDelay();
  if (!r) return null;
  try {
    const d = (await r.json()) as { exchangeInfo?: { closePrice?: unknown; fluctuationsRatio?: unknown } };
    const value = parseNaverNumber(d.exchangeInfo?.closePrice);
    if (value == null) return null;
    return { value, changePct: parseNaverNumber(d.exchangeInfo?.fluctuationsRatio) };
  } catch (e) {
    log.warn(`네이버 시세 환율: 응답 파싱 실패 — ${(e as Error).message}`);
    return null;
  }
}
