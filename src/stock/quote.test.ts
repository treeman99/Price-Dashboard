import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeChartRows,
  normalizeSearchItems,
  parseLocalDate,
  parseNaverNumber,
  parseSiseJson,
} from "./quote.ts";

// 픽스처는 전부 **실제 네이버 응답**에서 복사했다. 합성 데이터로 만들면
// 필드명/포맷이 바뀌어도 테스트가 통과해 버려 파서 회귀를 못 잡는다.
// 네트워크 테스트는 넣지 않는다(CI 에서 깨진다).

test("parseNaverNumber: 콤마 문자열/숫자/쓰레기값", () => {
  assert.equal(parseNaverNumber("1,486.50"), 1486.5);
  assert.equal(parseNaverNumber("-0.13"), -0.13);
  assert.equal(parseNaverNumber(346500.0), 346500);
  assert.equal(parseNaverNumber(0), 0);
  assert.equal(parseNaverNumber("N/A"), null);
  assert.equal(parseNaverNumber(""), null);
  assert.equal(parseNaverNumber(null), null);
  assert.equal(parseNaverNumber(undefined), null);
  assert.equal(parseNaverNumber(Infinity), null);
  assert.equal(parseNaverNumber(NaN), null);
});

test("parseLocalDate: YYYYMMDD → YYYY-MM-DD, 형식 어긋나면 null", () => {
  assert.equal(parseLocalDate("20260617"), "2026-06-17");
  assert.equal(parseLocalDate("날짜"), null);
  assert.equal(parseLocalDate("2026-06-17"), null);
  assert.equal(parseLocalDate(20260617), null);
});

test("normalizeChartRows: 한국 종목 차트 응답(005930) — 오름차순 + changePct 서버 계산", () => {
  // api.stock.naver.com/chart/domestic/item/005930/day 실제 응답 (역순으로 섞어 정렬도 검증)
  const raw = [
    {
      localDate: "20260617",
      closePrice: 346500.0,
      openPrice: 332000.0,
      highPrice: 348000.0,
      lowPrice: 331500.0,
      accumulatedTradingVolume: 18134051,
      foreignRetentionRate: 47.57,
    },
    {
      localDate: "20260616",
      closePrice: 330000.0,
      openPrice: 329000.0,
      highPrice: 331000.0,
      lowPrice: 328000.0,
      accumulatedTradingVolume: 12000000,
      foreignRetentionRate: 47.5,
    },
  ];
  const pts = normalizeChartRows(raw, "KRW");

  assert.equal(pts.length, 2);
  assert.deepEqual(
    pts.map((p) => p.date),
    ["2026-06-16", "2026-06-17"]
  );
  // 첫 점은 직전 종가를 모르므로 changePct 가 null 이어야 한다(0 으로 채우면 차트가 거짓말한다).
  assert.equal(pts[0].prevClose, null);
  assert.equal(pts[0].changePct, null);
  assert.equal(pts[1].prevClose, 330000);
  assert.equal(pts[1].close, 346500);
  assert.ok(Math.abs(pts[1].changePct! - 5.0) < 1e-9);
  assert.equal(pts[1].volume, 18134051);
  assert.equal(pts[1].currency, "KRW");
});

test("normalizeChartRows: 미국 종목 차트 응답 — foreignRetentionRate 없어도 동작", () => {
  // api.stock.naver.com/chart/foreign/item/AAPL.O/day 실제 응답 형태
  const raw = [
    {
      localDate: "20260616",
      closePrice: 300.0,
      openPrice: 299.0,
      highPrice: 301.0,
      lowPrice: 298.0,
      accumulatedTradingVolume: 40000000,
    },
    {
      localDate: "20260617",
      closePrice: 295.95,
      openPrice: 300.845,
      highPrice: 302.07,
      lowPrice: 294.36,
      accumulatedTradingVolume: 42745060,
    },
  ];
  const pts = normalizeChartRows(raw, "USD");

  assert.equal(pts.length, 2);
  assert.equal(pts[1].currency, "USD");
  assert.equal(pts[1].prevClose, 300);
  assert.ok(Math.abs(pts[1].changePct! - -1.35) < 0.01);
});

test("normalizeChartRows: 날짜 없는 행은 버리고, 종가 null 이면 changePct 도 null", () => {
  const pts = normalizeChartRows(
    [
      { localDate: "20260616", closePrice: 100, accumulatedTradingVolume: 1 },
      { localDate: null, closePrice: 999, accumulatedTradingVolume: 1 },
      { localDate: "20260617", closePrice: "휴장", accumulatedTradingVolume: null },
    ],
    "KRW"
  );
  assert.equal(pts.length, 2);
  assert.equal(pts[1].close, null);
  assert.equal(pts[1].changePct, null);
  assert.equal(pts[1].volume, null);
});

test("parseSiseJson: 파이썬 리터럴 텍스트 파싱 + 헤더 행 제거", () => {
  // api.finance.naver.com/siseJson.naver 실제 응답 (작은따옴표 + 들쭉날쭉한 개행/탭까지 그대로)
  const text = `
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],



["20260710", 807.0, 845.88, 800.39, 837.43, 490954, 0.0],

["20260711", 837.43, 850.0, 830.0, 845.0, 500000, 0.0]]
`;
  const rows = parseSiseJson(text);

  assert.equal(rows.length, 2); // 헤더 행이 빠졌는지
  assert.deepEqual(rows[0], {
    localDate: "20260710",
    closePrice: 837.43,
    accumulatedTradingVolume: 490954,
  });

  // 파서 출력이 차트 정규화로 그대로 흘러들어가는지 (지수 경로의 실제 연결)
  const pts = normalizeChartRows(rows, "KRW");
  assert.deepEqual(
    pts.map((p) => p.date),
    ["2026-07-10", "2026-07-11"]
  );
  assert.equal(pts[1].prevClose, 837.43);
  assert.ok(Math.abs(pts[1].changePct! - 0.9040) < 0.001);
});

test("parseSiseJson: 깨진 응답이면 throw 하지 않고 빈 배열", () => {
  assert.deepEqual(parseSiseJson(""), []);
  assert.deepEqual(parseSiseJson("<html>error</html>"), []);
  assert.deepEqual(parseSiseJson("{}"), []);
});

test("normalizeSearchItems: 실제 자동완성 응답 — stock 만, nationCode 로 시장 판정", () => {
  // ac.stock.naver.com/ac?q=... 실제 응답 항목들
  const items = [
    {
      code: "005930",
      name: "삼성전자",
      typeCode: "KOSPI",
      typeName: "코스피",
      url: "/domestic/stock/005930/total",
      reutersCode: "005930",
      nationCode: "KOR",
      nationName: "대한민국",
      category: "stock",
    },
    {
      code: "NVDA",
      name: "엔비디아",
      typeCode: "NASDAQ",
      typeName: "나스닥 증권거래소",
      url: "/worldstock/stock/NVDA.O/total",
      reutersCode: "NVDA.O",
      nationCode: "USA",
      nationName: "미국",
      category: "stock",
    },
    // 지수/시장지표는 종목이 아니라 버린다.
    { code: "KOSPI", name: "코스피", nationCode: "KOR", reutersCode: "KOSPI", category: "index" },
    // KOR/USA 외 국가는 시세 경로가 없어 버린다.
    {
      code: "7203",
      name: "도요타",
      typeName: "도쿄증권거래소",
      reutersCode: "7203.T",
      nationCode: "JPN",
      category: "stock",
    },
  ];
  const out = normalizeSearchItems(items);

  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    market: "kr",
    symbol: "005930",
    name: "삼성전자",
    quoteCode: "005930",
    exchange: "코스피",
  });
  assert.deepEqual(out[1], {
    market: "us",
    symbol: "NVDA",
    name: "엔비디아",
    quoteCode: "NVDA.O",
    exchange: "나스닥 증권거래소",
  });
});

test("normalizeSearchItems: quoteCode 없는 항목은 조회 불가라 버린다", () => {
  const out = normalizeSearchItems([
    { code: "005930", name: "삼성전자", nationCode: "KOR", category: "stock" },
    { code: "", name: "빈코드", reutersCode: "X", nationCode: "KOR", category: "stock" },
  ]);
  assert.deepEqual(out, []);
});
