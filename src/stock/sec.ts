import { config } from "../config.ts";
import { log, withRetry } from "../util/log.ts";
import { localDateDaysAgo } from "../util/date.ts";

/**
 * **SEC EDGAR 공시·실적** — 미국장 브리핑에 넣을 결정론적 원자료.
 *
 * ## 출처
 * 규칙은 day-trader-skill(https://github.com/Jakeschincariol/day-trader-skill, MIT, Jake Schincariol)의
 * `trader-news`(8-K 항목 분류·중요 항목 집합)와 `trader-analyst`(XBRL 분기 실적 계산)를 옮긴 것이다.
 * 2026-11-01 사용자 요청으로 도입했고, 범위는 사용자가 고른 **'SEC 공시·실적만'** 이다.
 * 원본 저작권·허가 고지는 같은 폴더의 `sec.LICENSE-day-trader-skill.txt` 에 있다(MIT 요건).
 * 옮긴 계산이 원본과 같은 숫자를 내는지는 sec.test.ts 가 원본 facts.py 출력으로 고정한다.
 *
 * ## 그 패키지의 나머지를 쓰지 않는 이유
 * - 스캐너·진입·청산·시뮬레이션·주문·알림 8종은 매매 행동을 지시한다 — 증시 에이전트의 최우선 규칙
 *   '매매 행동 지시 금지'(agent.ts)와 정면 충돌한다.
 * - 그 8종과 trader-news 의 헤드라인·등락률은 Yahoo Finance 에 의존하는데, 이 회선은 Yahoo 를 429 로
 *   차단당한다(2026-11-01 재확인 — chart·spark·RSS 전부). SEC 는 200 이다.
 * - 원본은 Python 을 Bash 로 돌리는 스킬이다. 브리핑 에이전트에 Bash 를 열면 외부 페이지의 프롬프트
 *   인젝션이 셸 실행으로 이어진다. 그래서 **서버가 미리 조회해 프롬프트에 주입**하는 quote.ts 방식으로
 *   옮겼다 — 에이전트 도구는 그대로 WebSearch/WebFetch 뿐이다.
 *
 * ## 실패 정책: fail-open
 * 이 자료는 브리핑의 **보강**이지 전제가 아니다. User-Agent 미설정·SEC 장애·종목 하나의 조회 실패는
 * 전부 로그만 남기고 그 부분을 비운 채 브리핑을 진행한다(시세가 죽으면 브리핑을 막는 stock.ts 의
 * quoteOutage 판정과는 반대 선택이다 — 시세는 숫자의 정본이고 이건 아니다).
 */

/** 8-K 항목 번호 → 한국어 라벨. 원본 ITEMS_8K 의 번역(9.01 첨부서류는 표에서 뺀다). */
export const ITEMS_8K_KO: Record<string, string> = {
  "1.01": "중요 계약 체결",
  "1.02": "중요 계약 종료",
  "1.03": "파산·회생 절차",
  "1.05": "사이버보안 사고",
  "2.01": "자산 인수·매각 완료",
  "2.02": "실적 발표",
  "2.03": "신규 채무 발생",
  "2.04": "채무 기한이익 상실",
  "2.05": "구조조정 비용",
  "2.06": "자산 손상",
  "3.01": "상장폐지·상장요건 미달 통지",
  "3.02": "미등록 주식 발행",
  "3.03": "주주 권리 변경",
  "4.01": "감사인 변경",
  "4.02": "과거 재무제표 신뢰 불가",
  "5.01": "지배권 변경",
  "5.02": "이사·임원 변동",
  "5.03": "정관·회계연도 변경",
  "5.07": "주주총회 표결 결과",
  "7.01": "공정공시(Reg FD)",
  "8.01": "기타 주요 사항",
  "9.01": "재무제표·첨부서류",
};

/**
 * 주가에 직접 작용하는 중요 항목. 원본 IMPORTANT_ITEMS 그대로다 — 실적(2.02)·임원 변동(5.02)·
 * 손상(2.06)·상장폐지 통지(3.01)·재무제표 신뢰 불가(4.02)·파산(1.03)·사이버 사고(1.05) 등.
 */
export const IMPORTANT_8K_ITEMS = new Set(["1.03", "1.05", "2.02", "2.04", "2.06", "3.01", "4.02", "5.01", "5.02"]);

/**
 * 공시 조회 창(달력일). 3일인 이유: 월요일 아침 결산이 금요일 장 마감 뒤 공시(뉴욕 날짜 금요일)를
 * 잡아야 한다. 주중에는 하루 이틀 지난 공시가 다시 보이지만, 표에 제출일이 붙어 있어 모델이 가린다.
 */
export const SEC_FILING_LOOKBACK_DAYS = 3;

/** 종목당 공시 상한. 한 회사가 하루에 8-K 를 여러 건 내도 프롬프트를 독식하지 못하게 한다. */
const MAX_FILINGS_PER_SYMBOL = 5;

/** SEC 공정 접근 정책은 초당 10건까지다. 순차 호출 + 이 간격이면 초당 7건 아래로 유지된다. */
const SEC_PAUSE_MS = 150;

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const submissionsUrl = (cik: number) => `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`;
const companyFactsUrl = (cik: number) =>
  `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`;

/** 공시 원문 URL. 접수번호의 하이픈을 지운 폴더 아래 주 문서가 있다. */
export function filingUrl(cik: number, accessionNumber: string, primaryDocument: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNumber.replace(/-/g, "")}/${primaryDocument}`;
}

// ───────────────────────────── 타입 ─────────────────────────────

export interface SecFiling {
  form: string;
  /** 뉴욕 기준 제출일 YYYY-MM-DD */
  filingDate: string;
  /** 접수 시각 ISO(정렬용). 없으면 빈 문자열. */
  acceptedAt: string;
  /** 8-K 항목 번호들("2.02","9.01") */
  items: string[];
  important: boolean;
  url: string;
}

/** 최근 제출 분기 1개. 금액은 USD, 비율은 % (소수 1자리), EPS 는 소수 2자리. */
export interface SecQuarter {
  /** 분기 종료일 YYYY-MM-DD */
  periodEnd: string;
  /** "Q3 2026" — 회사 회계연도 기준이라 달력 분기와 다를 수 있다. */
  fiscal: string;
  /** 10-K 연간에서 3개 분기를 빼 만든 4분기면 true(원본 규칙 — EPS 는 근사치다). */
  derived: boolean;
  form: string | null;
  filed: string | null;
  revenue: number | null;
  revenueYoy: number | null;
  netIncome: number | null;
  netIncomeYoy: number | null;
  epsDiluted: number | null;
  epsYoy: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
}

export interface SecCompanyDigest {
  symbol: string;
  cik: number;
  entity: string;
  filings: SecFiling[];
  quarter: SecQuarter | null;
  /**
   * 실적 표 분기 **이후에** 나온 실적 발표(8-K 2.02). 실적 발표 직후 며칠은 10-Q 가 아직 없어
   * XBRL 이 직전 분기에 머문다 — 이걸 알리지 않으면 모델이 '지난 분기 숫자'를 '방금 발표된 숫자'로
   * 인용한다.
   */
  newerEarningsRelease: { filingDate: string; url: string } | null;
}

export interface SecDigest {
  /** 공시 조회 창 시작일(이 날짜 이후 제출분) */
  since: string;
  companies: SecCompanyDigest[];
  /** "SNDK: CIK 미발견" 같은 종목별 실패 사유. 로그·진단용. */
  failures: string[];
}

// ───────────────────────────── 순수 파서 ─────────────────────────────

/**
 * company_tickers.json → 티커(대문자) → CIK.
 * 클래스주는 SEC 가 하이픈("BRK-B")으로 적으므로 조회 쪽에서 secTicker() 로 맞춘다.
 */
export function parseTickerMap(json: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!json || typeof json !== "object") return out;
  for (const v of Object.values(json as Record<string, unknown>)) {
    const o = v as { ticker?: unknown; cik_str?: unknown };
    if (typeof o?.ticker === "string" && typeof o.cik_str === "number") {
      out.set(o.ticker.toUpperCase(), o.cik_str);
    }
  }
  return out;
}

/** 네이버 심볼 → SEC 티커("BRK.B" → "BRK-B"). */
export function secTicker(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\./g, "-");
}

interface RecentFilings {
  form?: string[];
  filingDate?: string[];
  acceptanceDateTime?: string[];
  accessionNumber?: string[];
  primaryDocument?: string[];
  items?: string[];
  reportDate?: string[];
}

function recentOf(submissions: unknown): RecentFilings {
  const r = (submissions as { filings?: { recent?: RecentFilings } } | null)?.filings?.recent;
  return r ?? {};
}

/** submissions → since(포함) 이후 8-K·8-K/A, 최신순, 종목당 상한 적용. */
export function recentFilings(submissions: unknown, cik: number, since: string): SecFiling[] {
  const r = recentOf(submissions);
  const n = r.form?.length ?? 0;
  const out: SecFiling[] = [];
  for (let i = 0; i < n; i++) {
    const form = r.form?.[i] ?? "";
    if (form !== "8-K" && form !== "8-K/A") continue;
    const filingDate = r.filingDate?.[i] ?? "";
    if (!filingDate || filingDate < since) continue;
    const accn = r.accessionNumber?.[i];
    const doc = r.primaryDocument?.[i];
    if (!accn || !doc) continue;
    const items = (r.items?.[i] ?? "").match(/\d+\.\d+/g) ?? [];
    out.push({
      form,
      filingDate,
      acceptedAt: r.acceptanceDateTime?.[i] ?? "",
      items,
      important: items.some((it) => IMPORTANT_8K_ITEMS.has(it)),
      url: filingUrl(cik, accn, doc),
    });
  }
  out.sort((a, b) => (b.acceptedAt || b.filingDate).localeCompare(a.acceptedAt || a.filingDate));
  return out.slice(0, MAX_FILINGS_PER_SYMBOL);
}

/** 가장 최근 실적 발표(8-K 2.02). 기간 제한 없음 — 실적 표와 견주는 용도다. */
export function latestEarningsRelease(
  submissions: unknown,
  cik: number
): { filingDate: string; url: string } | null {
  const r = recentOf(submissions);
  const n = r.form?.length ?? 0;
  let best: { filingDate: string; url: string } | null = null;
  for (let i = 0; i < n; i++) {
    const form = r.form?.[i] ?? "";
    if (form !== "8-K" && form !== "8-K/A") continue;
    if (!(r.items?.[i] ?? "").match(/\d+\.\d+/g)?.includes("2.02")) continue;
    const filingDate = r.filingDate?.[i] ?? "";
    const accn = r.accessionNumber?.[i];
    const doc = r.primaryDocument?.[i];
    if (!filingDate || !accn || !doc) continue;
    if (!best || filingDate > best.filingDate) best = { filingDate, url: filingUrl(cik, accn, doc) };
  }
  return best;
}

/** 가장 최근 분기·연간 보고서(10-Q/10-K)의 접수번호. companyfacts 캐시 키로 쓴다. */
export function latestPeriodicAccession(submissions: unknown): string | null {
  const r = recentOf(submissions);
  const n = r.form?.length ?? 0;
  let best: { date: string; accn: string } | null = null;
  for (let i = 0; i < n; i++) {
    const form = (r.form?.[i] ?? "").split("/")[0];
    if (form !== "10-Q" && form !== "10-K") continue;
    const date = r.filingDate?.[i] ?? "";
    const accn = r.accessionNumber?.[i];
    if (date && accn && (!best || date > best.date)) best = { date, accn };
  }
  return best?.accn ?? null;
}

// ── XBRL 분기 실적 (원본 trader-analyst/facts.py 의 periods·quarterly·series·analyse) ──

interface XbrlFact {
  start?: string;
  end: string;
  val: number;
  accn?: string;
  fy?: number | null;
  fp?: string | null;
  form?: string;
  filed?: string;
}

/** 지표별 us-gaap 개념 후보. 앞쪽이 우선이고, 뒤쪽은 앞에서 빈 분기만 메운다(원본 CONCEPTS). */
const CONCEPTS = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "RevenuesNetOfInterestExpense",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
    "SalesRevenueGoodsNet",
    "SalesRevenueServicesNet",
  ],
  cost_of_revenue: ["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfGoodsSold"],
  gross_profit: ["GrossProfit"],
  operating_income: ["OperatingIncomeLoss"],
  net_income: ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"],
  eps_diluted: ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"],
} as const;
type MetricKey = keyof typeof CONCEPTS;

const PERIODIC_FORMS = new Set(["10-Q", "10-K", "20-F", "40-F"]);
const DAY_MS = 86_400_000;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

function factsFor(companyfacts: unknown, concept: string, unitHint: string): XbrlFact[] {
  const node = (companyfacts as { facts?: { "us-gaap"?: Record<string, { units?: Record<string, XbrlFact[]> }> } })
    ?.facts?.["us-gaap"]?.[concept];
  const units = node?.units;
  if (!units) return [];
  const unit = unitHint in units ? unitHint : Object.keys(units)[0];
  return unit ? (units[unit] ?? []) : [];
}

interface PeriodFact extends XbrlFact {
  firstFiled?: string;
}

/**
 * (start,end) → 사실 1개. **값은 가장 늦은 제출**(정정 공시가 이긴다), **회계 라벨(fy·fp)은 처음
 * 보고한 제출**에서 가져온다 — 다음 해 10-Q 가 비교 열로 같은 기간을 다시 실으면 자기 fy·fp 를 달기 때문.
 */
function periods(facts: XbrlFact[]): Map<string, PeriodFact> {
  const latest = new Map<string, XbrlFact>();
  const first = new Map<string, XbrlFact>();
  const stamp = (f: XbrlFact) => `${f.filed ?? ""}|${f.accn ?? ""}`;
  for (const f of facts) {
    if (!f.start || !PERIODIC_FORMS.has((f.form ?? "").split("/")[0])) continue;
    const key = `${f.start}|${f.end}`;
    const l = latest.get(key);
    if (!l || stamp(f) > stamp(l)) latest.set(key, f);
    const fi = first.get(key);
    if (!fi || stamp(f) < stamp(fi)) first.set(key, f);
  }
  const out = new Map<string, PeriodFact>();
  for (const [key, f] of latest) {
    const fi = first.get(key)!;
    out.set(key, { ...f, fy: fi.fy, fp: fi.fp, firstFiled: fi.filed });
  }
  return out;
}

interface QuarterValue {
  value: number;
  start: string;
  end: string;
  derived: boolean;
  fy: number | null;
  fp: string | null;
  form: string | null;
  filed: string | null;
}

/** 3개월 값만 추린다. 4분기는 10-K 연간 − 그 해 3개 분기로 만든다(파생). */
function quarterly(facts: XbrlFact[]): Map<string, QuarterValue> {
  const q = new Map<string, QuarterValue>();
  const years: PeriodFact[] = [];
  for (const f of periods(facts).values()) {
    const days = daysBetween(f.start!, f.end);
    if (days >= 80 && days <= 100) {
      q.set(f.end, {
        value: f.val,
        start: f.start!,
        end: f.end,
        derived: false,
        fy: f.fy ?? null,
        fp: f.fp ?? null,
        form: f.form ?? null,
        filed: f.filed ?? null,
      });
    } else if (days >= 350 && days <= 380) {
      years.push(f);
    }
  }
  for (const y of years) {
    if (q.has(y.end)) continue;
    const inside = [...q.values()].filter((v) => v.start >= y.start! && v.end < y.end).sort((a, b) => a.end.localeCompare(b.end));
    if (inside.length !== 3) continue;
    const lastEnd = new Date(Date.parse(`${inside[2].end}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
    q.set(y.end, {
      value: y.val - inside.reduce((s, v) => s + v.value, 0),
      start: lastEnd,
      end: y.end,
      derived: true,
      fy: y.fy ?? null,
      fp: "Q4",
      form: y.form ?? null,
      filed: y.filed ?? null,
    });
  }
  return q;
}

function series(companyfacts: unknown, key: MetricKey): Map<string, QuarterValue> {
  const unit = key === "eps_diluted" ? "USD/shares" : "USD";
  const merged = new Map<string, QuarterValue>();
  for (const concept of CONCEPTS[key]) {
    for (const [end, v] of quarterly(factsFor(companyfacts, concept, unit))) {
      if (!merged.has(end)) merged.set(end, v);
    }
  }
  return merged;
}

/** 1년 전 같은 분기 — 종료일이 365일 ±10일인 분기 중 가장 가까운 것. */
function yoyMatch(s: Map<string, QuarterValue>, end: string): QuarterValue | null {
  let best: { gap: number; v: QuarterValue } | null = null;
  for (const [e, v] of s) {
    const gap = Math.abs(daysBetween(e, end) - 365);
    if (gap <= 10 && (!best || gap < best.gap)) best = { gap, v };
  }
  return best?.v ?? null;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

function pct(a: number | null, b: number | null): number | null {
  if (a == null || b == null || b === 0) return null;
  return round1((100 * (a - b)) / Math.abs(b));
}

function margin(part: number | null, whole: number | null): number | null {
  if (part == null || !whole) return null;
  return round1((100 * part) / whole);
}

/** 분기 실적 행들(최신순, 최대 n개). 테스트가 파생 4분기까지 검증하려고 전체를 노출한다. */
export function quarterRows(companyfacts: unknown, n = 6): SecQuarter[] {
  const s = {} as Record<MetricKey, Map<string, QuarterValue>>;
  for (const key of Object.keys(CONCEPTS) as MetricKey[]) s[key] = series(companyfacts, key);
  const rev = s.revenue;
  const ni = s.net_income;
  const ends = [...new Set([...rev.keys(), ...ni.keys()])].sort().reverse().slice(0, n);
  return ends.map((end) => {
    const r = rev.get(end)?.value ?? null;
    let gp = s.gross_profit.get(end)?.value ?? null;
    if (gp == null && r != null && s.cost_of_revenue.has(end)) gp = r - s.cost_of_revenue.get(end)!.value;
    const oi = s.operating_income.get(end)?.value ?? null;
    const net = ni.get(end)?.value ?? null;
    const epsRaw = s.eps_diluted.get(end)?.value ?? null;
    const eps = epsRaw == null ? null : Math.round(epsRaw * 100) / 100;
    const base = rev.get(end) ?? ni.get(end);
    const priorEps = yoyMatch(s.eps_diluted, end)?.value ?? null;
    return {
      periodEnd: end,
      fiscal: `${base?.fp ?? ""} ${base?.fy ?? ""}`.trim(),
      derived: Boolean(rev.get(end)?.derived || ni.get(end)?.derived),
      form: base?.form ?? null,
      filed: base?.filed ?? null,
      revenue: r,
      revenueYoy: pct(r, yoyMatch(rev, end)?.value ?? null),
      netIncome: net,
      netIncomeYoy: pct(net, yoyMatch(ni, end)?.value ?? null),
      epsDiluted: eps,
      // 원본과 같이 반올림 전 EPS 로 증감률을 낸다(반올림 후 값으로 내면 소수 1자리가 어긋난다).
      epsYoy: pct(epsRaw, priorEps),
      grossMargin: margin(gp, r),
      operatingMargin: margin(oi, r),
      netMargin: margin(net, r),
    };
  });
}

export function latestQuarter(companyfacts: unknown): SecQuarter | null {
  return quarterRows(companyfacts, 1)[0] ?? null;
}

// ───────────────────────────── 네트워크 ─────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function secGet(url: string, ua: string): Promise<unknown> {
  return withRetry(
    async () => {
      const res = await fetch(url, {
        // SEC 는 연락처가 든 User-Agent 가 없으면 403 을 준다(공정 접근 정책).
        headers: { "User-Agent": ua, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    { tries: 2, baseMs: 1_000, label: `SEC 조회 ${new URL(url).pathname}` }
  );
}

/** 티커 → CIK 표. 하루에 한 번만 받는다(80만 바이트, 상장·티커 변경은 드물다). */
let tickerCache: { at: number; map: Map<string, number> } | null = null;
const TICKER_TTL_MS = 24 * 3_600_000;

/**
 * CIK → 계산된 최신 분기. companyfacts 는 대형주가 2~4MB 라 매 브리핑마다 받기엔 무겁다.
 * 키는 **최신 10-Q/10-K 접수번호**다 — 새 보고서가 올라오기 전에는 값이 바뀌지 않는다.
 * 단 SEC 의 XBRL 집계가 보고서보다 늦게 따라오는 경우가 있어(원본 stale_note), 분기가 보고서
 * 기간을 따라잡지 못했으면 캐시하지 않고 다음 브리핑 때 다시 받는다.
 */
const quarterCache = new Map<number, { accn: string; quarter: SecQuarter | null }>();

function reportPeriodOf(submissions: unknown, accn: string): string | null {
  const r = recentOf(submissions);
  const i = r.accessionNumber?.indexOf(accn) ?? -1;
  return i >= 0 ? (r.reportDate?.[i] ?? null) : null;
}

/**
 * 등록된 미국 종목들의 SEC 공시·실적을 모은다. User-Agent 가 없거나 티커 표조차 못 받으면 null.
 * 종목별 실패는 격리한다 — 한 종목이 죽어도 나머지는 싣는다.
 */
export async function fetchSecDigest(symbols: string[], since: string): Promise<SecDigest | null> {
  const ua = config.secUserAgent;
  if (!ua) {
    log.info("SEC 공시·실적 생략 — SEC_USER_AGENT 미설정(.env 에 '이름 이메일' 형식으로 넣으면 켜진다)");
    return null;
  }
  try {
    if (!tickerCache || Date.now() - tickerCache.at > TICKER_TTL_MS) {
      tickerCache = { at: Date.now(), map: parseTickerMap(await secGet(TICKERS_URL, ua)) };
    }
  } catch (e) {
    log.warn(`SEC 티커 표 조회 실패 → 공시·실적 없이 브리핑: ${(e as Error).message}`);
    return null;
  }

  const companies: SecCompanyDigest[] = [];
  const failures: string[] = [];
  for (const symbol of symbols) {
    const cik = tickerCache.map.get(secTicker(symbol));
    if (cik == null) {
      failures.push(`${symbol}: SEC 티커 표에 없음(해외 상장·ETF 일 수 있음)`);
      continue;
    }
    try {
      await sleep(SEC_PAUSE_MS);
      const sub = await secGet(submissionsUrl(cik), ua);
      const entity = (sub as { name?: unknown })?.name;
      const accn = latestPeriodicAccession(sub);
      let quarter: SecQuarter | null = null;
      const cached = quarterCache.get(cik);
      if (accn && cached?.accn === accn) {
        quarter = cached.quarter;
      } else {
        try {
          await sleep(SEC_PAUSE_MS);
          quarter = latestQuarter(await secGet(companyFactsUrl(cik), ua));
          const reportPeriod = accn ? reportPeriodOf(sub, accn) : null;
          const caughtUp = !reportPeriod || !quarter || daysBetween(quarter.periodEnd, reportPeriod) <= 20;
          if (accn && caughtUp) quarterCache.set(cik, { accn, quarter });
        } catch (e) {
          // 실적만 실패한 경우 공시는 살린다.
          failures.push(`${symbol}: 실적(XBRL) 조회 실패 ${(e as Error).message}`);
        }
      }
      const release = latestEarningsRelease(sub, cik);
      companies.push({
        symbol,
        cik,
        entity: typeof entity === "string" ? entity : symbol,
        filings: recentFilings(sub, cik, since),
        quarter,
        newerEarningsRelease: release && quarter?.filed && release.filingDate > quarter.filed ? release : null,
      });
    } catch (e) {
      failures.push(`${symbol}: ${(e as Error).message}`);
    }
  }
  if (failures.length) log.warn(`SEC 공시·실적 일부 실패 ${failures.length}건 — ${failures.join(" / ")}`);
  return { since, companies, failures };
}

/**
 * 브리핑용 진입점. **절대 throw 하지 않는다** — 실패는 null 로 접어 브리핑을 막지 않는다.
 */
export async function gatherSec(symbols: string[]): Promise<SecDigest | null> {
  if (!symbols.length) return null;
  const startedAt = Date.now();
  try {
    const d = await fetchSecDigest(symbols, localDateDaysAgo(SEC_FILING_LOOKBACK_DAYS));
    if (d) {
      const filings = d.companies.reduce((n, c) => n + c.filings.length, 0);
      log.info(
        `SEC 공시·실적 ${d.companies.length}/${symbols.length}종목 · 공시 ${filings}건 (${d.since} 이후) · ` +
          `${Date.now() - startedAt}ms`
      );
    }
    return d;
  } catch (e) {
    log.warn(`SEC 공시·실적 수집 예외 → 생략: ${(e as Error).message}`);
    return null;
  }
}
