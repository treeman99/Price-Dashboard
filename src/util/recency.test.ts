// 조사 기간 판정(실행 시점 기준 최근 N시간, 시각 단위) — 2026-11-23 사용자 결정 "24시간 이내로만".
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRecency, formatWindowKst, parseTimestamp, toLocalIso, windowEndingAt } from "./recency.ts";

// 실행 시각 11/23 09:00(KST) → 구간 11/22 09:00 ~ 11/23 09:00
const RUN = new Date("2026-11-23T09:00:00+09:00");
const W = windowEndingAt(RUN, 24);

test("시각을 알면 시각으로: 구간 안은 통과, 시작 이전(같은 날짜라도)은 제외, 15분 넘는 미래는 제외", () => {
  assert.deepEqual(checkRecency({ publishedAt: "2026-11-22T09:00:00+09:00" }, W), { ok: true, approx: false }, "시작 경계 포함");
  assert.deepEqual(checkRecency({ publishedAt: "2026-11-23T08:59:00+09:00" }, W), { ok: true, approx: false });
  assert.deepEqual(checkRecency({ publishedAt: "2026-11-22T08:59:00+09:00", date: "2026-11-22" }, W), { ok: false, reason: "old" }, "어제 08:59 는 24시간 밖");
  assert.deepEqual(checkRecency({ publishedAt: "2026-11-22T00:30:00Z" }, W), { ok: true, approx: false }, "UTC 00:30 = KST 09:30");
  assert.deepEqual(checkRecency({ publishedAt: "2026-11-23T09:10:00+09:00" }, W), { ok: true, approx: false }, "시계 오차 15분 안");
  assert.deepEqual(checkRecency({ publishedAt: "2026-11-23T10:00:00+09:00" }, W), { ok: false, reason: "future" });
});

test("날짜만 알면 보수적으로: 그 날 0시가 구간 안인 날짜(오늘)만 통과하고 approx 로 표시, 어제 날짜는 제외", () => {
  assert.deepEqual(checkRecency({ date: "2026-11-23" }, W), { ok: true, approx: true });
  assert.deepEqual(checkRecency({ date: "2026-11-22" }, W), { ok: false, reason: "date-only" });
  assert.deepEqual(checkRecency({ publishedAt: null, date: "2026-11-24" }, W), { ok: false, reason: "future" });
  assert.deepEqual(checkRecency({ publishedAt: "어제", date: null }, W), { ok: false, reason: "unknown" });
  // 짧은 구간(6시간, 17:00 실행)이면 오늘 날짜도 0시가 구간 시작(11:00) 이전이라 날짜만으로는 통과하지 못한다.
  const short = windowEndingAt(new Date("2026-11-23T17:00:00+09:00"), 6);
  assert.deepEqual(checkRecency({ date: "2026-11-23" }, short), { ok: false, reason: "date-only" });
});

test("시각 문자열: 시간대 없으면 로컬, 'YYYY-MM-DD HH:mm' 허용, 날짜만이면 시각이 아니다", () => {
  assert.equal(parseTimestamp("2026-11-23 08:30")?.getTime(), new Date(2026, 10, 23, 8, 30).getTime());
  assert.equal(parseTimestamp("2026-11-23T08:30:00+0900")?.toISOString(), "2026-11-22T23:30:00.000Z");
  assert.equal(parseTimestamp("2026-11-23"), null);
  assert.equal(parseTimestamp(null), null);
  assert.match(toLocalIso(new Date("2026-11-22T23:30:00Z")), /^2026-11-23T08:30:00\+09:00$/);
});

test("보고서용 구간 표기: '11/22 09:00 ~ 11/23 09:00 KST'", () => {
  assert.equal(formatWindowKst(W), "11/22 09:00 ~ 11/23 09:00 KST");
  assert.equal(formatWindowKst({ start: "2026-11-22T08:00:00Z", end: "2026-11-23T08:00:00Z" }), "11/22 17:00 ~ 11/23 17:00 KST");
});
