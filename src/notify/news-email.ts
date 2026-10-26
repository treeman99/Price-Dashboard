import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { isMailConfigured, sendMail } from "./mailer.ts";
import { sendIMessage } from "./imessage.ts";
import { isTabNotifyEnabled } from "../settings/tab-settings.ts";
import { escapeHtml, safeHref } from "./html.ts";
import { articleRow, breakLongRuns, emailDocument, emptyLine, metaLine, sectionHeader, strong, subHeader, textLink } from "./email-kit.ts";
import type { NewsSnapshot, NewsItem, NewsCategory } from "../../shared/types.ts";

/** 뉴스 다이제스트 iMessage 텍스트: 총건수 + 카테고리별 상위 2개 제목. */
export function newsIMessageText(s: NewsSnapshot): string {
  const total = s.categories.reduce((a, c) => a + c.items.length, 0);
  const lines = [`📰 뉴스 다이제스트 — ${s.date} (총 ${total}건)`];
  for (const c of s.categories) {
    if (!c.items.length) continue;
    const titles = c.items.slice(0, 2).map((it) => it.title).join(" / ");
    lines.push(`${c.emoji} ${c.label}(${c.items.length}): ${titles}`);
  }
  return lines.join("\n");
}

/** 뉴스 다이제스트를 본인 iMessage 로 발송. off(전역·탭)/미설정/0건이면 false. 절대 throw 안 함. */
export async function sendNewsIMessage(s: NewsSnapshot): Promise<boolean> {
  if (!isTabNotifyEnabled("news", "imessage")) return false;
  if (!s.categories.some((c) => c.items.length)) return false;
  try {
    await sendIMessage(newsIMessageText(s));
    return true;
  } catch (e) {
    log.warn(`뉴스 iMessage 발송 예외: ${(e as Error).message}`);
    return false;
  }
}

/** 관련 출처 한 줄. 링크가 http(s) 가 아니면 앵커 없이 출처 이름만 남긴다. */
function relatedHtml(item: NewsItem): string {
  if (!item.related.length) return "";
  const links = item.related
    .map((r) => {
      const href = safeHref(r.link);
      return href ? textLink(href, r.label) : escapeHtml(r.label);
    })
    .join(" · ");
  return `관련 출처: ${links}`;
}

function itemRow(item: NewsItem): string {
  const href = safeHref(item.link);
  const links = [href ? textLink(href, "원문 보기") : "", relatedHtml(item)].filter(Boolean).join("&nbsp;&nbsp;·&nbsp;&nbsp;");
  return articleRow({
    title: item.title,
    href,
    meta: metaLine([escapeHtml(item.source), escapeHtml(item.date)]),
    summary: breakLongRuns(escapeHtml(item.summary)),
    after: links || undefined,
  });
}

/** 카테고리 제목 — 이모지는 사용자가 정한 데이터라 화면처럼 그대로 둔다. */
function categoryTitle(cat: NewsCategory): string {
  return `${cat.emoji ? `${escapeHtml(cat.emoji)} ` : ""}${escapeHtml(cat.label)}`;
}

/** 뉴스 다이제스트 이메일 HTML. 순수 함수 — 발송하지 않는다. */
export function buildNewsEmailHtml(s: NewsSnapshot): string {
  // 화면과 같은 순서: 뉴스가 있는 카테고리 먼저, 비어 있는 카테고리는 맨 아래 한 줄씩.
  const filled = s.categories.filter((c) => c.items.length);
  const empty = s.categories.filter((c) => !c.items.length);
  const total = filled.reduce((a, c) => a + c.items.length, 0);

  const sections = filled
    .map(
      (c, i) =>
        sectionHeader({ title: categoryTitle(c), accent: c.color, count: c.items.length, first: i === 0 }) +
        c.items.map(itemRow).join("")
    )
    .join("");
  const emptyBlock = empty.length
    ? subHeader("오늘 뉴스가 없는 카테고리", { count: `${empty.length}개` }) +
      empty.map((c) => emptyLine(`${c.emoji ? `${c.emoji} ` : ""}${c.label} — 오늘은 최신 뉴스가 없습니다`)).join("")
    : "";

  return emailDocument({
    tab: "news",
    title: "뉴스 다이제스트",
    date: s.date,
    meta: metaLine(["최근 24시간 뉴스", `총 ${strong(`${total}건`)}`, `카테고리 ${strong(`${filled.length}개`)}`]),
    body: (sections || emptyLine("오늘은 수록할 뉴스가 없습니다")) + emptyBlock,
  });
}

/** 뉴스 다이제스트 메일 제목. 발송과 미리보기(preview/mail-preview.ts)가 같이 쓴다. */
export function newsSubject(s: NewsSnapshot): string {
  return `📰 Daily News Digest - ${s.date}`;
}

/** 데일리 뉴스 다이제스트 이메일. NOTIFY_EMAIL + Gmail 주소 + Google OAuth 클라이언트 필요. */
export async function sendNewsEmail(s: NewsSnapshot): Promise<boolean> {
  if (!config.notify.email) return false;
  if (!isMailConfigured()) {
    log.warn("메일 설정 미완료(GMAIL_ADDRESS / GOOGLE_CLIENT_*) → 뉴스 이메일 건너뜀");
    return false;
  }
  if (!isTabNotifyEnabled("news", "email")) {
    log.info("뉴스 메일 알림 꺼짐(대시보드 운영 설정) → 건너뜀");
    return false;
  }

  return sendMail({
    subject: newsSubject(s),
    html: buildNewsEmailHtml(s),
  });
}
