import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import type { StockMarket } from "../../shared/types.ts";

/**
 * 증시 휴장일 판정.
 *
 * 미국(NYSE)·한국(KRX) 모두 휴장일을 **계산**으로 유도한다(네트워크·API 키 불필요).
 * 음력 공휴일(설·추석·부처님오신날)은 Node 내장 ICU 의 한국 음력(dangi) 달력으로 환산한다.
 *
 * 3계층으로 판정한다:
 *   1) 주말 컷 → 2) 계산된 공휴일 + 원장 오버라이드 → 3) 실증 폴백(markClosedIfNoSession)
 *
 * 원장은 **계산이 원리적으로 불가능한 것**만 담는다 — 임시공휴일(정부 고시)과 선거일.
 * 사람이 넣은 원장 값이 계산 결과를 이긴다.
 *
 * ⚠️ **3계층이 다 걸리는 건 미국장뿐이다.** 한국장 08:00 브리핑은 개장 전이라 "오늘 세션 데이터가
 *    없는 것"이 정상이고, 여기에 실증 폴백을 걸면 매일 휴장으로 오판한다(stock.ts 의 2-b 참고).
 *    즉 한국장은 1)+2) 만으로 막으며, **계산 불가한 임시공휴일·선거일에는 브리핑이 나간다.**
 *    실측 기준 연 1~2회이고, 막으려면 그날을 원장(setHolidays)에 미리 넣는 수밖에 없다.
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
  /** 날짜 → 사유. 수동 등록 표기. */
  names: Record<string, string>;
  /** 항상 "manual" 로 쓴다. "api" 는 특일정보 API 를 쓰던 시절 원장을 읽기 위한 하위호환. */
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

function putYear(market: StockMarket, year: number, map: Map<string, string>): void {
  const ledger = loadLedger();
  const dates = [...map.keys()].sort();
  const names: Record<string, string> = {};
  for (const d of dates) names[d] = map.get(d) ?? "휴장일";
  ledger[market] = {
    ...(ledger[market] ?? {}),
    [String(year)]: { dates, names, source: "manual", savedAt: new Date().toISOString() },
  };
  ledgerMemo = ledger;
  saveLedger(ledger);
}

// ── KRX 공휴일 계산 ───────────────────────────────────────

/**
 * 한국 음력(dangi) 달력. Node 내장 ICU 에 포함돼 있어 의존성이 필요 없다.
 * timeZone:"UTC" 고정 — 우리 날짜 헬퍼가 전부 UTC 자정 기준이라 맞춰야 하루가 밀리지 않는다.
 */
const dangiFormat = new Intl.DateTimeFormat("en-u-ca-dangi", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  timeZone: "UTC",
});

interface LunarDate {
  /** 음력 연도(relatedYear). dangi 의 'year' 는 60갑자 순번이라 쓰지 않는다. */
  year: number;
  /** 평달은 "1"…"12", **윤달은 "4bis" 처럼 bis 접미사가 붙는다**(라이브 확인: 2020/4bis, 2023/2bis, 2025/6bis). */
  month: string;
  day: number;
}

/** 양력 YYYY-MM-DD → 음력. */
function toLunar(date: string): LunarDate {
  const parts = Object.fromEntries(
    dangiFormat.formatToParts(parseYmd(date)).map((p) => [p.type, p.value])
  );
  return { year: Number(parts.relatedYear), month: String(parts.month), day: Number(parts.day) };
}

/**
 * 음력 (year, month **평달**, day) → 양력. [from, to] 구간을 훑어 찾는다.
 *
 * month 를 String(n) 과 정확히 비교하므로 윤달("4bis")은 자동으로 걸러진다 —
 * 부처님오신날은 윤4월 8일이 아니라 평4월 8일이라 이게 맞다(2020 년 윤4월로 확인).
 * 못 찾으면 null(호출부가 그 공휴일을 건너뛴다).
 */
function fromLunar(year: number, month: number, day: number, from: string, to: string): string | null {
  const target = String(month);
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const l = toLunar(d);
    if (l.year === year && l.month === target && l.day === day) return d;
  }
  return null;
}

/** 대체공휴일 규칙. */
type SubstituteRule =
  /** 대체 없음 — 신정·현충일·제헌절. */
  | "none"
  /** 토·일과 겹치면 대체 — 삼일절·광복절·개천절·한글날·부처님오신날·성탄절. */
  | "weekend"
  /** 토·일 **또는 다른 공휴일**과 겹치면 대체 — 어린이날 전용(아래 주석 참고). */
  | "weekendOrOverlap";

interface KrBaseHoliday {
  date: string;
  name: string;
  rule: SubstituteRule;
}

const krCache = new Map<number, Map<string, string>>();

/**
 * 해당 연도의 KRX **공휴일** → 사유. 순수 함수(네트워크 없음).
 * 근로자의날·연말 폐장일 같은 '공휴일이 아닌 휴장일'은 krExchangeExtras 가 따로 더한다.
 *
 * 아래 규칙은 전부 네이버 시세(삼성전자 005930 일별 차트) **2021-01-01~2026-07-16** 실거래일로
 * 백테스트했다 — 대상 평일 1445일 중 1437일 일치, 위양성 0, 위음성 8(전부 임시공휴일/선거일 → 원장 관할).
 *
 * ⚠️ 백테스트 구간을 줄이지 말 것. 처음엔 2023-01-01 부터만 검증해 "위양성 0"이라 결론냈는데,
 *    성탄절·부처님오신날 대체공휴일 시행연도 가드 누락 버그가 **2023년 이전에만 발현**하는 탓에
 *    그 구간에서는 구조적으로 보이지 않았다. 구간을 2021 로 넓히자 위양성 3건이 드러났다.
 *    규칙에 시행연도가 걸린 항목이 있는 한, 시행 이전 연도를 포함해야 검증이 성립한다.
 *
 *  · 설날 연휴 3일: 2023-01-21~23 ✓, 2024-02-09~11 ✓, 2025-01-28~30 ✓, 2026-02-16~18 ✓
 *  · 추석 연휴 3일: 2023-09-28~30 ✓, 2024-09-16~18 ✓, 2025-10-05~07 ✓
 *  · 부처님오신날: 2024-05-15 ✓, 2025-05-05 ✓ / 토요일 대체 2023-05-29 ✓, 일요일 대체 2026-05-25 ✓
 *  · 연휴가 일요일과 겹쳐 생긴 대체: 2023-01-24 ✓, 2024-02-12 ✓, 2025-10-08 ✓
 *  · 토·일 대체: 2024-05-06(어린이날 일) ✓, 2025-03-03(삼일절 토) ✓, 2026-03-02(삼일절 일) ✓
 *  · **어린이날 '다른 공휴일과 겹침' 대체**: 2025-05-05 는 어린이날이자 부처님오신날인데
 *    둘 다 월요일이라 주말 규칙으로는 대체가 안 나온다. 그런데 2025-05-06(화)은 실제로 휴장이었다 ✓
 *    → 어린이날에만 있는 '토요일 또는 다른 공휴일과 겹치는 경우' 조항이 실재함을 실측으로 확인.
 */
export function krHolidays(year: number): Map<string, string> {
  const hit = krCache.get(year);
  if (hit) return hit;

  const base: KrBaseHoliday[] = [];
  /** 연휴(설·추석) — 연휴 전체가 일요일과 겹치는지로 대체를 판정하므로 런 단위로 따로 든다. */
  const runs: { name: string; days: string[] }[] = [];

  // ── 양력 고정 공휴일 ──
  base.push({ date: `${year}-01-01`, name: "신정", rule: "none" });
  base.push({ date: `${year}-03-01`, name: "삼일절", rule: "weekend" });
  base.push({ date: `${year}-05-05`, name: "어린이날", rule: "weekendOrOverlap" });
  base.push({ date: `${year}-06-06`, name: "현충일", rule: "none" });
  base.push({ date: `${year}-08-15`, name: "광복절", rule: "weekend" });
  base.push({ date: `${year}-10-03`, name: "개천절", rule: "weekend" });
  base.push({ date: `${year}-10-09`, name: "한글날", rule: "weekend" });
  // 성탄절·부처님오신날의 대체공휴일은 2023년 시행령 개정으로 **신설**됐다. 그 전엔 없었다.
  // 실측으로 경계를 확정: 2021-12-27·2022-12-26(성탄절 대체 자리)과 2022-05-09(부처님오신날 대체 자리)은
  // 전부 정상 거래일이었고, 2023-05-29 부터 휴장이다. 가드 없이 전 연도에 적용하면 과거 조회에서
  // 멀쩡한 거래일을 휴장으로 만든다.
  const subst2023: SubstituteRule = year >= 2023 ? "weekend" : "none";
  base.push({ date: `${year}-12-25`, name: "성탄절", rule: subst2023 });

  // 제헌절은 2008년 공휴일에서 빠졌다가 2026년 재지정됐다.
  // 실측: 2023·2024·2025-07-17 은 전부 거래일 ✓ / 2026-07-17(금)은 거래 없음 ✓
  // [검증필요] 대체공휴일 적용 여부가 불명확하다. 2026-07-17 은 금요일이라 실측으로 판별할 수 없어
  // 일단 '대체 없음'으로 둔다. 7/17 이 주말인 첫 해는 2027(토)이라 그때 실측으로 확정해야 한다.
  if (year >= 2026) base.push({ date: `${year}-07-17`, name: "제헌절", rule: "none" });

  // ── 음력 공휴일 ──
  // 설날은 양력 1/21~2/21 에만 온다. 스캔 구간을 넉넉히 잡아 경계에서 놓치지 않게 한다.
  // (연휴 전날이 전년 12월로 넘어가는 일은 구조적으로 없다 — 가장 이른 설날이 1/21 이라 전날도 1/20.)
  const seollal = fromLunar(year, 1, 1, `${year}-01-01`, `${year}-03-15`);
  if (seollal) runs.push({ name: "설날", days: [addDays(seollal, -1), seollal, addDays(seollal, 1)] });

  // 추석은 양력 9/8~10/8 에만 온다.
  const chuseok = fromLunar(year, 8, 15, `${year}-08-15`, `${year}-10-31`);
  if (chuseok) runs.push({ name: "추석", days: [addDays(chuseok, -1), chuseok, addDays(chuseok, 1)] });

  // 부처님오신날은 양력 4/28~5/27 에만 온다. 윤4월이 있어도 평4월만 잡는다(fromLunar 주석 참고).
  const buddha = fromLunar(year, 4, 8, `${year}-04-01`, `${year}-06-15`);
  if (buddha) base.push({ date: buddha, name: "부처님오신날", rule: subst2023 });

  for (const run of runs) {
    const label = [`${run.name} 전날`, run.name, `${run.name} 다음날`];
    run.days.forEach((d, i) => base.push({ date: d, name: label[i], rule: "none" }));
  }

  // ── 1단계: 법정공휴일을 원장에 채운다 ──
  const map = new Map<string, string>();
  for (const h of base) if (!map.has(h.date)) map.set(h.date, h.name);

  /** 같은 날에 다른 공휴일이 하나 더 있는가(어린이날 대체 판정용). */
  const overlapsOther = (date: string): boolean => base.filter((h) => h.date === date).length > 1;

  /** anchor 다음날부터 '주말도 공휴일도 아닌 첫 날'. 대체가 또 겹치면 연쇄로 밀린다. */
  const nextFreeWeekday = (anchor: string): string => {
    let d = addDays(anchor, 1);
    for (let i = 0; i < SESSION_SCAN_LIMIT; i++) {
      if (!isWeekend(d) && !map.has(d)) return d;
      d = addDays(d, 1);
    }
    throw new Error(`${anchor} 이후 ${SESSION_SCAN_LIMIT}일 내에 대체공휴일 자리를 찾지 못했습니다.`);
  };

  // ── 2단계: 대체공휴일 ──
  // anchor 오름차순으로 처리해야 연쇄가 결정적으로 풀린다(앞 대체가 뒤 대체의 자리를 막을 수 있다).
  const candidates: { anchor: string; name: string; triggered: boolean }[] = [];

  for (const run of runs) {
    // 연휴가 **일요일**과 겹치면 대체(토요일은 대체 사유가 아니다). anchor 는 연휴 마지막 날.
    const last = run.days[run.days.length - 1];
    candidates.push({
      anchor: last,
      name: `${run.name} 연휴 대체공휴일`,
      triggered: run.days.some((d) => dayOfWeek(d) === 0),
    });
  }

  for (const h of base) {
    if (h.rule === "none") continue;
    const weekend = isWeekend(h.date);
    const triggered = h.rule === "weekendOrOverlap" ? weekend || overlapsOther(h.date) : weekend;
    candidates.push({ anchor: h.date, name: `${h.name} 대체공휴일`, triggered });
  }

  for (const c of candidates.filter((c) => c.triggered).sort((a, b) => a.anchor.localeCompare(b.anchor))) {
    map.set(nextFreeWeekday(c.anchor), c.name);
  }

  // 해당 연도 밖으로 새어나간 날짜는 버린다(krHolidays(year) 계약은 그 해 양력 날짜만).
  for (const d of [...map.keys()]) if (!d.startsWith(`${year}-`)) map.delete(d);

  krCache.set(year, map);
  return map;
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

/**
 * 해당 연도 휴장일 → 사유. **계산 결과 위에 원장을 덮어쓴다**(사람이 넣은 값이 이긴다).
 *
 * 원장은 계산으로 유도할 수 없는 것만 담는다 — 임시공휴일(정부가 갑자기 고시)과 선거일.
 * 실측으로 확인된 사례: 2023-10-02, 2024-04-10(총선), 2024-10-01(국군의날), 2025-01-27, 2025-06-03(대선).
 *
 * 전체 교체가 아니라 병합인 이유: 원장이 임시공휴일 1건만 담고 있어도 그 해 법정공휴일이
 * 통째로 사라지면 안 된다. setHolidays 로 넣은 해도 계산된 공휴일은 그대로 살아 있어야 한다.
 */
async function holidayMap(market: StockMarket, year: number): Promise<Map<string, string>> {
  const map = market === "us" ? new Map(nyseHolidays(year)) : new Map(krHolidays(year));

  if (market === "kr") {
    // extras 는 계산된 공휴일을 덮지 않는다(같은 날짜면 공휴일 사유명을 남긴다).
    for (const e of krExchangeExtras(year)) if (!map.has(e.date)) map.set(e.date, e.name);
  }

  // 원장 오버라이드 — 계산 결과를 덮어쓴다.
  const cached = loadLedger()[market]?.[String(year)];
  if (cached) for (const d of cached.dates) map.set(d, cached.names?.[d] ?? "휴장일");

  // 주말은 원장에 남기지 않는다 — 주말 컷이 먼저 걸러서 중복이다.
  for (const d of [...map.keys()]) if (isWeekend(d)) map.delete(d);

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

/**
 * UI 수동 편집용 — 계산으로 못 잡는 임시공휴일/선거일을 등록한다.
 *
 * 원장은 계산 결과 **위에 덮어쓰는 레이어**다. 즉 여기 넣은 날짜는 휴장으로 **추가**되지만,
 * 계산된 법정공휴일을 이 목록에서 빼는 방식으로 **되돌릴 수는 없다**(병합이라 계산분이 남는다).
 * 계산이 틀려서 휴장일을 빼야 하는 상황이면 그건 규칙 버그이니 krHolidays 를 고쳐야 한다.
 */
export function setHolidays(market: StockMarket, year: number, dates: string[]): void {
  const prev = loadLedger()[market]?.[String(year)];
  const map = new Map<string, string>();
  for (const d of dates) {
    parseYmd(d);
    map.set(d, prev?.names?.[d] ?? "휴장일(수동 등록)");
  }
  putYear(market, year, map);
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
