// 알림 메일 공통 규칙 — 다섯 빌더 모두가 지켜야 하는 '첫 로드 안정성'·'폭' 규칙을 한곳에서 고정한다.
//
// 근거: data/gmail-jump-investigation/round3/report-C-all-mails.md §6, report-A-coldload.md §5·§6.2.
// Gmail iPad 앱은 본문 높이가 로드 중에 바뀌거나 읽기 창보다 넓어지면 재배치한다. 그래서 HTML 은
//  - 첫 레이아웃 높이 = 최종 높이(이미지가 대기·깨짐·표시 어느 상태여도 같은 자리)
//  - 600~860px 읽기 창에서 가로로 넘치지 않음(긴 덩어리는 Gmail 이 지우지 않는 word-break 로 끊음)
// 을 지켜야 한다. 메일 한 종만 고치고 다른 메일에서 같은 문제가 다시 생기지 않게, 규칙을 빌더 단위가 아니라 전 종에 건다.
//
// 렌더 데이터는 미리보기 픽스처(모든 상태가 한 번씩 나오는 데이터)와, 그 픽스처의 자유 텍스트를 전부
// '나쁜 데이터'(쿼리 URL + 띄어쓰기 없는 한국어 52자)로 바꾼 변형이다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FONT_LINK, breakLongRuns } from "./email-kit.ts";
import { escapeHtml } from "./html.ts";
import { buildNewsEmailHtml } from "./news-email.ts";
import { buildYoutubeEmailHtml } from "./youtube-email.ts";
import { buildEventsEmailHtml } from "./events-email.ts";
import { buildSkillsEmailHtml } from "./skills-email.ts";
import { buildStockEmailParts } from "./stock-email.ts";
import {
  SKILLS_CYCLE_LABEL_FIXTURE,
  STOCK_KR_PINNED,
  eventsFixture,
  newsFixture,
  skillsFixture,
  stockKrClosedFixture,
  stockKrFixture,
  youtubeFixture,
} from "./preview/fixtures.ts";
import type { EventsSnapshot, NewsSnapshot, StockSnapshot, YoutubeSnapshot } from "../../shared/types.ts";
import type { SkillsSnapshot } from "../../shared/skills.ts";

// ── 나쁜 데이터 ────────────────────────────────────────────────────────────────

/** 쿼리스트링 URL — '?'·'&'·'=' 는 줄바꿈 기회가 아니라 표 칸 안에서 한 줄로 남는다(유튜브 제목이면 600px 에서 +354px). */
const URLQ = "https://example.com/article?id=20261029000355&utm_source=newsletter&utm_medium=email&utm_campaign=daily_digest";
/** 띄어쓰기 없는 한국어 52자 — body 가 keep-all 이라 overflow-wrap 없이는 한 덩어리(Gmail iOS 는 overflow-wrap 을 지운다). */
const KO52 = "대한민국국제반도체산업전시회및컨퍼런스특별기획전시".repeat(2);
const BAD = `${URLQ} ${KO52}`;

function badNews(s: NewsSnapshot): NewsSnapshot {
  return {
    ...s,
    categories: s.categories.map((c) => ({
      ...c,
      label: BAD,
      items: c.items.map((it) => ({ ...it, title: BAD, source: BAD, summary: BAD, related: it.related.map((r) => ({ ...r, label: BAD })) })),
    })),
  };
}

function badYoutube(s: YoutubeSnapshot): YoutubeSnapshot {
  return {
    ...s,
    categories: s.categories.map((c) => ({
      ...c,
      label: BAD,
      items: c.items.map((v) => ({ ...v, title: BAD, channel: BAD, channelHandle: BAD, summary: BAD, views: BAD, duration: BAD })),
    })),
  };
}

function badEvents(s: EventsSnapshot): EventsSnapshot {
  const text = { summary: BAD, period: `${BAD}~${BAD}` };
  return {
    ...s,
    popups: s.popups.map((p) => ({ ...p, ...text, name: BAD, region: BAD, category: BAD })),
    exhibitions: {
      ...s.exhibitions,
      venues: s.exhibitions.venues.map((v) => ({ ...v, name: BAD, items: v.items.map((e) => ({ ...e, ...text, title: BAD, venue: BAD })) })),
    },
    festivals: (s.festivals ?? []).map((f) => ({ ...f, ...text, name: BAD, region: BAD })),
  };
}

function badSkills(s: SkillsSnapshot): SkillsSnapshot {
  const entry = (e: SkillsSnapshot["byStars"][number]) => ({
    ...e,
    repo: { ...e.repo, fullName: `${KO52}/${URLQ}`, summary: BAD, description: BAD, language: BAD, license: BAD },
  });
  return { ...s, notes: BAD, byStars: s.byStars.map(entry), byGrowth: s.byGrowth.map(entry) };
}

function badStock(s: StockSnapshot): StockSnapshot {
  const prose = { summary: BAD, outlook: BAD, rationale: BAD, risks: BAD };
  return {
    ...s,
    notes: BAD,
    disclaimer: BAD,
    closedReason: s.closedReason ? BAD : s.closedReason,
    news: s.news.map((n) => ({ ...n, title: BAD, source: BAD, summary: BAD, bucket: BAD })),
    indices: s.indices.map((i) => ({ ...i, name: BAD, comment: BAD, outlook: BAD, rationale: BAD })),
    analyses: s.analyses.map((a) => ({ ...a, ...prose, name: BAD })),
    watchlist: s.watchlist.map((w) => ({ ...w, ...prose, name: BAD, levels: BAD })),
    positions: s.positions?.map((p) => ({ ...p, name: BAD, factors: BAD, pulseSummary: BAD })),
  };
}

// ── 렌더 ────────────────────────────────────────────────────────────────────

type Mail = { name: string; html: string };

function render(bad: boolean): Mail[] {
  const pick = <T>(s: T, f: (x: T) => T) => (bad ? f(s) : s);
  return [
    { name: "news", html: buildNewsEmailHtml(pick(newsFixture, badNews)) },
    { name: "youtube", html: buildYoutubeEmailHtml(pick(youtubeFixture, badYoutube)) },
    { name: "events", html: buildEventsEmailHtml(pick(eventsFixture, badEvents)) },
    { name: "skills", html: buildSkillsEmailHtml(pick(skillsFixture, badSkills), SKILLS_CYCLE_LABEL_FIXTURE) },
    // 증시는 차트(cid img)가 붙는 경로로 — 고정 종목이 있어야 img 규칙이 실제로 검사된다.
    { name: "stock", html: buildStockEmailParts(pick(stockKrFixture, badStock), STOCK_KR_PINNED).html },
    { name: "stock-closed", html: buildStockEmailParts(pick(stockKrClosedFixture, badStock), STOCK_KR_PINNED).html },
  ].map((m) => ({ ...m, name: bad ? `${m.name}(나쁜 데이터)` : m.name }));
}

const MAILS = [...render(false), ...render(true)];

// ── HTML 훑기(태그 단위, 의존성 없이) ──────────────────────────────────────────

const VOID = new Set(["img", "br", "meta", "link", "wbr", "hr", "input", "col", "source"]);

interface Node {
  tag: string;
  style: string;
}

/** 열린 태그 스택을 따라가며 본문(body) 텍스트 조각과 img 태그를 조상 정보와 함께 넘긴다. */
function walk(html: string, on: { text?: (text: string, stack: Node[]) => void; img?: (tag: string, stack: Node[]) => void }) {
  const stack: Node[] = [];
  let inBody = false;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g;
  for (const m of html.matchAll(re)) {
    if (m[4] !== undefined) {
      if (inBody) on.text?.(m[4], stack);
      continue;
    }
    const [, close, rawTag, attrs] = m;
    const tag = rawTag.toLowerCase();
    if (tag === "body") inBody = !close;
    if (close) {
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      continue;
    }
    if (tag === "img") on.img?.(m[0], stack);
    if (VOID.has(tag) || attrs.endsWith("/")) continue;
    stack.push({ tag, style: (attrs.match(/style="([^"]*)"/)?.[1] ?? "").replace(/\s+/g, "") });
  }
}

function decode(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** 줄을 바꿀 수 없는 공백 없는 20자 이상 덩어리. &nbsp; 는 글자를 붙이므로 덩어리에 넣는다. */
const LONG_RUN = /(?:\S| ){20,}/g;

// ── T-a 이미지 ────────────────────────────────────────────────────────────────

test("규칙 T-a: 모든 <img> 는 width·height 속성 + 같은 높이의 height:Npx;overflow:hidden 래퍼 안에 있다", () => {
  let imgs = 0;
  for (const m of MAILS) {
    walk(m.html, {
      img: (tag, stack) => {
        imgs++;
        const w = tag.match(/\swidth="(\d+)"/)?.[1];
        const h = tag.match(/\sheight="(\d+)"/)?.[1];
        assert.ok(w && h, `${m.name}: width·height 속성이 없는 img — ${tag.slice(0, 120)}`);
        // 래퍼는 같은 칸(td) 안에 있어야 한다. 그 위의 표·칸 높이는 이미지 상태와 무관하다.
        const cell = stack.map((n) => n.tag).lastIndexOf("td");
        const wrapper = stack.slice(cell + 1).find((n) => /(^|;)height:\d+px/.test(n.style) && /overflow:hidden/.test(n.style));
        assert.ok(wrapper, `${m.name}: 고정 높이 래퍼 없는 img — ${tag.slice(0, 120)}`);
        assert.equal(wrapper.style.match(/(?:^|;)height:(\d+)px/)?.[1], h, `${m.name}: 래퍼 높이가 img height 속성과 다르다`);
      },
    });
  }
  // 유튜브 썸네일·증시 차트가 실제로 검사됐는지(0장이면 이 테스트는 아무것도 지키지 않는다).
  assert.ok(imgs >= 4, `검사한 img 가 ${imgs}장뿐이다`);
});

// ── T-b 금지 CSS ──────────────────────────────────────────────────────────────

test("규칙 T-b: 높이를 부모·뷰포트·비동기 자원에 묶는 CSS 와 <style>·<script> 를 쓰지 않는다", () => {
  const banned: [string, RegExp][] = [
    ["vh 단위", /\d(\.\d+)?vh\b/],
    ["% 높이", /(?<![-\w])height:\s*\d+(\.\d+)?%|\sheight="\d+%"/],
    ["min-height", /min-height/],
    ["position", /position\s*:/],
    ["overflow:auto|scroll", /overflow(-[xy])?\s*:\s*(auto|scroll)/],
    ["background-image", /background-image/],
    ["url(", /url\(/],
    ["<style", /<style\b/i],
    ["<script", /<script\b/i],
    ["@font-face", /@font-face/],
  ];
  for (const m of MAILS) {
    for (const [label, re] of banned) assert.doesNotMatch(m.html, re, `${m.name}: ${label}`);
  }
});

// ── T-c 긴 덩어리 ─────────────────────────────────────────────────────────────

test("규칙 T-c: 공백 없는 20자 이상 덩어리는 모두 word-break:break-all 안에 있다(나쁜 데이터 포함)", () => {
  for (const m of MAILS) {
    const left: string[] = [];
    walk(m.html, {
      text: (raw, stack) => {
        if (stack.some((n) => n.style.includes("word-break:break-all"))) return;
        for (const run of decode(raw).match(LONG_RUN) ?? []) left.push(run.slice(0, 40));
      },
    });
    assert.deepEqual(left, [], `${m.name}: 끊을 수 없는 덩어리`);
  }
  // 나쁜 데이터가 실제로 본문에 들어갔는지(필드 이름이 바뀌어 조용히 빠지면 이 테스트가 무의미해진다).
  for (const m of MAILS.filter((x) => x.name.includes("나쁜"))) {
    assert.ok(m.html.includes(KO52), `${m.name}: 나쁜 데이터가 렌더되지 않았다`);
  }
});

test("breakLongRuns: 20자 이상만 감싸고, 엔티티를 자르지 않으며, 짧은 어절은 그대로 둔다", () => {
  assert.equal(breakLongRuns("짧은 어절 그대로"), "짧은 어절 그대로");
  assert.equal(breakLongRuns("가".repeat(19)), "가".repeat(19));
  assert.equal(breakLongRuns("가".repeat(20)), `<span style="word-break:break-all">${"가".repeat(20)}</span>`);
  // 엔티티가 20자 경계에 걸쳐도 덩어리째 감싼다(공백이 없으므로 엔티티 중간에서 끊길 수 없다).
  const escaped = escapeHtml(`${"x".repeat(17)}&"<>${"y".repeat(5)} 뒤`);
  const out = breakLongRuns(escaped);
  assert.equal(out, `<span style="word-break:break-all">${"x".repeat(17)}&amp;&quot;&lt;&gt;${"y".repeat(5)}</span> 뒤`);
  // span 밖에 '&' 로 시작하는 조각이 남지 않는다 = 엔티티가 둘로 갈리지 않았다.
  assert.equal(out.replace(/<span[^>]*>[^<]*<\/span>/g, ""), " 뒤");
  // 태그 경계는 만들지 않는다 — 평문 안의 줄바꿈·공백은 그대로 경계다.
  assert.equal(breakLongRuns(`${"a".repeat(10)}\n${"b".repeat(10)}`), `${"a".repeat(10)}\n${"b".repeat(10)}`);
  // &nbsp;(U+00A0)는 줄을 바꾸지 않으므로 덩어리를 잇는다.
  const glued = `${"a".repeat(10)} ${"b".repeat(10)}`;
  assert.equal(breakLongRuns(glued), `<span style="word-break:break-all">${glued}</span>`);
});

// ── T-d 메타 줄 ───────────────────────────────────────────────────────────────

test("규칙 T-d: 메타 줄 구분자는 줄바꿈을 허용한다(&nbsp;·&nbsp; 0건)", () => {
  for (const m of MAILS) assert.ok(!m.html.includes("&nbsp;·&nbsp;"), `${m.name}: &nbsp;·&nbsp;`);
  // 구분자 자체는 남아 있다(지워진 게 아니라 바뀐 것).
  assert.ok(MAILS[0].html.includes("&nbsp;· </span>"));
});

// ── T-e 크기 ──────────────────────────────────────────────────────────────────

test("규칙 T-e: HTML 이 90,000 바이트 미만이다(Gmail 102KB 잘림 기준에 여유) — 큰 픽스처 기준", () => {
  // 실발송 최대치에 맞춘 큰 변형: 유튜브 카테고리 4개 × 10영상(10-29 실메일 40건), 뉴스 카테고리 5개 × 10건,
  // 증시 뉴스 15건 + 등록 종목 전부 고정.
  const many = <T>(items: T[], n: number) => Array.from({ length: n }, (_, i) => items[i % items.length]);
  const ytCats = youtubeFixture.categories.filter((c) => c.items.length);
  const youtube = buildYoutubeEmailHtml({
    ...youtubeFixture,
    categories: many(ytCats, 4).map((c, i) => ({ ...c, key: `${c.key}${i}`, items: many(c.items, 10) })),
  });
  const newsCats = newsFixture.categories.filter((c) => c.items.length);
  const news = buildNewsEmailHtml({
    ...newsFixture,
    categories: many(newsCats, 5).map((c, i) => ({ ...c, key: `${c.key}${i}`, items: many(c.items, 10) })),
  });
  const stock = buildStockEmailParts(
    { ...stockKrFixture, news: many(stockKrFixture.news, 15) },
    new Set(stockKrFixture.analyses.map((a) => a.symbol))
  ).html;
  for (const [name, html] of [["youtube×40", youtube], ["news×50", news], ["stock 뉴스 15·전부 고정", stock], ...MAILS.map((m) => [m.name, m.html])]) {
    const bytes = Buffer.byteLength(html, "utf8");
    assert.ok(bytes < 90_000, `${name}: ${bytes} 바이트`);
  }
});

// ── T-f 외부 CSS ──────────────────────────────────────────────────────────────

test("규칙 T-f: <link> 는 웹폰트 FONT_LINK 1건뿐이다", () => {
  for (const m of MAILS) {
    const links = m.html.match(/<link\b[^>]*>/gi) ?? [];
    assert.deepEqual(links, [`<link rel="stylesheet" href="${FONT_LINK}">`], m.name);
  }
});
