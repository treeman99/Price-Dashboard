import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { isMailConfigured, sendMail } from "./mailer.ts";
import { sendIMessage } from "./imessage.ts";
import { isTabNotifyEnabled } from "../settings/tab-settings.ts";
import { escapeHtml, escapeAttr, safeHref } from "./html.ts";
import {
  FONT,
  INK,
  MUTED,
  TNUM,
  TONE,
  cellNote,
  dataTable,
  emailDocument,
  emptyLine,
  metaLine,
  notice,
  onPaper,
  sectionHeader,
  statusTag,
  strong,
  type Column,
} from "./email-kit.ts";
import { getSchedule } from "../scheduler/schedule-store.ts";
import { describeSchedule } from "../../shared/schedule.ts";
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

/** 순위 변동 글씨 — 화면 RankDelta 와 같은 색: NEW 정보색, ▲ 성공색, ▼ 흐린 잉크, 변동 없음은 더 흐리게. */
function rankDeltaHtml(rank: number, prevRank: number | null): string {
  const label = rankDeltaLabel(rank, prevRank);
  const color =
    prevRank === null ? TONE.info : prevRank > rank ? TONE.success : prevRank < rank ? MUTED : onPaper(MUTED, 0.5);
  return `<span style="font-family:${FONT.mono};font-size:11px;font-weight:600;color:${color};${TNUM}">${escapeHtml(label)}</span>`;
}

/**
 * 저장소 칸: owner/ 회색 + name 굵게(원문 링크) → 설명 → 언어·라이선스.
 * 이름은 fullName 을 그대로 나눠 쓴다(owner·name 필드와 어긋나도 보이는 값은 하나). 영문 긴 이름은 칸 안에서 끊는다.
 */
function repoCell(e: SkillRankEntry): string {
  const repo = e.repo;
  const href = safeHref(repo.url);
  const cut = repo.fullName.indexOf("/") + 1;
  const name =
    `<span style="color:${MUTED}">${escapeHtml(repo.fullName.slice(0, cut))}</span>` +
    `<span style="font-weight:600">${escapeHtml(repo.fullName.slice(cut))}</span>`;
  const title = href
    ? `<a href="${escapeAttr(href)}" style="color:${INK};text-decoration:none;word-break:break-all">${name}</a>`
    : `<span style="word-break:break-all">${name}</span>`;
  // 별은 많은데 관리가 끊긴 저장소를 숨기지 않는다.
  const archived = repo.archived ? ` ${statusTag("보관됨", "warn")}` : "";
  // 요약이 없으면 원문 description 으로 폴백한다(둘 다 없으면 안내 문구) — 목록이 비면 안 된다.
  const desc = repo.summary ?? repo.description ?? "설명이 없는 저장소입니다.";
  const badges = metaLine([repo.language && escapeHtml(repo.language), repo.license && escapeHtml(repo.license)]);
  return (
    `<span style="font-size:15px">${title}</span>${archived}` +
    cellNote(`<span style="white-space:pre-line">${escapeHtml(desc)}</span>`) +
    (badges ? cellNote(badges) : "")
  );
}

/** 증가 칸. 급상승 순위에서는 성공색 굵게(화면과 같음), 총합 순위에서는 참고값이라 흐리게. */
function gainedHtml(v: number | null, emphasize: boolean): string {
  if (v === null) return `<span style="color:${onPaper(MUTED, 0.5)}">—</span>`;
  const style = emphasize && v > 0 ? `color:${TONE.success};font-weight:600` : `color:${MUTED}`;
  return `<span style="${style}">${signed(v)}</span>`;
}

/**
 * 랭킹 표: 순위 | 저장소 | star | 증가. 증가값이 하나도 없으면(첫 회차 총합) 증가 열을 만들지 않는다 —
 * 한 줄도 값이 없는 열은 대시만 늘어선다.
 */
function rankTable(entries: SkillRankEntry[], growth: boolean): string {
  const withGain = entries.some((e) => e.starsGained !== null);
  const columns: Column[] = [
    { label: "순위", align: "right", width: "44px" },
    { label: "저장소" },
    { label: "star", align: "right" },
    ...(withGain ? [{ label: "증가", align: "right" as const }] : []),
  ];
  const rows = entries.map((e) => [
    `<span style="font-family:${FONT.mono};font-size:15px;font-weight:600">${e.rank}</span>` +
      cellNote(rankDeltaHtml(e.rank, e.prevRank)),
    repoCell(e),
    `<span style="font-weight:600">${n(e.repo.stars)}</span>`,
    ...(withGain ? [gainedHtml(e.starsGained, growth)] : []),
  ]);
  return dataTable(columns, rows);
}

/**
 * 머리줄의 갱신 주기 문구. 정본은 스케줄(getSchedule().skills, 대시보드에서 요일·주기·시각 변경 가능)이다 —
 * 예전 상수(SKILLS_CYCLE_LABEL "월요일 09:00")는 사용자가 회차를 바꾸면 거짓말이 된다.
 * 예: "매주 월요일 09:00 갱신" / "격주 월요일 09:00 갱신" / "매월 1일 09:00 갱신" / "자동 갱신 꺼짐".
 */
export function skillsCycleLabel(): string {
  const job = getSchedule().skills;
  return job.enabled ? `${describeSchedule(job)} 갱신` : "자동 갱신 꺼짐";
}

/**
 * 스킬 랭킹 이메일 HTML. 순수 함수 — 발송하지 않는다.
 *
 * 증가 섹션은 window 가 있을 때만 표를 그린다. 그 대신 첫 회차에는 "왜 없는지"를 한 줄로 설명한다 —
 * 설명 없이 섹션만 사라지면 사용자는 기능이 고장 난 줄 안다.
 */
export function buildSkillsEmailHtml(s: SkillsSnapshot, cycleLabel: string = skillsCycleLabel()): string {
  const interim = !!s.interim;
  const stars = s.byStars.slice(0, SKILLS_EMAIL_TOP);
  // 총합 표의 증가 열도 같은 구간 값이라, 구간을 숨기지 않도록 머리 메모에 함께 적는다.
  const starNote = metaLine([
    escapeHtml(`기준 ${s.date} ${interim ? "중간 점검" : "스냅샷"}`),
    s.window && escapeHtml(`증가는 ${windowLabel(s.window.days)}`),
  ]);
  const starSection =
    sectionHeader({ title: "star 총합 순위", count: stars.length, note: starNote, first: true }) +
    (stars.length ? rankTable(stars, false) : emptyLine("표시할 저장소가 없습니다."));

  let growthSection: string;
  if (s.window && s.byGrowth.length) {
    const w = s.window;
    // 구간 라벨은 days 를 그대로 인용한다. 중간 점검이면 끝점이 저장된 스냅샷이 아니라 지금 값이라 그렇게 적는다.
    const range = interim ? `${w.fromDate} 스냅샷 → ${w.toDate} 중간 점검` : `${w.fromDate} → ${w.toDate}`;
    const growth = s.byGrowth.slice(0, SKILLS_EMAIL_TOP);
    growthSection =
      sectionHeader({
        title: "급상승 순위",
        count: growth.length,
        note: metaLine([escapeHtml(`${windowLabel(w.days)} 증가`), escapeHtml(`비교 구간 ${range} (${w.days}일)`)]),
      }) + rankTable(growth, true);
  } else {
    // 회차 주기는 사용자가 바꿀 수 있어(격주·매월) '주간'으로 못 박지 않는다.
    growthSection =
      sectionHeader({ title: "급상승 순위" }) +
      emptyLine(
        "비교할 지난 스냅샷이 없어 이번 회차에는 증가 랭킹이 없습니다. GitHub 이 과거 star 수를 제공하지 않아, 증가분은 회차마다 쌓는 스냅샷을 직접 차분해야만 구할 수 있습니다 — 다음 회차부터 채워집니다."
      );
  }

  // 수집이 실패하면 지난 회차 스냅샷이 그대로 남는다 — notes 는 그 사실을 적어 둔 유일한 자리라 맨 위에 띄운다(화면과 같음).
  const notes = s.notes ? notice(`<span style="white-space:pre-line">${escapeHtml(s.notes)}</span>`, "warn") : "";

  return emailDocument({
    tab: "skills",
    title: "스킬 랭킹",
    date: s.date,
    meta: metaLine([escapeHtml(cycleLabel), `추적 저장소 ${strong(`${n(s.trackedCount)}개`)}`, interim && "중간 점검"]),
    body: notes + starSection + growthSection,
    footnote: "출처: GitHub 검색 API (topic 기반) · 숫자는 전부 API 실측값이며 설명만 AI 요약입니다.",
  });
}

/** 스킬 랭킹 메일 제목. 발송과 미리보기(preview/mail-preview.ts)가 같이 쓴다. */
export function skillsSubject(s: SkillsSnapshot): string {
  return `🧩 스킬 랭킹 - ${s.date}`;
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
    subject: skillsSubject(s),
    html: buildSkillsEmailHtml(s),
  });
}
