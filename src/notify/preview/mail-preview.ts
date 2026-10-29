// 메일 미리보기 — 발송 없이 알림 메일 5종(+증시 휴장 변형)을 렌더해 브라우저 한 페이지에서 본다.
//
//   npm run mail:preview                    가상 데이터(fixtures.ts)로 렌더 → data/mail-preview/index.html 을 연다
//   npm run mail:preview -- --live          돌고 있는 서비스의 읽기 전용 GET API 에서 현재 스냅샷을 받아 렌더
//   npm run mail:preview -- --no-open       브라우저를 열지 않는다
//
// ⚠️ 절대 발송하지 않는다. send*·sendMail·sendIMessage 를 import 하지도 부르지도 않고, DB 도 열지 않는다
//    (증시 차트를 붙일 pinned 종목은 픽스처에서 정하고, --live 면 GET /api/stock/:market/tickers 로 읽는다).
//    순수 빌더(build*EmailHtml / buildStockEmailParts)만 부른다.
//
// 결과물은 data/mail-preview/ 아래(.gitignore 의 data/)에 메일별 HTML + index.html 로 남는다.
// 메일별 HTML 은 받은편지함에서 보일 모양 그대로이고(증시 차트의 cid: 만 data: URI 로 바꿔 끼운다),
// index.html 은 메일마다 데스크톱(720px)·아이폰(390px) 폭의 iframe 두 개를 나란히 놓는다.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "../../config.ts";
import { escapeAttr, escapeHtml } from "../html.ts";
import { FONT, FONT_LINK, HAIRLINE, INK, MUTED, PAPER, SUNKEN, TAB_COLOR, TNUM, type MailTab } from "../email-kit.ts";
import { buildNewsEmailHtml, newsSubject } from "../news-email.ts";
import { buildYoutubeEmailHtml, youtubeSubject } from "../youtube-email.ts";
import { buildEventsEmailHtml, eventsSubject } from "../events-email.ts";
import { buildSkillsEmailHtml, skillsSubject } from "../skills-email.ts";
import { buildStockEmailParts, subjectOf as stockSubject } from "../stock-email.ts";
import { describeSchedule } from "../../../shared/schedule.ts";
import type { MailAttachment } from "../mailer.ts";
import type {
  EventsSnapshot,
  NewsSnapshot,
  ScheduleResponse,
  StockMarket,
  StockSnapshot,
  StockTicker,
  YoutubeSnapshot,
} from "../../../shared/types.ts";
import type { SkillsSnapshot } from "../../../shared/skills.ts";
import {
  PREVIEW_THUMB_PREFIX,
  SKILLS_CYCLE_LABEL_FIXTURE,
  STOCK_KR_PINNED,
  eventsFixture,
  newsFixture,
  skillsFixture,
  stockKrClosedFixture,
  stockKrFixture,
  youtubeFixture,
} from "./fixtures.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = path.resolve(HERE, "../../../data/mail-preview");

// ── 증시 인라인 차트 ─────────────────────────────────────────────────────────────

/** 본문의 `cid:<id>` 를 첨부 PNG 의 data: URI 로 바꾼다. 브라우저는 cid: 를 모른다. */
function inlineCid(html: string, attachments: MailAttachment[]): { html: string; inlined: number } {
  let out = html;
  let inlined = 0;
  for (const a of attachments) {
    if (!a.cid) continue;
    const uri = `data:${a.contentType ?? "image/png"};base64,${a.content.toString("base64")}`;
    const before = out;
    for (const ref of new Set([`cid:${a.cid}`, `cid:${escapeAttr(a.cid)}`])) out = out.split(ref).join(uri);
    if (out !== before) inlined++;
  }
  return { html: out, inlined };
}

// ── 유튜브 썸네일 자리표시 ────────────────────────────────────────────────────────

/**
 * 4:3 회색 판 — 픽스처 썸네일 주소(.invalid)·i.ytimg.com 주소를 렌더 뒤 이것으로 바꾼다(외부 요청 없음).
 * 실발송 썸네일(hqdefault 480×360)과 같은 비율이라, 메일의 144×108 고정 자리에 빈 띠 없이 꼭 맞는다.
 */
const THUMB_PLACEHOLDER = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">` +
    `<rect width="320" height="240" fill="${SUNKEN}"/>` +
    `<path d="M146 92v36l30-18z" fill="${MUTED}"/>` +
    `<text x="160" y="180" font-family="sans-serif" font-size="24" fill="${MUTED}" text-anchor="middle">썸네일 예시</text>` +
    `</svg>`
)}`;

function placeholderThumbs(html: string): string {
  const prefix = PREVIEW_THUMB_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html
    .replace(new RegExp(`${prefix}[^"'\\s)<>]*`, "g"), THUMB_PLACEHOLDER)
    .replace(/https:\/\/i\.ytimg\.com\/vi\/[^"'\s)<>]*/g, THUMB_PLACEHOLDER);
}

// ── 메일 렌더 ────────────────────────────────────────────────────────────────────

export interface RenderedMail {
  /** 파일 이름(확장자 제외)이자 index 앵커. */
  id: string;
  /** index 에 보일 이름. */
  name: string;
  tab: MailTab;
  /** 발송 탭 — 대시보드 탭 이름과 같은 말. */
  tabLabel: string;
  /** 메일 제목 — 각 모듈이 export 한 제목 함수 그대로(발송과 같은 식). */
  subject: string;
  /** cid → data: URI 까지 끝낸 HTML. */
  html: string;
  /** 인라인 차트 수(증시만). */
  charts?: number;
  /** index 에 덧붙일 회색 메모(html). */
  note?: string;
}

/** 스냅샷 묶음. --live 에서 수집 전인 탭은 null 이다. */
export interface PreviewSet {
  news: NewsSnapshot | null;
  youtube: YoutubeSnapshot | null;
  events: EventsSnapshot | null;
  skills: SkillsSnapshot | null;
  skillsCycleLabel: string;
  stock: { id: string; name: string; snapshot: StockSnapshot; pinned: ReadonlySet<string> }[];
}

export function renderMails(set: PreviewSet, o: { placeholderThumbs: boolean }): RenderedMail[] {
  const out: RenderedMail[] = [];
  if (set.news) {
    out.push({
      id: "news",
      name: "뉴스 다이제스트",
      tab: "news",
      tabLabel: "뉴스",
      subject: newsSubject(set.news),
      html: buildNewsEmailHtml(set.news),
    });
  }
  if (set.youtube) {
    const html = buildYoutubeEmailHtml(set.youtube);
    out.push({
      id: "youtube",
      name: "유튜브 소식",
      tab: "youtube",
      tabLabel: "유튜브 소식",
      subject: youtubeSubject(set.youtube),
      html: o.placeholderThumbs ? placeholderThumbs(html) : html,
      note: o.placeholderThumbs ? "썸네일은 외부 요청 없이 보려고 회색 자리표시로 바꿔 끼웠습니다." : undefined,
    });
  }
  if (set.events) {
    out.push({
      id: "events",
      name: "팝업 · 전시 · 축제",
      tab: "events",
      tabLabel: "팝업·전시",
      subject: eventsSubject(set.events),
      html: buildEventsEmailHtml(set.events),
    });
  }
  if (set.skills) {
    out.push({
      id: "skills",
      name: "스킬 랭킹",
      tab: "skills",
      tabLabel: "스킬 랭킹",
      subject: skillsSubject(set.skills),
      html: buildSkillsEmailHtml(set.skills, set.skillsCycleLabel),
    });
  }
  for (const st of set.stock) {
    const parts = buildStockEmailParts(st.snapshot, st.pinned);
    const { html, inlined } = inlineCid(parts.html, parts.attachments);
    out.push({
      id: st.id,
      name: st.name,
      tab: "stock",
      tabLabel: "증시",
      subject: stockSubject(st.snapshot),
      html,
      charts: inlined,
      note: st.snapshot.closed ? "휴장 브리핑에는 차트가 붙지 않습니다." : undefined,
    });
  }
  return out;
}

/** 가상 데이터 묶음. */
export function fixtureSet(): PreviewSet {
  return {
    news: newsFixture,
    youtube: youtubeFixture,
    events: eventsFixture,
    skills: skillsFixture,
    skillsCycleLabel: SKILLS_CYCLE_LABEL_FIXTURE,
    stock: [
      { id: "stock-kr", name: "국내증시 브리핑", snapshot: stockKrFixture, pinned: STOCK_KR_PINNED },
      { id: "stock-kr-closed", name: "국내증시 브리핑 · 휴장", snapshot: stockKrClosedFixture, pinned: STOCK_KR_PINNED },
    ],
  };
}

// ── --live: 돌고 있는 서비스의 읽기 전용 GET ─────────────────────────────────────────

async function getJson<T>(base: string, p: string): Promise<T> {
  const res = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET ${p} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** 브리핑 응답의 variants(역할별 스냅샷)는 화면용 덧붙임이라 메일 빌더에 넘기지 않는다. */
function stripVariants(s: (StockSnapshot & { variants?: unknown }) | null): StockSnapshot | null {
  if (!s) return null;
  const { variants: _variants, ...rest } = s;
  return rest;
}

export async function liveSet(base: string): Promise<PreviewSet> {
  const [news, youtube, events, skills, schedule] = await Promise.all([
    getJson<NewsSnapshot | null>(base, "/api/news"),
    getJson<YoutubeSnapshot | null>(base, "/api/youtube"),
    getJson<EventsSnapshot | null>(base, "/api/events"),
    getJson<SkillsSnapshot | null>(base, "/api/skills"),
    getJson<ScheduleResponse>(base, "/api/schedule"),
  ]);
  const stock: PreviewSet["stock"] = [];
  for (const market of ["kr", "us"] as StockMarket[]) {
    const [snap, tickers] = await Promise.all([
      getJson<(StockSnapshot & { variants?: unknown }) | null>(base, `/api/stock/${market}`),
      getJson<StockTicker[]>(base, `/api/stock/${market}/tickers`),
    ]);
    const snapshot = stripVariants(snap);
    if (!snapshot) continue;
    stock.push({
      id: `stock-${market}`,
      name: market === "kr" ? "국내증시 브리핑" : "미국증시 브리핑",
      snapshot,
      pinned: new Set(tickers.filter((t) => t.pinned).map((t) => t.symbol)),
    });
  }
  const job = schedule.schedule.skills;
  return {
    news,
    youtube,
    events,
    // 수집 전이면 /api/skills 가 빈 스냅샷(source=empty)을 준다 — 보낼 메일이 없으니 건너뛴다.
    skills: skills && skills.source !== "empty" ? skills : null,
    // skills-email.ts skillsCycleLabel() 과 같은 식. 그 함수는 data/schedule.json 을 직접 읽어서 API 값으로 대신한다.
    skillsCycleLabel: job.enabled ? `${describeSchedule(job)} 갱신` : "자동 갱신 꺼짐",
    stock,
  };
}

// ── 출력 ────────────────────────────────────────────────────────────────────────

/**
 * 조각 HTML(옛 빌더의 `<div>…</div>`)도 브라우저에서 바로 열리게 doctype·charset 만 앞에 붙인다.
 * 메일 클라이언트도 본문을 표준 모드 문서 안에 넣어 보여 주므로 모양은 같다. 본문은 건드리지 않는다.
 */
function asDocument(html: string): string {
  let head = "";
  if (!/^\s*<!doctype/i.test(html)) head += "<!doctype html>";
  if (!/<meta[^>]+charset/i.test(html)) head += '<meta charset="utf-8">';
  return head + html;
}

const FIT_SCRIPT = `function fitFrame(f){var d=f.contentDocument;if(!d||!d.documentElement)return;
var go=function(){f.style.height="0px";f.style.height=Math.max(d.documentElement.scrollHeight,d.body?d.body.scrollHeight:0)+"px";};
go();if(d.fonts&&d.fonts.ready)d.fonts.ready.then(go);
Array.prototype.forEach.call(d.images,function(i){if(!i.complete)i.addEventListener("load",go);});
if(window.ResizeObserver&&d.body)new ResizeObserver(go).observe(d.body);}`;

/** index.html — 대시보드와 같은 신문지 바탕. 위에 메일 목록, 아래에 메일마다 두 폭 iframe. */
export function buildIndexHtml(mails: RenderedMail[], o: { mode: "fixture" | "live"; skipped: string[]; generatedAt: Date }): string {
  const when = o.generatedAt.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
  const modeLabel = o.mode === "live" ? `실데이터(localhost:${config.port} 현재 스냅샷)` : "가상 데이터(fixtures.ts)";

  const square = (tab: MailTab) =>
    `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${TAB_COLOR[tab]};margin-right:8px;vertical-align:middle"></span>`;

  const toc = mails
    .map(
      (m) => `<li><a href="#${m.id}">${square(m.tab)}${escapeHtml(m.name)}</a><span class="toc-subject">${escapeHtml(m.subject)}</span></li>`
    )
    .join("");

  const sections = mails
    .map((m) => {
      const doc = escapeAttr(asDocument(m.html));
      const meta = [
        `발송 탭 <strong>${escapeHtml(m.tabLabel)}</strong>`,
        m.charts != null ? `인라인 차트 <strong>${m.charts}개</strong>` : "",
        `<a href="${m.id}.html" target="_blank">새 창에서 열기</a>`,
      ]
        .filter(Boolean)
        .join('<span class="dot">·</span>');
      return `<section id="${m.id}">
<h2>${square(m.tab)}${escapeHtml(m.name)}</h2>
<p class="meta">${meta}</p>
<p class="subject"><span class="label">제목</span>${escapeHtml(m.subject)}</p>
${m.note ? `<p class="hint">${escapeHtml(m.note)}</p>` : ""}
<div class="frames">
<figure><figcaption>데스크톱 · 720px</figcaption><iframe title="${escapeAttr(m.name)} 데스크톱" width="720" srcdoc="${doc}" onload="fitFrame(this)"></iframe></figure>
<figure><figcaption>아이폰 · 390px</figcaption><iframe title="${escapeAttr(m.name)} 아이폰" width="390" srcdoc="${doc}" onload="fitFrame(this)"></iframe></figure>
</div>
</section>`;
    })
    .join("\n");

  const skipped = o.skipped.length
    ? `<p class="hint">수집 전이라 건너뜀: ${o.skipped.map(escapeHtml).join(", ")}</p>`
    : "";

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${FONT_LINK}">
<title>메일 미리보기</title>
<style>
:root{color-scheme:light}
body{margin:0;background:${PAPER};color:${INK};font-family:${FONT.sans};font-size:15px;line-height:1.55;word-break:keep-all}
.page{max-width:1180px;margin:0 auto;padding:0 16px 64px}
.bar{height:3px;background:${INK}}
.masthead{padding:16px 0 12px;border-bottom:1px solid ${HAIRLINE};font-family:${FONT.serif};font-size:20px;font-weight:700;letter-spacing:-0.02em}
h1{margin:24px 0 0;font-family:${FONT.serif};font-size:28px;font-weight:600;letter-spacing:-0.01em}
.lede{margin:8px 0 0;font-size:13px;color:${MUTED};${TNUM}}
.lede strong,.meta strong{color:${INK};font-weight:500}
.dot{color:${HAIRLINE};margin:0 8px}
ol.toc{list-style:none;margin:24px 0 0;padding:0;border-top:2px solid ${INK}}
ol.toc li{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:baseline;padding:10px 0;border-bottom:1px solid ${HAIRLINE}}
ol.toc a{color:${INK};font-weight:600;text-decoration:none;min-width:220px}
ol.toc a:hover{text-decoration:underline;text-underline-offset:3px}
.toc-subject{font-family:${FONT.mono};font-size:13px;color:${MUTED}}
section{margin-top:48px;padding-top:10px;border-top:2px solid ${INK}}
h2{margin:0;font-family:${FONT.serif};font-size:22px;font-weight:600;letter-spacing:-0.01em}
.meta{margin:6px 0 0;font-size:13px;color:${MUTED}}
.meta a{color:${MUTED};text-underline-offset:3px}
.subject{margin:10px 0 0;font-family:${FONT.mono};font-size:13px}
.subject .label{display:inline-block;margin-right:10px;padding:0 6px;border:1px solid ${HAIRLINE};border-radius:3px;font-family:${FONT.sans};font-size:12px;color:${MUTED}}
.hint{margin:6px 0 0;font-family:${FONT.sans};font-size:12px;color:${MUTED}}
.frames{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start;margin-top:16px}
figure{margin:0;max-width:100%;overflow-x:auto}
figcaption{margin-bottom:6px;font-size:12px;font-weight:500;color:${MUTED}}
iframe{display:block;height:600px;border:1px solid ${HAIRLINE};background:${PAPER}}
</style>
<script>${FIT_SCRIPT}</script>
</head><body>
<div class="bar"></div>
<div class="page">
<div class="masthead">Daily Dashboard</div>
<h1>메일 미리보기</h1>
<p class="lede">${escapeHtml(modeLabel)}<span class="dot">·</span>메일 <strong>${mails.length}통</strong><span class="dot">·</span>${escapeHtml(when)} 생성<span class="dot">·</span>발송하지 않음</p>
${skipped}
<ol class="toc">${toc}</ol>
${sections}
</div>
</body></html>`;
}

/** data/mail-preview/ 의 이전 HTML 을 지우고 메일별 파일 + index.html 을 쓴다. 쓴 index 경로를 돌려준다. */
export function writePreview(mails: RenderedMail[], index: string, dir = OUT_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  // 이전 실행(--live ↔ 픽스처)의 메일이 남아 헷갈리지 않게 이 폴더의 .html 만 지운다.
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".html")) fs.rmSync(path.join(dir, f));
  for (const m of mails) fs.writeFileSync(path.join(dir, `${m.id}.html`), asDocument(m.html));
  const indexPath = path.join(dir, "index.html");
  fs.writeFileSync(indexPath, index);
  return indexPath;
}

// ── 실행 ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const known = new Set(["--live", "--no-open"]);
  for (const a of args) if (!known.has(a)) console.warn(`알 수 없는 옵션 무시: ${a} (쓸 수 있는 옵션: --live, --no-open)`);
  const live = args.includes("--live");

  let set: PreviewSet;
  if (live) {
    const base = `http://localhost:${config.port}`;
    try {
      set = await liveSet(base);
    } catch (e) {
      console.error(`실데이터를 읽지 못했습니다(${base}): ${(e as Error).message}`);
      console.error("서비스가 떠 있는지 확인하세요 — 가상 데이터로 보려면 --live 없이 실행합니다.");
      process.exit(1);
    }
  } else {
    set = fixtureSet();
  }

  const skipped = [
    !set.news && "뉴스",
    !set.youtube && "유튜브",
    !set.events && "팝업·전시",
    !set.skills && "스킬 랭킹",
    ...(live ? (["kr", "us"] as const).filter((m) => !set.stock.some((s) => s.snapshot.market === m)).map((m) => (m === "kr" ? "국내증시" : "미국증시")) : []),
  ].filter((v): v is string => Boolean(v));

  const mails = renderMails(set, { placeholderThumbs: !live });
  const index = buildIndexHtml(mails, { mode: live ? "live" : "fixture", skipped, generatedAt: new Date() });
  const indexPath = writePreview(mails, index);

  console.log(`메일 미리보기 ${mails.length}통 → ${path.relative(process.cwd(), OUT_DIR)}/ (발송하지 않음)`);
  for (const m of mails) console.log(`  ${m.id}.html  ${m.subject}`);
  if (skipped.length) console.log(`  건너뜀(수집 전): ${skipped.join(", ")}`);
  console.log(`  index.html  ${pathToFileURL(indexPath).href}`);

  if (!args.includes("--no-open")) {
    execFile("open", [indexPath], (err) => {
      if (err) console.warn(`브라우저를 열지 못했습니다: ${err.message}`);
    });
  }
}

// 테스트가 renderMails·fixtureSet 을 import 할 때는 실행하지 않는다.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
