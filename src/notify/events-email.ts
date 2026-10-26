import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { isMailConfigured, sendMail } from "./mailer.ts";
import { googleCalendarUrl } from "../../shared/calendar.ts";
import { splitPopupsByRegion, withLinkedItemsOnly, POPUP_GROUPS } from "../../shared/events.ts";
import { sendIMessage } from "./imessage.ts";
import { isTabNotifyEnabled } from "../settings/tab-settings.ts";
import { escapeHtml, safeHref } from "./html.ts";
import {
  MUTED,
  TNUM,
  cellNote,
  dataTable,
  emailDocument,
  emptyLine,
  metaLine,
  sectionHeader,
  statusTag,
  strong,
  subHeader,
  textLink,
} from "./email-kit.ts";
import type { EventsSnapshot, EventTag, PopupItem, ExhibitionItem, FestivalItem } from "../../shared/types.ts";

/** 팝업/전시/축제 iMessage 텍스트: 카운트 + '신규' 강조 + 팝업 이름 일부. */
export function eventsIMessageText(raw: EventsSnapshot): string {
  // 건수가 화면·메일과 어긋나지 않도록 같은 기준으로 거른다.
  const s = withLinkedItemsOnly(raw);
  const exhCount = s.exhibitions.venues.reduce((a, v) => a + v.items.length, 0);
  const festivals = s.festivals ?? [];
  const newItems = [
    ...s.popups.filter((p) => p.isNew).map((p) => p.name),
    ...s.exhibitions.venues.flatMap((v) => v.items.filter((e) => e.isNew).map((e) => e.title)),
    ...festivals.filter((f) => f.isNew).map((f) => f.name),
  ];
  const lines = [
    `🎈 오늘의 팝업·전시·축제 — ${s.date}`,
    `🛍 팝업 ${s.popups.length} · 🏛 전시 ${exhCount} · 🎉 축제 ${festivals.length}`,
  ];
  if (newItems.length) lines.push(`🆕 신규: ${newItems.slice(0, 6).join(", ")}`);
  if (s.popups.length) lines.push(`팝업: ${s.popups.slice(0, 6).map((p) => p.name).join(", ")}`);
  return lines.join("\n");
}

/** 팝업/전시/축제를 본인 iMessage 로 발송. off(전역·탭)/미설정/전부 0건이면 false. 절대 throw 안 함. */
export async function sendEventsIMessage(raw: EventsSnapshot): Promise<boolean> {
  if (!isTabNotifyEnabled("events", "imessage")) return false;
  // 전부 0건이면 무의미한 '팝업 0·전시 0·축제 0' 푸시를 보내지 않는다(유튜브/뉴스와 일관).
  // 표시 대상(링크 있는 항목) 기준으로 세야 '0건 메시지'를 제대로 막는다.
  const s = withLinkedItemsOnly(raw);
  const total =
    s.popups.length +
    s.exhibitions.venues.reduce((a, v) => a + v.items.length, 0) +
    s.festivals.length;
  if (total === 0) return false;
  try {
    await sendIMessage(eventsIMessageText(s));
    return true;
  } catch (e) {
    log.warn(`이벤트 iMessage 발송 예외: ${(e as Error).message}`);
    return false;
  }
}

/** 섹션 고유색 — 섹션 제목 앞 작은 사각형에만 쓴다(web/src/components/EventsBoard.tsx ACCENT 와 같은 값). */
const ACCENT = { popup: "#7C3AED", exhibition: "#FF8C00", festival: "#E8590C" } as const;

/** 로컬 날짜 YYYY-MM-DD — 화면 SnapshotNotice 의 localDay 와 같은 계산('오늘 종료' 판정용). */
function localDay(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 상태 칸 — 화면 EventsBoard 의 NewBadge + TagBadge 와 같은 규칙.
 * 서버 '약 일주일 만의 신규'(isNew)와 태그 '신규'는 같은 낱말이라 배지 하나로 합친다.
 * 태그 계산(어떤 항목이 종료임박인지)은 그대로 두고, 오늘 끝나는 것만 '오늘 종료'로 갈라 표기만 바꾼다.
 */
function statusCell(tag: EventTag, isNew: boolean | undefined, endDate: string | null, today: string): string {
  const tags: string[] = [];
  if (isNew || tag === "신규") tags.push(statusTag("신규", "new"));
  if (tag === "종료임박") tags.push(endDate === today ? statusTag("오늘 종료", "urgent") : statusTag("종료임박", "warn"));
  if (tag === "예정") tags.push(statusTag("오픈예정", "soon"));
  return tags.join(" ");
}

/** http(s) 링크만 앵커로 렌더. LLM 이 만든 javascript:/data: 스킴은 통째로 버린다. */
function linkAnchor(link: string | null): string {
  const href = safeHref(link);
  return href ? textLink(href, "보기") : "";
}

function calAnchor(title: string, startDate: string | null, endDate: string | null, location: string, summary: string, srcLink: string | null): string {
  const url = googleCalendarUrl({
    title,
    startDate,
    endDate,
    location,
    details: [summary, srcLink].filter(Boolean).join("\n"),
  });
  const href = safeHref(url);
  return href ? textLink(href, "캘린더 추가") : "";
}

/** 표 한 행의 공통 형태. 팝업·전시·축제가 같은 열 구성(상태 · 이름 · 장소와 기간)을 쓴다. */
interface EventRowData {
  title: string;
  category?: string | null;
  tag: EventTag;
  isNew?: boolean;
  place: string;
  period: string;
  startDate: string | null;
  endDate: string | null;
  summary: string;
  link: string | null;
}

const popupRow = (p: PopupItem): EventRowData => ({ ...p, title: p.name, place: p.region });
const exhRow = (e: ExhibitionItem): EventRowData => ({ ...e, place: e.venue });
const festivalRow = (f: FestivalItem): EventRowData => ({ ...f, title: f.name, place: f.region });

/**
 * 한 행의 세 칸: 상태 | 이름(+분류 회색) → 한 줄 설명 → 보기·캘린더 추가 | 장소 → 기간.
 * 화면은 장소·기간·링크를 열로 나누지만, 메일은 390px(아이폰)에서 상태·이름·장소·기간 네 칸의 최소 폭만 합쳐도
 * 420px 이라(실데이터 측정) 링크는 이름 칸에, 기간은 장소 칸 둘째 줄에 둔다.
 */
function eventCells(r: EventRowData, today: string): string[] {
  // 붙여 쓴 긴 한국어 낱말(전시회 이름 등)이 좁은 칸을 밀어내지 않게, 넘칠 때만 낱말 안에서 끊는다.
  const name =
    `<span style="font-size:15px;font-weight:600;line-height:1.45;word-wrap:break-word;overflow-wrap:anywhere">${escapeHtml(r.title)}</span>` +
    (r.category ? ` <span style="font-size:12.5px;color:${MUTED}">${escapeHtml(r.category)}</span>` : "");
  const links = metaLine([
    linkAnchor(r.link),
    calAnchor(r.title, r.startDate, r.endDate, r.place, r.summary, r.link),
  ]);
  // 기간은 "2026.10.12~2026.11.10" 처럼 띄어쓰기가 없어 좁은 폭에서 칸을 밀어낸다 — '~' 뒤에서 줄을 바꿀 수 있게 한다.
  const period = r.period
    ? `<span style="${TNUM}">${escapeHtml(r.period).replace(/~/g, "~<wbr>")}</span>`
    : "";
  return [
    statusCell(r.tag, r.isNew, r.endDate, today),
    name + (r.summary ? cellNote(escapeHtml(r.summary)) : "") + (links ? cellNote(links) : ""),
    `<span style="font-size:13px;word-wrap:break-word;overflow-wrap:anywhere">${escapeHtml(r.place)}</span>` +
      (period ? cellNote(period) : ""),
  ];
}

function eventTable(placeLabel: string, rows: EventRowData[], today: string): string {
  return dataTable(
    [{ label: "상태", width: "64px" }, { label: "이름" }, { label: `${placeLabel} · 기간`, width: "30%" }],
    rows.map((r) => eventCells(r, today))
  );
}

/**
 * 표 위 소그룹(팝업 지역 · 전시장). 화면 GroupRows 와 같은 라벨·점 색·건수 표기와 빈 문구를 쓴다
 * (지역 판별 기준은 shared/events.ts 공용).
 */
function groupBlock(
  group: { label: string; sub?: string; accent?: string },
  placeLabel: string,
  rows: EventRowData[],
  empty: string,
  today: string
): string {
  const head = subHeader(group.label, {
    count: `${rows.length}건`,
    dot: group.accent,
    note: group.sub ? escapeHtml(group.sub) : undefined,
  });
  return head + (rows.length ? eventTable(placeLabel, rows, today) : emptyLine(empty));
}

/** 팝업/전시/축제 이메일 HTML. 순수 함수 — 발송하지 않는다. */
export function buildEventsEmailHtml(raw: EventsSnapshot): string {
  // 화면과 같은 기준: 출처 링크 없는 항목 제외 → 서울/서울 외로 분리.
  const s = withLinkedItemsOnly(raw);
  const today = localDay();
  const { seoul, outer } = splitPopupsByRegion(s.popups);
  const venues = s.exhibitions.venues;
  const festivals = s.festivals ?? [];
  const exhibitionCount = venues.reduce((a, v) => a + v.items.length, 0);

  const popupHtml = s.popups.length
    ? groupBlock(POPUP_GROUPS.seoul, "지역", seoul.map(popupRow), "확인된 팝업이 없습니다", today) +
      groupBlock(POPUP_GROUPS.outer, "지역", outer.map(popupRow), "확인된 팝업이 없습니다", today)
    : emptyLine("확인된 팝업이 없습니다");

  const venueHtml = venues.length
    ? venues
        .map((v) => groupBlock({ label: v.name }, "전시장", v.items.map(exhRow), "이번 주 확인된 행사가 없습니다", today))
        .join("")
    : emptyLine("이번 주 확인된 행사가 없습니다");

  const festivalHtml = festivals.length
    ? eventTable("지역", festivals.map(festivalRow), today)
    : emptyLine("확인된 축제가 없습니다.");

  const body =
    sectionHeader({ title: "팝업스토어", count: s.popups.length, accent: ACCENT.popup, first: true }) +
    popupHtml +
    sectionHeader({
      title: "주요 전시장",
      count: exhibitionCount,
      accent: ACCENT.exhibition,
      note: "코엑스 · 세텍 · 킨텍스 · 수원컨벤션 · 수원메쎄",
    }) +
    venueHtml +
    sectionHeader({ title: "대한민국 축제", count: festivals.length, accent: ACCENT.festival }) +
    festivalHtml;

  return emailDocument({
    tab: "events",
    title: "팝업·전시",
    date: s.date,
    meta: metaLine([
      `팝업 ${strong(`${s.popups.length}건`)}`,
      `전시 ${strong(`${exhibitionCount}건`)}`,
      `축제 ${strong(`${festivals.length}건`)}`,
    ]),
    body,
    footnote: metaLine(["정보는 수집 시점 기준이며 변동될 수 있습니다", s.source === "naver-raw" && "검색 원본"]),
  });
}

/** 팝업·전시 메일 제목. 발송과 미리보기(preview/mail-preview.ts)가 같이 쓴다. */
export function eventsSubject(s: EventsSnapshot): string {
  return `🎈 [팝업·전시·축제] ${s.date} 오늘의 팝업스토어 & 전시 & 축제 정보`;
}

/** 팝업/전시 일일 요약 이메일. NOTIFY_EMAIL + Gmail 주소 + Google OAuth 클라이언트 필요. */
export async function sendEventsEmail(s: EventsSnapshot): Promise<boolean> {
  if (!config.notify.email) return false;
  if (!isMailConfigured()) {
    log.warn("메일 설정 미완료(GMAIL_ADDRESS / GOOGLE_CLIENT_*) → 이벤트 이메일 건너뜀");
    return false;
  }
  if (!isTabNotifyEnabled("events", "email")) {
    log.info("이벤트 메일 알림 꺼짐(대시보드 운영 설정) → 건너뜀");
    return false;
  }

  return sendMail({
    subject: eventsSubject(s),
    html: buildEventsEmailHtml(s),
  });
}
