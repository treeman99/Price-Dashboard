import nodemailer from "nodemailer";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { getHistory } from "../db/repo.ts";
import { localDateDaysAgo } from "../util/date.ts";
import { renderPriceChartPng } from "./chart.ts";
import type { ProductSummary } from "../../shared/types.ts";

const GREEN = "#2ecc71"; // 하락
const RED = "#e74c3c"; // 상승

function won(n: number | null): string {
  return n == null ? "-" : `${n.toLocaleString()}원`;
}

function changeBadge(c: ProductSummary["change"]): string {
  if (c.amount == null || c.direction === "flat")
    return `<span style="color:#888">- 변동없음</span>`;
  const color = c.direction === "down" ? GREEN : RED;
  const arrow = c.direction === "down" ? "▼" : "▲";
  const pct = c.percent != null ? ` (${c.percent.toFixed(1)}%)` : "";
  return `<span style="color:${color};font-weight:600">${arrow} ${Math.abs(c.amount).toLocaleString()}원${pct}</span>`;
}

function priceCell(price: number, link: string | null): string {
  return link
    ? `<a href="${escapeAttr(link)}" style="color:#1a73e8;text-decoration:none">${won(price)}</a>`
    : won(price);
}

function renderProduct(s: ProductSummary, chartCid: string): string {
  // 종합 최저가는 가능하면 1위 리스팅 링크로 연결
  const cheapestLink = s.topListings[0]?.link ?? null;
  const overall = s.latest?.overallLowest ?? null;
  const overallHtml =
    overall != null && cheapestLink
      ? `<a href="${escapeAttr(cheapestLink)}" style="color:#1a73e8;text-decoration:none"><b>${won(overall)}</b></a>`
      : `<b>${won(overall)}</b>`;

  const top3 = s.topListings
    .map(
      (l) =>
        `<li>${l.rank}. ${
          l.link ? `<a href="${escapeAttr(l.link)}" style="color:#1a73e8;text-decoration:none">${escapeHtml(l.mall)}</a>` : escapeHtml(l.mall)
        } — ${priceCell(l.price, l.link)}</li>`
    )
    .join("");
  const reviews = s.reviews
    .slice(0, 3)
    .map(
      (r) =>
        `<li><b>${escapeHtml(r.source)}</b>${r.rating != null ? ` ⭐${r.rating}` : ""}${
          r.date ? ` (${escapeHtml(r.date)})` : ""
        }<br>${
          r.link
            ? `<a href="${escapeAttr(r.link)}" style="color:#1a73e8;text-decoration:none">${escapeHtml(r.summary)}</a>`
            : escapeHtml(r.summary)
        }</li>`
    )
    .join("");

  return `
  <div style="border:1px solid #eee;border-radius:10px;padding:16px;margin:12px 0">
    <h3 style="margin:0 0 8px">${escapeHtml(s.product.name)}</h3>
    <table style="border-collapse:collapse;font-size:14px">
      <tr><td style="padding:2px 12px 2px 0;color:#666">종합 최저가</td><td>${overallHtml}${
        s.latest?.lowestSource ? ` <span style="color:#888">(${escapeHtml(s.latest.lowestSource)})</span>` : ""
      }</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666">쿠팡 최저가</td><td>${won(s.latest?.coupangLowest ?? null)}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666">평균가</td><td>${won(s.latest?.avgPrice ?? null)}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666">전일 대비</td><td>${changeBadge(s.change)}</td></tr>
    </table>
    <div style="margin-top:10px"><img src="cid:${chartCid}" alt="가격 추이 차트" width="540" style="max-width:100%;border:1px solid #f0f0f0;border-radius:8px"/></div>
    ${top3 ? `<div style="margin-top:8px"><b style="font-size:13px">Top3 최저가</b><ul style="margin:4px 0">${top3}</ul></div>` : ""}
    ${reviews ? `<div style="margin-top:8px"><b style="font-size:13px">리뷰</b><ul style="margin:4px 0;color:#444">${reviews}</ul></div>` : ""}
  </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

/**
 * 이메일 리포트 발송. 발송 성공 시 true.
 * 자격증명 미설정 시 경고 후 false(수집 자체는 계속 진행).
 */
export async function sendEmailReport(
  summaries: ProductSummary[],
  today: string
): Promise<boolean> {
  if (!config.notify.email) return false;
  if (!config.notify.gmailAddress || !config.notify.gmailAppPassword) {
    log.warn("이메일 자격증명 미설정 → 이메일 발송 건너뜀");
    return false;
  }

  const subject = `[가격 추적] 관심 물건 최저가 리포트 - ${today}`;
  const since = localDateDaysAgo(30);

  // 상품별 차트 PNG 생성 → CID 인라인 첨부
  const attachments: { filename: string; content: Buffer; cid: string }[] = [];
  const body = summaries
    .map((s) => {
      const cid = `chart_${s.product.id}@dailyprice`;
      const points = getHistory(s.product.id, since);
      try {
        attachments.push({
          filename: `chart_${s.product.id}.png`,
          content: renderPriceChartPng(points, `${s.product.name} 가격 추이 (최근 30일)`),
          cid,
        });
      } catch (e) {
        log.warn(`차트 생성 실패 [${s.product.name}]: ${(e as Error).message}`);
      }
      return renderProduct(s, cid);
    })
    .join("");

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;max-width:680px;margin:0 auto">
    <h2>📷 관심 물건 최저가 리포트 <span style="color:#888;font-size:14px">${today}</span></h2>
    <p style="color:#666;font-size:13px">대시보드: <a href="http://localhost:${config.port}">http://localhost:${config.port}</a></p>
    ${body}
    <p style="color:#aaa;font-size:12px;margin-top:16px">Daily Price Dashboard · 로컬 자동 수집</p>
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
    subject,
    html,
    attachments,
  });
  log.info(`이메일 리포트 발송 완료 (차트 ${attachments.length}개 포함)`);
  return true;
}
