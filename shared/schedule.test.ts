import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEDULE_RULES,
  describeSchedule,
  expandInterval,
  isDueDate,
  lastOccurrence,
  nextOccurrence,
  normalizeJobSchedule,
  scheduleBlackoutAt,
  toLocalIso,
} from "./schedule.ts";
import type { JobSchedule, ScheduleRepeat } from "./types.ts";

// ⚠️ 전부 로컬 시각 기준이다. 테스트도 반드시 로컬 생성자 new Date(y, m, d, h, mi) 를 쓴다
//    (ISO 문자열 파싱은 UTC 라 시간대에 따라 날짜가 바뀐다).
const d = (y: number, m: number, day: number, h = 0, mi = 0) => new Date(y, m - 1, day, h, mi, 0, 0);
const job = (repeat: ScheduleRepeat, times: string[], enabled = true): JobSchedule => ({
  enabled,
  repeat,
  times,
});
const weekly = (days: number[], intervalWeeks = 1, anchorDate?: string): ScheduleRepeat =>
  ({ kind: "weekly", days, intervalWeeks, ...(anchorDate ? { anchorDate } : {}) }) as ScheduleRepeat;

// ── isDueDate ──

test("isDueDate — daily 는 매일, 평일은 월~금만", () => {
  assert.equal(isDueDate({ kind: "daily" }, d(2026, 10, 25)), true); // 일
  const weekdays = weekly([1, 2, 3, 4, 5]);
  assert.equal(isDueDate(weekdays, d(2026, 10, 26)), true, "월");
  assert.equal(isDueDate(weekdays, d(2026, 10, 30)), true, "금");
  assert.equal(isDueDate(weekdays, d(2026, 10, 31)), false, "토");
  assert.equal(isDueDate(weekdays, d(2026, 10, 25)), false, "일");
});

test("isDueDate — 격주는 anchorDate 가 속한 월~일 주부터 2주마다", () => {
  // 기준 2026-10-28(수) → 그 주 = 10/26(월)~11/1(일). 실행 주: 10/26 주, 11/9 주, …
  const biweeklyMon = weekly([1], 2, "2026-10-28");
  assert.equal(isDueDate(biweeklyMon, d(2026, 10, 26)), true, "기준 주의 월요일(기준일보다 앞이어도 같은 주)");
  assert.equal(isDueDate(biweeklyMon, d(2026, 11, 2)), false, "다음 주는 쉰다");
  assert.equal(isDueDate(biweeklyMon, d(2026, 11, 9)), true, "2주 뒤");
  assert.equal(isDueDate(biweeklyMon, d(2026, 10, 19)), false, "기준 1주 전");
  assert.equal(isDueDate(biweeklyMon, d(2026, 10, 12)), true, "기준 2주 전(과거 방향도 같은 위상)");
  // 일요일은 그 주의 **마지막 날**이다(월요일 시작 주). 11/1(일)은 기준 주에 속한다.
  const biweeklySun = weekly([0], 2, "2026-10-26");
  assert.equal(isDueDate(biweeklySun, d(2026, 11, 1)), true);
  assert.equal(isDueDate(biweeklySun, d(2026, 11, 8)), false);
  // 3주마다
  const every3 = weekly([3], 3, "2026-10-28");
  assert.equal(isDueDate(every3, d(2026, 10, 28)), true);
  assert.equal(isDueDate(every3, d(2026, 11, 11)), false);
  assert.equal(isDueDate(every3, d(2026, 11, 18)), true);
});

test("isDueDate — 격주인데 기준일이 없거나 깨졌으면 매주로 접는다", () => {
  assert.equal(isDueDate(weekly([1], 2), d(2026, 11, 2)), true);
  assert.equal(isDueDate(weekly([1], 2, "2026-02-30"), d(2026, 11, 2)), true);
});

test("isDueDate — 매월 31일은 31일 없는 달을 건너뛰고, -1 은 말일", () => {
  const m31: ScheduleRepeat = { kind: "monthly", dates: [31] };
  assert.equal(isDueDate(m31, d(2026, 10, 31)), true);
  assert.equal(isDueDate(m31, d(2026, 11, 30)), false, "11월엔 31일이 없다 — 30일로 당기지 않는다");
  assert.equal(isDueDate(m31, d(2026, 12, 31)), true);

  const last: ScheduleRepeat = { kind: "monthly", dates: [-1] };
  assert.equal(isDueDate(last, d(2026, 11, 30)), true);
  assert.equal(isDueDate(last, d(2026, 11, 29)), false);
  assert.equal(isDueDate(last, d(2027, 2, 28)), true, "평년 2월 말일");
  assert.equal(isDueDate(last, d(2028, 2, 28)), false, "윤년 2월 28일은 말일이 아니다");
  assert.equal(isDueDate(last, d(2028, 2, 29)), true);

  const mixed: ScheduleRepeat = { kind: "monthly", dates: [1, 15] };
  assert.equal(isDueDate(mixed, d(2026, 11, 15)), true);
  assert.equal(isDueDate(mixed, d(2026, 11, 16)), false);
});

// ── next/lastOccurrence ──

test("nextOccurrence — from 초과(정각 제외), 자정을 넘기면 다음 날 첫 시각", () => {
  const daily = job({ kind: "daily" }, ["08:00", "17:00"]);
  assert.deepEqual(nextOccurrence(daily, d(2026, 10, 25, 7, 59)), d(2026, 10, 25, 8, 0));
  assert.deepEqual(nextOccurrence(daily, d(2026, 10, 25, 8, 0)), d(2026, 10, 25, 17, 0), "정각은 이미 지난 것");
  assert.deepEqual(nextOccurrence(daily, d(2026, 10, 25, 23, 59)), d(2026, 10, 26, 8, 0));
  // 월말 → 다음 달 1일
  assert.deepEqual(nextOccurrence(daily, d(2026, 10, 31, 18, 0)), d(2026, 11, 1, 8, 0));
});

test("lastOccurrence — at 이하(정각 포함), 자정 직후엔 전날 마지막 시각", () => {
  const daily = job({ kind: "daily" }, ["17:00", "08:00"]); // 저장 순서가 뒤집혀 있어도 된다
  assert.deepEqual(lastOccurrence(daily, d(2026, 10, 25, 8, 0)), d(2026, 10, 25, 8, 0));
  assert.deepEqual(lastOccurrence(daily, d(2026, 10, 25, 7, 59)), d(2026, 10, 24, 17, 0));
  assert.deepEqual(lastOccurrence(daily, d(2026, 11, 1, 0, 5)), d(2026, 10, 31, 17, 0), "월말 경계");
});

test("next/lastOccurrence — 매월 말일·31일은 달을 건너뛴다", () => {
  const m31 = job({ kind: "monthly", dates: [31] }, ["09:00"]);
  assert.deepEqual(nextOccurrence(m31, d(2026, 10, 31, 10, 0)), d(2026, 12, 31, 9, 0));
  assert.deepEqual(lastOccurrence(m31, d(2026, 12, 30, 0, 0)), d(2026, 10, 31, 9, 0));
  const last = job({ kind: "monthly", dates: [-1] }, ["09:00"]);
  assert.deepEqual(nextOccurrence(last, d(2027, 2, 1)), d(2027, 2, 28, 9, 0));
});

test("next/lastOccurrence — 격주 경계(쉬는 주를 건너뛴다)", () => {
  const bi = job(weekly([1], 2, "2026-10-26"), ["09:00"]); // 10/26, 11/9, 11/23 …
  assert.deepEqual(nextOccurrence(bi, d(2026, 10, 26, 9, 0)), d(2026, 11, 9, 9, 0));
  assert.deepEqual(lastOccurrence(bi, d(2026, 11, 8, 23, 0)), d(2026, 10, 26, 9, 0));
  assert.deepEqual(lastOccurrence(bi, d(2026, 11, 9, 8, 59)), d(2026, 10, 26, 9, 0));
  assert.deepEqual(lastOccurrence(bi, d(2026, 11, 9, 9, 0)), d(2026, 11, 9, 9, 0));
});

test("next/lastOccurrence — 꺼진 잡은 null", () => {
  const off = job({ kind: "daily" }, ["08:00"], false);
  assert.equal(nextOccurrence(off, d(2026, 10, 25)), null);
  assert.equal(lastOccurrence(off, d(2026, 10, 25)), null);
});

// ── describeSchedule ──

test("describeSchedule — 계약 §1.6 문구", () => {
  assert.equal(describeSchedule(job({ kind: "daily" }, ["08:00", "17:00"])), "매일 08:00, 17:00");
  assert.equal(describeSchedule(job(weekly([1, 2, 3, 4, 5]), ["08:00"])), "평일 08:00");
  assert.equal(describeSchedule(job(weekly([0, 6]), ["10:00"])), "주말 10:00");
  assert.equal(describeSchedule(job(weekly([1], 2, "2026-10-26"), ["09:00"])), "격주 월요일 09:00");
  assert.equal(describeSchedule(job(weekly([0]), ["10:00"])), "매주 일요일 10:00");
  assert.equal(describeSchedule(job(weekly([5, 1, 3]), ["07:30"])), "매주 월·수·금요일 07:30");
  assert.equal(describeSchedule(job(weekly([2], 3, "2026-10-26"), ["09:00"])), "3주마다 화요일 09:00");
  assert.equal(describeSchedule(job({ kind: "monthly", dates: [1, 15] }, ["09:00"])), "매월 1·15일 09:00");
  assert.equal(describeSchedule(job({ kind: "monthly", dates: [-1] }, ["09:00"])), "매월 말일 09:00");
  assert.equal(describeSchedule(job({ kind: "monthly", dates: [1, -1] }, ["09:00"])), "매월 1일·말일 09:00");
  assert.equal(describeSchedule(job({ kind: "daily" }, ["08:00"], false)), "꺼짐");
});

// ── expandInterval ──

test("expandInterval — 끝 포함, 자정 넘김 허용, 결과는 오름차순", () => {
  assert.deepEqual(expandInterval("08:00", "12:00", 120), ["08:00", "10:00", "12:00"]);
  assert.deepEqual(expandInterval("08:00", "11:00", 120), ["08:00", "10:00"], "간격에 안 맞는 끝은 빠진다");
  assert.deepEqual(expandInterval("22:00", "02:00", 60), ["00:00", "01:00", "02:00", "22:00", "23:00"]);
  assert.deepEqual(expandInterval("9:00", "9:00", 60), ["09:00"]);
  assert.equal(expandInterval("00:00", "23:30", 30).length, 48);
});

test("expandInterval — 잘못된 입력은 throw", () => {
  assert.throws(() => expandInterval("25:00", "02:00", 60), /시작 시각/);
  assert.throws(() => expandInterval("08:00", "8시", 60), /끝 시각/);
  assert.throws(() => expandInterval("08:00", "10:00", 0), /간격/);
  assert.throws(() => expandInterval("08:00", "10:00", 1.5), /간격/);
});

// ── normalizeJobSchedule ──

const NOW = d(2026, 10, 25, 12, 0);

test("normalize — 시각 정규화(zero-pad·중복 제거·정렬), v1 배열은 매일로", () => {
  assert.deepEqual(normalizeJobSchedule(["17:00", "8:00", "08:00"], "news", NOW), {
    enabled: true,
    repeat: { kind: "daily" },
    times: ["08:00", "17:00"],
  });
  assert.deepEqual(
    normalizeJobSchedule({ enabled: false, repeat: { kind: "weekly", days: [5, 1, 1], intervalWeeks: 1, anchorDate: "2026-01-05" }, times: ["9:30"] }, "events", NOW),
    { enabled: false, repeat: { kind: "weekly", days: [1, 5], intervalWeeks: 1 }, times: ["09:30"] },
    "매주(1)면 기준일은 버린다"
  );
});

test("normalize — 격주 기준일이 비면 저장 시점 날짜로 채운다", () => {
  const r = normalizeJobSchedule({ enabled: true, repeat: { kind: "weekly", days: [1], intervalWeeks: 2 }, times: ["09:00"] }, "skills", NOW);
  assert.deepEqual(r.repeat, { kind: "weekly", days: [1], intervalWeeks: 2, anchorDate: "2026-10-25" });
  assert.throws(
    () => normalizeJobSchedule({ enabled: true, repeat: { kind: "weekly", days: [1], intervalWeeks: 2, anchorDate: "2026-13-01" }, times: ["09:00"] }, "news", NOW),
    /기준 날짜/
  );
});

test("normalize — 매월 날짜는 정렬하되 말일(-1)은 맨 뒤", () => {
  const r = normalizeJobSchedule({ enabled: true, repeat: { kind: "monthly", dates: [-1, 15, 1, 15] }, times: ["09:00"] }, "news", NOW);
  assert.deepEqual(r.repeat, { kind: "monthly", dates: [1, 15, -1] });
});

test("normalize 거부 — 잘못된 HH:mm·빈 시각·maxTimes 초과", () => {
  assert.throws(() => normalizeJobSchedule(["24:00"], "news", NOW), /뉴스: 시각 형식 오류: "24:00"/);
  assert.throws(() => normalizeJobSchedule(["8시"], "news", NOW), /시각 형식 오류/);
  assert.throws(() => normalizeJobSchedule([], "news", NOW), /최소 1개/);
  const many = expandInterval("00:00", "23:30", 30); // 48개
  assert.throws(() => normalizeJobSchedule(many, "news", NOW), /최대 24개/);
  assert.equal(normalizeJobSchedule(many, "stockPulse", NOW).times.length, 48, "펄스는 48개까지");
  assert.throws(
    () => normalizeJobSchedule({ enabled: true, repeat: { kind: "weekly", days: [1], intervalWeeks: 1 }, times: ["09:00", "10:00"] }, "skills", NOW),
    /최대 1개/
  );
});

test("normalize 거부 — 빈 요일·요일 개수 초과·간격 초과·허용 안 된 반복", () => {
  const w = (days: number[], intervalWeeks = 1) => ({ enabled: true, repeat: { kind: "weekly", days, intervalWeeks }, times: ["09:00"] });
  assert.throws(() => normalizeJobSchedule(w([]), "news", NOW), /요일을 1개 이상/);
  assert.throws(() => normalizeJobSchedule(w([7]), "news", NOW), /요일 값 오류/);
  assert.throws(() => normalizeJobSchedule(w([1, 2]), "lotto", NOW), /요일은 최대 1개/);
  assert.throws(() => normalizeJobSchedule(w([1], 5), "news", NOW), /1~4/);
  assert.throws(() => normalizeJobSchedule(w([0], 2), "lotto", NOW), /매주 반복만/);
  assert.throws(() => normalizeJobSchedule(["09:00"], "skills", NOW), /'매일' 반복은 쓸 수 없습니다/);
  assert.throws(() => normalizeJobSchedule({ enabled: true, repeat: { kind: "monthly", dates: [1] }, times: ["10:00"] }, "lotto", NOW), /'매월'/);
  assert.throws(() => normalizeJobSchedule({ enabled: true, repeat: { kind: "monthly", dates: [] }, times: ["10:00"] }, "news", NOW), /날짜를 1개 이상/);
  assert.throws(() => normalizeJobSchedule({ enabled: true, repeat: { kind: "monthly", dates: [0] }, times: ["10:00"] }, "news", NOW), /날짜 값 오류/);
  assert.throws(() => normalizeJobSchedule({ enabled: true, repeat: { kind: "monthly", dates: [1, 15] }, times: ["10:00"] }, "skills", NOW), /날짜는 최대 1개/);
  assert.throws(() => normalizeJobSchedule({ enabled: "yes", repeat: { kind: "daily" }, times: ["10:00"] }, "news", NOW), /enabled/);
  assert.throws(() => normalizeJobSchedule({ enabled: true, repeat: { kind: "hourly" }, times: ["10:00"] }, "news", NOW), /알 수 없는 반복/);
  assert.throws(() => normalizeJobSchedule("08:00", "news", NOW), /형식이 올바르지/);
});

test("normalize 거부 — 로또 토요일 20:00~24:00 금지 구간", () => {
  const sat = (t: string) => ({ enabled: true, repeat: { kind: "weekly", days: [6], intervalWeeks: 1 }, times: [t] });
  assert.throws(() => normalizeJobSchedule(sat("20:00"), "lotto", NOW), /토요일 20:00~24:00에는 실행할 수 없습니다/);
  assert.throws(() => normalizeJobSchedule(sat("20:45"), "lotto", NOW), /이미 추첨된 회차/);
  assert.throws(() => normalizeJobSchedule(sat("23:59"), "lotto", NOW), /로또:/);
  // 경계 밖은 허용: 추첨 전(19:59)·다른 요일의 같은 시각
  assert.equal(normalizeJobSchedule(sat("19:59"), "lotto", NOW).times[0], "19:59");
  const sun = { enabled: true, repeat: { kind: "weekly", days: [0], intervalWeeks: 1 }, times: ["21:00"] };
  assert.equal(normalizeJobSchedule(sun, "lotto", NOW).repeat.kind, "weekly");
  // 꺼 둔 상태로 저장해도 금지 구간은 금지다(켜는 순간 그대로 돌기 때문)
  assert.throws(() => normalizeJobSchedule({ ...sat("21:00"), enabled: false }, "lotto", NOW), /실행할 수 없습니다/);
});

test("scheduleBlackoutAt — 실행 시점 가드가 같은 구간 정의를 쓴다", () => {
  assert.equal(scheduleBlackoutAt("lotto", d(2026, 10, 31, 19, 59)), null);
  assert.match(scheduleBlackoutAt("lotto", d(2026, 10, 31, 20, 0)) ?? "", /추첨/);
  assert.match(scheduleBlackoutAt("lotto", d(2026, 10, 31, 23, 59)) ?? "", /추첨/);
  assert.equal(scheduleBlackoutAt("lotto", d(2026, 11, 1, 0, 0)), null, "자정부터는 열린다");
  assert.equal(scheduleBlackoutAt("news", d(2026, 10, 31, 21, 0)), null, "로또 외 잡엔 금지 구간이 없다");
  assert.ok(SCHEDULE_RULES.lotto.blackout?.length === 1);
});

test("toLocalIso — 로컬 오프셋을 붙인다", () => {
  assert.match(toLocalIso(d(2026, 10, 26, 8, 0)), /^2026-10-26T08:00:00[+-]\d{2}:\d{2}$/);
});
