/**
 * 탭별 자동 실행 스케줄 v2 의 순수 계산 (서버·화면 공용).
 *
 * 의미 규칙의 정본은 `docs/customization-contract.md` §1 이고, 이 파일은 그 규칙을 코드로 옮긴
 * **유일한** 구현이다. 서버(schedule-store · scheduler · uptime · lotto · skills)와 화면
 * (`@shared/schedule`)이 같은 함수를 본다 — 화면이 "다음 실행"을 따로 계산하면 서버와 하루씩
 * 어긋나는 순간이 반드시 생긴다.
 *
 * ⚠️ **순수 함수만** 둔다. 파일·네트워크·config 접근 금지 — 브라우저 번들에 그대로 들어간다.
 *    모든 계산은 실행 환경의 **로컬 시간대**(맥 시간대 = 화면을 여는 브라우저 시간대)다.
 */
import type {
  JobSchedule,
  JobScheduleRules,
  ScheduleJobId,
  ScheduleRepeat,
  Weekday,
} from "./types.ts";

/** 스케줄을 갖는 잡 전체(순회 순서 = 화면 기본 정렬 순서). */
export const SCHEDULE_JOB_IDS: readonly ScheduleJobId[] = [
  "events",
  "news",
  "youtube",
  "stockKr",
  "stockUs",
  "stockPulse",
  "skills",
  "lotto",
];

export const SCHEDULE_JOB_LABEL: Record<ScheduleJobId, string> = {
  events: "팝업·전시",
  news: "뉴스",
  youtube: "유튜브 소식",
  stockKr: "증시(한국)",
  stockUs: "증시(미국)",
  stockPulse: "증시 펄스",
  skills: "스킬 랭킹",
  lotto: "로또",
};

/** 하루 여러 번 도는 일반 탭. 반복 3종 + 4주 간격까지 허용한다. */
const MULTI_SLOT_RULES: JobScheduleRules = {
  repeatKinds: ["daily", "weekly", "monthly"],
  maxTimes: 24,
  maxIntervalWeeks: 4,
};

/**
 * 잡별 편집 제약(계약 §1.4). 서버 검증의 정본이고, 화면은 응답의 rules 로 입력 범위를 막는다.
 *
 * 값의 근거:
 * - 일반 탭 maxTimes 24: 한 번이 최대 20분짜리 LLM 작업이라 '매시간'이 현실적인 상한이다.
 * - 펄스 maxTimes 48: 원래 하루 10회 이상이 정상인 잡이라 30분 간격까지 연다.
 * - 스킬 랭킹: '기간 증가분' 랭킹이라 하루 간격은 의미가 없다(같은 star 수 차분이 0 에 수렴).
 * - 로또: 회차가 주 1회라 **매주 1번**만 연다. 격주로 돌면 그 사이 회차는 추천 번호 없이 지나간다.
 */
export const SCHEDULE_RULES: Record<ScheduleJobId, JobScheduleRules> = {
  events: MULTI_SLOT_RULES,
  news: MULTI_SLOT_RULES,
  youtube: MULTI_SLOT_RULES,
  stockKr: {
    ...MULTI_SLOT_RULES,
    note: "결산·프리뷰 역할은 시각으로 정해집니다(이른 시각=결산, 늦은 시각=프리뷰). 지난 날의 브리핑은 보충하지 않습니다.",
  },
  stockUs: {
    ...MULTI_SLOT_RULES,
    note: "결산·프리뷰 역할은 시각으로 정해집니다(이른 시각=결산, 늦은 시각=프리뷰). 지난 날의 브리핑은 보충하지 않습니다.",
  },
  stockPulse: {
    ...MULTI_SLOT_RULES,
    maxTimes: 48,
    note: "실시간 감시라 지나간 시각은 보충하지 않습니다.",
  },
  skills: {
    repeatKinds: ["weekly", "monthly"],
    maxTimes: 1,
    maxDays: 1,
    maxDates: 1,
    maxIntervalWeeks: 4,
    note: "'기간 증가분' 랭킹이라 주 1회 이상 간격만 됩니다. 증가 기간은 실제 수집 간격(일수)으로 표시됩니다.",
  },
  lotto: {
    repeatKinds: ["weekly"],
    maxTimes: 1,
    maxDays: 1,
    maxIntervalWeeks: 1,
    blackout: [
      {
        day: 6,
        from: "20:00",
        // "24:00" = 그날 끝(자정 직전까지). [from, to) 반열린 구간이다.
        to: "24:00",
        // ── 이 구간의 근거 (src/lotto/cycle.ts · draws.ts) ──
        // 사이클은 '다음 회차 = DB 최신 회차 + 1' 로 번호를 확정한다(writeUpcomingPicks).
        // 토요일 20:45경 추첨이 끝나도 동행복권 JSON 에 그 회차가 올라오기 전에는 '최신'이 한 회차
        // 뒤처져 있어, 그 사이에 돌면 **방금 추첨된 회차**의 번호를 새로 뽑아 저장한다 — 추첨 후에
        // 고른 번호는 예측이 아니다. 판매 마감(20:00)부터 결과 공개가 확실해지는 자정까지를 닫는다.
        // (큐 대기로 확정 시각이 이 구간에 밀려 들어오는 경우는 cycle.ts 가 따로 막는다.)
        reason:
          "추첨(20:45경)과 결과 공개가 겹치는 시간이라, 이때 돌면 이미 추첨된 회차의 번호를 새로 뽑을 수 있습니다.",
      },
    ],
    note: "회차가 주 1회라 매주 한 번만 돕니다. 추천 번호는 추첨 전에 확정되고 이후 바뀌지 않습니다.",
  },
};

const WEEKDAY_NAME = ["일", "월", "화", "수", "목", "금", "토"] as const;
const REPEAT_KIND_LABEL: Record<ScheduleRepeat["kind"], string> = {
  daily: "매일",
  weekly: "매주",
  monthly: "매월",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/**
 * 다음/직전 실행을 찾을 때 훑는 최대 일수. 가장 긴 간격은 '매월 31일'(31일 없는 달을 건너뛰어
 * 최대 2달)과 '4주마다'(28일)라 400일이면 어떤 유효 스케줄도 반드시 걸린다.
 */
const SCAN_DAYS = 400;

// ── 시각/날짜 유틸 ──

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "H:mm"/"HH:mm" → 하루 중 분(0~1439). allow24 면 "24:00"(=1440, 구간 끝 전용)도 받는다. 형식 오류면 null. */
function parseMinutes(t: unknown, allow24 = false): number | null {
  if (typeof t !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (allow24 && hour === 24 && minute === 0) return 24 * 60;
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function formatMinutes(min: number): string {
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

/** 로컬 YYYY-MM-DD. */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "YYYY-MM-DD" → 그날 로컬 00:00. 형식 오류·없는 날짜(2월 30일 등)면 null. */
function parseLocalDate(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return ymd(d) === s ? d : null;
}

/** 그날이 속한 주(월요일 시작)의 월요일 00:00. */
function mondayOf(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
}

function isLastDayOfMonth(d: Date): boolean {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() === d.getDate();
}

/** 유효한 시각만 분 단위로, 오름차순·중복 없이. (읽기 경로라 깨진 항목은 조용히 버린다.) */
function sortedMinutes(times: readonly string[]): number[] {
  const out = new Set<number>();
  for (const t of times) {
    const m = parseMinutes(t);
    if (m !== null) out.add(m);
  }
  return [...out].sort((a, b) => a - b);
}

function atMinutes(day: Date, min: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(min / 60), min % 60, 0, 0);
}

/** 로컬 오프셋을 붙인 ISO(`2026-10-26T08:00:00+09:00`). toISOString 은 UTC 라 날짜가 하루 어긋나 보인다. */
export function toLocalIso(d: Date): string {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return (
    `${ymd(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

// ── 실행일 판정 (계약 §1.1) ──

/**
 * 그 날짜가 실행일인지. 시각은 보지 않는다 — 실행일이면 times 전부가 돈다.
 *
 * - weekly + intervalWeeks>1: anchorDate 가 속한 **월~일 주**부터 센 주 차이가 배수인 주만.
 *   기준일이 비었거나 깨졌으면 매주로 접는다(영영 안 도는 쪽보다 한 번 더 도는 쪽이 낫다).
 * - monthly: 그 달에 없는 날짜(2월 30일)는 그 달 건너뛴다. -1 = 말일.
 */
export function isDueDate(repeat: ScheduleRepeat, date: Date): boolean {
  switch (repeat.kind) {
    case "daily":
      return true;
    case "weekly": {
      if (!repeat.days.includes(date.getDay() as Weekday)) return false;
      const n = Math.floor(repeat.intervalWeeks);
      if (!(n > 1)) return true;
      const anchor = parseLocalDate(repeat.anchorDate);
      if (!anchor) return true;
      // DST 가 있는 시간대에서도 1시간 오차를 흡수하도록 반올림한다(한국은 DST 없음).
      const weeks = Math.round((mondayOf(date).getTime() - mondayOf(anchor).getTime()) / WEEK_MS);
      return ((weeks % n) + n) % n === 0;
    }
    case "monthly":
      return (
        repeat.dates.includes(date.getDate()) || (repeat.dates.includes(-1) && isLastDayOfMonth(date))
      );
    default:
      return false; // 알 수 없는 종류(손상된 저장값) — 돌지 않는다
  }
}

// ── 다음/직전 실행 ──

/** from **초과** 첫 실행 예정 시각. 꺼져 있거나(enabled=false) 유효 시각이 없으면 null. */
export function nextOccurrence(job: JobSchedule, from: Date): Date | null {
  if (!job.enabled) return null;
  const mins = sortedMinutes(job.times);
  if (mins.length === 0) return null;
  for (let i = 0; i <= SCAN_DAYS; i++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    if (!isDueDate(job.repeat, day)) continue;
    for (const m of mins) {
      const at = atMinutes(day, m);
      if (at.getTime() > from.getTime()) return at;
    }
  }
  return null;
}

/** at **이하** 마지막 실행 예정 시각(정각은 포함). 꺼져 있거나 유효 시각이 없으면 null. */
export function lastOccurrence(job: JobSchedule, at: Date): Date | null {
  if (!job.enabled) return null;
  const mins = sortedMinutes(job.times).reverse();
  if (mins.length === 0) return null;
  for (let i = 0; i <= SCAN_DAYS; i++) {
    const day = new Date(at.getFullYear(), at.getMonth(), at.getDate() - i);
    if (!isDueDate(job.repeat, day)) continue;
    for (const m of mins) {
      const occ = atMinutes(day, m);
      if (occ.getTime() <= at.getTime()) return occ;
    }
  }
  return null;
}

// ── 표시 문구 ──

/** 요일 목록을 월요일부터 읽는 순서로(화면·문구는 월~일 관례). */
function mondayFirst(days: readonly number[]): number[] {
  return [...new Set(days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
}

/** 반복 규칙만의 문구: "매일" / "평일" / "매주 월요일" / "격주 월·목요일" / "매월 1·15일·말일". */
export function describeRepeat(repeat: ScheduleRepeat): string {
  switch (repeat.kind) {
    case "daily":
      return "매일";
    case "weekly": {
      const days = mondayFirst(repeat.days);
      const key = days.join(",");
      let label: string;
      let standalone = true; // "매주" 를 붙이지 않아도 뜻이 통하는 묶음
      if (days.length === 7) label = "매일";
      else if (key === "1,2,3,4,5") label = "평일";
      else if (key === "6,0") label = "주말";
      else {
        label = `${days.map((d) => WEEKDAY_NAME[d] ?? "?").join("·")}요일`;
        standalone = false;
      }
      const n = Math.floor(repeat.intervalWeeks);
      if (!(n > 1)) return standalone ? label : `매주 ${label}`;
      return `${n === 2 ? "격주" : `${n}주마다`} ${label}`;
    }
    case "monthly": {
      const regular = [...new Set(repeat.dates.filter((d) => d > 0))].sort((a, b) => a - b);
      const parts: string[] = [];
      if (regular.length > 0) parts.push(`${regular.join("·")}일`);
      if (repeat.dates.includes(-1)) parts.push("말일");
      return `매월 ${parts.join("·")}`;
    }
    default:
      return "알 수 없는 반복";
  }
}

/** "매일 08:00, 17:00" / "평일 08:00" / "격주 월요일 09:00" / "매월 1·15일 09:00" / "매월 말일 09:00" / "꺼짐". */
export function describeSchedule(job: JobSchedule): string {
  if (!job.enabled) return "꺼짐";
  return `${describeRepeat(job.repeat)} ${job.times.join(", ")}`;
}

// ── 'N시간 간격' 펼치기 ──

/**
 * "start~end 를 everyMinutes 마다" → 시각 목록. 끝 시각도 간격에 맞으면 포함한다.
 * end 가 start 보다 이르면 **자정을 넘긴다**(예: 22:00~06:00 2시간 → 22·00·02·04·06시).
 * 결과는 JobSchedule.times 불변식대로 오름차순·중복 없음이다. 입력 오류면 throw(한국어).
 */
export function expandInterval(start: string, end: string, everyMinutes: number): string[] {
  const s = parseMinutes(start);
  if (s === null) throw new Error(`시작 시각 형식 오류: "${start}" (HH:mm 이어야 합니다)`);
  const e = parseMinutes(end);
  if (e === null) throw new Error(`끝 시각 형식 오류: "${end}" (HH:mm 이어야 합니다)`);
  if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 24 * 60) {
    throw new Error(`간격은 1~1440분 사이의 정수여야 합니다(받은 값: ${everyMinutes}).`);
  }
  const span = e >= s ? e - s : e + 24 * 60 - s;
  const out = new Set<string>();
  for (let m = 0; m <= span; m += everyMinutes) out.add(formatMinutes((s + m) % (24 * 60)));
  return [...out].sort();
}

// ── 금지 구간 ──

/** 이 반복이 그 요일에 걸릴 수 있는가. 매일·매월은 어느 요일에나 걸릴 수 있다. */
function repeatCanHitDay(repeat: ScheduleRepeat, day: Weekday): boolean {
  return repeat.kind === "weekly" ? repeat.days.includes(day) : true;
}

/**
 * 그 시각이 잡의 금지 구간 안이면 사유, 아니면 null. 저장 검증뿐 아니라 **실행 시점 가드**
 * (로또 사이클이 추첨~결과 공개 사이에 번호를 확정하지 않게)에도 같은 정의를 쓴다.
 */
export function scheduleBlackoutAt(id: ScheduleJobId, at: Date): string | null {
  const now = at.getHours() * 60 + at.getMinutes();
  for (const b of SCHEDULE_RULES[id]?.blackout ?? []) {
    if (at.getDay() !== b.day) continue;
    const from = parseMinutes(b.from, true) ?? 0;
    const to = parseMinutes(b.to, true) ?? 24 * 60;
    if (now >= from && now < to) return b.reason;
  }
  return null;
}

// ── 엄격 정규화 (쓰기 경로) ──

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 입력 1건을 검증·정규화한다. **실패하면 throw(한국어 사유)** — 라우트가 400 으로 돌려준다.
 *
 * - v1 형식(시각 배열)이 오면 `{enabled:true, repeat:{kind:"daily"}, times}` 로 해석한다(계약 §1.5).
 * - 시각: HH:mm 정규화(zero-pad)·중복 제거·오름차순, 1개 이상, rules.maxTimes 이하.
 * - weekly: 요일 1개 이상(rules.maxDays 이하), intervalWeeks 1~rules.maxIntervalWeeks.
 *   intervalWeeks>1 인데 anchorDate 가 비어 있으면 `now` 의 날짜로 채운다. 1 이면 anchorDate 를 버린다.
 * - monthly: 1~31 또는 -1(말일), 오름차순(말일은 맨 뒤)·중복 없음, rules.maxDates 이하.
 * - rules.blackout 에 걸리는 시각이 하나라도 있으면 거부한다.
 */
export function normalizeJobSchedule(
  input: unknown,
  id: ScheduleJobId,
  now: Date = new Date()
): JobSchedule {
  const rules = SCHEDULE_RULES[id];
  if (!rules) throw new Error(`알 수 없는 스케줄 항목입니다: "${String(id)}"`);
  const label = SCHEDULE_JOB_LABEL[id];
  const fail = (msg: string): never => {
    throw new Error(`${label}: ${msg}`);
  };

  const raw: unknown = Array.isArray(input)
    ? { enabled: true, repeat: { kind: "daily" }, times: input }
    : input;
  if (!isPlainObject(raw)) return fail("스케줄 형식이 올바르지 않습니다.");
  if (typeof raw.enabled !== "boolean") fail("켜기/끄기(enabled)는 true 또는 false 여야 합니다.");

  const repeat = normalizeRepeat(raw.repeat, rules, now, fail);
  const times = normalizeTimes(raw.times, rules, fail);

  for (const b of rules.blackout ?? []) {
    if (!repeatCanHitDay(repeat, b.day)) continue;
    const from = parseMinutes(b.from, true) ?? 0;
    const to = parseMinutes(b.to, true) ?? 24 * 60;
    const hit = times.find((t) => {
      const m = parseMinutes(t) as number;
      return m >= from && m < to;
    });
    if (hit) fail(`${WEEKDAY_NAME[b.day]}요일 ${b.from}~${b.to}에는 실행할 수 없습니다 — ${b.reason}`);
  }

  return { enabled: raw.enabled as boolean, repeat, times };
}

function normalizeTimes(v: unknown, rules: JobScheduleRules, fail: (m: string) => never): string[] {
  if (!Array.isArray(v)) return fail("실행 시각(times) 목록이 필요합니다.");
  const mins = new Set<number>();
  for (const t of v) {
    const m = parseMinutes(t);
    if (m === null) fail(`시각 형식 오류: "${String(t)}" (HH:mm 이어야 합니다)`);
    mins.add(m as number);
  }
  if (mins.size === 0) fail("실행 시각이 최소 1개 필요합니다.");
  if (mins.size > rules.maxTimes) fail(`실행 시각은 최대 ${rules.maxTimes}개까지 정할 수 있습니다.`);
  return [...mins].sort((a, b) => a - b).map(formatMinutes);
}

function normalizeRepeat(
  v: unknown,
  rules: JobScheduleRules,
  now: Date,
  fail: (m: string) => never
): ScheduleRepeat {
  if (!isPlainObject(v)) return fail("반복(repeat) 설정이 필요합니다.");
  const kind = v.kind;
  if (kind !== "daily" && kind !== "weekly" && kind !== "monthly") {
    return fail(`알 수 없는 반복 종류입니다: "${String(kind)}"`);
  }
  if (!rules.repeatKinds.includes(kind)) {
    const allowed = rules.repeatKinds.map((k) => REPEAT_KIND_LABEL[k]).join("·");
    return fail(`'${REPEAT_KIND_LABEL[kind]}' 반복은 쓸 수 없습니다(가능: ${allowed}).`);
  }

  if (kind === "daily") return { kind: "daily" };

  if (kind === "weekly") {
    if (!Array.isArray(v.days)) return fail("요일(days) 목록이 필요합니다.");
    const days = new Set<Weekday>();
    for (const d of v.days) {
      if (!Number.isInteger(d) || (d as number) < 0 || (d as number) > 6) {
        fail(`요일 값 오류: ${JSON.stringify(d)} (0=일 … 6=토)`);
      }
      days.add(d as Weekday);
    }
    if (days.size === 0) fail("요일을 1개 이상 골라야 합니다.");
    const maxDays = rules.maxDays ?? 7;
    if (days.size > maxDays) fail(`요일은 최대 ${maxDays}개까지 고를 수 있습니다.`);

    const n = v.intervalWeeks;
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > rules.maxIntervalWeeks) {
      fail(
        rules.maxIntervalWeeks === 1
          ? "매주 반복만 됩니다(N주마다 불가)."
          : `주 간격(intervalWeeks)은 1~${rules.maxIntervalWeeks} 사이의 정수여야 합니다.`
      );
    }
    const intervalWeeks = n as number;
    const sorted = [...days].sort((a, b) => a - b);
    if (intervalWeeks === 1) return { kind: "weekly", days: sorted, intervalWeeks };

    let anchorDate: string;
    if (v.anchorDate === undefined || v.anchorDate === null || v.anchorDate === "") {
      anchorDate = ymd(now);
    } else if (parseLocalDate(v.anchorDate)) {
      anchorDate = v.anchorDate as string;
    } else {
      return fail(`기준 날짜(anchorDate) 형식 오류: ${JSON.stringify(v.anchorDate)} (YYYY-MM-DD)`);
    }
    return { kind: "weekly", days: sorted, intervalWeeks, anchorDate };
  }

  // monthly
  if (!Array.isArray(v.dates)) return fail("날짜(dates) 목록이 필요합니다.");
  const dates = new Set<number>();
  for (const d of v.dates) {
    if (!Number.isInteger(d) || !(d === -1 || ((d as number) >= 1 && (d as number) <= 31))) {
      fail(`날짜 값 오류: ${JSON.stringify(d)} (1~31, 말일은 -1)`);
    }
    dates.add(d as number);
  }
  if (dates.size === 0) fail("날짜를 1개 이상 골라야 합니다.");
  if (rules.maxDates !== undefined && dates.size > rules.maxDates) {
    fail(`날짜는 최대 ${rules.maxDates}개까지 고를 수 있습니다.`);
  }
  // 말일(-1)은 그 달의 가장 늦은 날이라 맨 뒤에 둔다.
  const order = (d: number) => (d === -1 ? 32 : d);
  return { kind: "monthly", dates: [...dates].sort((a, b) => order(a) - order(b)) };
}
