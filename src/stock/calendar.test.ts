import test from "node:test";
import assert from "node:assert/strict";
import {
  easterSunday,
  isWeekend,
  isNyseHoliday,
  isMarketClosed,
  markClosedIfNoSession,
  lastUsSessionDate,
  nextKrSessionDate,
} from "./calendar.ts";

/**
 * 회귀 테스트. NYSE 기대값은 전부 네이버 시세(AAPL.O 일별 차트)의 실제 거래일 유무로
 * 확인한 것이다 — 합성 기대값이 아니다. 각 케이스 주석의 ✓ 는 라이브 확인을 뜻한다.
 */

test("easterSunday — 알려진 부활절", () => {
  assert.equal(easterSunday(2024), "2024-03-31");
  assert.equal(easterSunday(2025), "2025-04-20");
  assert.equal(easterSunday(2026), "2026-04-05");
  assert.equal(easterSunday(2027), "2027-03-28");
});

test("easterSunday — 항상 일요일이고 3/22~4/25 범위 안", () => {
  for (let y = 1900; y <= 2100; y++) {
    const e = easterSunday(y);
    assert.equal(isWeekend(e), true, `${y}: ${e} 가 주말이 아님`);
    assert.equal(new Date(`${e}T00:00:00Z`).getUTCDay(), 0, `${y}: ${e} 가 일요일이 아님`);
    assert.ok(e >= `${y}-03-22` && e <= `${y}-04-25`, `${y}: ${e} 가 부활절 가능 범위를 벗어남`);
  }
});

test("isWeekend", () => {
  assert.equal(isWeekend("2026-07-17"), false); // 금
  assert.equal(isWeekend("2026-07-18"), true); // 토
  assert.equal(isWeekend("2026-07-19"), true); // 일
  assert.equal(isWeekend("2026-07-20"), false); // 월
});

test("isNyseHoliday — 2026년 휴장일 전체", () => {
  assert.equal(isNyseHoliday("2026-01-01"), "신정"); // 목
  assert.equal(isNyseHoliday("2026-01-19"), "마틴 루터 킹 데이"); // 1월 셋째 월
  assert.equal(isNyseHoliday("2026-02-16"), "워싱턴 탄생일"); // 2월 셋째 월
  assert.equal(isNyseHoliday("2026-04-03"), "성금요일"); // 부활절 4/5 - 2
  assert.equal(isNyseHoliday("2026-05-25"), "메모리얼 데이"); // 5월 마지막 월
  assert.equal(isNyseHoliday("2026-06-19"), "준틴스"); // 금
  assert.equal(isNyseHoliday("2026-09-07"), "노동절"); // 9월 첫째 월
  assert.equal(isNyseHoliday("2026-11-26"), "추수감사절"); // 11월 넷째 목
  assert.equal(isNyseHoliday("2026-12-25"), "성탄절"); // 금
});

test("isNyseHoliday — 관측 이동: 토요일 휴일은 전날 금요일로 당겨진다", () => {
  // 2026-07-04 는 토요일 → 7/3 금요일 휴장. 과거 동일 사례 2020-07-03 거래 없음으로 확인 ✓
  assert.equal(isNyseHoliday("2026-07-03"), "독립기념일(관측 이동)");
  assert.equal(isNyseHoliday("2026-07-04"), null, "휴일 당일(토)은 관측일이 아니다");
  assert.equal(isNyseHoliday("2020-07-03"), "독립기념일(관측 이동)"); // ✓ 거래 없음
  assert.equal(isNyseHoliday("2021-12-24"), "성탄절(관측 이동)"); // ✓ 12/25 토 → 12/24 거래 없음
});

test("isNyseHoliday — 관측 이동: 일요일 휴일은 다음 월요일로 밀린다", () => {
  assert.equal(isNyseHoliday("2021-07-05"), "독립기념일(관측 이동)"); // ✓ 7/4 일 → 7/5 거래 없음
  assert.equal(isNyseHoliday("2023-01-02"), "신정(관측 이동)"); // ✓ 1/1 일 → 1/2 거래 없음
});

test("isNyseHoliday — 신정 예외: 1/1 이 토요일이어도 전년 12/31 은 휴장이 아니다", () => {
  // 2022-01-01(토)인데 2021-12-31(금) 실제 거래 있음 ✓ — 관측 이동이 해를 넘지 않는다.
  assert.equal(isNyseHoliday("2021-12-31"), null);
  assert.equal(isNyseHoliday("2022-01-03"), null, "월요일로 밀지도 않는다"); // ✓ 거래 있음
});

test("isNyseHoliday — 준틴스는 2022년부터 관측", () => {
  assert.equal(isNyseHoliday("2021-06-18"), null); // ✓ 2021-06-18 거래 있음
  assert.equal(isNyseHoliday("2022-06-20"), "준틴스(관측 이동)"); // ✓ 6/19 일 → 6/20 거래 없음
});

test("isNyseHoliday — 2024년 실측 대조", () => {
  assert.equal(isNyseHoliday("2024-01-15"), "마틴 루터 킹 데이"); // ✓ 거래 없음
  assert.equal(isNyseHoliday("2024-02-19"), "워싱턴 탄생일"); // ✓
  assert.equal(isNyseHoliday("2024-03-29"), "성금요일"); // ✓
  assert.equal(isNyseHoliday("2024-05-27"), "메모리얼 데이"); // ✓
  assert.equal(isNyseHoliday("2024-09-02"), "노동절"); // ✓
  assert.equal(isNyseHoliday("2024-11-28"), "추수감사절"); // ✓
  // 추수감사절 다음날은 단축 개장이지 휴장이 아니다 ✓ 2024-11-29 거래 있음
  assert.equal(isNyseHoliday("2024-11-29"), null);
});

test("isNyseHoliday — 평범한 거래일은 null", () => {
  assert.equal(isNyseHoliday("2026-07-17"), null);
  assert.equal(isNyseHoliday("2026-03-10"), null);
});

test("isNyseHoliday — 잘못된 날짜 형식은 던진다", () => {
  assert.throws(() => isNyseHoliday("2026/01/01"));
  assert.throws(() => isNyseHoliday("20260101"));
});

test("isMarketClosed — 주말 컷이 최우선", async () => {
  assert.deepEqual(await isMarketClosed("us", "2026-07-18"), { closed: true, reason: "주말" });
  assert.deepEqual(await isMarketClosed("kr", "2026-07-19"), { closed: true, reason: "주말" });
});

test("isMarketClosed — us 휴장일/거래일", async () => {
  assert.deepEqual(await isMarketClosed("us", "2026-01-01"), { closed: true, reason: "신정" });
  assert.deepEqual(await isMarketClosed("us", "2026-07-17"), { closed: false, reason: null });
});

test("isMarketClosed — kr 근로자의날은 공휴일이 아니어도 휴장", async () => {
  // 2026-05-01 은 금요일. 특일정보 키 없이도 KRX 보정으로 잡혀야 한다. ✓ 2024-05-01 거래 없음
  const r = await isMarketClosed("kr", "2026-05-01");
  assert.equal(r.closed, true);
  assert.match(r.reason ?? "", /근로자의날/);
});

test("isMarketClosed — kr 연말 폐장일은 12월 마지막 영업일", async () => {
  // 2026-12-31 은 목요일 → 그 날이 폐장일. ✓ 2021·2024 사례로 규칙 확인
  const r = await isMarketClosed("kr", "2026-12-31");
  assert.equal(r.closed, true);
  assert.match(r.reason ?? "", /폐장/);

  // 2022-12-31 은 토요일이라 폐장일이 12/30(금)으로 당겨진다. ✓ 12/30 거래 없음, 12/29 마지막 거래
  const r2 = await isMarketClosed("kr", "2022-12-30");
  assert.equal(r2.closed, true);
  assert.match(r2.reason ?? "", /폐장/);
});

test("markClosedIfNoSession — 해당 거래일이 있으면 휴장 아님", () => {
  const points = [{ date: "2026-07-16" }, { date: "2026-07-17" }];
  assert.equal(markClosedIfNoSession("us", "2026-07-17", points), false);
});

test("markClosedIfNoSession — 해당 거래일이 없으면 휴장 간주", () => {
  const points = [{ date: "2026-07-15" }, { date: "2026-07-16" }];
  assert.equal(markClosedIfNoSession("us", "2026-07-17", points), true);
});

test("markClosedIfNoSession — 빈 시세는 보수적으로 휴장 간주", () => {
  assert.equal(markClosedIfNoSession("kr", "2026-07-17", []), true);
});

test("lastUsSessionDate — 18:00 KST 는 뉴욕 당일 05:00 라 전날 거래일", async () => {
  // 2026-07-17(금) 18:00 KST = 2026-07-17(금) 05:00 ET → 아직 마감 전 → 전날 7/16(목)
  const at = new Date("2026-07-17T18:00:00+09:00");
  assert.equal(await lastUsSessionDate(at), "2026-07-16");
});

test("lastUsSessionDate — 뉴욕 마감(16:00 ET) 후에는 당일", async () => {
  // 2026-07-18 06:00 KST = 2026-07-17(금) 17:00 ET → 마감 후 → 7/17
  const at = new Date("2026-07-18T06:00:00+09:00");
  assert.equal(await lastUsSessionDate(at), "2026-07-17");
});

test("lastUsSessionDate — 월요일 18:00 KST 는 주말을 건너뛰어 금요일", async () => {
  // 2026-07-20(월) 18:00 KST = 7/20 05:00 ET → 마감 전 → 7/19(일)·7/18(토) 건너뛰고 7/17(금)
  const at = new Date("2026-07-20T18:00:00+09:00");
  assert.equal(await lastUsSessionDate(at), "2026-07-17");
});

test("lastUsSessionDate — 휴장일을 건너뛴다", async () => {
  // 2026-01-02(금) 18:00 KST = 1/2 04:00 ET → 마감 전 → 1/1(신정) 건너뛰고 2025-12-31(수)
  const at = new Date("2026-01-02T18:00:00+09:00");
  assert.equal(await lastUsSessionDate(at), "2025-12-31");
});

test("nextKrSessionDate — 거래일 아침이면 당일", async () => {
  const at = new Date("2026-07-17T08:00:00+09:00"); // 금
  assert.equal(await nextKrSessionDate(at), "2026-07-17");
});

test("nextKrSessionDate — 주말이면 다음 거래일", async () => {
  const at = new Date("2026-07-18T08:00:00+09:00"); // 토 → 월요일
  assert.equal(await nextKrSessionDate(at), "2026-07-20");
});

test("nextKrSessionDate — 근로자의날은 건너뛴다", async () => {
  // 2026-05-01(금) 휴장 → 5/2(토)·5/3(일) 건너뛰고 5/4(월)
  const at = new Date("2026-05-01T08:00:00+09:00");
  assert.equal(await nextKrSessionDate(at), "2026-05-04");
});
