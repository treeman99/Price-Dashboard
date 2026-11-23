/**
 * 조사 기간(신선도) 판정 — **실행 시점 기준 최근 N시간을 시각 단위로** 본다(2026-11-23 사용자 결정 "24시간 이내로만").
 *
 * 규칙(뉴스·유튜브 공통, 세 모델 후처리·보고서 통합 단계·유튜브 watch 재검증이 모두 이 함수를 쓴다):
 *  1. 발행·업로드 **시각**(ISO, 시간대 포함)을 알면: 구간 [start, end] 안이면 통과. 미래 시각은 15분까지만 허용(시계 오차).
 *  2. **날짜만** 알면(시각 미확인): 그 날짜의 0시(로컬)가 구간 시작 이후이고 끝 이전일 때만 통과하고 `approx` 로 표시한다.
 *     즉 그 날 전체가 구간 안에 들어오는 날짜만 받는다(보수적). 24시간 구간이면 '오늘 날짜'만 통과하고, 어제 날짜는
 *     어제의 구간 밖 시간대일 수 있어 뺀다.
 *  3. 날짜도 시각도 없으면 판정 불가 → 제외.
 * 시간대가 없는 시각 문자열("2026-11-23 08:30")은 로컬(맥 시간대 = Asia/Seoul)로 본다.
 */

export interface RecencyWindow {
  /** 구간 시작(포함). */
  start: Date;
  /** 구간 끝(실행 시점, 포함). */
  end: Date;
  hours: number;
}

export type RecencyCheck =
  | { ok: true; approx: boolean }
  | { ok: false; reason: "old" | "future" | "date-only" | "unknown" };

const FUTURE_SLACK_MS = 15 * 60_000;

/** 실행 시점 end 에서 hours 시간 전까지. */
export function windowEndingAt(end: Date, hours: number): RecencyWindow {
  const h = Math.max(1, Math.round(hours));
  return { start: new Date(end.getTime() - h * 3_600_000), end: new Date(end.getTime()), hours: h };
}

/**
 * 시각 문자열 → Date. 시각(시:분)이 없는 값(날짜만)은 null — 날짜만인 값은 parseDateOnly 로 따로 다룬다.
 * 허용: ISO(Z·±hh:mm), "YYYY-MM-DD HH:mm(:ss)", 시간대 없으면 로컬.
 */
export function parseTimestamp(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, tz] = m;
  if (tz) {
    const iso = `${y}-${mo}-${d}T${hh}:${mi}:${ss ?? "00"}${tz.toUpperCase() === "Z" ? "Z" : tz.length === 5 ? `${tz.slice(0, 3)}:${tz.slice(3)}` : tz}`;
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? null : t;
  }
  const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss ?? 0));
  return Number.isNaN(t.getTime()) ? null : t;
}

/** "YYYY-MM-DD" → 그 날 0시(로컬). 형식이 아니면 null. */
export function parseDateOnly(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t.getTime()) ? null : t;
}

/** 로컬 시간대 오프셋을 붙인 ISO("2026-11-23T08:30:00+09:00"). 저장·표시용. */
export function toLocalIso(d: Date): string {
  const p = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.trunc(off / 60))}:${p(off % 60)}`
  );
}

/** 시각 또는 날짜로 구간 판정(위 규칙). */
export function checkRecency(item: { publishedAt?: string | null; date?: string | null }, w: RecencyWindow): RecencyCheck {
  const at = parseTimestamp(item.publishedAt);
  if (at) {
    if (at.getTime() < w.start.getTime()) return { ok: false, reason: "old" };
    if (at.getTime() > w.end.getTime() + FUTURE_SLACK_MS) return { ok: false, reason: "future" };
    return { ok: true, approx: false };
  }
  const day = parseDateOnly(item.date);
  if (!day) return { ok: false, reason: "unknown" };
  if (day.getTime() >= w.start.getTime() && day.getTime() <= w.end.getTime()) return { ok: true, approx: true };
  return { ok: false, reason: day.getTime() > w.end.getTime() ? "future" : "date-only" };
}

const KST_FMT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "11/22 09:00" (Asia/Seoul). */
export function kstShort(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(t.getTime())) return String(d);
  const parts = Object.fromEntries(KST_FMT.formatToParts(t).map((p) => [p.type, p.value]));
  return `${parts.month}/${parts.day} ${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
}

/** "11/22 09:00 ~ 11/23 09:00 KST" */
export function formatWindowKst(w: { start: Date | string; end: Date | string }): string {
  return `${kstShort(w.start)} ~ ${kstShort(w.end)} KST`;
}

/** 프롬프트용 구간 문구: "2026-11-22 09:00 ~ 2026-11-23 09:00 (한국시간)". */
export function promptWindow(w: RecencyWindow): string {
  const f = (d: Date) => toLocalIso(d).slice(0, 16).replace("T", " ");
  return `${f(w.start)} ~ ${f(w.end)} (한국시간)`;
}
