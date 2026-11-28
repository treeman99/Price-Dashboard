/**
 * 세 모델 통합 보고서 — 메일·문자 발송(price 서버 전용, 수집기 번들에는 들어가지 않는다).
 *
 * - 메일 = 보고서 전문(HTML). 문자 = 핵심 요약 + 모델별 상태 + 대시보드 링크.
 * - 켜기/끄기: 대시보드 '보고서' 탭 스위치(report.notifyEmail / report.notifyImessage, 기본 꺼짐) AND .env 전역
 *   스위치(NOTIFY_EMAIL / NOTIFY_IMESSAGE)·자격. 증시·팝업/전시·스킬·펄스·가동 중단 알림은 보내지 않는다.
 * - 실제 발송기(sendMail·sendIMessage)는 주입할 수 있다 — 테스트는 모의 발송기만 쓴다(실제 메시지 금지).
 */
import { config } from "../config.ts";
import { formatWindowKst, kstShort as kstClock } from "../util/recency.ts";
import { log } from "../util/log.ts";
import { getTabSettings } from "../settings/tab-settings.ts";
import { getGoogleAuthStatus } from "../notify/google-auth.ts";
import { sendMail } from "../notify/mailer.ts";
import { sendIMessage } from "../notify/imessage.ts";
import { escapeHtml, safeHref } from "../notify/html.ts";
import {
  articleRow,
  breakLongRuns,
  dataTable,
  emailDocument,
  emptyLine,
  metaLine,
  notice,
  sectionHeader,
  statusTag,
  strong,
  subHeader,
  textLink,
  type TagTone,
} from "../notify/email-kit.ts";
import {
  DAILY_REPORT_OUTCOME_LABEL,
  type DailyReportChannelState,
  type DailyReportEntry,
  type DailyReportJson,
  type DailyReportModelOutcome,
} from "../../shared/report.ts";

export type ReportChannel = "email" | "imessage";

/** 보고서 탭 스위치 + 전역 자격으로 본 채널 상태. 비밀값·주소는 싣지 않는다. */
export function reportChannels(): Record<ReportChannel, DailyReportChannelState> {
  const s = getTabSettings().report;
  const auth = getGoogleAuthStatus();
  const emailProblem = !config.notify.email
    ? ".env 의 NOTIFY_EMAIL 이 꺼져 있습니다."
    : !config.notify.gmailAddress
      ? ".env 의 GMAIL_ADDRESS 가 비어 있습니다."
      : !auth.configured
        ? ".env 의 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 이 비어 있습니다."
        : auth.needsReauth
          ? "Google 계정 재연결이 필요합니다."
          : !auth.connected
            ? "Google 계정이 연결되지 않았습니다."
            : null;
  const imessageProblem = !config.notify.imessage
    ? ".env 의 NOTIFY_IMESSAGE 가 꺼져 있습니다."
    : !config.notify.imessageTo
      ? ".env 의 IMESSAGE_TO 가 비어 있습니다."
      : process.platform !== "darwin"
        ? "iMessage 는 macOS 에서만 보낼 수 있습니다."
        : null;
  return {
    email: { enabled: s.notifyEmail, ready: emailProblem === null, problem: emailProblem },
    imessage: { enabled: s.notifyImessage, ready: imessageProblem === null, problem: imessageProblem },
  };
}

const KST = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "11. 23. 09:02" 형태(Asia/Seoul). */
function kstShort(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : KST.format(d);
}

/** 수집 시작일(로컬) YYYY-MM-DD. 메일 제호 날짜에 쓴다. */
function ymd(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function newItemCount(r: DailyReportJson): { news: number; youtube: number } {
  const n = (secs: DailyReportJson["news"]) => secs.reduce((a, s) => a + s.items.length, 0);
  return { news: n(r.news), youtube: n(r.youtube) };
}

const OUTCOME_TONE: Record<DailyReportModelOutcome, TagTone> = {
  success: "success",
  "skipped-limit": "warn",
  "skipped-error": "error",
};

/** 대시보드 보고서 탭 주소. */
export function reportDashboardUrl(): string {
  return `http://localhost:${config.port}/#report`;
}

export function reportSubject(r: DailyReportJson): string {
  const c = newItemCount(r);
  const state = !r.ok ? " — 통합 실패" : r.successCount < r.modelCount ? ` — ${r.modelCount}개 중 ${r.successCount}개 모델` : "";
  return `🗞️ IT 보고서 ${kstShort(r.startedAt)} · 뉴스 ${c.news} · 영상 ${c.youtube}${state}`;
}

/** 발행·업로드 시각 "11. 23. 08:30" — 시각을 모르면 날짜(시각 미확인). */
function entryWhen(e: DailyReportEntry): string {
  if (e.publishedAt && !e.timeApprox) return kstClock(e.publishedAt);
  return e.timeApprox ? `${e.date}(시각 미확인)` : e.date;
}

/** 수집 범위 한 줄(정확한 시각 구간). 예전 실행에는 구간 기록이 없다. */
function coverageLine(r: DailyReportJson): string | null {
  const w = r.coverage.windows;
  if (!w) return null;
  return `수집 범위: 뉴스 ${formatWindowKst({ start: w.news.from, end: w.news.to })} · 유튜브 ${formatWindowKst({ start: w.youtube.from, end: w.youtube.to })}(실행 시점 기준, 발행·업로드 시각 단위)`;
}

/**
 * 항목 한 줄 — 뉴스·영상 모두 같은 기사형 행(제목·메타·요약·링크)이다. 영상 섬네일은 화면(보고서 탭·1면)에서만
 * 보여 주고 메일에는 싣지 않는다 — 보고서 메일이 Gmail 잘림 기준(약 102KB)을 넘기 쉬워서다(2026-11-28 사용자 결정).
 */
function entryRow(e: DailyReportEntry): string {
  const href = safeHref(e.url);
  const isVideo = e.kind === "youtube";
  const lead = e.update ? statusTag("새 출처", "info") : "";
  const meta = metaLine([
    breakLongRuns(escapeHtml(e.source)),
    breakLongRuns(escapeHtml(`${isVideo ? "업로드" : "발행"} ${entryWhen(e)}`)),
    `찾은 모델 ${escapeHtml(e.foundBy.join(", "))}`,
  ]);
  const extra = [
    href ? textLink(href, isVideo ? "영상 보기" : "원문 보기") : "",
    e.secondary.length
      ? `보조 출처: ${e.secondary
          .slice(0, 4)
          .map((s) => {
            const h = safeHref(s.link);
            return h ? textLink(h, s.label) : breakLongRuns(escapeHtml(s.label));
          })
          .join(" · ")}`
      : "",
    e.conflict ? `⚠️ 근거 차이: ${breakLongRuns(escapeHtml(e.conflict))}` : "",
  ].filter(Boolean);
  return articleRow({
    title: e.title,
    href,
    lead: lead || undefined,
    meta,
    summary: breakLongRuns(escapeHtml(e.summary)),
    after: extra.length ? extra.join("&nbsp;&nbsp;· ") : undefined,
  });
}

/** 보고서 메일 HTML. 순수 함수 — 발송하지 않는다. */
export function buildReportEmailHtml(r: DailyReportJson): string {
  const c = newItemCount(r);
  const parts: string[] = [];

  if (!r.ok) {
    parts.push(notice("세 모델이 모두 건너뛰어 이번 보고서를 만들지 못했습니다. 다음 실행이 같은 구간을 다시 수집합니다.", "error"));
  } else if (r.successCount < r.modelCount) {
    const skipped = r.models.filter((m) => m.outcome !== "success").map((m) => m.label);
    parts.push(notice(`부분 결과: ${r.modelCount}개 모델 중 ${r.successCount}개 성공 (건너뜀: ${escapeHtml(skipped.join(", "))})`, "warn"));
  }
  const action = r.models.filter((m) => m.outcome === "skipped-error");
  if (action.length) {
    parts.push(
      notice(`<strong>조치 필요</strong> — ${action.map((m) => `${escapeHtml(m.label)}: ${escapeHtml(m.reason.slice(0, 200))}`).join(" / ")}`, "error")
    );
  }

  // 핵심 요약
  if (r.ok) {
    parts.push(sectionHeader({ title: "핵심 요약", first: true }));
    parts.push(
      r.highlights.length
        ? `<ul style="margin:8px 0 0;padding-left:20px">${r.highlights.map((h) => `<li style="margin:4px 0">${breakLongRuns(escapeHtml(h))}</li>`).join("")}</ul>`
        : emptyLine("직전 보고 이후 새 항목이 없습니다.")
    );
  }

  // 모델별 상태
  parts.push(sectionHeader({ title: "모델별 상태", first: !r.ok }));
  parts.push(
    dataTable(
      [{ label: "모델" }, { label: "상태" }, { label: "뉴스/영상", align: "right" }],
      r.models.map((m) => [
        `${escapeHtml(m.label)}<div style="margin-top:2px;font-size:12px;color:#6c6860">${escapeHtml(m.model)}${
          m.actualModels.length && m.actualModels.join(",") !== m.model ? ` → ${escapeHtml(m.actualModels.join(", "))}` : ""
        }</div>`,
        `${statusTag(DAILY_REPORT_OUTCOME_LABEL[m.outcome], OUTCOME_TONE[m.outcome])}${
          m.reason ? `<div style="margin-top:4px;font-size:12px;color:#6c6860">${breakLongRuns(escapeHtml(m.reason.slice(0, 160)))}</div>` : ""
        }`,
        m.outcome === "success" ? `${m.newsCount} / ${m.youtubeCount}` : "-",
      ])
    )
  );

  const sectionsHtml = (title: string, secs: DailyReportJson["news"]) => {
    const total = secs.reduce((a, s) => a + s.items.length, 0);
    let html = sectionHeader({ title, count: total });
    if (!total) return html + emptyLine("새 항목 없음");
    for (const s of secs) {
      html += subHeader(s.label, { count: s.items.length });
      html += s.items.map(entryRow).join("");
    }
    return html;
  };
  if (r.ok) {
    parts.push(sectionsHtml("주요 뉴스", r.news));
    parts.push(sectionsHtml("유튜브 동향", r.youtube));
    if (r.seedsOnly.length) {
      parts.push(sectionHeader({ title: "추천 채널 신규 업로드", count: r.seedsOnly.length, note: "모델 미선정 · RSS 기준" }));
      // 섬네일 없이 제목·채널·날짜만(본문 항목과 같은 이유 — entryRow 참고).
      parts.push(
        r.seedsOnly
          .slice(0, 20)
          .map((v) =>
            articleRow({
              title: v.title,
              href: safeHref(v.url),
              meta: metaLine([breakLongRuns(escapeHtml(v.channel)), escapeHtml(v.date), breakLongRuns(escapeHtml(v.categoryLabel))]),
            })
          )
          .join("")
      );
    }
  }

  if (r.sourceFailures.length || r.coverage.gap) {
    parts.push(sectionHeader({ title: "수집 실패·확인 불가" }));
    if (r.coverage.gap) {
      parts.push(
        emptyLine(`범위 공백: ${kstShort(r.coverage.gap.from)} ~ ${kstShort(r.coverage.gap.to)} 구간은 뉴스 수집 범위(최근 24시간) 밖이라 확인하지 못했습니다.`)
      );
    }
    for (const f of r.sourceFailures.slice(0, 10)) parts.push(emptyLine(`${f.label}: ${f.error}`));
  }

  return emailDocument({
    tab: "report",
    title: "IT 뉴스·유튜브 통합 보고서",
    date: ymd(r.startedAt),
    meta: metaLine([
      `보고 ${strong(escapeHtml(kstShort(r.startedAt)))}`,
      `모델 ${strong(`${r.successCount}/${r.modelCount}`)} 성공`,
      `새 뉴스 ${strong(String(c.news))}`,
      `새 영상 ${strong(String(c.youtube))}`,
      r.editor.label ? `편집 ${escapeHtml(r.editor.label)}` : null,
    ]),
    body: parts.join(""),
    footnote:
      `${coverageLine(r) ? `${escapeHtml(coverageLine(r)!)}. ` : ""}직전 보고 이후 새 항목만 싣습니다(통합 전 ${r.counts.before}건 → 통합 후 ${r.counts.afterMerge}건, 이미 보고 ${r.counts.alreadyReported}건 제외). ` +
      "유튜브 요약은 제목·설명·검색 결과 기준이며 영상을 시청한 것은 아닙니다.",
  });
}

/** 문자(iMessage) 본문: 핵심 요약 + 모델별 상태 + 대시보드 링크. 순수 함수. */
export function buildReportSmsText(r: DailyReportJson, dashboardUrl = reportDashboardUrl()): string {
  const c = newItemCount(r);
  const lines = [`🗞️ IT 보고서 ${kstShort(r.startedAt)} — 뉴스 ${c.news}·영상 ${c.youtube}`];
  if (!r.ok) lines.push("⚠️ 세 모델이 모두 건너뛰어 보고서를 만들지 못했습니다.");
  else if (r.highlights.length) for (const h of r.highlights.slice(0, 4)) lines.push(`• ${h.slice(0, 120)}`);
  else lines.push("직전 보고 이후 새 항목이 없습니다.");
  const icon: Record<DailyReportModelOutcome, string> = { success: "✓", "skipped-limit": "한도", "skipped-error": "오류" };
  lines.push(`모델: ${r.models.map((m) => `${m.label.replace(/^Claude |^Gemini 4 /, "")} ${icon[m.outcome]}`).join(" · ")}`);
  lines.push(dashboardUrl);
  return lines.join("\n");
}

export interface DeliverySenders {
  mail(opts: { subject: string; html: string }): Promise<boolean>;
  imessage(text: string): Promise<void>;
}

const REAL_SENDERS: DeliverySenders = {
  mail: (o) => sendMail(o),
  imessage: (t) => sendIMessage(t),
};

let senders: DeliverySenders = REAL_SENDERS;

/** 테스트 전용 — 발송기를 모의 발송기로 바꾼다(null 이면 원복). 실제 메시지를 보내지 않게 하는 주입점. */
export function __setReportSendersForTest(s: DeliverySenders | null): void {
  senders = s ?? REAL_SENDERS;
}

export interface DeliveryResult {
  /** 보낸 채널 → 보낸 시각(ISO). */
  sent: Partial<Record<ReportChannel, string>>;
  /** 건너뛴 채널 → 사유. */
  skipped: Partial<Record<ReportChannel, string>>;
  errors: string[];
}

/**
 * 보고서를 메일·문자로 보낸다. **절대 throw 하지 않는다** — 발송 하나가 탭 갱신을 깨면 안 된다.
 * @param only 지정하면 그 채널만, 탭 스위치와 무관하게 보낸다(사용자가 화면에서 직접 누른 '보내기').
 *             자격(.env·계정 연결)은 그대로 요구한다.
 */
export async function deliverReport(r: DailyReportJson, opts: { only?: ReportChannel[] } = {}): Promise<DeliveryResult> {
  const ch = reportChannels();
  const out: DeliveryResult = { sent: {}, skipped: {}, errors: [] };
  const wanted = (c: ReportChannel) => (opts.only ? opts.only.includes(c) : ch[c].enabled);

  for (const c of ["email", "imessage"] as const) {
    if (!wanted(c)) {
      out.skipped[c] = opts.only ? "이번 발송 대상 아님" : "보고서 탭 알림 꺼짐";
      continue;
    }
    if (!ch[c].ready) {
      out.skipped[c] = ch[c].problem ?? "발송 준비 안 됨";
      log.warn(`보고서 ${c === "email" ? "메일" : "문자"} 건너뜀 [${r.runId}]: ${out.skipped[c]}`);
      continue;
    }
    try {
      if (c === "email") {
        const ok = await senders.mail({ subject: reportSubject(r), html: buildReportEmailHtml(r) });
        if (ok) out.sent.email = new Date().toISOString();
        else out.errors.push("메일 발송 실패(서버 로그 참고)");
      } else {
        await senders.imessage(buildReportSmsText(r));
        out.sent.imessage = new Date().toISOString();
      }
    } catch (e) {
      const msg = `${c === "email" ? "메일" : "문자"} 발송 예외: ${(e as Error).message}`;
      out.errors.push(msg);
      log.warn(`보고서 ${msg} [${r.runId}]`);
    }
  }
  if (out.sent.email || out.sent.imessage) {
    log.info(`보고서 발송 [${r.runId}] — ${Object.keys(out.sent).join("·")}`);
  }
  return out;
}
