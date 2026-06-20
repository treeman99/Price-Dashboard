import nodemailer from "nodemailer";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import type { EventsSnapshot, PopupItem, ExhibitionItem } from "../../shared/types.ts";

function escapeHtml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function tagBadge(tag: PopupItem["tag"]): string {
  if (!tag) return "";
  const color = tag === "신규" ? "#03C75A" : "#FF5A5A";
  return ` <span style="background:${color};color:#fff;border-radius:4px;padding:1px 6px;font-size:11px">${tag}</span>`;
}

function popupCard(p: PopupItem): string {
  const link = p.link
    ? `<a href="${escapeAttr(p.link)}" style="color:#4361ee;text-decoration:none;font-size:13px">🔗 보기</a>`
    : "";
  return `<div style="margin-bottom:10px;padding:12px 14px;background:#f8f9fa;border-radius:8px;border-left:4px solid #7C3AED">
    <h3 style="margin:0 0 4px;font-size:15px;color:#1a1a2e">${escapeHtml(p.name)}${tagBadge(p.tag)}</h3>
    <p style="margin:0 0 4px;color:#666;font-size:13px">📍 ${escapeHtml(p.region)}${p.period ? ` · ${escapeHtml(p.period)}` : ""}</p>
    ${p.summary ? `<p style="margin:0 0 4px;color:#444;font-size:13px">${escapeHtml(p.summary)}</p>` : ""}
    ${link}
  </div>`;
}

function exhCard(e: ExhibitionItem, color: string): string {
  const link = e.link
    ? `<a href="${escapeAttr(e.link)}" style="color:#4361ee;text-decoration:none;font-size:13px">🔗 보기</a>`
    : "";
  return `<div style="margin-bottom:10px;padding:12px 14px;background:#f8f9fa;border-radius:8px;border-left:4px solid ${color}">
    <h3 style="margin:0 0 4px;font-size:15px;color:#1a1a2e">${escapeHtml(e.title)}</h3>
    <p style="margin:0 0 4px;color:#666;font-size:13px">🏛 ${escapeHtml(e.venue)}${e.period ? ` · ${escapeHtml(e.period)}` : ""}</p>
    ${e.summary ? `<p style="margin:0 0 4px;color:#444;font-size:13px">${escapeHtml(e.summary)}</p>` : ""}
    ${link}
  </div>`;
}

/** 팝업/전시 일일 요약 이메일. NOTIFY_EMAIL + Gmail 자격증명 필요. */
export async function sendEventsEmail(s: EventsSnapshot): Promise<boolean> {
  if (!config.notify.email) return false;
  if (!config.notify.gmailAddress || !config.notify.gmailAppPassword) {
    log.warn("이메일 자격증명 미설정 → 이벤트 이메일 건너뜀");
    return false;
  }

  const popupHtml = s.popups.length
    ? s.popups.map(popupCard).join("")
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

  const generalHtml = s.exhibitions.general.length
    ? s.exhibitions.general.map((e) => exhCard(e, "#2E86DE")).join("")
    : `<p style="color:#999">확인된 일반 전시가 없습니다.</p>`;

  const html = `<div style="font-family:'Apple SD Gothic Neo',sans-serif;max-width:680px;margin:0 auto;padding:16px">
    <h1 style="color:#7C3AED;border-bottom:3px solid #7C3AED;padding-bottom:8px">🎈 오늘의 팝업 · 전시</h1>
    <p style="color:#666">${s.date} · 대시보드: <a href="http://localhost:${config.port}">localhost:${config.port}</a></p>

    <h2 style="color:#7C3AED;margin-top:28px;border-bottom:2px solid #eee;padding-bottom:6px">🛍 팝업스토어</h2>
    ${popupHtml}

    <h2 style="color:#FF8C00;margin-top:32px;border-bottom:2px solid #eee;padding-bottom:6px">🏛 주요 전시장 (코엑스·세텍·킨텍스·수원)</h2>
    ${venueHtml}

    <h2 style="color:#2E86DE;margin-top:32px;border-bottom:2px solid #eee;padding-bottom:6px">🖼 서울·경기 전시</h2>
    ${generalHtml}

    <hr style="margin-top:32px;border:none;border-top:1px solid #eee">
    <p style="color:#aaa;font-size:11px;text-align:center">정보는 수집 시점 기준이며 변동될 수 있습니다 · Daily Dashboard${
      s.source === "naver-raw" ? " (검색 원본)" : ""
    }</p>
  </div>`;

  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: config.notify.gmailAddress, pass: config.notify.gmailAppPassword },
  });
  await transport.sendMail({
    from: config.notify.gmailAddress,
    to: config.notify.gmailAddress,
    subject: `🎈 [팝업·전시] ${s.date} 오늘의 팝업스토어 & 전시 정보`,
    html,
  });
  log.info("이벤트 이메일 발송 완료");
  return true;
}
