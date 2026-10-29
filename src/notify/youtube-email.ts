import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { isMailConfigured, sendMail } from "./mailer.ts";
import { sendIMessage } from "./imessage.ts";
import { isTabNotifyEnabled } from "../settings/tab-settings.ts";
import { escapeHtml, escapeAttr, safeHref } from "./html.ts";
import {
  HAIRLINE,
  INK,
  INK_80,
  MUTED,
  SUNKEN,
  TNUM,
  articleRow,
  breakLongRuns,
  emailDocument,
  emptyLine,
  metaLine,
  sectionHeader,
  strong,
  subHeader,
  textLink,
} from "./email-kit.ts";
import type { YoutubeSnapshot, YoutubeVideo, YoutubeCategory } from "../../shared/types.ts";

/** 유튜브 소식 iMessage 텍스트: 총건수 + 카테고리별 상위 2개 제목. */
export function youtubeIMessageText(s: YoutubeSnapshot): string {
  const total = s.categories.reduce((a, c) => a + c.items.length, 0);
  const lines = [`📺 유튜브 소식 — ${s.date} (총 ${total}건)`];
  for (const c of s.categories) {
    if (!c.items.length) continue;
    const titles = c.items.slice(0, 2).map((v) => v.title).join(" / ");
    lines.push(`${c.emoji} ${c.label}(${c.items.length}): ${titles}`);
  }
  return lines.join("\n");
}

/** 유튜브 소식을 본인 iMessage 로 발송. off(전역·탭)/미설정/0건이면 false. 절대 throw 안 함. */
export async function sendYoutubeIMessage(s: YoutubeSnapshot): Promise<boolean> {
  if (!isTabNotifyEnabled("youtube", "imessage")) return false;
  if (!s.categories.some((c) => c.items.length)) return false;
  try {
    await sendIMessage(youtubeIMessageText(s));
    return true;
  } catch (e) {
    log.warn(`유튜브 iMessage 발송 예외: ${(e as Error).message}`);
    return false;
  }
}

/** 채널 · 핸들 · 게시일 · 조회수 · 길이. 아이콘 대신 가운데점으로만 나눈다(화면 행 메타와 같은 순서). */
function videoMeta(v: YoutubeVideo): string {
  const text = (s: string) => breakLongRuns(escapeHtml(s));
  return metaLine([
    text(v.channel),
    v.channelHandle && text(v.channelHandle),
    text(v.date),
    v.views && text(v.views),
    v.duration && text(v.duration),
  ]);
}

/** 썸네일 폭. 화면 좁은 폭(w-36)과 같은 144px — 390px 에서도 글 칸이 200px 남는다. */
const THUMB_W = 144;
/** 썸네일 높이. curate.ts thumbFor() 가 늘 hqdefault(480×360, 4:3)를 주므로 144px 폭이면 108px. */
const THUMB_H = 108;

/**
 * 영상 한 행 — 화면 VideoRow 처럼 카드 없이 [썸네일 | 제목·메타·요약·영상 보기] 두 칸, 아래 헤어라인.
 * 썸네일이 없으면 기사형 행(articleRow) 그대로 쓴다.
 */
function videoRow(v: YoutubeVideo): string {
  // url·thumbnail 모두 LLM 이 만들어 온 값이라 http(s) 가 아니면 링크/이미지를 버린다.
  const href = safeHref(v.url);
  const thumbSrc = safeHref(v.thumbnail);
  const row = {
    title: v.title,
    href,
    meta: videoMeta(v),
    summary: breakLongRuns(escapeHtml(v.summary)),
    after: href ? textLink(href, "영상 보기") : undefined,
  };
  if (!thumbSrc) return articleRow(row);

  // height 속성은 로드 전 자리(144×108) 잡기용 — 없으면 깨진 썸네일이 144×144 정사각형이 돼 행이 늘어난다(10-29 +554px).
  // 속성 비율은 alt 가 비어 있을 때만 깨진 상자에 먹으므로, 증시 차트(9f73ddb)처럼 높이 고정 div 로 모든 상태를 108px 에 가둔다.
  // 폭은 고정하지 않는다: width:144px 를 주면 ≤414px 에서 썸네일 칸이 줄지 못해 가로로 넘친다
  // (data/gmail-jump-investigation/round3/report-A-coldload.md §5).
  const img = `<img src="${escapeAttr(thumbSrc)}" alt="" width="${THUMB_W}" height="${THUMB_H}" style="display:block;width:${THUMB_W}px;max-width:100%;height:auto;border:0;border-radius:3px;background:${SUNKEN}" />`;
  const link = href ? `<a href="${escapeAttr(href)}" style="display:block;text-decoration:none">${img}</a>` : img;
  const thumb = `<div style="height:${THUMB_H}px;overflow:hidden">${link}</div>`;
  // 제목은 표 칸 안이라 긴 덩어리(URL 등)가 그대로 남으면 칸 최소 폭이 돼 표 전체를 민다(600px 에서 +354px).
  const text = breakLongRuns(escapeHtml(v.title));
  const title = href ? `<a href="${escapeAttr(href)}" style="color:${INK};text-decoration:none">${text}</a>` : text;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-bottom:1px solid ${HAIRLINE}"><tr>
<td valign="top" width="${THUMB_W}" style="width:${THUMB_W}px;padding:14px 14px 14px 0;vertical-align:top">${thumb}</td>
<td valign="top" style="padding:14px 0;vertical-align:top">
<p style="margin:0;font-size:15px;font-weight:600;line-height:1.45;color:${INK}">${title}</p>
<p style="margin:4px 0 0;font-size:12.5px;color:${MUTED};${TNUM}">${row.meta}</p>
${row.summary ? `<p style="margin:8px 0 0;font-size:14px;line-height:1.65;color:${INK_80}">${row.summary}</p>` : ""}
${row.after ? `<p style="margin:8px 0 0;font-size:12.5px;color:${MUTED}">${row.after}</p>` : ""}
</td></tr></table>`;
}

/** 카테고리 제목 — 이모지는 사용자가 정한 데이터라 화면처럼 그대로 둔다. */
function categoryTitle(cat: YoutubeCategory): string {
  return `${cat.emoji ? `${escapeHtml(cat.emoji)} ` : ""}${breakLongRuns(escapeHtml(cat.label))}`;
}

/** 유튜브 소식 이메일 HTML. 순수 함수 — 발송하지 않는다. */
export function buildYoutubeEmailHtml(s: YoutubeSnapshot): string {
  // 뉴스 메일과 같은 순서: 영상이 있는 카테고리 먼저, 비어 있는 카테고리는 맨 아래 한 줄씩.
  const filled = s.categories.filter((c) => c.items.length);
  const empty = s.categories.filter((c) => !c.items.length);
  const total = filled.reduce((a, c) => a + c.items.length, 0);

  const sections = filled
    .map(
      (c, i) =>
        sectionHeader({ title: categoryTitle(c), accent: c.color, count: c.items.length, first: i === 0 }) +
        c.items.map(videoRow).join("")
    )
    .join("");
  const emptyBlock = empty.length
    ? subHeader("최근 새 영상이 없는 카테고리", { count: `${empty.length}개` }) +
      empty.map((c) => emptyLine(`${c.emoji ? `${c.emoji} ` : ""}${c.label} — 최근 새 영상이 없습니다`)).join("")
    : "";

  return emailDocument({
    tab: "youtube",
    title: "유튜브 소식",
    date: s.date,
    meta: metaLine([`최근 ${s.freshDays}일 이내 영상`, `총 ${strong(`${total}건`)}`, `카테고리 ${strong(`${filled.length}개`)}`]),
    body: (sections || emptyLine("수록할 새 영상이 없습니다")) + emptyBlock,
    footnote: "출처: YouTube (WebSearch/WebFetch 큐레이션)",
  });
}

/** 유튜브 소식 메일 제목. 발송과 미리보기(preview/mail-preview.ts)가 같이 쓴다. */
export function youtubeSubject(s: YoutubeSnapshot): string {
  return `▶ YouTube 소식 - ${s.date}`;
}

/** 유튜브 소식 다이제스트 이메일. NOTIFY_EMAIL + Gmail 주소 + Google OAuth 클라이언트 필요. */
export async function sendYoutubeEmail(s: YoutubeSnapshot): Promise<boolean> {
  if (!config.notify.email) return false;
  if (!isMailConfigured()) {
    log.warn("메일 설정 미완료(GMAIL_ADDRESS / GOOGLE_CLIENT_*) → 유튜브 이메일 건너뜀");
    return false;
  }
  if (!isTabNotifyEnabled("youtube", "email")) {
    log.info("유튜브 메일 알림 꺼짐(대시보드 운영 설정) → 건너뜀");
    return false;
  }

  return sendMail({
    subject: youtubeSubject(s),
    html: buildYoutubeEmailHtml(s),
  });
}
