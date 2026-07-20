import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { localDate } from "../util/date.ts";
import { ensureSeedTickers, listStocks } from "./tickers.ts";
import { upsertStockPoints, startStockRun, finishStockRun } from "../db/repo.ts";
import {
  loadNotifiedMap,
  slotNotified,
  mergeNotified,
  resolveSlot,
  MANUAL_SLOT,
  SLOT_HANDLED,
} from "./notify-ledger.ts";
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
import { stockSlotRoleDetail } from "./slot-role.ts";
import { getSchedule } from "../scheduler/schedule-store.ts";
import type {
  StockMarket,
  StockSlotRole,
  StockSnapshot,
  StockPoint,
  StockWatchItem,
  StockSearchCandidate,
} from "../../shared/types.ts";
import { normalizeSymbol, partitionWatchlist } from "../../shared/stock.ts";

/** 차트·이동평균에 쓰는 거래일 수. */
const HISTORY_DAYS = 20;

/**
 * 스냅샷은 **시장별 + 역할별로 분리 저장**한다.
 *
 * 시장 분리의 이유(원래 주석): 단일 파일이면 미국장 런이 같은 날 한국장 브리핑을 덮어써서 사라진다.
 * 역할 분리는 **같은 논리를 한 단계 아래에서** 적용한 것이다 — 미국장 안에서 오후 프리뷰 런이
 * 아침 결산 런을 덮어쓴다. 두 런이 같은 성격이던 시절엔 나중 런이 앞 런의 상위집합이라
 * 무해했지만, 역할을 나누면 두 스냅샷이 **상호 보완 관계**가 되어 덮어쓰기가 진짜 데이터
 * 손실이 된다(메일함에는 남지만 대시보드·API 에서는 소멸).
 *
 * ⚠️ role="both" 는 **레거시 파일명을 그대로 재사용한다.** 덕분에 단일 슬롯 사용자와 한국장은
 * 디스크 레이아웃이 한 글자도 안 변하고, 마이그레이션 스크립트도 필요 없다.
 */
function snapshotPath(market: StockMarket, role: StockSlotRole): string {
  const suffix = role === "both" ? "" : `-${role}`;
  return path.join(path.dirname(config.dbPath), `stock-${market}${suffix}-latest.json`);
}

/** 스냅샷이 저장될 수 있는 모든 역할 슬롯. 최신본 폴백·슬롯 게이트가 이 목록을 훑는다. */
const SNAPSHOT_ROLES: StockSlotRole[] = ["both", "close", "preview"];

const memo = new Map<string, StockSnapshot>();
/** 동시 실행 잠금은 **market 키 그대로** 유지한다 — 두 역할이 동시에 돌 일은 스케줄상 없고,
 *  허용하면 LLM 호출이 겹친다. */
const running = new Map<StockMarket, boolean>();

function memoKey(market: StockMarket, role: StockSlotRole): string {
  return `${market}|${role}`;
}

function loadFromDisk(market: StockMarket, role: StockSlotRole): StockSnapshot | null {
  try {
    const p = snapshotPath(market, role);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")) as StockSnapshot;
  } catch (e) {
    log.warn(`증시 스냅샷 로드 실패 [${market}/${role}]: ${(e as Error).message}`);
  }
  return null;
}

/**
 * 스냅샷 저장. **저장 역할은 내용 역할과 다를 수 있다** — storageRole 을 명시로 받는 이유다.
 * 휴장 스냅샷이 대표적이다(아래 holidayStorageRole 주석 참고).
 */
function saveToDisk(s: StockSnapshot, storageRole: StockSlotRole): void {
  try {
    const p = snapshotPath(s.market, storageRole);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
  } catch (e) {
    log.warn(`증시 스냅샷 저장 실패 [${s.market}/${storageRole}]: ${(e as Error).message}`);
  }
}

function store(s: StockSnapshot, storageRole: StockSlotRole): void {
  memo.set(memoKey(s.market, storageRole), s);
  saveToDisk(s, storageRole);
}

/**
 * 휴장 스냅샷은 **항상 레거시("both") 경로**에 쓴다.
 *
 * 역할 파일에 쓰면 토요일 08:00 휴장 스냅샷이 stock-us-close-latest.json 에 들어가
 * **금요일 아침의 진짜 결산 브리핑을 지운다** — 주말 내내 화면에서 결산이 사라진다.
 * 휴장은 '그 역할의 최신 브리핑'이 아니라 '오늘은 장이 없다'는 별개의 사실이므로,
 * 역할 파일은 마지막 실제 브리핑을 보존하고 휴장은 both 자리에서 최신본으로 뜬다
 * (getStockSnapshot 의 updatedAt 폴백이 오늘자 휴장을 골라준다).
 *
 * ⚠️ 대가: 파일이 한 곳이라 slot 필드도 하나만 담긴다. 슬롯이 2개인 휴장일에는 나중 런이
 * 앞선 런의 slot 을 덮어써 **어떤 상태에서도 두 슬롯이 동시에 커버되지 않는다.** 그래서
 * catch-up 의 스냅샷 게이트만으로는 휴장일 무한 재수집을 막을 수 없고, 원장(slotHandled)이
 * 1차 근거여야 한다 — scheduler.checkStockCatchup 참고. 여기서 역할 파일에 쓰도록 되돌리면
 * 무한 재수집은 막히지만 금요일 결산이 주말 내내 화면에서 사라진다(더 나쁜 거래).
 */
const HOLIDAY_STORAGE_ROLE: StockSlotRole = "both";

/**
 * 캐시된 스냅샷 (메모리 우선, 없으면 디스크).
 *
 * role 을 지정하면 그 역할 파일만 본다. 생략하면 세 파일 중 **updatedAt 이 가장 최신**인 것을
 * 돌려준다 — 이 폴백 덕에 `GET /stock/:market`·status·기존 호출부가 시그니처 변경 없이
 * 그대로 동작하고, 배포 직후 역할 파일이 아직 없어도 레거시 파일이 계속 보인다.
 */
export function getStockSnapshot(
  market: StockMarket,
  role?: StockSlotRole
): StockSnapshot | null {
  if (role) {
    const m = memo.get(memoKey(market, role));
    if (m) return m;
    const d = loadFromDisk(market, role);
    if (d) memo.set(memoKey(market, role), d);
    return d;
  }
  let best: StockSnapshot | null = null;
  for (const r of SNAPSHOT_ROLES) {
    const s = getStockSnapshot(market, r);
    if (!s) continue;
    if (!best || (s.updatedAt ?? "") > (best.updatedAt ?? "")) best = s;
  }
  return best;
}

/**
 * 이 슬롯의 오늘자 브리핑이 이미 있는지 (catch-up 1차 게이트).
 *
 * ⚠️ **역할이 아니라 슬롯 기준**이다. 역할 기준으로 판정하면 두 슬롯이 같은 밴드에 들어간
 * 구성(예: ["08:00","12:00"] → 둘 다 close)에서 조용히 무너진다. 슬롯은 스케줄러가 이미
 * 확실히 아는 값이라(catch-up 루프 변수) 항상 계산 가능하다.
 *
 * 세 역할 파일을 모두 훑는 이유: 어느 역할로 저장됐는지는 런이 끝나야 알 수 있고,
 * 휴장 런은 역할과 무관하게 both 파일에 쓴다.
 *
 * slot 필드가 **없는** 스냅샷은 이 필드 도입 이전 것이다. 그런 스냅샷이 오늘자면 '어느
 * 슬롯이든 커버한다'로 친다 — 옛 게이트(`snapshotDate !== today()`)와 정확히 같은 동작이라,
 * 배포 당일 이미 끝난 브리핑을 catch-up 이 다시 돌리지 않는다.
 */
export function snapshotForSlot(
  market: StockMarket,
  date: string,
  slot: string
): StockSnapshot | null {
  for (const r of SNAPSHOT_ROLES) {
    const s = getStockSnapshot(market, r);
    if (s && s.date === date && (s.slot === undefined || s.slot === slot)) return s;
  }
  return null;
}

export function hasSnapshotForSlot(market: StockMarket, date: string, slot: string): boolean {
  return snapshotForSlot(market, date, slot) !== null;
}

/** 오늘자 스냅샷이 이미 있는지 (역할 무관). 휴장 스냅샷도 '있음'으로 친다. */
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
 * 후보 목록에서 관심 종목 1건에 대응하는 후보를 고른다. **브리핑 시장을 우선**하고,
 * 없으면 타 시장에서 찾는다(= '해외 참고'로 라우팅될 항목).
 *
 * 채택 조건은 **심볼 정확일치 또는 종목명 완전일치** 둘 중 하나다. "첫 후보"로 폴백하면
 * LLM 이 심볼을 틀렸을 때 **엉뚱한 종목의 시세**가 붙는데, 표시명까지 조회 결과로 교체되므로
 * 화면상으로는 앞뒤가 맞아 보여 아무도 눈치채지 못한다. 지어낸 숫자를 막으려고 만든 검증
 * 계층이 정반대로 동작하는 최악의 경로라, 확신이 없으면 시세를 붙이지 않는다.
 * ⚠️ 이 보수성은 **타 시장 후보에도 똑같이** 적용된다 — 해외 라우팅이 뒷문이 되면 안 된다.
 *
 * 심볼 비교는 반드시 **후보 시장 기준 normalizeSymbol** 을 거친다. 드롭 정책 전환 이후로는
 * 표기 흔들림이 곧 소멸이라, 그냥 대문자 비교만 하면 KRX 에서 흔한 "A005930"·"5930" 표기가
 * "005930" 후보와 어긋나 그날 관심 종목이 통째로 0건이 된다(옛 정책에선 verified=false 로
 * 화면에 남던 항목들이다).
 *
 * 이름 완전일치를 **심볼이 있을 때도** 허용하는 이유: LLM 이 symbol 자리에 종목명을 넣는
 * ("symbol":"삼성전자") 실수가 흔한데, normalizeSymbol("삼성전자","kr") 은 숫자가 없어 ""
 * 를 돌려주므로 심볼 경로로는 회복 불가능하다. 이름 '완전'일치는 부분일치와 달리 오식별
 * 위험이 낮아 이 보수성 예산 안에 들어온다. 빈 정규화 심볼로는 절대 매칭하지 않는다 —
 * "" 가 아무 후보에나 붙으면 위에서 경계한 그 최악의 경로가 열린다.
 *
 * 순수 함수로 분리한 이유: verifyWatchlist 는 네트워크(searchTicker/fetchHistory)를 직접
 * import 해 단위 테스트가 어렵다. 라우팅 판정 로직만은 테스트로 못박는다.
 */
export function pickWatchCandidate(
  candidates: StockSearchCandidate[],
  market: StockMarket,
  symbol: string,
  name: string
): StockSearchCandidate | null {
  const wanted = (symbol ?? "").trim();
  const wantedName = (name ?? "").trim();
  const symbolHit = (c: StockSearchCandidate) => {
    const want = normalizeSymbol(wanted, c.market);
    if (!want) return false;
    return normalizeSymbol(c.symbol, c.market) === want;
  };
  const nameHit = (c: StockSearchCandidate) => !!wantedName && c.name.trim() === wantedName;
  // 시장 우선순위(브리핑 시장 → 타 시장)가 매칭 방식 우선순위(심볼 → 이름)보다 위다.
  const pick = (list: StockSearchCandidate[]) => list.find(symbolHit) ?? list.find(nameHit);
  return (
    pick(candidates.filter((c) => c.market === market)) ??
    pick(candidates.filter((c) => c.market !== market)) ??
    null
  );
}

interface VerifiedWatchlist {
  /** 검증을 통과해 시세가 붙은 항목들(전부 verified=true). */
  items: StockWatchItem[];
  /**
   * **조회 인프라 실패**로 드롭된 건수. 심볼이 안 맞아 떨어진 건(=모델 잘못)은 세지 않는다.
   * 호출부가 '네이버 전면 장애'를 판정해 슬롯을 닫지 않게 하는 데 쓴다 — 과잉 삭제 결과가
   * '성공'으로 확정 저장되면 그날 복구 기회가 사라진다.
   */
  lookupFailures: number;
}

/**
 * watchlist 1건에 대응하는 후보를 찾는다. **심볼로 먼저 검색하고, 못 찾으면 종목명으로 재검색**한다.
 *
 * 재검색이 필요한 이유: 네이버 자동완성은 질의 문자열 자체가 어긋나면 후보를 아예 안 준다
 * (라이브 확인: "A005930" → 0건, "5930" → 일본 종목만). pickWatchCandidate 의 심볼 정규화는
 * '후보를 받은 뒤'의 비교만 고치므로, 질의 단계의 표기 흔들림은 여기서 이름 재검색으로 만회해야
 * 한다. 드롭 정책 전환 이후 이 회복 경로가 없으면 표기 하나로 그날 watchlist 가 0건이 된다.
 *
 * 반환의 `failed` 는 '검색 호출 자체가 예외'였다는 뜻이다(= 인프라 실패). 후보는 왔는데 일치가
 * 없는 것(= 모델이 없는 심볼을 지어냄)과 반드시 구분해야 호출부가 장애를 오판하지 않는다.
 */
async function searchWatchItem(
  w: StockWatchItem,
  market: StockMarket
): Promise<{ hit: StockSearchCandidate | null; reason: string; failed: boolean }> {
  const queries = [w.symbol, w.name]
    .map((q) => (q ?? "").trim())
    .filter((q, i, a) => q && a.indexOf(q) === i);
  if (!queries.length) return { hit: null, reason: "심볼·종목명이 모두 비었다", failed: false };

  const seen: StockSearchCandidate[] = [];
  const errors: string[] = [];
  for (const q of queries) {
    try {
      // 시장 필터 전 **전체 후보**를 보존한다 — 타 시장 판정의 근거가 여기 들어 있다.
      const candidates = await searchTicker(q);
      seen.push(...candidates);
      const hit = pickWatchCandidate(candidates, market, w.symbol, w.name);
      if (hit) return { hit, reason: "", failed: false };
    } catch (e) {
      errors.push(`${q}: ${(e as Error).message}`);
    }
  }
  // 모든 질의가 예외로 끝났을 때만 인프라 실패다. 하나라도 응답을 받았다면 '후보 없음'이다.
  if (errors.length === queries.length)
    return { hit: null, reason: `종목 검색 실패 — ${errors.join(" / ")}`, failed: true };
  return {
    hit: null,
    reason:
      `심볼·이름 일치 후보 없음 (질의: ${queries.join(",")}; 전체 후보: ` +
      `${seen.map((c) => `${c.symbol}/${c.market}`).join(",") || "없음"})`,
    failed: false,
  };
}

/**
 * watchlist 종목의 시세를 사후 조회해 채우고, **실제 상장 시장을 확정해 태그**한다.
 *
 * ⚠️ **설계 반전** — 예전 주석은 "실패해도 항목을 드롭하지 않는다: 시세를 못 붙였을 뿐
 * '시장에서 거론된다'는 사실 자체는 유효하다. verified=false 로 남긴다" 였다. 그 결과
 * 한국장 브리핑의 '오늘의 관심 종목'에 **NVDA 가 close=null·currency="KRW" 로 올라갔다**
 * (KRW 는 curate.ts 가 브리핑 시장으로 정한 임시값이 그대로 살아남은 것이다).
 * 원인은 옛 코드가 두 가지를 구분하지 않은 것이다:
 *   - 일시적 조회 실패/심볼 오타 → 남기는 게 원래 의도였다
 *   - **다른 시장에서 멀쩡히 발견됨** → 이건 실패가 아니라 "이 시장 종목이 아니다"라는 **적극적 증거**
 *
 * 새 규칙:
 *   1) 브리핑 시장에서 심볼 일치 → 그대로 관심 종목.
 *   2) **다른 시장에서 심볼 일치 → 버리지 않고 그 시장으로 시세를 조회**해 붙이고 market 태그를
 *      달아 '해외 참고'로 라우팅한다. 통화는 조회 결과에서 온다(NVDA → us → USD).
 *      라우팅 판정에 추가 검색 호출은 필요 없다 — searchTicker 는 시장 필터를 하지 않아
 *      KOR·USA 후보가 한 응답에 온다. 후보 시장은 kr|us 둘뿐이므로(normalizeSearchItems 가
 *      그 외 nationCode 를 버린다) '타 시장'은 항상 정확히 하나로 결정된다.
 *      (심볼 질의가 후보를 못 얻었을 때만 searchWatchItem 이 이름으로 한 번 더 질의한다.)
 *   3) 시세를 끝내 검증 못 하면 **드롭한다**. verified=false 를 남기지 않는다.
 *
 * 대가: 네이버 조회가 일시적으로 죽으면 **멀쩡한 종목이 조용히 증발한다**. fetchNaver 는
 *   timeout 10초 × 2회 재시도라 항목당 최대 20여 초를 기다린 끝에 사라질 수도 있고,
 *   그날 관심 종목이 통째로 0건이 될 수도 있다.
 * 완화 1: 드롭할 때마다 종목명·심볼·**사유**를 log.warn 으로 남기고 루프 끝에 집계를 남긴다.
 *   "왜 오늘 관심 종목이 비었지"를 로그만으로 추적할 수 있어야 이 반전이 정당화된다 —
 *   그게 없으면 이 변경은 디버그 불가능한 침묵이 된다.
 * 완화 2: 인프라 실패로 인한 드롭 수(lookupFailures)를 호출부에 돌려준다. 전면 장애일 때
 *   '알맹이 없는 브리핑'을 성공으로 확정 저장하지 않기 위한 근거다(refreshStock 4-b 참고).
 * 완화 3: 표기 흔들림(A005930/5930/종목명)은 애초에 드롭 사유가 되지 않게 searchWatchItem +
 *   pickWatchCandidate 가 정규화·이름 재검색으로 흡수한다.
 */
async function verifyWatchlist(
  items: StockWatchItem[],
  market: StockMarket
): Promise<VerifiedWatchlist> {
  const kept: StockWatchItem[] = [];
  let dropped = 0;
  let foreign = 0;
  let lookupFailures = 0;
  const drop = (w: StockWatchItem, reason: string) => {
    dropped++;
    log.warn(
      `증시 큐레이션: 관심 종목 폐기 [${market}] ${w.name}(${w.symbol || "심볼없음"}) — ${reason}`
    );
  };

  for (const w of items) {
    const found = await searchWatchItem(w, market);
    if (!found.hit) {
      if (found.failed) lookupFailures++;
      drop(w, found.reason);
      continue;
    }
    const hit = found.hit;
    try {
      // ⚠️ 두번째 인자는 반드시 **hit.market** 이다. quoteCode 는 시장과 짝이고
      // quote.ts 가 이 값으로 domestic/foreign URL 을 가른다. 브리핑 market 을 그대로 넘기면
      // 해외 종목을 domestic 경로로 조회해 빈 배열이 오고, 새 드롭 정책상 조용히 증발한다.
      const points = await fetchHistory(hit.quoteCode, hit.market, HISTORY_DAYS);
      const last = lastPoint(points);
      if (!last || last.close == null) {
        if (!last) lookupFailures++;
        drop(
          w,
          `${last ? "최근 종가 없음" : "시세 조회 실패"} ` +
            `(조회 시장=${hit.market}, quoteCode=${hit.quoteCode})`
        );
        continue;
      }

      if (hit.market !== market) {
        foreign++;
        log.info(
          `증시 큐레이션: 관심 종목 → 해외 참고 라우팅 [${market}→${hit.market}] ` +
            `${hit.name || w.name}(${hit.symbol}) ${last.currency}`
        );
      }
      kept.push({
        ...w,
        symbol: hit.symbol,
        name: hit.name || w.name,
        quoteCode: hit.quoteCode,
        market: hit.market, // ← 시장 태그. 렌더 계층(partitionWatchlist)이 이걸로 분리한다.
        close: last.close,
        changePct: last.changePct,
        weekChangePct: weekChange(points),
        currency: last.currency, // ← 여기서 통화가 확정된다(us 라우팅이면 USD).
        history: points,
        ma5: movingAverage(points, 5),
        ma20: movingAverage(points, 20),
        verified: true, // 검증 실패는 위에서 전부 드롭됐다.
      });
    } catch (e) {
      // fetchHistory 는 실패 시 throw 한다(quote.ts 계약). 옛 설계에선 통과였으나 이제 드롭이다.
      lookupFailures++;
      drop(w, `시세 조회 예외: ${(e as Error).message}`);
    }
  }
  log.info(
    `증시 관심 종목 검증 [${market}]: 입력 ${items.length} → 관심 ${kept.length - foreign} / ` +
      `해외참고 ${foreign} / 폐기 ${dropped}(조회 실패 ${lookupFailures})`
  );
  return { items: kept, lookupFailures };
}

export interface RefreshStockOptions {
  market: StockMarket;
  trigger: string;
  notify?: boolean;
  /**
   * 이 런이 귀속되는 스케줄 슬롯("HH:mm"). 정시/catch-up 은 스케줄러가 이미 아는 값을 넘긴다.
   * 미지정(수동 갱신)이면 런 시작 시각 기준 '가장 최근 지난 슬롯'으로 귀속된다(notify-ledger).
   */
  slot?: string;
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
    // 슬롯은 반드시 **런 시작 시점**에 확정한다. 런이 6~8분 걸리므로(로그 08:00:00.383 →
    // 08:06:02.511) 알림 블록에서 다시 구하면 다음 슬롯 키를 선점해 조용한 누락이 난다.
    const slot = resolveSlot(market, opts.slot, now);
    // 역할은 슬롯에서 **파생**된다. now 로 유도하면 catch-up 런(실행 시각과 슬롯 시각이 최대
    // 9시간 차)이 뒤집힌다 — slot-role.ts 상단 주석 참고. 슬롯과 함께 런 시작 시점에 한 번만
    // 확정하고 런 전체에 스레딩한다.
    const times = market === "kr" ? getSchedule().stockKr : getSchedule().stockUs;
    const { role, reason: roleReason } = stockSlotRoleDetail(market, slot, times);
    // 후퇴 방지 가드의 '직전 값'은 반드시 **같은 역할**의 스냅샷이어야 한다. 역할 무관으로
    // 잡으면 프리뷰 수집 실패 시 아침 결산 스냅샷이 prev 로 반환돼 프리뷰 자리에 결산이 남는다.
    const prev = getStockSnapshot(market, role);
    startStockRun(today, market);
    ensureSeedTickers();
    log.info(`증시 역할 판정 [${market}] role=${role} ← ${roleReason}`);

    // ── 1. 휴장 체크 (LLM 호출 전에 — 휴장이면 토큰을 한 푼도 쓰지 않는다) ──
    const closed = await resolveSession(market, now, today, role);
    if (closed.holiday) {
      // ⚠️ 휴장 스냅샷의 date 는 반드시 **오늘**(수집일)이다. sessionDate 를 넣으면
      // catch-up 게이트가 계속 '오늘 것 없음'으로 보고 30분마다 무한 재시도한다.
      // slot 도 싣는다(슬롯이 1개인 구성에서는 이것만으로 게이트가 닫힌다). 슬롯이 2개면
      // 파일이 하나뿐이라 뒤 런이 앞 런의 slot 을 덮어쓰므로, 최종 방어선은 아래 SLOT_HANDLED 원장이다.
      const snap = holidaySnapshot(market, today, closed.sessionDate, closed.reason, {
        role,
        roleReason,
        slot,
      });
      // 휴장은 역할 파일이 아니라 both 경로에 쓴다(HOLIDAY_STORAGE_ROLE 주석).
      store(snap, HOLIDAY_STORAGE_ROLE);
      // 휴장은 보낼 것이 없으므로 이 슬롯을 SLOT_HANDLED 로 '닫는다'. 닫지 않으면
      // catch-up 원장 게이트가 미발송으로 보고 30분마다 휴장 수집을 반복한다.
      // 다른 슬롯 기록은 그대로 보존한다(과거처럼 맵을 false 로 리셋하면 같은 날 앞선
      // 슬롯의 발송 기록이 지워져 뒷 슬롯이 재발송된다). finishStockRun 이 detail 을
      // 통째로 덮어쓰기 때문에 '건드리지 않음' = '맵 전체 재기록' 이다.
      finishStockRun(today, market, true, {
        closed: true,
        reason: closed.reason,
        notifiedBySlot: mergeNotified(loadNotifiedMap(today, market), slot, SLOT_HANDLED),
      });
      log.info(`증시 휴장 [${market}] ${today} — ${closed.reason ?? "사유 미상"} (LLM·알림 생략)`);
      return snap;
    }
    const sessionDate = closed.sessionDate;

    // ── 2. 확정 시세 수집 ──
    const g = await gather(market);

    // ── 2-b. 실증 휴장 폴백 (달력이 놓친 휴장의 마지막 방어선) ──
    // 이 판정은 "시세 시계열에 sessionDate 데이터가 **이미 존재하는가**"를 본다.
    // 그래서 **개장 전 브리핑에는 걸 수 없다** — 대상 세션이 아직 안 열렸으니 데이터가 없는 게
    // 정상이고, 판정을 걸면 매일 휴장으로 오판한다. 해당되는 두 경우:
    //   · 한국장(항상 09:00 개장 전 프리뷰) → market === "us" 조건이 거른다
    //   · 미국장 role="preview"(오늘 밤 세션, 17:00 KST = 03~04시 ET) → role 조건이 거른다
    // ⚠️ 두 조건을 **모두** 유지해야 한다. 한국장은 이 설계에서 role="both" 이므로
    //    market 항을 지우면 한국장이 다시 이 폴백에 걸려 매일 휴장으로 오판한다.
    // close/both 는 sessionDate 가 과거의 마감된 세션이라 판정이 유효하므로 그대로 유지한다.
    if (market === "us" && role !== "preview" && g.indexPoints.length && sessionDate) {
      if (markClosedIfNoSession(market, sessionDate, g.indexPoints)) {
        const snap = holidaySnapshot(market, today, sessionDate, "휴장(시세 없음)", {
          role,
          roleReason,
          slot,
        });
        store(snap, HOLIDAY_STORAGE_ROLE);
        // 위 달력 휴장과 동일 — 이 슬롯만 닫고 앞선 슬롯 기록은 맵 전체로 되쓴다.
        finishStockRun(today, market, true, {
          closed: true,
          reason: "휴장(시세 없음)",
          notifiedBySlot: mergeNotified(loadNotifiedMap(today, market), slot, SLOT_HANDLED),
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
      role,
      roleReason,
      slot,
      now: nowLabel(now),
      quotes: g.quotes,
      indices: g.indices,
      exchangeRate: g.exchangeRate,
      histories: g.histories,
      indexHistories: g.indexHistories,
    });

    // ── 4. 검증: watchlist 시세 사후 조회 ──
    const verified =
      curated.source === "llm" ? await verifyWatchlist(curated.watchlist, market) : null;
    const snapshot: StockSnapshot = verified ? { ...curated, watchlist: verified.items } : curated;

    // ── 4-b. 시세 인프라 전면 장애 판정 ──
    // 드롭 정책 전환의 부작용 차단선이다. 네이버가 죽으면 지수는 빈 배열이 되고 등록 종목
    // 시세는 전부 null 이 되며 watchlist 는 통째로 드롭되는데, LLM 뉴스·분석 서술은 그대로
    // 남는다. 그러면 hasContent(지수+뉴스+분석)가 참이라 **알맹이 없는 브리핑이 발송되고
    // 슬롯이 닫혀** 몇 분 뒤 네이버가 살아나도 그날은 영영 복구되지 않는다.
    // 그래서 이 상태는 '성공'이 아니라 수집 실패로 취급한다 → 발송 생략 + 슬롯 열어둠
    // → 30분 catch-up 이 재시도한다(scheduler.checkStockCatchup 의 slotNeedsCatchup 게이트).
    // 조건은 watchlist 와 무관한 **등록 종목·지수** 기준이다. LLM 이 종목을 하나도 안 냈거나
    // 심볼을 지어낸 경우(모델 잘못)를 장애로 오판하면 catch-up 이 매번 헛돈다.
    const quoteOutage =
      curated.source === "llm" &&
      g.indices.length === 0 &&
      g.quotes.length > 0 &&
      g.quotes.every((q) => q.close == null);
    if (quoteOutage) {
      log.warn(
        `증시 시세 인프라 전면 장애 의심 [${market}] — 지수 0건 / 등록 종목 ${g.quotes.length}건 전부 시세 없음 / ` +
          `관심 종목 조회 실패 ${verified?.lookupFailures ?? 0}건 → 알림 생략, 슬롯 ${slot} 열어둔 채 catch-up 대기`
      );
    }

    // ── 5. 저장 (후퇴 방지 가드) ──
    // 수집 실패(source="empty")로 정상 브리핑을 빈 화면으로 덮어쓰지 않는다.
    // "holiday"는 이 조건에 걸리지 않아 정상 저장된다(휴장은 실패가 아니라 정상 결과).
    if (snapshot.source === "empty" && prev?.source === "llm") {
      log.warn(`증시 수집 실패 [${market}] → 기존 스냅샷 유지 (${snapshot.notes ?? "원인 미상"})`);
      // 맵 '전체'를 보존한다(단일 슬롯만 되쓰면 나머지 슬롯 기록이 소실된다).
      finishStockRun(today, market, false, {
        error: snapshot.notes,
        notifiedBySlot: loadNotifiedMap(today, market),
      });
      return prev;
    }
    store(snapshot, role);

    // ── 6. 알림 (stock_runs 원장으로 **슬롯×채널** 멱등) ──
    // 키가 (date, market) 뿐이던 시절엔 같은 날 두 번째 슬롯(예: 17:00)이 첫 슬롯의
    // notified=true 에 막혀 통째로 삼켜졌다. 이제 슬롯별로 따로 기록해
    // '슬롯당 1회 발송 + 같은 슬롯 재실행(catch-up/재시작) 시 중복 방지'를 동시에 만족한다.
    // ok=false 는 '이 슬롯을 닫지 않는다'는 뜻이다(발송 생략 + 원장에 미발송으로 남김).
    const ok = snapshot.source === "llm" && !quoteOutage;
    const notifiedMap = loadNotifiedMap(today, market);
    let { email: emailed, imessage: imessaged } = slotNotified(notifiedMap, slot);
    const hasContent =
      snapshot.indices.length + snapshot.news.length + snapshot.analyses.length > 0;
    // 첫 슬롯 이전의 수동 갱신(MANUAL_SLOT)은 메울 슬롯이 없으므로 발송하지 않는다.
    // 보내면 곧 오는 첫 정시 슬롯이 같은 브리핑을 한 번 더 보낸다(07:30 수동 → 08:00 정시).
    // 수동 갱신은 '지난 슬롯의 누락을 보충'할 뿐 새 알림을 만들지 않는다(notify-ledger 참고).
    const sendable = opts.notify === true && slot !== MANUAL_SLOT;
    if (sendable && ok && hasContent && (!emailed || !imessaged)) {
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
    } else if (sendable && ok && !hasContent) {
      // 보낼 내용이 없는 것은 '실패'가 아니라 확정된 결과다 → 슬롯을 닫아 catch-up 이
      // 이 슬롯을 30분마다 재시도하지 않게 한다(수집 실패 ok=false 는 반대로 열어 둔다).
      emailed = SLOT_HANDLED.email;
      imessaged = SLOT_HANDLED.imessage;
      log.info(`증시 브리핑 내용 0건 [${market}] → 알림 발송 생략 (슬롯 ${slot} 종료 처리)`);
    }

    finishStockRun(today, market, ok, {
      sessionDate,
      source: snapshot.source,
      notifiedBySlot: mergeNotified(notifiedMap, slot, { email: emailed, imessage: imessaged }),
    });
    // 관심 종목 수를 domestic/foreign 으로 쪼개 찍는다 — 배포 후 며칠간 이 비율로
    // '프롬프트 강화가 먹히는지'(해외 유출이 줄어드는지)를 로그만으로 관찰할 수 있어야 한다.
    const wl = partitionWatchlist(snapshot);
    log.info(
      `증시 수집 완료 [${trigger}] [${market}] ${today} 슬롯 ${slot} role=${role} ` +
        `(거래일 ${sessionDate ?? "미상"}, ` +
        `source=${snapshot.source}, 분석 ${snapshot.analyses.length} / 관심 ${wl.domestic.length} / ` +
        `해외참고 ${wl.foreign.length})`
    );
    return snapshot;
  } finally {
    running.set(market, false);
  }
}

/**
 * 대상 거래일과 휴장 여부를 정한다.
 *
 * ── 한국장 ──
 * 항상 **09:00 개장 전 프리뷰**다. 대상은 오늘 세션. nextKrSessionDate 가 오늘이 아닌 날을
 * 돌려주면 오늘은 거래일이 아니다 → 휴장.
 *
 * ── 미국장: 발화 게이트와 내용 날짜를 분리한다 ──
 * 미국장 브리핑은 이제 슬롯마다 성격이 다르다(role). 하지만 **휴장 게이트는 역할과 무관하게
 * 공통이다** — 이것이 이 함수의 가장 중요한 설계 결정이라 근거를 남긴다.
 *
 * 게이트는 `isMarketClosed("us", today_KST)` 하나다. 이건 "뉴욕 날짜 판정"이라기보다
 * **"이 KST 날짜에 미국장 브리핑을 보내는가"라는 정책 게이트**로 읽어야 한다. 그대로 두면
 * 발화하는 날의 집합이 역할 분리 전과 **비트 단위로 동일**하다 → 주말·공휴일에 요청되지 않은
 * 새 알림이 생기는 것이 구조적으로 불가능하다.
 *
 * ⚠️ '결산 게이트는 직전 마감 세션이 있는가로 판정해야 한다'는 것이 언뜻 자연스러워 보이지만
 *    **채택하지 않았다.** 그 술어는 "뉴욕 D−1 이 거래일인가" 이고, 토요일 08:00 KST 는
 *    D−1=금요일이라 참이 되어 **토요일 아침 이메일이 신설**된다(+미국 공휴일 아침 연 ~9회).
 *    사용자가 요청한 적 없는 알림이므로 금지다.
 *
 * 현행 게이트로도 결산 누락이 없다는 근거(불변식):
 *   아침 런이 발화하는 조건은 "뉴욕 날짜 D 가 거래일"이고, 그때 lastUsSessionDate 는 D 직전
 *   세션 S 를 준다. 다음 발화일 D' 의 결산 대상은 D(≠S)다. 따라서 **모든 뉴욕 세션이 정확히
 *   1회씩, 다음 뉴욕 거래일 아침에 결산된다 — 중복도 누락도 없다.**
 *   유일한 대가는 **지연**(금요일 마감 → 월요일 아침, 연휴면 최대 3~4일)이고, 이는 새로
 *   생기는 대가가 아니라 이미 현행 동작이다.
 *
 * 역할별로 갈리는 것은 게이트가 아니라 **내용 날짜(sessionDate)** 다:
 *   · role='preview' → today (오늘 밤 열릴 뉴욕 세션)
 *   · role='close'   → lastUsSessionDate (이미 마감된 직전 세션)
 *   · role='both'    → lastUsSessionDate (현행 혼합본과 동일 — 하위호환)
 *
 * 휴장 스냅샷의 sessionDate 는 역할과 무관하게 `last` 로 통일한다. preview 휴장에서 today 를
 * 넣으면 "07-25(토) 세션" 이라는 **존재하지 않는 세션**을 화면에 표시하게 된다.
 * 휴장 문구의 역할별 차이는 sessionDate 가 아니라 렌더 계층에서 처리한다.
 *
 * export 하는 이유: 위 불변식과 역할별 sessionDate 는 **테스트 없이는 회귀를 감지할 방법이
 * 전혀 없다.** 예전에는 private 라 단위 테스트가 0건이었다.
 */
export async function resolveSession(
  market: StockMarket,
  now: Date,
  today: string,
  role: StockSlotRole
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
  if (role === "preview") return { holiday: false, sessionDate: today, reason: null };
  return { holiday: false, sessionDate: last, reason: null };
}

/** 현재 시각 라벨 "YYYY-MM-DD HH:mm" (뉴스/유튜브 큐레이터와 동일 포맷). */
function nowLabel(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${localDate(d)} ${hh}:${mm}`;
}
