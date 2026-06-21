// 구글 캘린더 "이벤트 추가" URL 생성 (백엔드 이메일 + 프론트 공용).
// action=TEMPLATE 링크는 단순 GET URL이라 이메일/웹 어디서나 클릭하면
// 구글 캘린더 이벤트 생성 화면이 열린다(종일 이벤트).

export interface CalendarEventInput {
  title: string;
  startDate: string | null; // YYYY-MM-DD
  endDate: string | null; // YYYY-MM-DD
  location?: string;
  details?: string;
}

/** "2026-06-24" → "20260624" */
function compact(d: string): string {
  return d.replace(/-/g, "");
}

/** 종일 이벤트 종료일은 exclusive → 하루 더한 날짜를 YYYYMMDD로 반환 */
function nextDayCompact(d: string): string {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * 구글 캘린더 추가 URL. 시작일이 없으면 캘린더에 넣을 수 없으므로 null.
 * 종료일이 없으면 시작일 하루짜리 종일 이벤트로 생성.
 */
export function googleCalendarUrl(input: CalendarEventInput): string | null {
  if (!input.startDate) return null;

  const start = compact(input.startDate);
  const endSource = input.endDate && input.endDate >= input.startDate ? input.endDate : input.startDate;
  const end = nextDayCompact(endSource);

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: input.title,
    dates: `${start}/${end}`,
  });
  if (input.location) params.set("location", input.location);
  if (input.details) params.set("details", input.details);

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
