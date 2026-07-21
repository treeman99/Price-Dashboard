import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEventsEmailHtml, eventsIMessageText } from "./events-email.ts";
import type { EventsSnapshot, PopupItem, ExhibitionItem, FestivalItem } from "../../shared/types.ts";

function popup(over: Partial<PopupItem> = {}): PopupItem {
  return {
    name: "성수 팝업",
    region: "성수",
    period: "7/1~7/31",
    startDate: "2026-07-01",
    endDate: "2026-07-31",
    summary: "브랜드 체험 공간",
    link: "https://example.com/popup",
    category: null,
    tag: "신규",
    ...over,
  };
}

function exhibition(over: Partial<ExhibitionItem> = {}): ExhibitionItem {
  return {
    title: "코엑스 전시",
    venue: "코엑스",
    period: "7/10~7/12",
    startDate: "2026-07-10",
    endDate: "2026-07-12",
    summary: "산업 박람회",
    link: "https://example.com/exh",
    tag: null,
    ...over,
  };
}

function festival(over: Partial<FestivalItem> = {}): FestivalItem {
  return {
    name: "함평 나비축제",
    region: "전남 함평",
    period: "7/20~7/25",
    startDate: "2026-07-20",
    endDate: "2026-07-25",
    summary: "가족 축제",
    link: "https://example.com/fes",
    tag: null,
    ...over,
  };
}

function snapshot(over: Partial<EventsSnapshot> = {}): EventsSnapshot {
  return {
    date: "2026-07-17",
    updatedAt: "2026-07-17T08:00:00+09:00",
    source: "llm",
    popups: [popup()],
    exhibitions: { venues: [{ name: "코엑스", items: [exhibition()] }] },
    festivals: [festival()],
    notes: null,
    ...over,
  };
}

// ── 기존 동작 고정 (안전망) ────────────────────────────────────

test("buildEventsEmailHtml: 3개 섹션과 항목이 렌더된다", () => {
  const html = buildEventsEmailHtml(snapshot());
  assert.ok(html.includes("🛍 팝업스토어"));
  assert.ok(html.includes("🎉 대한민국 축제"));
  assert.ok(html.includes("성수 팝업"));
  assert.ok(html.includes("코엑스 전시"));
  assert.ok(html.includes("함평 나비축제"));
});

test("buildEventsEmailHtml: 팝업을 서울 / 수원·화성 등으로 나눠 렌더한다", () => {
  const html = buildEventsEmailHtml(
    snapshot({
      popups: [
        popup({ name: "성수 팝업", region: "서울 성수" }),
        popup({ name: "수원 팝업", region: "경기 수원" }),
      ],
    })
  );
  const seoulAt = html.indexOf("서울");
  const outerAt = html.indexOf("수원 · 화성 등");
  assert.ok(seoulAt >= 0 && outerAt > seoulAt, "서울 그룹이 서울 외 그룹보다 먼저 나온다");
  assert.ok(html.includes("(경기 등 서울 외)"));
  // 각 팝업이 자기 그룹 뒤에 놓인다.
  assert.ok(html.indexOf("성수 팝업") > seoulAt && html.indexOf("성수 팝업") < outerAt);
  assert.ok(html.indexOf("수원 팝업") > outerAt);
});

test("buildEventsEmailHtml: 한쪽 지역이 비면 그룹 머리말 + 없음 문구", () => {
  const html = buildEventsEmailHtml({
    ...snapshot(),
    popups: [popup({ region: "서울 성수" })],
  });
  assert.ok(html.includes("수원 · 화성 등"));
  assert.ok(html.includes("해당 지역의 팝업 없음"));
});

test("buildEventsEmailHtml: 전부 비어도 throw 없이 안내 문구", () => {
  const html = buildEventsEmailHtml(
    snapshot({ popups: [], exhibitions: { venues: [] }, festivals: [] })
  );
  assert.equal(typeof html, "string");
  assert.ok(html.includes("확인된 팝업이 없습니다."));
  assert.ok(html.includes("확인된 축제가 없습니다."));
});

test("buildEventsEmailHtml: 정상 링크는 '보기' 앵커 + 캘린더 앵커", () => {
  const html = buildEventsEmailHtml(snapshot());
  assert.ok(html.includes(`<a href="https://example.com/popup"`));
  assert.ok(html.includes("🔗 보기"));
  assert.ok(html.includes("📅 캘린더 추가"));
});

test("buildEventsEmailHtml: link 가 null 이면 '보기' 앵커가 없다", () => {
  const html = buildEventsEmailHtml(
    snapshot({ popups: [popup({ link: null })], exhibitions: { venues: [] }, festivals: [] })
  );
  assert.ok(!html.includes("🔗 보기"));
  assert.ok(html.includes("성수 팝업")); // 카드 자체는 남는다
});

test("buildEventsEmailHtml: 시작일이 없으면 캘린더 앵커가 없다", () => {
  const html = buildEventsEmailHtml(
    snapshot({
      popups: [popup({ startDate: null })],
      exhibitions: { venues: [] },
      festivals: [],
    })
  );
  assert.ok(!html.includes("📅 캘린더 추가"));
});

test("buildEventsEmailHtml: XSS — 이름·요약의 <script> 가 이스케이프된다", () => {
  const evil = '<script>alert("x")</script>';
  const html = buildEventsEmailHtml(
    snapshot({
      popups: [popup({ name: evil, summary: evil, region: evil })],
      exhibitions: { venues: [] },
      festivals: [],
    })
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

// ── safeHref 가드 ──────────────────────────────────────────────

test("buildEventsEmailHtml: XSS — 팝업의 javascript: 링크는 앵커로 렌더하지 않는다", () => {
  const html = buildEventsEmailHtml(
    snapshot({
      // eslint-disable-next-line no-script-url
      popups: [popup({ link: "javascript:alert(1)" })],
      exhibitions: { venues: [] },
      festivals: [],
    })
  );
  assert.ok(!html.includes("javascript:"));
  assert.ok(!html.includes("🔗 보기"));
  assert.ok(html.includes("성수 팝업"));
});

test("buildEventsEmailHtml: XSS — 전시의 data: 링크는 앵커로 렌더하지 않는다", () => {
  const html = buildEventsEmailHtml(
    snapshot({
      popups: [],
      exhibitions: {
        venues: [{ name: "코엑스", items: [exhibition({ link: "data:text/html,<script>alert(1)</script>" })] }],
      },
      festivals: [],
    })
  );
  assert.ok(!html.includes("data:text/html"));
  assert.ok(!html.includes("🔗 보기"));
  assert.ok(html.includes("코엑스 전시"));
});

test("buildEventsEmailHtml: XSS — 축제의 javascript: 링크는 앵커로 렌더하지 않는다", () => {
  const html = buildEventsEmailHtml(
    snapshot({
      popups: [],
      exhibitions: { venues: [] },
      // eslint-disable-next-line no-script-url
      festivals: [festival({ link: "javascript:alert(1)" })],
    })
  );
  assert.ok(!html.includes("javascript:"));
  assert.ok(!html.includes("🔗 보기"));
  assert.ok(html.includes("함평 나비축제"));
});

test("buildEventsEmailHtml: 불안전한 링크라도 캘린더 앵커(구글 URL)는 살아있다", () => {
  const html = buildEventsEmailHtml(
    snapshot({
      // eslint-disable-next-line no-script-url
      popups: [popup({ link: "javascript:alert(1)" })],
      exhibitions: { venues: [] },
      festivals: [],
    })
  );
  assert.ok(html.includes("📅 캘린더 추가"));
  assert.ok(html.includes("https://calendar.google.com"));
  assert.ok(!html.includes("javascript:")); // details 로도 새어나가지 않는다
});

// ── eventsIMessageText ─────────────────────────────────────────

test("eventsIMessageText: 카운트와 신규 강조", () => {
  const t = eventsIMessageText(snapshot({ popups: [popup({ isNew: true })] }));
  assert.match(t, /🎈 오늘의 팝업·전시·축제 — 2026-07-17/);
  assert.match(t, /🛍 팝업 1 · 🏛 전시 1 · 🎉 축제 1/);
  assert.ok(t.includes("🆕 신규: 성수 팝업"));
});
