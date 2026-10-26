import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSymbol,
  formatPrice,
  changeTone,
  marketLabel,
  DEFAULT_STOCK_TICKERS,
  partitionWatchlist,
  watchMarket,
  foreignSectionTitle,
  seoulToday,
  isPreviewUpcoming,
  isSymbolRegistered,
} from "./stock.ts";
import type { StockMarket, StockSnapshot, StockWatchItem } from "./types.ts";

test("KR 심볼: 표기가 어떻든 6자리 코드 하나로 수렴한다(자연키가 갈라지면 안 됨)", () => {
  assert.equal(normalizeSymbol("5930", "kr"), "005930");
  assert.equal(normalizeSymbol("005930", "kr"), "005930");
  assert.equal(normalizeSymbol("A005930", "kr"), "005930"); // 증권사 표기 접두사
  assert.equal(normalizeSymbol(" 005930 ", "kr"), "005930");
  assert.equal(normalizeSymbol("000660", "kr"), "000660");
});

test("KR 심볼: 숫자가 없으면 '' — zero-pad 로 '000000' 이라는 가짜 코드를 만들지 않는다", () => {
  assert.equal(normalizeSymbol("", "kr"), "");
  assert.equal(normalizeSymbol("   ", "kr"), "");
  assert.equal(normalizeSymbol("삼성전자", "kr"), "");
});

test("US 심볼: trim + 대문자, 점은 티커의 일부라 보존", () => {
  assert.equal(normalizeSymbol("aapl", "us"), "AAPL");
  assert.equal(normalizeSymbol(" nvda ", "us"), "NVDA");
  assert.equal(normalizeSymbol("AAPL", "us"), "AAPL");
  assert.equal(normalizeSymbol("brk.b", "us"), "BRK.B");
  assert.equal(normalizeSymbol("", "us"), "");
});

test("formatPrice KRW: 천단위 구분 + '원', REAL 로 들어온 소수는 반올림", () => {
  assert.equal(formatPrice(349000, "KRW"), "349,000원");
  assert.equal(formatPrice(346500.0, "KRW"), "346,500원");
  assert.equal(formatPrice(346500.4, "KRW"), "346,500원");
  assert.equal(formatPrice(0, "KRW"), "0원"); // 0 은 값 없음이 아니다
});

test("formatPrice USD: 항상 소수 2자리", () => {
  assert.equal(formatPrice(295.95, "USD"), "$295.95");
  assert.equal(formatPrice(300, "USD"), "$300.00");
  assert.equal(formatPrice(1234.5, "USD"), "$1,234.50");
  assert.equal(formatPrice(0, "USD"), "$0.00");
});

test("formatPrice: 값 없음/비정상 수치는 '-'", () => {
  assert.equal(formatPrice(null, "KRW"), "-");
  assert.equal(formatPrice(null, "USD"), "-");
  assert.equal(formatPrice(NaN, "USD"), "-");
  assert.equal(formatPrice(Infinity, "KRW"), "-");
});

test("formatPrice: 미지원 통화도 숫자를 잃지 않는다", () => {
  assert.equal(formatPrice(1234.5, "JPY"), "1,234.5 JPY");
});

test("changeTone: 0 과 null 은 모두 flat(색 없음)", () => {
  assert.equal(changeTone(1.2), "up");
  assert.equal(changeTone(0.001), "up");
  assert.equal(changeTone(-1.2), "down");
  assert.equal(changeTone(-0.001), "down");
  assert.equal(changeTone(0), "flat");
  assert.equal(changeTone(null), "flat");
  assert.equal(changeTone(NaN), "flat");
});

test("marketLabel", () => {
  assert.equal(marketLabel("kr"), "한국장");
  assert.equal(marketLabel("us"), "미국장");
});

test("시드는 자기 자신의 정규화 규칙을 통과한다(시드가 원장에 두 행으로 갈라지지 않게)", () => {
  for (const market of ["kr", "us"] as const) {
    for (const t of DEFAULT_STOCK_TICKERS[market]) {
      assert.equal(normalizeSymbol(t.symbol, market), t.symbol, `${market} ${t.symbol}`);
    }
  }
});

test("KR 시드는 quoteCode 가 symbol 과 같고, US 시드는 로이터 코드를 쓴다", () => {
  for (const t of DEFAULT_STOCK_TICKERS.kr) assert.equal(t.quoteCode, t.symbol);
  for (const t of DEFAULT_STOCK_TICKERS.us) assert.match(t.quoteCode, /^[A-Z]+\.[A-Z]$/);
});

// ── partitionWatchlist / watchMarket ──────────────────────────
// 한국장 브리핑에 NVDA 가 섞여 나온 버그의 재발 방지선. 렌더 계층은 반드시 이 함수로 가른다.

function watch(over: Partial<StockWatchItem> = {}): StockWatchItem {
  return {
    symbol: "005930",
    name: "삼성전자",
    quoteCode: "005930",
    close: 346500,
    changePct: 1.2,
    weekChangePct: 3.4,
    currency: "KRW",
    history: [],
    ma5: null,
    ma20: null,
    summary: "요약",
    outlook: "전망",
    rationale: "근거",
    risks: "리스크",
    verdict: "📈",
    verified: true,
    attention: "🔥강",
    levels: null,
    ...over,
  };
}

function snap(watchlist: StockWatchItem[], market: StockMarket = "kr"): StockSnapshot {
  return {
    market,
    date: "2026-07-17",
    sessionDate: "2026-07-17",
    updatedAt: "2026-07-17T18:00:00+09:00",
    source: "llm",
    closed: false,
    closedReason: null,
    indices: [],
    news: [],
    analyses: [],
    watchlist,
    disclaimer: "면책",
    notes: null,
  };
}

test("partitionWatchlist: market 태그가 스냅샷 시장과 같으면 관심 종목", () => {
  const { domestic, foreign } = partitionWatchlist(snap([watch({ market: "kr" })]));
  assert.equal(domestic.length, 1);
  assert.equal(foreign.length, 0);
});

test("partitionWatchlist: 타 시장 태그는 해외 참고로 갈린다(한국장의 NVDA)", () => {
  const nvda = watch({ symbol: "NVDA", name: "엔비디아", market: "us", currency: "USD" });
  const { domestic, foreign } = partitionWatchlist(snap([watch({ market: "kr" }), nvda]));
  assert.deepEqual(
    domestic.map((w) => w.symbol),
    ["005930"]
  );
  assert.deepEqual(
    foreign.map((w) => w.symbol),
    ["NVDA"]
  );
});

test("partitionWatchlist: 미국장 브리핑의 한국 종목도 대칭으로 갈린다", () => {
  const s = snap([watch({ symbol: "AAPL", market: "us" }), watch({ market: "kr" })], "us");
  const { domestic, foreign } = partitionWatchlist(s);
  assert.deepEqual(
    domestic.map((w) => w.symbol),
    ["AAPL"]
  );
  assert.deepEqual(
    foreign.map((w) => w.symbol),
    ["005930"]
  );
});

test("하위호환: market 태그 없는 옛 항목은 스냅샷 시장 소속으로 폴백한다", () => {
  const old = watch(); // market 키 자체가 없다(이 필드 도입 이전 스냅샷)
  assert.equal(old.market, undefined);
  assert.equal(watchMarket(old, "kr"), "kr");
  assert.equal(watchMarket(old, "us"), "us");
  const { domestic, foreign } = partitionWatchlist(snap([old]));
  assert.equal(domestic.length, 1, "옛 항목은 전부 관심 종목으로 분류되어야 한다");
  assert.equal(foreign.length, 0);
});

test("레거시 오염: market 태그 없고 verified=false 인 항목은 어느 섹션에도 렌더되지 않는다", () => {
  // 실제 디스크의 data/stock-kr-latest.json 재현 — 옛 verifyWatchlist 가 통과시킨 NVDA.
  // 스냅샷 시장으로 폴백하면 신고된 증상(한국장 관심 종목에 엔비디아, KRW/가격 '-')이
  // 다음 수집 전까지 그대로 되살아난다.
  const nvda = watch({
    symbol: "NVDA",
    name: "엔비디아",
    currency: "KRW",
    close: null,
    verified: false,
  });
  delete (nvda as { market?: unknown }).market;
  const { domestic, foreign, stale } = partitionWatchlist(snap([nvda, watch({ market: "kr" })]));
  assert.deepEqual(
    domestic.map((w) => w.symbol),
    ["005930"]
  );
  assert.deepEqual(foreign, []);
  assert.deepEqual(
    stale.map((w) => w.symbol),
    ["NVDA"]
  );
});

test("레거시 오염 판정은 verified 만 본다 — 태그가 붙은 항목은 그대로 분류된다", () => {
  // 새 정책의 항목은 항상 verified=true 라 stale 로 새지 않아야 한다.
  const s = snap([watch({ market: "us", symbol: "NVDA" }), watch({ market: "kr" })]);
  const { domestic, foreign, stale } = partitionWatchlist(s);
  assert.equal(domestic.length, 1);
  assert.equal(foreign.length, 1);
  assert.deepEqual(stale, []);
});

test("하위호환: watchlist 키가 아예 없는 스냅샷에도 throw 하지 않는다", () => {
  // loadFromDisk 가 `as StockSnapshot` 캐스트라 옛 JSON 이 그대로 흐를 수 있다.
  const legacy = { ...snap([]) } as StockSnapshot;
  delete (legacy as { watchlist?: unknown }).watchlist;
  const { domestic, foreign } = partitionWatchlist(legacy);
  assert.deepEqual(domestic, []);
  assert.deepEqual(foreign, []);
});

test("해외 참고 섹션 제목은 시장 대칭이 아니다(미국장의 한국 종목은 '해외'가 아니다)", () => {
  assert.equal(foreignSectionTitle("kr"), "해외 참고");
  assert.equal(foreignSectionTitle("us"), "국내(한국) 참고");
});

// ── 프리뷰 시제: '오늘 밤'은 조건부다 ────────────────────────────────
//
// 프리뷰 스냅샷은 오후 슬롯에서만 갱신되므로, 다음 오후까지 약 9시간 동안 화면에는 **어제 밤**
// 프리뷰가 남는다. 그것을 '오늘 밤'이라 단언하면 이미 끝난 세션을 미래형으로 읽게 되어
// 사용자가 결산과 프리뷰를 혼동한다. 라벨(탭)과 본문이 모두 이 술어로 시제를 정한다.

test("프리뷰 신선도: 오늘 밤 세션이면 미래형", () => {
  assert.equal(isPreviewUpcoming({ role: "preview", sessionDate: "2026-07-20" }, "2026-07-20"), true);
});

test("프리뷰 신선도: 지난 밤 세션은 미래형이 아니다(화요일 아침의 월요일 프리뷰)", () => {
  // 화요일 09:00 — 08:00 결산은 돌았고 프리뷰 파일은 월요일 17:00 런 그대로다.
  assert.equal(isPreviewUpcoming({ role: "preview", sessionDate: "2026-07-20" }, "2026-07-21"), false);
});

test("프리뷰 신선도: 결산·혼합·구 스냅샷은 애초에 프리뷰가 아니다", () => {
  assert.equal(isPreviewUpcoming({ role: "close", sessionDate: "2026-07-21" }, "2026-07-21"), false);
  assert.equal(isPreviewUpcoming({ role: "both", sessionDate: "2026-07-21" }, "2026-07-21"), false);
  // role 없는 구 디스크 스냅샷 → effectiveRole 이 both 로 접는다.
  assert.equal(isPreviewUpcoming({ role: undefined, sessionDate: "2026-07-21" }, "2026-07-21"), false);
});

test("프리뷰 신선도: sessionDate 가 없으면 미래형이 아니다", () => {
  assert.equal(isPreviewUpcoming({ role: "preview", sessionDate: null }, "2026-07-21"), false);
});

test("seoulToday 는 브라우저 타임존과 무관하게 서울 날짜를 준다", () => {
  // 2026-07-20 16:00 UTC = 서울 07-21 01:00. 로컬 타임존이 무엇이든 07-21 이어야 한다
  // (해외에서 대시보드를 열면 프리뷰 라벨이 하루 어긋나던 문제의 축).
  assert.equal(seoulToday(new Date("2026-07-20T16:00:00Z")), "2026-07-21");
  assert.equal(seoulToday(new Date("2026-07-20T14:00:00Z")), "2026-07-20");
  assert.match(seoulToday(), /^\d{4}-\d{2}-\d{2}$/);
});

// ── 등록 종목 중복 판정 ──────────────────────────────────────────────
//
// '오늘의 관심 종목' 카드의 '등록 종목에 추가' 버튼은 이미 원장에 있는 종목이면 뜨면 안 된다.
// 판정 축은 **정규화된 심볼**이다: 스냅샷의 watchlist 심볼은 LLM 이 쓴 표기라 "5930"·"A005930"
// 처럼 흔들릴 수 있고, 원장은 normalizeSymbol 을 거친 "005930" 만 갖는다. 원문 비교로 판정하면
// 같은 종목에 '추가' 버튼이 다시 떠서 서버가 중복 추가를 거절하거나 행이 갈라진다.

test("등록 판정: 표기가 흔들려도 정규화하면 같은 종목이다(KR)", () => {
  const ledger = [
    { symbol: "005930", market: "kr" as StockMarket },
    { symbol: "000660", market: "kr" as StockMarket },
  ];
  assert.equal(isSymbolRegistered("005930", "kr", ledger), true);
  assert.equal(isSymbolRegistered("5930", "kr", ledger), true); // zero-pad 누락
  assert.equal(isSymbolRegistered("A005930", "kr", ledger), true); // 증권사 표기 접두사
  assert.equal(isSymbolRegistered(" 000660 ", "kr", ledger), true);
});

test("등록 판정: 원장에 없는 종목은 false — 추가 버튼이 떠야 한다", () => {
  const ledger = [{ symbol: "005930", market: "kr" as StockMarket }];
  assert.equal(isSymbolRegistered("035420", "kr", ledger), false);
  assert.equal(isSymbolRegistered("005930", "kr", []), false);
});

test("등록 판정: US 는 대소문자·공백을 무시하고 점은 티커의 일부다", () => {
  const ledger = [
    { symbol: "AAPL", market: "us" as StockMarket },
    { symbol: "BRK.B", market: "us" as StockMarket },
  ];
  assert.equal(isSymbolRegistered("aapl", "us", ledger), true);
  // 공백은 **원장에 있는 심볼**로 검증해야 의미가 있다. 원장에 없는 심볼(NVDA)로 재면
  // trim 을 지워도 결과가 false 그대로라 공백 처리를 전혀 검증하지 못한다.
  assert.equal(isSymbolRegistered(" aapl ", "us", ledger), true);
  assert.equal(isSymbolRegistered(" BRK.B ", "us", ledger), true);
  assert.equal(isSymbolRegistered(" NVDA ", "us", ledger), false); // 원장에 없으면 공백과 무관하게 false
  assert.equal(isSymbolRegistered("brk.b", "us", ledger), true);
  assert.equal(isSymbolRegistered("BRKB", "us", ledger), false); // 점을 지운 표기는 다른 티커다
});

test("등록 판정: 시장이 다른 원장 행은 매칭하지 않는다(엉뚱한 시장의 등록 종목 방지)", () => {
  // 원장 목록은 시장별로 받아오지만, 계약 자체가 시장을 확인해야 호출부가 흔들려도 안전하다.
  const ledger = [{ symbol: "AAPL", market: "us" as StockMarket }];
  assert.equal(isSymbolRegistered("AAPL", "kr", ledger), false);
  assert.equal(isSymbolRegistered("AAPL", "us", ledger), true);
});

test("등록 판정: 식별 불가 심볼은 false — 빈 정규화값끼리 맞물려 '등록됨'으로 보이면 안 된다", () => {
  // normalizeSymbol 은 KR 에서 숫자가 없으면 "" 를 준다. 원장에 깨진 행이 있어도
  // ""==="" 로 맞물려 버튼이 사라지면 사용자는 추가할 방법을 잃는다.
  const ledger = [{ symbol: "삼성전자", market: "kr" as StockMarket }];
  assert.equal(isSymbolRegistered("삼성전자", "kr", ledger), false);
  assert.equal(isSymbolRegistered("", "kr", ledger), false);
  assert.equal(isSymbolRegistered("", "us", [{ symbol: "", market: "us" as StockMarket }]), false);
});
