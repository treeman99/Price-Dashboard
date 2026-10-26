// 알림 메일 공용 지면 — 대시보드 화면과 같은 "조간 브리핑" 문법(DESIGN.md)을 메일 HTML 로 옮긴다.
//
// 신문지 바탕 + 윤전 잉크 글씨, 섹션은 위 2px 잉크 괘선과 명조 제목, 행은 1px 헤어라인으로만 나눈다.
// 카드 상자·굵은 왼쪽 색 테두리·제목 앞 이모지·하드코딩 링크색(#4361ee)은 쓰지 않는다.
//
// 메일 클라이언트 제약 때문에 화면 부품(React)을 그대로 쓰지 못한다:
//  - 스타일은 전부 인라인. 큰 뼈대는 table(role=presentation) — Gmail·Outlook 이 flex/grid 를 무시한다.
//  - 투명도(rgba)는 클라이언트마다 다르게 나와서, 잉크·신호색의 옅은 변형은 신문지에 미리 섞은 HEX 로 쓴다.
//  - 웹폰트는 Apple Mail 에서만 뜬다. Gmail 은 link 를 버리므로 글꼴 목록 뒤쪽(애플 명조·고딕)이 실제 모양이다.
//
// 이 파일의 함수는 **HTML 조각을 그대로 받는다** — 텍스트는 부르는 쪽이 escapeHtml 로 감싸서 넘긴다.
// (제목처럼 늘 텍스트인 인자만 여기서 이스케이프한다. 인자 설명에 표시해 둔다.)

import { config } from "../config.ts";
import { changeTone } from "../../shared/stock.ts";
import { escapeAttr, escapeHtml } from "./html.ts";

// ── 색 ─────────────────────────────────────────────────────────────────────────
// web/src/index.css 의 HSL 토큰을 HEX 로 옮긴 값. 값을 바꾸면 화면과 함께 바꾼다.

/** 윤전 잉크 — 본문 글씨, 섹션 괘선. */
export const INK = "#1c1b17";
/** 신문지 — 메일 전체 바탕. */
export const PAPER = "#f6f4ef";
/** 흐린 잉크 — 메타, 표 머리, 보조 링크, 빈 상태 문구. */
export const MUTED = "#6c6860";
/** 헤어라인 — 행 구분선. */
export const HAIRLINE = "#ded9cf";
/** 눌린 바탕 — 코드 칩, 꼭 묶어야 하는 영역. */
export const SUNKEN = "#edeae3";

/** 신호색(오류·경고·정보·성공). 안내 띠의 선·아이콘과 상태 태그의 글씨에만 쓴다. */
export const TONE = {
  error: "#b42318",
  warn: "#b05607",
  info: "#1961cc",
  success: "#07744c",
} as const;
export type Tone = keyof typeof TONE;

/** 증시 상승·하락(한국 관례: 상승 빨강, 하락 파랑). 등락률 글씨와 차트 끝점에만 쓴다. */
export const MARKET = { up: "#c23224", down: "#1f5fd6" } as const;

/** 탭 고유색 — 메일 맨 위 3px 띠와 섹션 앞 작은 사각형에만 쓴다(web/src/App.tsx TABS 와 같은 값). */
export const TAB_COLOR = {
  news: "#d97706",
  youtube: "#dc2626",
  skills: "#2563eb",
  stock: "#059669",
  events: "#db2777",
  holdings: "#0d9488",
  lotto: "#7c3aed",
} as const;
export type MailTab = keyof typeof TAB_COLOR;

/** a 를 신문지 위에 alpha 만큼 섞은 HEX. 메일에서는 rgba 대신 이것을 쓴다. */
export function onPaper(hex: string, alpha: number): string {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return (
    "#" +
    [0, 1, 2]
      .map((i) => Math.round(p(hex, i) * alpha + p(PAPER, i) * (1 - alpha)).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** 요약 글 — 잉크 80%. */
export const INK_80 = onPaper(INK, 0.8);
/** 표 머리 아래 괘선 — 잉크 80%. 헤더 아래 선 — 잉크 15%. */
const RULE_HEAD = onPaper(INK, 0.8);
const RULE_SOFT = onPaper(INK, 0.15);

// ── 글꼴 ───────────────────────────────────────────────────────────────────────

export const FONT = {
  /** 제호·섹션 제목·큰 숫자에만. 본문·버튼·표에는 쓰지 않는다. */
  serif: "Hahmlet,'AppleMyungjo','Apple Myungjo','Nanum Myeongjo',Batang,serif",
  sans: "'IBM Plex Sans KR',-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif",
  /** 종목코드·시각·순위·건수 같은 기계적인 값. */
  mono: "'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace",
} as const;

/** 숫자가 세로로 줄을 서는 곳(가격·건수·날짜)에 붙인다. */
export const TNUM = "font-variant-numeric:tabular-nums;";

export const FONT_LINK =
  "https://fonts.googleapis.com/css2?family=Hahmlet:wght@600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+KR:wght@400;500;600&display=swap";

// ── 지면 ───────────────────────────────────────────────────────────────────────

/** "2026-10-26" → "10월 26일 월요일". 형식이 아니면 받은 값 그대로. */
export function dateline(ymd: string): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "long" });
}

/** 툴바 메타 줄처럼 조각을 가운데점으로 잇는다. 빈 조각은 건너뛴다. */
export function metaLine(parts: (string | null | undefined | false)[]): string {
  return parts.filter(Boolean).join(`<span style="color:${onPaper(MUTED, 0.5)}">&nbsp;·&nbsp;</span>`);
}

/** 메타 안의 값(시각·건수) — 잉크색 medium 으로 올린다. html 그대로. */
export function strong(html: string): string {
  return `<strong style="color:${INK};font-weight:500">${html}</strong>`;
}

/**
 * 메일 한 통의 뼈대: 탭 색 3px 띠 → 제호·날짜 → 명조 제목 + 메타 줄 → 본문 → 각주·발신 줄.
 *
 * @param title 텍스트(여기서 이스케이프한다). 예: "뉴스 다이제스트"
 * @param date "2026-10-26" 같은 수집일. 제호 옆에 "10월 26일 월요일"로 찍힌다.
 * @param meta 제목 아래 회색 한 줄(html). metaLine 으로 만든다.
 * @param body 본문(html).
 * @param footnote 맨 아래 회색 각주(html) — 면책 문구 같은 것.
 */
export function emailDocument(o: {
  tab: MailTab;
  title: string;
  date: string;
  meta?: string;
  body: string;
  footnote?: string;
}): string {
  const tab = TAB_COLOR[o.tab];
  const home = `http://localhost:${config.port}`;
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<link rel="stylesheet" href="${FONT_LINK}">
<title>${escapeHtml(o.title)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};color:${INK};font-family:${FONT.sans};font-size:15px;line-height:1.55;word-break:keep-all;-webkit-text-size-adjust:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER}"><tr><td align="center" style="padding:0 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;text-align:left">
<tr><td style="height:3px;line-height:3px;font-size:0;background:${tab}">&nbsp;</td></tr>
<tr><td style="padding:16px 0 12px;border-bottom:1px solid ${RULE_SOFT}">
<span style="font-family:${FONT.serif};font-size:20px;font-weight:700;letter-spacing:-0.02em;color:${INK}">Daily Dashboard</span>
<span style="font-size:13px;color:${MUTED};${TNUM}">&nbsp;&nbsp;${escapeHtml(dateline(o.date))}</span>
</td></tr>
<tr><td style="padding:24px 0 4px">
<h1 style="margin:0;font-family:${FONT.serif};font-size:26px;font-weight:600;line-height:1.25;letter-spacing:-0.01em;color:${INK}">${escapeHtml(o.title)}</h1>
${o.meta ? `<p style="margin:8px 0 0;font-size:13px;color:${MUTED};${TNUM}">${o.meta}</p>` : ""}
</td></tr>
<tr><td style="padding:0 0 8px">${o.body}</td></tr>
<tr><td style="padding:20px 0 40px;border-top:1px solid ${HAIRLINE};font-size:12px;line-height:1.6;color:${MUTED}">
${o.footnote ? `<p style="margin:0 0 10px">${o.footnote}</p>` : ""}
<p style="margin:0">Daily Dashboard · 맥북에서 자동 수집 · <a href="${escapeAttr(home)}" style="color:${MUTED};text-decoration:underline">대시보드에서 전체 보기</a></p>
</td></tr>
</table></td></tr></table>
</body></html>`;
}

// ── 부품 ───────────────────────────────────────────────────────────────────────

/** 제목 앞 10px 색 사각형(카테고리·탭 고유색). */
export function accentSquare(color: string, size = 10): string {
  return `<span style="display:inline-block;width:${size}px;height:${size}px;border-radius:2px;background:${color};vertical-align:middle;margin-right:8px"></span>`;
}

/**
 * 섹션 머리 — 이 지면의 서명. 위 2px 잉크 괘선, 명조 제목, 옆에 Mono 건수와 회색 메모.
 *
 * @param title html(카테고리 이모지 같은 사용자 데이터를 함께 넣을 수 있게). 텍스트면 escapeHtml 로 감싸서 넘긴다.
 * @param note html.
 * @param first 본문 첫 섹션이면 위 여백을 줄인다.
 */
export function sectionHeader(o: {
  title: string;
  accent?: string;
  count?: number | string | null;
  note?: string;
  first?: boolean;
}): string {
  const count =
    o.count != null && o.count !== ""
      ? ` <span style="font-family:${FONT.mono};font-size:13px;font-weight:400;color:${MUTED};${TNUM}">${escapeHtml(String(o.count))}</span>`
      : "";
  const note = o.note ? ` <span style="font-family:${FONT.sans};font-size:13px;font-weight:400;color:${MUTED}">${o.note}</span>` : "";
  return `<h2 style="margin:${o.first ? 28 : 40}px 0 4px;padding-top:10px;border-top:2px solid ${INK};font-family:${FONT.serif};font-size:20px;font-weight:600;line-height:1.3;letter-spacing:-0.01em;color:${INK}">${o.accent ? accentSquare(o.accent) : ""}${o.title}${count}${note}</h2>`;
}

/** 섹션 안 소그룹 라벨. 13px semibold + Mono 건수, 아래 헤어라인, 앞에 8px 원형 점(선택). label 은 텍스트. */
export function subHeader(label: string, o: { count?: number | string; dot?: string; note?: string } = {}): string {
  const dot = o.dot
    ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${o.dot};vertical-align:middle;margin-right:6px"></span>`
    : "";
  const count = o.count != null ? ` <span style="font-family:${FONT.mono};font-size:12px;font-weight:400;color:${MUTED}">${escapeHtml(String(o.count))}</span>` : "";
  const note = o.note ? ` <span style="font-size:12px;font-weight:400;color:${MUTED}">${o.note}</span>` : "";
  return `<p style="margin:20px 0 0;padding:0 0 6px;border-bottom:1px solid ${HAIRLINE};font-size:13px;font-weight:600;letter-spacing:0.02em;color:${INK}">${dot}${escapeHtml(label)}${count}${note}</p>`;
}

/**
 * 기사형 행 하나(뉴스·유튜브·브리핑 뉴스). 제목이 곧 원문 링크다. 아래 헤어라인으로만 나눈다.
 *
 * @param title 텍스트(여기서 이스케이프한다).
 * @param href 이미 safeHref 를 통과한 http(s) 주소. 없으면 링크 없이 제목만.
 * @param lead 제목 앞에 붙일 html(상태 태그 등).
 * @param meta 제목 아래 회색 한 줄(html, metaLine 으로).
 * @param summary 요약(html).
 * @param after 요약 아래 덧붙일 html(관련 출처, 보조 링크 등).
 */
export function articleRow(o: {
  title: string;
  href?: string | null;
  lead?: string;
  meta?: string;
  summary?: string;
  after?: string;
}): string {
  const title = o.href
    ? `<a href="${escapeAttr(o.href)}" style="color:${INK};text-decoration:none">${escapeHtml(o.title)}</a>`
    : escapeHtml(o.title);
  return `<div style="padding:14px 0;border-bottom:1px solid ${HAIRLINE}">
<p style="margin:0;font-size:15px;font-weight:600;line-height:1.45;color:${INK}">${o.lead ? `${o.lead} ` : ""}${title}</p>
${o.meta ? `<p style="margin:4px 0 0;font-size:12.5px;color:${MUTED};${TNUM}">${o.meta}</p>` : ""}
${o.summary ? `<p style="margin:8px 0 0;font-size:14px;line-height:1.65;color:${INK_80}">${o.summary}</p>` : ""}
${o.after ? `<p style="margin:8px 0 0;font-size:12.5px;color:${MUTED}">${o.after}</p>` : ""}
</div>`;
}

/**
 * 요약에 섞여 오는 긴 URL(공백 없는 30자 이상 ASCII)만 아무 데서나 끊게 감싼다. 한국어 어절은 keep-all 그대로.
 * 이게 없으면 URL 한 줄이 표 칸을 밀어 메일 전체 폭이 680px 을 넘는다(유튜브 실데이터 763px 로 확인).
 * escaped 는 이미 escapeHtml 을 거친 텍스트 — 태그가 없으므로 엔티티째 감싸도 안전하다.
 */
export function breakLongRuns(escaped: string): string {
  return escaped.replace(/[!-~]{30,}/g, (run) => `<span style="word-break:break-all">${run}</span>`);
}

/** 행 안의 보조 링크('원문 보기'). href 는 safeHref 를 통과한 값, label 은 텍스트. */
export function textLink(href: string, label: string): string {
  return `<a href="${escapeAttr(href)}" style="color:${MUTED};text-decoration:underline;text-underline-offset:3px">${escapeHtml(label)}</a>`;
}

export type TagTone = "new" | "urgent" | "soon" | "warn" | "neutral" | "info" | "success" | "error";

const TAG_COLOR: Record<TagTone, string> = {
  new: TONE.success,
  success: TONE.success,
  urgent: TONE.error,
  error: TONE.error,
  soon: TONE.info,
  info: TONE.info,
  warn: TONE.warn,
  neutral: MUTED,
};

/** 짧은 상태 표시(신규·종료임박·상승 전망 …). 색을 채우지 않는다 — 글씨 + 얇은 테두리. text 는 텍스트. */
export function statusTag(text: string, tone: TagTone = "neutral"): string {
  const c = TAG_COLOR[tone];
  const border = tone === "neutral" ? onPaper(INK, 0.2) : onPaper(c, 0.45);
  return `<span style="display:inline-block;padding:1px 6px;border:1px solid ${border};border-radius:3px;font-family:${FONT.sans};font-size:11px;font-weight:600;line-height:16px;color:${c};vertical-align:1px;white-space:nowrap">${escapeHtml(text)}</span>`;
}

/**
 * 안내 띠 — 지면에 끼워 넣는 정정 기사 같은 띠. 왼쪽 3px 신호색 선 + 같은 색 옅은 바탕, 글씨는 잉크 그대로.
 * tone "muted" 는 잉크 20% 선 + 눌린 바탕(면책·참고 문구). html 그대로.
 */
export function notice(html: string, tone: Tone | "muted" = "muted"): string {
  const bar = tone === "muted" ? onPaper(INK, 0.2) : TONE[tone];
  const bg = tone === "muted" ? SUNKEN : onPaper(TONE[tone], 0.07);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0"><tr><td style="padding:10px 14px;border-left:3px solid ${bar};background:${bg};font-size:14px;line-height:1.6;color:${INK}">${html}</td></tr></table>`;
}

/** 섹션 안 한 줄 회색 문구(빈 상태). text 는 텍스트. */
export function emptyLine(text: string): string {
  return `<p style="margin:0;padding:12px 0;border-bottom:1px solid ${HAIRLINE};font-size:14px;color:${MUTED}">${escapeHtml(text)}</p>`;
}

export interface Column {
  /** 머리 글씨(텍스트). */
  label: string;
  /** 숫자 열은 "right" — tabular 숫자도 함께 붙는다. */
  align?: "left" | "right";
  /** "40%" 같은 폭. 비우면 내용대로. */
  width?: string;
}

/**
 * 데이터 표(.dtable). 머리는 12px 흐린 잉크 + 아래 1px 잉크 80% 괘선, 행은 아래 헤어라인, 위 정렬.
 * rows 의 각 칸은 html.
 */
export function dataTable(columns: Column[], rows: string[][]): string {
  const th = columns
    .map(
      (c) =>
        `<th align="${c.align ?? "left"}" style="padding:4px 10px 8px;border-bottom:1px solid ${RULE_HEAD};font-size:12px;font-weight:500;color:${MUTED};text-align:${c.align ?? "left"};white-space:nowrap${c.width ? `;width:${c.width}` : ""}">${escapeHtml(c.label)}</th>`
    )
    .join("");
  const tr = rows
    .map(
      (r) =>
        `<tr>${r
          .map((cell, i) => {
            const right = columns[i]?.align === "right";
            return `<td valign="top" align="${right ? "right" : "left"}" style="padding:10px 10px;border-bottom:1px solid ${HAIRLINE};font-size:14px;line-height:1.5;color:${INK};vertical-align:top;text-align:${right ? "right" : "left"}${right ? `;white-space:nowrap;${TNUM}` : ""}">${cell}</td>`;
          })
          .join("")}</tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:8px"><tr>${th}</tr>${tr}</table>`;
}

/** 표 칸 안의 두 번째 줄(회색 작은 글씨). html 그대로. */
export function cellNote(html: string): string {
  return `<div style="margin-top:2px;font-size:12.5px;line-height:1.5;color:${MUTED}">${html}</div>`;
}

/**
 * 등락률 글씨(상승 빨강 ▲ · 하락 파랑 ▼ · 값 없음/0 은 흐린 '-'). 판정은 화면과 같은 changeTone.
 * ▲▼ 는 신문 시세표의 활자 관례로 쓴다(아이콘 대용이 아니다 — 메일엔 아이콘 글꼴이 없다).
 */
export function changeText(pct: number | null | undefined, digits = 2): string {
  const t = changeTone(pct ?? null);
  if (t === "flat") return `<span style="color:${MUTED}">-</span>`;
  const color = t === "up" ? MARKET.up : MARKET.down;
  return `<span style="color:${color};font-weight:600;${TNUM}">${t === "up" ? "▲" : "▼"}${Math.abs(pct as number).toFixed(digits)}%</span>`;
}
