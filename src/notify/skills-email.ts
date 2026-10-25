import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { isMailConfigured, sendMail } from "./mailer.ts";
import { sendIMessage } from "./imessage.ts";
import { isTabNotifyEnabled } from "../settings/tab-settings.ts";
import { escapeHtml, escapeAttr, safeHref } from "./html.ts";
import { SKILLS_CYCLE_LABEL } from "../../shared/skills.ts";
import type { SkillRankEntry, SkillsSnapshot } from "../../shared/skills.ts";

/**
 * 스킬 랭킹 주간 알림(이메일 + iMessage). `src/notify/news-email.ts` 를 본떴다.
 *
 * ── 이 파일의 규칙 ───────────────────────────────────────────────────────────
 * 1. 숫자는 **스냅샷에 들어 있는 값만** 쓴다. 여기서 계산하거나 반올림해 만들어내지 않는다
 *    (star 는 GitHub 실측, 증가분은 DB 차분 — 둘 다 이미 확정된 값이다).
 * 2. 증가분 라벨은 SkillWindow.days 를 **그대로 인용**한다. "최근 7일간"이라고 적어 두고 실제로는
 *    14일치를 보여주는 쪽이 값을 숨기는 것보다 훨씬 나쁘다(shared/skills.ts 머리말).
 * 3. 첫 회차(window === null)에는 증가 섹션을 **통째로 생략**한다. 비교 대상이 없는데 빈 표를
 *    보내면 "이번 주엔 아무것도 안 늘었다"로 읽힌다.
 */

/** 알림에 싣는 각 랭킹의 길이. 메일 한 통이 스크롤 지옥이 되지 않는 선. */
export const SKILLS_EMAIL_TOP = 10;

/** 화면·메일 공통 천단위 표기. */
function n(v: number): string {
  return v.toLocaleString("ko-KR");
}

/** "+1,204" / "-3". 부호를 항상 붙여 증감임을 드러낸다. */
function signed(v: number): string {
  return `${v >= 0 ? "+" : "-"}${n(Math.abs(v))}`;
}

/** 증가 구간 라벨. window 가 없으면 호출되지 않는다(호출부에서 섹션째 생략). */
export function windowLabel(days: number): string {
  return `최근 ${days}일간`;
}

/** 순위 변동 배지 문구. 직전 순위가 없으면 NEW. */
export function rankDeltaLabel(rank: number, prevRank: number | null): string {
  if (prevRank === null) return "NEW";
  const diff = prevRank - rank;
  if (diff === 0) return "―";
  return diff > 0 ? `▲${diff}` : `▼${Math.abs(diff)}`;
}

// ── iMessage ────────────────────────────────────────────

/**
 * iMessage 본문: 총합 TOP 5 + 증가 TOP 5.
 *
 * 메일과 달리 5개씩만 싣는다 — 문자는 한 화면에 들어와야 읽힌다. 링크도 넣지 않는다
 * (10개의 github.com URL 이 본문의 대부분을 차지한다).
 */
export function skillsIMessageText(s: SkillsSnapshot): string {
  const lines: string[] = [`🧩 스킬 랭킹 — ${s.date}`];

  if (s.byStars.length) {
    lines.push("", `⭐ star 총합 TOP 5`);
    for (const e of s.byStars.slice(0, 5)) {
      lines.push(`${e.rank}. ${e.repo.fullName} (${n(e.repo.stars)})`);
    }
  }

  if (s.window && s.byGrowth.length) {
    lines.push("", `📈 ${windowLabel(s.window.days)} 증가 TOP 5`);
    for (const e of s.byGrowth.slice(0, 5)) {
      lines.push(`${e.rank}. ${e.repo.fullName} (${signed(e.starsGained ?? 0)})`);
    }
  }

  return lines.join("\n");
}

/** 스킬 랭킹을 본인 iMessage 로 발송. off(전역·탭)/미설정/0건이면 false. 절대 throw 안 함. */
export async function sendSkillsIMessage(s: SkillsSnapshot): Promise<boolean> {
  if (!isTabNotifyEnabled("skills", "imessage")) return false;
  if (!s.byStars.length) return false;
  try {
    await sendIMessage(skillsIMessageText(s));
    return true;
  } catch (e) {
    log.warn(`스킬 iMessage 발송 예외: ${(e as Error).message}`);
    return false;
  }
}

// ── 이메일 ──────────────────────────────────────────────

/** 저장소 한 줄. 요약이 없으면 원문 description 으로 폴백한다(둘 다 없으면 안내 문구). */
function entryRow(e: SkillRankEntry, metric: string): string {
  const repo = e.repo;
  const href = safeHref(repo.url);
  const title = href
    ? `<a href="${escapeAttr(href)}" style="color:#1a1a2e;text-decoration:none;">${escapeHtml(repo.fullName)}</a>`
    : escapeHtml(repo.fullName);
  const desc = repo.summary ?? repo.description ?? "설명이 없는 저장소입니다.";
  const badges: string[] = [];
  if (repo.language) badges.push(escapeHtml(repo.language));
  if (repo.license) badges.push(escapeHtml(repo.license));
  if (repo.archived) badges.push("보관됨");
  const meta = badges.length
    ? `<span style="color:#999;font-size:12px;">${badges.join(" · ")}</span>`
    : "";

  return `<tr>
  <td style="padding:10px 8px;border-bottom:1px solid #eee;vertical-align:top;width:36px;color:#888;font-size:13px;">${e.rank}</td>
  <td style="padding:10px 8px;border-bottom:1px solid #eee;vertical-align:top;">
    <div style="font-weight:600;font-size:14px;">${title} <span style="color:#b0b0b0;font-size:11px;font-weight:400;">${escapeHtml(rankDeltaLabel(e.rank, e.prevRank))}</span></div>
    <div style="color:#444;font-size:13px;line-height:1.5;margin-top:4px;">${escapeHtml(desc)}</div>
    ${meta}
  </td>
  <td style="padding:10px 8px;border-bottom:1px solid #eee;vertical-align:top;text-align:right;white-space:nowrap;font-size:13px;color:#1a1a2e;">${escapeHtml(metric)}</td>
</tr>`;
}

function tableHtml(rows: string): string {
  return `<table style="width:100%;border-collapse:collapse;margin-top:8px;">${rows}</table>`;
}

/**
 * 스킬 랭킹 이메일 HTML. 순수 함수 — 발송하지 않는다.
 *
 * 증가 섹션은 window 가 있을 때만 그린다. 그 대신 첫 회차에는 "왜 없는지"를 한 줄로 설명한다 —
 * 설명 없이 섹션만 사라지면 사용자는 기능이 고장 난 줄 안다.
 */
export function buildSkillsEmailHtml(s: SkillsSnapshot): string {
  const starRows = s.byStars
    .slice(0, SKILLS_EMAIL_TOP)
    .map((e) => entryRow(e, `⭐ ${n(e.repo.stars)}`))
    .join("");

  let growthSection: string;
  if (s.window && s.byGrowth.length) {
    const label = windowLabel(s.window.days);
    const rows = s.byGrowth
      .slice(0, SKILLS_EMAIL_TOP)
      .map((e) => entryRow(e, `${label} ${signed(e.starsGained ?? 0)}`))
      .join("");
    growthSection = `<h2 style="color:#e07a5f;margin-top:36px;border-bottom:2px solid #e07a5f;padding-bottom:8px;">📈 ${escapeHtml(label)} 증가 TOP ${Math.min(SKILLS_EMAIL_TOP, s.byGrowth.length)}</h2>
  <p style="color:#888;font-size:12px;margin:6px 0 0 0;">비교 구간: ${escapeHtml(s.window.fromDate)} → ${escapeHtml(s.window.toDate)} (${s.window.days}일)</p>
  ${tableHtml(rows)}`;
  } else {
    growthSection = `<h2 style="color:#e07a5f;margin-top:36px;border-bottom:2px solid #e07a5f;padding-bottom:8px;">📈 주간 증가</h2>
  <p style="color:#666;font-size:13px;line-height:1.6;">비교할 지난 스냅샷이 없어 이번 회차에는 증가 랭킹이 없습니다. GitHub 이 과거 star 수를 제공하지 않아, 증가분은 매주 쌓는 스냅샷을 직접 차분해야만 구할 수 있습니다 — 다음 회차부터 채워집니다.</p>`;
  }

  const notes = s.notes
    ? `<p style="color:#888;font-size:12px;line-height:1.6;margin-top:24px;">${escapeHtml(s.notes)}</p>`
    : "";

  return `<html><body style="font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:700px;margin:0 auto;padding:20px;background-color:#ffffff;">
  <h1 style="color:#1a1a2e;border-bottom:3px solid #4361ee;padding-bottom:10px;">🧩 스킬 랭킹</h1>
  <p style="color:#666;margin-bottom:4px;">${escapeHtml(s.date)} | 매주 ${escapeHtml(SKILLS_CYCLE_LABEL)} 갱신 | 추적 ${n(s.trackedCount)}개 저장소</p>
  <p style="color:#888;font-size:13px;margin-bottom:24px;">출처: GitHub 검색 API (topic 기반) · 숫자는 전부 API 실측값이며 설명만 AI 요약입니다.</p>

  <h2 style="color:#4361ee;margin-top:28px;border-bottom:2px solid #4361ee;padding-bottom:8px;">⭐ star 총합 TOP ${Math.min(SKILLS_EMAIL_TOP, s.byStars.length)}</h2>
  ${tableHtml(starRows)}

  ${growthSection}
  ${notes}
  <hr style="margin-top:40px;border:none;border-top:1px solid #eee;">
  <p style="color:#999;font-size:11px;text-align:center;">Generated by Claude · Daily Dashboard | <a href="http://localhost:${config.port}">localhost:${config.port}</a></p>
</body></html>`;
}

/** 주간 스킬 랭킹 이메일. NOTIFY_EMAIL + Gmail 주소 + Google OAuth 클라이언트 필요. */
export async function sendSkillsEmail(s: SkillsSnapshot): Promise<boolean> {
  if (!config.notify.email) return false;
  if (!s.byStars.length) return false;
  if (!isMailConfigured()) {
    log.warn("메일 설정 미완료(GMAIL_ADDRESS / GOOGLE_CLIENT_*) → 스킬 이메일 건너뜀");
    return false;
  }
  if (!isTabNotifyEnabled("skills", "email")) {
    log.info("스킬 메일 알림 꺼짐(대시보드 운영 설정) → 건너뜀");
    return false;
  }

  return sendMail({
    subject: `🧩 스킬 랭킹 - ${s.date}`,
    html: buildSkillsEmailHtml(s),
  });
}
