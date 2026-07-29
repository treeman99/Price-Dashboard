import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateLatestRound, normalizeItem } from "./draws.ts";

/** 2026-07-25 추첨된 1234회차 실제 응답(필드 발췌). */
const REAL = {
  ltEpsd: 1234,
  tm1WnNo: 1,
  tm2WnNo: 15,
  tm3WnNo: 19,
  tm4WnNo: 31,
  tm5WnNo: 35,
  tm6WnNo: 43,
  bnsWnNo: 27,
  ltRflYmd: "20260725",
};

test("실제 응답을 그대로 정규화한다", () => {
  assert.deepEqual(normalizeItem(REAL), {
    round: 1234,
    drawDate: "2026-07-25",
    numbers: [1, 15, 19, 31, 35, 43],
    bonus: 27,
  });
});

test("본번호는 항상 오름차순으로 정렬된다", () => {
  const shuffled = { ...REAL, tm1WnNo: 43, tm6WnNo: 1 };
  assert.deepEqual(normalizeItem(shuffled)?.numbers, [1, 15, 19, 31, 35, 43]);
});

test("오염된 회차는 저장 대상에서 제외된다", () => {
  assert.equal(normalizeItem(null), null);
  assert.equal(normalizeItem({}), null);
  // 날짜 형식 오류
  assert.equal(normalizeItem({ ...REAL, ltRflYmd: "2026-07-25" }), null);
  // 범위 밖 번호
  assert.equal(normalizeItem({ ...REAL, tm1WnNo: 46 }), null);
  assert.equal(normalizeItem({ ...REAL, tm1WnNo: 0 }), null);
  // 본번호 중복
  assert.equal(normalizeItem({ ...REAL, tm1WnNo: 15 }), null);
  // 보너스가 본번호와 겹침
  assert.equal(normalizeItem({ ...REAL, bnsWnNo: 15 }), null);
  // 회차 번호 이상
  assert.equal(normalizeItem({ ...REAL, ltEpsd: 0 }), null);
});

test("최신 회차 추정은 1회차 추첨일(2002-12-07) 기준 주 단위", () => {
  assert.equal(estimateLatestRound(new Date("2002-12-07T12:00:00Z")), 1);
  assert.equal(estimateLatestRound(new Date("2002-12-14T12:00:00Z")), 2);
  // 2026-07-25 = 1234회차. 추정치는 이분탐색의 상한을 잡는 용도라 ±2 면 충분하다.
  const est = estimateLatestRound(new Date("2026-07-25T12:00:00Z"));
  assert.ok(Math.abs(est - 1234) <= 2, `추정 ${est}`);
});
