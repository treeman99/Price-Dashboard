import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSymbol,
  formatPrice,
  changeTone,
  marketLabel,
  DEFAULT_STOCK_TICKERS,
} from "./stock.ts";

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
