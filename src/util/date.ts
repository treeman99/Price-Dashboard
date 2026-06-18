/**
 * 로컬 타임존 기준 날짜/시각 유틸.
 * 수집 시각(COLLECT_TIME)과 기존 이력(KST)이 모두 로컬 기준이므로,
 * "오늘"은 UTC가 아니라 반드시 로컬 날짜로 계산한다.
 */

/** 로컬 기준 YYYY-MM-DD */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** N일 전 로컬 날짜 (YYYY-MM-DD) */
export function localDateDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return localDate(d);
}
