import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHorizon,
  optionalNumber,
  requirePositive,
  summarizeHolding,
  formatPnlPct,
  pnlTone,
} from "./holdings.ts";
import type { StockHolding } from "./types.ts";

const H: StockHolding = {
  id: 1,
  market: "us",
  symbol: "NVDA",
  name: "엔비디아",
  quoteCode: "NVDA.O",
  exchange: "나스닥",
  quantity: 10,
  avgPrice: 100,
  targetPrice: 150,
  stopPrice: 80,
  horizon: "mid",
  memo: "",
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const USD = { currency: "USD" };

test("손익률·손익금액·평가금액을 평단 기준으로 계산한다", () => {
  const s = summarizeHolding(H, { close: 120, changePct: 1, ...USD });
  assert.equal(s.pnlPct, 20);
  assert.equal(s.pnlAmount, 200);
  assert.equal(s.marketValue, 1200);
});

test("손실 구간도 정확히 계산한다", () => {
  const s = summarizeHolding(H, { close: 75, changePct: -2, ...USD });
  assert.equal(s.pnlPct, -25);
  assert.equal(s.pnlAmount, -250);
});

test("목표가·손절가까지의 거리(%)를 현재가 기준으로 계산한다", () => {
  const s = summarizeHolding(H, { close: 120, changePct: 0, ...USD });
  // 목표 150 은 현재가 120 대비 +25% (아직 못 미침)
  assert.equal(s.toTargetPct, 25);
  // 손절 80 은 현재가 120 대비 -33.33% (아직 여유 있음)
  assert.ok(s.toStopPct !== null && Math.abs(s.toStopPct - -33.3333) < 0.01);
});

test("손절가를 이미 이탈했으면 거리가 양수가 된다(=되돌아가야 할 폭)", () => {
  const s = summarizeHolding(H, { close: 70, changePct: 0, ...USD });
  assert.ok(s.toStopPct !== null && s.toStopPct > 0);
});

test("시세 조회 실패(close=null)면 파생값이 전부 null 이지만 항목은 남는다", () => {
  const s = summarizeHolding(H, { close: null, changePct: null, ...USD });
  assert.equal(s.pnlPct, null);
  assert.equal(s.pnlAmount, null);
  assert.equal(s.marketValue, null);
  assert.equal(s.toTargetPct, null);
  assert.equal(s.symbol, "NVDA", "보유 사실은 시세와 무관하게 유효하다");
});

test("목표가·손절가 미설정이면 거리도 null (0 으로 계산하지 않는다)", () => {
  const s = summarizeHolding(
    { ...H, targetPrice: null, stopPrice: null },
    { close: 120, changePct: 0, ...USD }
  );
  assert.equal(s.toTargetPct, null);
  assert.equal(s.toStopPct, null);
});

test("평단이 0 이면 손익률은 null (Infinity 를 만들지 않는다)", () => {
  const s = summarizeHolding({ ...H, avgPrice: 0 }, { close: 120, changePct: 0, ...USD });
  assert.equal(s.pnlPct, null);
});

test("소수점 수량(해외주식 소수점 매수)도 정확히 계산한다", () => {
  const s = summarizeHolding({ ...H, quantity: 0.5 }, { close: 200, changePct: 0, ...USD });
  assert.equal(s.marketValue, 100);
  assert.equal(s.pnlAmount, 50);
});

test("optionalNumber: 빈 문자열은 0 이 아니라 null 이다", () => {
  assert.equal(optionalNumber(""), null, "Number('') === 0 함정");
  assert.equal(optionalNumber("   "), null);
  assert.equal(optionalNumber(null), null);
  assert.equal(optionalNumber(undefined), null);
  assert.equal(optionalNumber("abc"), null);
  assert.equal(optionalNumber(Infinity), null);
  assert.equal(optionalNumber("150"), 150);
  assert.equal(optionalNumber(0), 0, "명시적 0 은 유효한 값이다");
});

test("requirePositive: 0·음수·비수치는 사유와 함께 거부한다", () => {
  assert.throws(() => requirePositive("", "수량"), /수량/);
  assert.throws(() => requirePositive(0, "수량"), /0보다 커야/);
  assert.throws(() => requirePositive(-1, "평단"), /0보다 커야/);
  assert.equal(requirePositive("10.5", "수량"), 10.5);
});

test("normalizeHorizon: 허용 목록 밖은 mid 로 접는다", () => {
  assert.equal(normalizeHorizon("short"), "short");
  assert.equal(normalizeHorizon("long"), "long");
  assert.equal(normalizeHorizon("forever"), "mid");
  assert.equal(normalizeHorizon(undefined), "mid");
  assert.equal(normalizeHorizon(42), "mid");
});

test("formatPnlPct: 부호를 명시하고 null 은 '-'", () => {
  assert.equal(formatPnlPct(20), "+20.00%");
  assert.equal(formatPnlPct(-3.456), "-3.46%");
  assert.equal(formatPnlPct(0), "0.00%");
  assert.equal(formatPnlPct(null), "-");
});

test("pnlTone: 0 과 null 은 flat", () => {
  assert.equal(pnlTone(5), "up");
  assert.equal(pnlTone(-5), "down");
  assert.equal(pnlTone(0), "flat");
  assert.equal(pnlTone(null), "flat");
});
