import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { isMailConfigured, sendMail } from "./mailer.ts";
import { googleCalendarUrl } from "../../shared/calendar.ts";
import { splitPopupsByRegion, withLinkedItemsOnly, POPUP_GROUPS } from "../../shared/events.ts";
import { sendIMessage, isIMessageConfigured } from "./imessage.ts";
import { escapeHtml, escapeAttr, safeHref } from "./html.ts";
import type { EventsSnapshot, PopupItem, ExhibitionItem, FestivalItem } from "../../shared/types.ts";

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

/** 팝업/전시/축제를 본인 iMessage 로 발송. off/미설정/전부 0건이면 false. 절대 throw 안 함. */
export async function sendEventsIMessage(raw: EventsSnapshot): Promise<boolean> {
  if (!isIMessageConfigured()) return false;
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

function tagBadge(tag: PopupItem["tag"]): string {
  if (!tag) return "";
  const map = { 신규: "#03C75A", 종료임박: "#FF5A5A", 예정: "#2E86DE" } as const;
  const label = tag === "예정" ? "오픈예정" : tag;
  return ` <span style="background:${map[tag]};color:#fff;border-radius:4px;padding:1px 6px;font-size:11px">${label}</span>`;
}

/** http(s) 링크만 앵커로 렌더. LLM 이 만든 javascript:/data: 스킴은 통째로 버린다. */
function linkAnchor(link: string | null, label: string): string {
  const href = safeHref(link);
  return href
    ? `<a href="${escapeAttr(href)}" style="color:#4361ee;text-decoration:none;font-size:13px">${label}</a>`
    : "";
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
  return href
    ? `<a href="${escapeAttr(href)}" style="color:#1a7f37;text-decoration:none;font-size:13px">📅 캘린더 추가</a>`
    : "";
}

function actions(parts: string[]): string {
  const xs = parts.filter(Boolean);
  return xs.length ? `<p style="margin:6px 0 0">${xs.join('<span style="color:#ccc"> · </span>')}</p>` : "";
}

function popupCard(p: PopupItem, color: string): string {
  const link = linkAnchor(p.link, "🔗 보기");
  const cal = calAnchor(p.name, p.startDate, p.endDate, p.region, p.summary, p.link);
  return `<div style="margin-bottom:10px;padding:12px 14px;background:#f8f9fa;border-radius:8px;border-left:4px solid ${color}">
    <h3 style="margin:0 0 4px;font-size:15px;color:#1a1a2e">${escapeHtml(p.name)}${tagBadge(p.tag)}</h3>
    <p style="margin:0 0 4px;color:#666;font-size:13px">📍 ${escapeHtml(p.region)}${p.period ? ` · ${escapeHtml(p.period)}` : ""}</p>
    ${p.summary ? `<p style="margin:0 0 4px;color:#444;font-size:13px">${escapeHtml(p.summary)}</p>` : ""}
    ${actions([link, cal])}
  </div>`;
}

/**
 * 팝업 지역 하위 그룹(서울 / 수원·화성 등) 블록. 화면의 PopupSubgroup 과 같은
 * 라벨·색·건수 표기를 쓴다(판별 기준은 shared/events.ts 공용).
 */
function popupSubgroup(
  group: { label: string; sub: string; accent: string },
  items: PopupItem[]
): string {
  const head = `<h3 style="margin:18px 0 8px;font-size:14px;color:#1a1a2e">
    <span style="color:${group.accent}">●</span> ${escapeHtml(group.label)}${
      group.sub ? ` <span style="color:#888;font-weight:normal">${escapeHtml(group.sub)}</span>` : ""
    } <span style="color:#888;font-weight:normal">· ${items.length}건</span>
  </h3>`;
  const body = items.length
    ? items.map((p) => popupCard(p, group.accent)).join("")
    : `<p style="color:#999;font-size:13px">해당 지역의 팝업 없음</p>`;
  return head + body;
}

function exhCard(e: ExhibitionItem, color: string): string {
  const link = linkAnchor(e.link, "🔗 보기");
  const cal = calAnchor(e.title, e.startDate, e.endDate, e.venue, e.summary, e.link);
  return `<div style="margin-bottom:10px;padding:12px 14px;background:#f8f9fa;border-radius:8px;border-left:4px solid ${color}">
    <h3 style="margin:0 0 4px;font-size:15px;color:#1a1a2e">${escapeHtml(e.title)}${tagBadge(e.tag)}</h3>
    <p style="margin:0 0 4px;color:#666;font-size:13px">🏛 ${escapeHtml(e.venue)}${e.period ? ` · ${escapeHtml(e.period)}` : ""}</p>
    ${e.summary ? `<p style="margin:0 0 4px;color:#444;font-size:13px">${escapeHtml(e.summary)}</p>` : ""}
    ${actions([link, cal])}
  </div>`;
}

function festivalCard(f: FestivalItem, color: string): string {
  const link = linkAnchor(f.link, "🔗 보기");
  const cal = calAnchor(f.name, f.startDate, f.endDate, f.region, f.summary, f.link);
  return `<div style="margin-bottom:10px;padding:12px 14px;background:#f8f9fa;border-radius:8px;border-left:4px solid ${color}">
    <h3 style="margin:0 0 4px;font-size:15px;color:#1a1a2e">${escapeHtml(f.name)}${tagBadge(f.tag)}</h3>
    <p style="margin:0 0 4px;color:#666;font-size:13px">📍 ${escapeHtml(f.region)}${f.period ? ` · ${escapeHtml(f.period)}` : ""}</p>
    ${f.summary ? `<p style="margin:0 0 4px;color:#444;font-size:13px">${escapeHtml(f.summary)}</p>` : ""}
    ${actions([link, cal])}
  </div>`;
}

/** 팝업/전시/축제 이메일 HTML. 순수 함수 — 발송하지 않는다. */
export function buildEventsEmailHtml(raw: EventsSnapshot): string {
  // 화면과 같은 기준: 출처 링크 없는 항목 제외 → 서울/서울 외로 분리.
  const s = withLinkedItemsOnly(raw);
  const { seoul, outer } = splitPopupsByRegion(s.popups);
  const popupHtml = s.popups.length
    ? popupSubgroup(POPUP_GROUPS.seoul, seoul) + popupSubgroup(POPUP_GROUPS.outer, outer)
    : `<p style="color:#999">확인된 팝업이 없습니다.</p>`;

  const venueHtml = s.exhibitions.venues
    .map(
      (v) =>
        `<h3 style="margin:18px 0 8px;color:#1a1a2e">🏛 ${escapeHtml(v.name)}</h3>` +
        (v.items.length
          ? v.items.map((e) => exhCard(e, "#FF8C00")).join("")
          : `<p style="color:#999;font-size:13px">이번 주 확인된 행사 없음</p>`)
    )
    .join("");

  const festivals = s.festivals ?? [];
  const festivalHtml = festivals.length
    ? festivals.map((f) => festivalCard(f, "#E8590C")).join("")
    : `<p style="color:#999">확인된 축제가 없습니다.</p>`;

  return `<div style="font-family:'Apple SD Gothic Neo',sans-serif;max-width:680px;margin:0 auto;padding:16px">
    <h1 style="color:#7C3AED;border-bottom:3px solid #7C3AED;padding-bottom:8px">🎈 오늘의 팝업 · 전시 · 축제</h1>
    <p style="color:#666">${s.date} · 대시보드: <a href="http://localhost:${config.port}">localhost:${config.port}</a></p>

    <h2 style="color:#7C3AED;margin-top:28px;border-bottom:2px solid #eee;padding-bottom:6px">🛍 팝업스토어</h2>
    ${popupHtml}

    <h2 style="color:#FF8C00;margin-top:32px;border-bottom:2px solid #eee;padding-bottom:6px">🏛 주요 전시장 (코엑스·세텍·킨텍스·수원컨벤션·수원메쎄)</h2>
    ${venueHtml}

    <h2 style="color:#E8590C;margin-top:32px;border-bottom:2px solid #eee;padding-bottom:6px">🎉 대한민국 축제</h2>
    ${festivalHtml}

    <hr style="margin-top:32px;border:none;border-top:1px solid #eee">
    <p style="color:#aaa;font-size:11px;text-align:center">정보는 수집 시점 기준이며 변동될 수 있습니다 · Daily Dashboard${
      s.source === "naver-raw" ? " (검색 원본)" : ""
    }</p>
  </div>`;
}

/** 팝업/전시 일일 요약 이메일. NOTIFY_EMAIL + Gmail 주소 + Google OAuth 클라이언트 필요. */
export async function sendEventsEmail(s: EventsSnapshot): Promise<boolean> {
  if (!config.notify.email) return false;
  if (!isMailConfigured()) {
    log.warn("메일 설정 미완료(GMAIL_ADDRESS / GOOGLE_CLIENT_*) → 이벤트 이메일 건너뜀");
    return false;
  }

  return sendMail({
    subject: `🎈 [팝업·전시·축제] ${s.date} 오늘의 팝업스토어 & 전시 & 축제 정보`,
    html: buildEventsEmailHtml(s),
  });
}
