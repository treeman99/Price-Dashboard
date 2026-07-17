import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  easterSunday,
  isWeekend,
  isNyseHoliday,
  isMarketClosed,
  krHolidays,
  markClosedIfNoSession,
  lastUsSessionDate,
  nextKrSessionDate,
} from "./calendar.ts";

/**
 * 회귀 테스트.
 *
 * NYSE 기대값은 네이버 시세(AAPL.O 일별 차트)의 실제 거래일 유무로,
 * KRX 기대값은 네이버 시세(삼성전자 005930 일별 차트) 2023-01-01~2026-07-16 실거래일로
 * 백테스트해 확정한 것이다 — 합성 기대값이 아니다. 각 케이스 주석의 ✓ 는 실측 확인을 뜻한다.
 *
 * 백테스트 결과: 대상 평일 924 / 일치 918 / 위양성 0 / 위음성 6(전부 임시공휴일·선거일 → 원장 관할).
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
  // 2026-07-16(목)은 실거래일 ✓. (2026-07-17 은 제헌절이라 이제 거래일이 아니다 — 아래 케이스 참고)
  const at = new Date("2026-07-16T08:00:00+09:00");
  assert.equal(await nextKrSessionDate(at), "2026-07-16");
});

test("nextKrSessionDate — 제헌절(2026~)은 건너뛴다", async () => {
  // 이게 실제로 터졌던 버그다: 2026-07-17(금)은 휴장인데 브리핑이 나갔다. ✓ 거래 없음 확인
  const at = new Date("2026-07-17T08:00:00+09:00");
  assert.equal(await nextKrSessionDate(at), "2026-07-20"); // 7/18 토·7/19 일 건너뛰고 월요일
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

// ── KRX 공휴일 계산 ───────────────────────────────────────
// 아래 날짜는 전부 삼성전자 실거래일 백테스트로 대조한 것이다.

test("krHolidays — 양력 고정 공휴일", () => {
  const h = krHolidays(2026);
  assert.equal(h.get("2026-01-01"), "신정");
  assert.equal(h.get("2026-03-01"), "삼일절");
  assert.equal(h.get("2026-05-05"), "어린이날"); // ✓ 거래 없음
  assert.equal(h.get("2026-06-06"), "현충일");
  assert.equal(h.get("2026-08-15"), "광복절");
  assert.equal(h.get("2026-10-03"), "개천절");
  assert.equal(h.get("2026-10-09"), "한글날");
  assert.equal(h.get("2026-12-25"), "성탄절");
});

test("krHolidays — 설날 연휴 3일(음력 1/1 ±1)", () => {
  // 실측: 각 해 설날 당일이 음력 1/1 임을 dangi 로 확인, 연휴 휴장은 거래일 유무로 대조
  assert.equal(krHolidays(2024).get("2024-02-10"), "설날"); // ✓ 토
  assert.equal(krHolidays(2024).get("2024-02-09"), "설날 전날"); // ✓ 거래 없음
  assert.equal(krHolidays(2024).get("2024-02-11"), "설날 다음날"); // 일

  assert.equal(krHolidays(2025).get("2025-01-29"), "설날"); // ✓ 거래 없음
  assert.equal(krHolidays(2025).get("2025-01-28"), "설날 전날"); // ✓ 거래 없음
  assert.equal(krHolidays(2025).get("2025-01-30"), "설날 다음날"); // ✓ 거래 없음

  assert.equal(krHolidays(2026).get("2026-02-17"), "설날"); // ✓ 거래 없음
  assert.equal(krHolidays(2026).get("2026-02-16"), "설날 전날"); // ✓ 거래 없음
  assert.equal(krHolidays(2026).get("2026-02-18"), "설날 다음날"); // ✓ 거래 없음
});

test("krHolidays — 추석 연휴 3일(음력 8/15 ±1)", () => {
  assert.equal(krHolidays(2024).get("2024-09-17"), "추석"); // ✓ 거래 없음
  assert.equal(krHolidays(2024).get("2024-09-16"), "추석 전날"); // ✓ 거래 없음
  assert.equal(krHolidays(2024).get("2024-09-18"), "추석 다음날"); // ✓ 거래 없음

  assert.equal(krHolidays(2025).get("2025-10-06"), "추석"); // ✓ 거래 없음
  assert.equal(krHolidays(2023).get("2023-09-29"), "추석"); // ✓ 거래 없음
});

test("krHolidays — 부처님오신날(음력 4/8)", () => {
  assert.equal(krHolidays(2024).get("2024-05-15"), "부처님오신날"); // ✓ 거래 없음
  assert.equal(krHolidays(2026).get("2026-05-24"), "부처님오신날"); // 일 → 5/25 대체 ✓
  assert.equal(krHolidays(2027).get("2027-05-13"), "부처님오신날"); // 목
  // 2025 는 어린이날(5/5)과 같은 날이라 사유명은 먼저 등록된 어린이날이 남는다(휴장 판정엔 영향 없음).
  assert.equal(krHolidays(2025).get("2025-05-05"), "어린이날");
});

test("krHolidays — 윤달이 있어도 부처님오신날은 평4월 8일", () => {
  // 2020 년엔 윤4월이 있다(dangi month 가 '4bis' 로 나온다). 평4월 8일 = 2020-04-30 이 정답이고,
  // 윤4월 8일(2020-05-30)을 잡으면 안 된다.
  assert.equal(krHolidays(2020).get("2020-04-30"), "부처님오신날");
  assert.equal(krHolidays(2020).get("2020-05-30"), undefined, "윤4월 8일을 부처님오신날로 잡으면 안 된다");
  // 윤2월(2023)·윤6월(2025) 해도 설·추석이 정상 위치에 잡히는지
  assert.equal(krHolidays(2023).get("2023-01-22"), "설날"); // ✓
  assert.equal(krHolidays(2025).get("2025-10-06"), "추석"); // ✓
});

test("krHolidays — 제헌절은 2026년부터 휴장", () => {
  // 실측: 2023-07-17(월)·2024-07-17(수)·2025-07-17(목) 전부 거래 있음 / 2026-07-17(금) 거래 없음 ✓
  assert.equal(krHolidays(2023).get("2023-07-17"), undefined);
  assert.equal(krHolidays(2024).get("2024-07-17"), undefined);
  assert.equal(krHolidays(2025).get("2025-07-17"), undefined);
  assert.equal(krHolidays(2026).get("2026-07-17"), "제헌절");
});

test("krHolidays — 대체공휴일: 설·추석 연휴가 일요일과 겹치면 연휴 뒤 첫 평일", () => {
  // 2023 설날 1/22(일) 포함 → 1/24(화) 대체. ✓ 1/23·1/24 거래 없음
  assert.equal(krHolidays(2023).get("2023-01-24"), "설날 연휴 대체공휴일");
  // 2024 설 연휴 2/9~2/11 중 2/11(일) → 2/12(월) 대체. ✓ 거래 없음
  assert.equal(krHolidays(2024).get("2024-02-12"), "설날 연휴 대체공휴일");
  // 2025 추석 연휴 10/5(일)~10/7 → 10/8(수) 대체. ✓ 거래 없음
  assert.equal(krHolidays(2025).get("2025-10-08"), "추석 연휴 대체공휴일");
  // 2025 설 연휴 1/28~1/30 엔 일요일이 없다 → 대체 없음(1/31 은 거래일 ✓)
  assert.equal(krHolidays(2025).get("2025-01-31"), undefined);
  // 2024 추석 연휴 9/16~9/18 엔 일요일이 없다 → 대체 없음(9/19 는 거래일 ✓)
  assert.equal(krHolidays(2024).get("2024-09-19"), undefined);
  // 2023 추석 연휴 9/28~9/30 중 9/30 은 **토요일** → 토요일은 연휴 대체 사유가 아니다.
  // (10/2 는 실제 휴장이었지만 그건 임시공휴일이라 원장 관할 — 여기서 잡으면 안 된다.)
  assert.equal(krHolidays(2023).get("2023-10-02"), undefined);
});

test("krHolidays — 대체공휴일: 토·일과 겹치는 공휴일", () => {
  assert.equal(krHolidays(2025).get("2025-03-03"), "삼일절 대체공휴일"); // ✓ 3/1 토 → 거래 없음
  assert.equal(krHolidays(2026).get("2026-03-02"), "삼일절 대체공휴일"); // ✓ 3/1 일 → 거래 없음
  assert.equal(krHolidays(2024).get("2024-05-06"), "어린이날 대체공휴일"); // ✓ 5/5 일 → 거래 없음
  assert.equal(krHolidays(2023).get("2023-05-29"), "부처님오신날 대체공휴일"); // ✓ 5/27 토 → 거래 없음
  assert.equal(krHolidays(2026).get("2026-05-25"), "부처님오신날 대체공휴일"); // ✓ 5/24 일 → 거래 없음
  assert.equal(krHolidays(2026).get("2026-08-17"), "광복절 대체공휴일"); // 8/15 토
  assert.equal(krHolidays(2027).get("2027-12-27"), "성탄절 대체공휴일"); // 12/25 토
});

test("krHolidays — 어린이날은 '다른 공휴일'과 겹쳐도 대체", () => {
  // 2025-05-05 는 어린이날이자 부처님오신날인데 **둘 다 월요일**이라 주말 규칙으로는 대체가 안 나온다.
  // 그런데 2025-05-06(화)은 실제로 휴장이었다 ✓ → 어린이날 전용 '다른 공휴일과 겹치는 경우' 조항.
  assert.equal(krHolidays(2025).get("2025-05-06"), "어린이날 대체공휴일");
});

test("krHolidays — 신정·현충일은 대체 없음", () => {
  // 2022-01-01 은 토요일인데 1/3(월)은 실제 거래일이었다 ✓ → 신정은 대체가 없다.
  assert.equal(krHolidays(2022).get("2022-01-03"), undefined);
  // 2026-06-06 은 토요일인데 6/8(월)은 대체가 아니다(현충일은 대체 없음).
  assert.equal(krHolidays(2026).get("2026-06-08"), undefined);
});

test("krHolidays — 대체공휴일 연쇄: 앞 대체가 막으면 다음 평일로 밀린다", () => {
  // 2027: 한글날 10/9(토) → 10/11(월) 대체. 개천절 10/3(일) → 10/4(월) 대체.
  // 두 대체가 서로 다른 자리를 잡아야 한다(같은 날에 겹쳐 하나가 사라지면 안 된다).
  assert.equal(krHolidays(2027).get("2027-10-04"), "개천절 대체공휴일");
  assert.equal(krHolidays(2027).get("2027-10-11"), "한글날 대체공휴일");
});

test("krHolidays — 순수 함수: 네트워크 없이 같은 값을 돌려준다", () => {
  assert.deepEqual([...krHolidays(2026).entries()].sort(), [...krHolidays(2026).entries()].sort());
});

test("isMarketClosed — kr 계산된 공휴일", async () => {
  assert.deepEqual(await isMarketClosed("kr", "2026-02-17"), { closed: true, reason: "설날" });
  assert.deepEqual(await isMarketClosed("kr", "2026-07-17"), { closed: true, reason: "제헌절" });
  // 평범한 거래일 ✓ 2026-07-16 거래 있음
  assert.deepEqual(await isMarketClosed("kr", "2026-07-16"), { closed: false, reason: null });
});

test("isMarketClosed — kr 주말 공휴일은 '주말'로 잡힌다(중복 없음)", async () => {
  // 2026-06-06 현충일은 토요일 → 주말 컷이 먼저다.
  assert.deepEqual(await isMarketClosed("kr", "2026-06-06"), { closed: true, reason: "주말" });
});

test("원장 — 임시공휴일을 계산 결과 위에 덮어쓴다", () => {
  // setHolidays 는 config.dbPath 옆에 원장을 쓴다. 실제 data/ 를 더럽히지 않으려고
  // DB_PATH 를 임시 디렉터리로 돌린 별도 프로세스에서 검증한다(모듈 로드 시점에 경로가 굳는다).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-ledger-"));
  try {
    // .mts 로 써야 한다 — 임시 디렉터리는 저장소 밖이라 package.json 의 "type":"module" 이
    // 안 걸려서 .ts 면 CJS 로 트랜스파일되고 top-level await 이 깨진다.
    const script = path.join(dir, "run.mts");
    const calendarUrl = new URL("./calendar.ts", import.meta.url).href;
    fs.writeFileSync(
      script,
      `const { setHolidays, isMarketClosed, getHolidays } = await import(${JSON.stringify(calendarUrl)});\n` +
        // 2025-01-27 은 실제 휴장이었지만 임시공휴일이라 계산으로는 못 잡는다 ✓
        `const before = await isMarketClosed("kr", "2025-01-27");\n` +
        `setHolidays("kr", 2025, ["2025-01-27"]);\n` +
        `const after = await isMarketClosed("kr", "2025-01-27");\n` +
        // 원장에 1건만 넣어도 계산된 법정공휴일이 사라지면 안 된다(교체가 아니라 병합).
        `const seollal = await isMarketClosed("kr", "2025-01-29");\n` +
        `const list = await getHolidays("kr", 2025);\n` +
        `console.log(JSON.stringify({ before, after, seollal, has27: list.includes("2025-01-27"), has29: list.includes("2025-01-29") }));\n`
    );
    const out = execFileSync("npx", ["tsx", script], {
      cwd: path.dirname(new URL(import.meta.url).pathname),
      env: { ...process.env, DB_PATH: path.join(dir, "price.db") },
      encoding: "utf8",
      timeout: 60_000,
    });
    const r = JSON.parse(out.trim().split("\n").pop() ?? "{}");

    assert.deepEqual(r.before, { closed: false, reason: null }, "임시공휴일은 계산으로 못 잡는다(원장 전)");
    assert.equal(r.after.closed, true, "원장 등록 후엔 휴장으로 잡혀야 한다");
    assert.deepEqual(r.seollal, { closed: true, reason: "설날" }, "원장 병합이 계산된 설날을 지우면 안 된다");
    assert.equal(r.has27, true);
    assert.equal(r.has29, true);
    assert.equal(fs.existsSync(path.join(dir, "stock-holidays.json")), true, "원장 파일이 dbPath 옆에 생겨야 한다");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
