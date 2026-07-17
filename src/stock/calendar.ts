import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import type { StockMarket } from "../../shared/types.ts";

/**
 * 증시 휴장일 판정.
 *
 * 미국(NYSE)은 휴장일이 전부 규칙이라 100% 알고리즘으로 유도한다(데이터 불필요).
 * 한국(KRX)은 설·추석이 음력이고 대체공휴일이 정부 고시라 계산이 불가능해서 3계층으로 판정한다:
 *   1) 주말 컷 → 2) 공공데이터포털 「특일 정보」 원장(연 단위 캐시) → 3) 실증 폴백(markClosedIfNoSession)
 */

const DAY_MS = 86_400_000;

/** 휴장 연휴가 아무리 길어도 이 범위를 넘지 않는다(설·추석+주말 최대 ~10일). 무한 루프 방지용. */
const SESSION_SCAN_LIMIT = 30;

/** NYSE 정규장 마감(뉴욕 로컬 16:00). 이 시각 전이면 '오늘'은 아직 마감된 거래일이 아니다. */
const NYSE_CLOSE_HOUR = 16;

// ── 순수 날짜 헬퍼 ────────────────────────────────────────
// 전부 UTC 기준으로 다룬다. 로컬 타임존이 끼면 서머타임·날짜경계에서 하루가 밀린다.

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function parseYmd(date: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`날짜 형식이 올바르지 않습니다(YYYY-MM-DD): ${date}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) throw new Error(`존재하지 않는 날짜입니다: ${date}`);
  return d;
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** date 에서 n 일 이동한 날짜. n 은 음수 가능. */
function addDays(date: string, n: number): string {
  return ymd(new Date(parseYmd(date).getTime() + n * DAY_MS));
}

/** 0=일 … 6=토 */
function dayOfWeek(date: string): number {
  return parseYmd(date).getUTCDay();
}

export function isWeekend(date: string): boolean {
  const d = dayOfWeek(date);
  return d === 0 || d === 6;
}

/**
 * 부활절 일요일 (Anonymous Gregorian computus).
 * 2024-03-31 / 2025-04-20 / 2026-04-05 로 검증했다.
 */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** 해당 월의 n 번째 weekday(0=일…6=토). 예: nthWeekday(2026, 1, 1, 3) = 1월 셋째 월요일 */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return ymd(new Date(Date.UTC(year, month - 1, 1 + shift + (n - 1) * 7)));
}

/** 해당 월의 마지막 weekday. 예: lastWeekday(2026, 5, 1) = 5월 마지막 월요일(메모리얼 데이) */
function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0)); // month 의 0일 = 이전 달 마지막 날 = 해당 월 말일
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return ymd(new Date(last.getTime() - back * DAY_MS));
}

/**
 * 주말 관측 이동: 토요일이면 전날 금요일, 일요일이면 다음 월요일로 휴장을 옮긴다.
 * (NYSE Rule 7.2. 신정만 예외 — nyseHolidays 주석 참고)
 */
function observed(date: string): string {
  const d = dayOfWeek(date);
  if (d === 6) return addDays(date, -1);
  if (d === 0) return addDays(date, 1);
  return date;
}

// ── NYSE ─────────────────────────────────────────────────

const nyseCache = new Map<number, Map<string, string>>();

/**
 * 해당 연도의 NYSE 휴장일 → 사유.
 *
 * 아래 규칙은 전부 네이버 시세(AAPL.O 일별 차트)의 실제 거래일 유무로 검증했다:
 *  · 토요일 휴일 → 전날 금요일 휴장: 2020-07-03(7/4 토) 거래 없음 ✓, 2021-12-24(12/25 토) 거래 없음 ✓
 *  · 일요일 휴일 → 다음 월요일 휴장: 2021-07-05(7/4 일) ✓, 2023-01-02(1/1 일) ✓
 *  · **신정 예외**: 1/1 이 토요일이면 전년 12/31 을 휴장시키지 **않는다**.
 *    2022-01-01(토)인데 2021-12-31(금) 거래 있음 ✓ — 관측 이동이 해를 넘지 않는다.
 *  · 준틴스는 2022년부터 관측: 2021-06-18(금) 거래 있음 ✓, 2022-06-20(월) 거래 없음 ✓
 *  · Good Friday 2024-03-29 ✓, MLK 2024-01-15 ✓, 워싱턴 2024-02-19 ✓,
 *    메모리얼 2024-05-27 ✓, 노동절 2024-09-02 ✓, 추수감사절 2024-11-28 ✓ 모두 거래 없음
 *
 * 국가 애도일 같은 임시 휴장은 규칙이 아니라서 여기서 못 잡는다 → setHolidays 로 수동 등록한다.
 */
function nyseHolidays(year: number): Map<string, string> {
  const hit = nyseCache.get(year);
  if (hit) return hit;

  const map = new Map<string, string>();
  const put = (date: string, name: string): void => {
    const obs = observed(date);
    map.set(obs, obs === date ? name : `${name}(관측 이동)`);
  };

  // 신정: 토요일이면 전년 금요일을 쉬지 않는다(관측 이동이 연도를 넘지 않음). 일요일이면 1/2 월요일 휴장.
  const newYear = `${year}-01-01`;
  if (dayOfWeek(newYear) !== 6) put(newYear, "신정");

  put(nthWeekday(year, 1, 1, 3), "마틴 루터 킹 데이");
  put(nthWeekday(year, 2, 1, 3), "워싱턴 탄생일");
  put(addDays(easterSunday(year), -2), "성금요일");
  put(lastWeekday(year, 5, 1), "메모리얼 데이");
  // 준틴스는 2021년 연방공휴일 지정, NYSE 는 2022년부터 관측했다(2021-06-18 금요일 정상 거래 확인).
  if (year >= 2022) put(`${year}-06-19`, "준틴스");
  put(`${year}-07-04`, "독립기념일");
  put(nthWeekday(year, 9, 1, 1), "노동절");
  put(nthWeekday(year, 11, 4, 4), "추수감사절");
  put(`${year}-12-25`, "성탄절");

  nyseCache.set(year, map);
  return map;
}

/** NYSE 휴장일이면 사유를, 아니면 null. 주말은 포함하지 않는다(주말 컷이 따로 처리). */
export function isNyseHoliday(date: string): string | null {
  parseYmd(date);
  return nyseHolidays(Number(date.slice(0, 4))).get(date) ?? null;
}

// ── KRX 원장 (파일 캐시) ──────────────────────────────────

interface HolidayYear {
  dates: string[];
  /** 날짜 → 사유. 특일정보의 dateName 또는 수동 등록 표기. */
  names: Record<string, string>;
  source: "api" | "manual";
  savedAt: string;
}

type Ledger = Partial<Record<StockMarket, Record<string, HolidayYear>>>;

const LEDGER_PATH = path.join(path.dirname(config.dbPath), "stock-holidays.json");

let ledgerMemo: Ledger | null = null;

function loadLedger(): Ledger {
  if (ledgerMemo) return ledgerMemo;
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
      if (parsed && typeof parsed === "object") {
        ledgerMemo = parsed as Ledger;
        return ledgerMemo;
      }
    }
  } catch (e) {
    log.warn(`증시 휴장일 원장 로드 실패 → 새로 만듭니다: ${(e as Error).message}`);
  }
  ledgerMemo = {};
  return ledgerMemo;
}

function saveLedger(l: Ledger): void {
  try {
    fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2));
  } catch (e) {
    log.warn(`증시 휴장일 원장 저장 실패: ${(e as Error).message}`);
  }
}

function putYear(market: StockMarket, year: number, map: Map<string, string>, source: "api" | "manual"): void {
  const ledger = loadLedger();
  const dates = [...map.keys()].sort();
  const names: Record<string, string> = {};
  for (const d of dates) names[d] = map.get(d) ?? "휴장일";
  ledger[market] = { ...(ledger[market] ?? {}), [String(year)]: { dates, names, source, savedAt: new Date().toISOString() } };
  ledgerMemo = ledger;
  saveLedger(ledger);
}

/**
 * 공공데이터포털 「특일 정보」에서 해당 연도 공휴일을 긁는다(월 단위 12회).
 *
 * [검증필요] 서비스키가 없어 실제 응답을 확인하지 못했다. 아래는 공식 문서 기재 형태
 * (response.body.items.item[] / locdate=20260101 숫자 / isHoliday="Y")에 맞춰 구현했고,
 * XML→JSON 변환 API 의 통상 관례(item 이 1건이면 배열이 아닌 객체, 0건이면 items 가 빈 문자열)를
 * 방어적으로 처리했다. 키를 넣고 첫 실행 시 응답을 반드시 눈으로 확인할 것.
 *
 * 한 달이라도 실패하면 null 을 돌려준다 — 구멍 뚫린 원장을 저장하면 그 해 내내
 * 특정 공휴일을 못 걸러서 잘못된 브리핑이 나간다.
 */
async function fetchKrHolidays(year: number): Promise<Map<string, string> | null> {
  if (!config.holidayApiKey) return null;

  const map = new Map<string, string>();
  for (let month = 1; month <= 12; month++) {
    const url = new URL("https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo");
    // serviceKey 는 '디코딩된' 키를 .env 에 넣는다는 전제 — URLSearchParams 가 인코딩한다.
    // 포털에서 복사한 'Encoding' 키를 그대로 넣으면 이중 인코딩으로 401 이 난다.
    url.searchParams.set("serviceKey", config.holidayApiKey);
    url.searchParams.set("solYear", String(year));
    url.searchParams.set("solMonth", pad(month));
    url.searchParams.set("_type", "json");
    url.searchParams.set("numOfRows", "50");

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      // 키 오류 시 JSON 이 아니라 XML 에러가 오는 경우가 있어 파싱 실패를 명시적으로 잡는다.
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        throw new Error(`JSON 이 아닌 응답(키 오류 의심): ${body.slice(0, 120)}`);
      }
      for (const item of extractItems(json)) {
        if (item.isHoliday && item.isHoliday !== "Y") continue;
        const date = normalizeLocdate(item.locdate);
        if (date) map.set(date, item.dateName?.trim() || "공휴일");
      }
    } catch (e) {
      log.warn(`특일정보 조회 실패(${year}-${pad(month)}) → KRX 휴장일 원장을 만들지 않습니다: ${(e as Error).message}`);
      return null;
    }
  }
  return map;
}

interface SpcdeItem {
  locdate?: unknown;
  dateName?: string;
  isHoliday?: string;
}

/** response.body.items.item 을 배열로 정규화. 0건(빈 문자열)·1건(객체)·N건(배열) 모두 처리. */
function extractItems(json: unknown): SpcdeItem[] {
  const items = (json as { response?: { body?: { items?: unknown } } })?.response?.body?.items;
  if (!items || typeof items !== "object") return [];
  const item = (items as { item?: unknown }).item;
  if (!item) return [];
  return (Array.isArray(item) ? item : [item]) as SpcdeItem[];
}

/** locdate(20260101 숫자 또는 문자열) → "2026-01-01". 형식이 다르면 null. */
function normalizeLocdate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * 특일정보가 주지 않는 KRX 고유 휴장일. **KRX 휴장 ≠ 공휴일**이라 반드시 더해야 한다.
 *  · 근로자의날(5/1): 공휴일이 아니지만 휴장. 2024-05-01(수) 거래 없음으로 확인 ✓
 *  · 연말 폐장일: 12월 **마지막 영업일**이 휴장이다. 12/31 이 주말이면 그 앞 평일로 당겨진다.
 *    2021-12-31(금) ✓, 2024-12-31(화) ✓, 2022 는 12/31 이 토요일이라 12/30(금) 휴장 ✓ 로 확인.
 */
function krExchangeExtras(year: number): { date: string; name: string }[] {
  const out: { date: string; name: string }[] = [];
  const mayDay = `${year}-05-01`;
  // 5/1 이 주말이면 이미 주말 컷에 걸려 휴장 개념 자체가 무의미하다.
  if (!isWeekend(mayDay)) out.push({ date: mayDay, name: "근로자의날(휴장)" });

  let yearEnd = `${year}-12-31`;
  while (isWeekend(yearEnd)) yearEnd = addDays(yearEnd, -1);
  out.push({ date: yearEnd, name: "연말 폐장일" });
  return out;
}

/** 해당 연도 휴장일 → 사유. 원장(수동/캐시)이 있으면 그걸 우선한다. */
async function holidayMap(market: StockMarket, year: number): Promise<Map<string, string>> {
  const cached = loadLedger()[market]?.[String(year)];
  if (cached) return new Map(cached.dates.map((d) => [d, cached.names?.[d] ?? "휴장일"]));

  if (market === "us") return nyseHolidays(year);

  const fetched = await fetchKrHolidays(year);
  const map = new Map<string, string>(fetched ?? []);
  // extras 는 API 결과를 덮지 않는다(같은 날짜면 공식 사유명을 남긴다).
  for (const e of krExchangeExtras(year)) if (!map.has(e.date)) map.set(e.date, e.name);
  // 주말은 원장에 남기지 않는다 — 주말 컷이 먼저 걸러서 중복이다.
  for (const d of [...map.keys()]) if (isWeekend(d)) map.delete(d);

  // 조회 실패/키 없음이면 저장하지 않는다. 저장해버리면 나중에 키를 넣어도
  // 공휴일이 빠진 원장이 캐시로 굳어버린다.
  if (fetched) putYear("kr", year, map, "api");
  return map;
}

// ── 공개 API ─────────────────────────────────────────────

/**
 * 휴장 여부. date 는 **거래소 로컬 날짜** 기준 YYYY-MM-DD.
 * 주말 → 원장 순으로 판정한다(주말 컷이 대부분을 LLM/네트워크 없이 거른다).
 */
export async function isMarketClosed(
  market: StockMarket,
  date: string
): Promise<{ closed: boolean; reason: string | null }> {
  parseYmd(date);
  if (isWeekend(date)) return { closed: true, reason: "주말" };
  const reason = (await holidayMap(market, Number(date.slice(0, 4)))).get(date);
  return reason ? { closed: true, reason } : { closed: false, reason: null };
}

/** 해당 연도 휴장일 목록(YYYY-MM-DD 오름차순). 주말은 포함하지 않는다. */
export async function getHolidays(market: StockMarket, year: number): Promise<string[]> {
  return [...(await holidayMap(market, year)).keys()].sort();
}

/** UI 수동 편집용. 원장을 통째로 교체한다(이후 조회는 API 대신 이 값을 쓴다). */
export function setHolidays(market: StockMarket, year: number, dates: string[]): void {
  const prev = loadLedger()[market]?.[String(year)];
  const map = new Map<string, string>();
  for (const d of dates) {
    parseYmd(d);
    map.set(d, prev?.names?.[d] ?? "휴장일(수동 등록)");
  }
  putYear(market, year, map, "manual");
  log.info(`${market.toUpperCase()} ${year}년 휴장일 ${map.size}건 수동 등록`);
}

/**
 * 실증 폴백 — 원장이 틀려도 잘못된 브리핑이 나가지 않게 하는 마지막 방어선.
 * 시세 조회 결과에 기대한 거래일이 없으면 휴장으로 간주한다(true=휴장).
 *
 * points 가 비어 있으면(수집 실패 포함) 보수적으로 휴장 처리한다 —
 * "브리핑을 거르는 것"이 "없는 시세로 브리핑을 내는 것"보다 안전하기 때문이다.
 * 원장을 갱신하지는 않는다: 일시적 조회 실패가 정상 거래일을 휴장으로 굳혀버리면 안 된다.
 */
export function markClosedIfNoSession(
  market: StockMarket,
  expectedDate: string,
  points: readonly { date: string }[]
): boolean {
  if (points.some((p) => p.date === expectedDate)) return false;
  log.warn(`${market.toUpperCase()} ${expectedDate}: 시세에 해당 거래일이 없어 휴장으로 간주합니다(실증 폴백).`);
  return true;
}

// ── 거래일 계산 ───────────────────────────────────────────

/** 특정 타임존에서 본 날짜/시각. Date 는 절대 시각이라 tz 포매팅만으로 변환된다. */
function zonedParts(at: Date, timeZone: string): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0; // hour12:false 에서 자정을 24 로 내는 런타임 대비
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour, minute: Number(get("minute")) };
}

/**
 * 지금(KST) 기준 가장 최근에 **마감된** 뉴욕 거래일(뉴욕 로컬 YYYY-MM-DD).
 * 18:00 KST 미국 브리핑은 뉴욕 기준 전날 05:00 무렵이라 거의 항상 '전날 거래일'이 나온다.
 */
export async function lastUsSessionDate(nowKst: Date): Promise<string> {
  const { date, hour } = zonedParts(nowKst, "America/New_York");
  // 오늘이 거래일이어도 16:00 ET 마감 전이면 아직 '마감된 거래일'이 아니다.
  const settledToday = hour >= NYSE_CLOSE_HOUR && !(await isMarketClosed("us", date)).closed;
  let cur = settledToday ? date : addDays(date, -1);
  for (let i = 0; i < SESSION_SCAN_LIMIT; i++) {
    if (!(await isMarketClosed("us", cur)).closed) return cur;
    cur = addDays(cur, -1);
  }
  throw new Error(`${date} 이전 ${SESSION_SCAN_LIMIT}일 내에 뉴욕 거래일을 찾지 못했습니다(원장 오류 의심).`);
}

/**
 * 08:00 KST 한국 브리핑이 대상으로 삼는 거래일(한국 로컬 YYYY-MM-DD).
 * 오늘이 거래일이면 오늘(09:00 개장 전 프리뷰), 아니면 다음 거래일.
 */
export async function nextKrSessionDate(nowKst: Date): Promise<string> {
  let cur = zonedParts(nowKst, "Asia/Seoul").date;
  for (let i = 0; i < SESSION_SCAN_LIMIT; i++) {
    if (!(await isMarketClosed("kr", cur)).closed) return cur;
    cur = addDays(cur, 1);
  }
  throw new Error(`${cur} 까지 ${SESSION_SCAN_LIMIT}일 내에 한국 거래일을 찾지 못했습니다(원장 오류 의심).`);
}
