import { test } from "node:test";
import assert from "node:assert/strict";
import { decideEventsPublish, deriveEventsAttempt, getEventsLastAttempt } from "./events.ts";
import type {
  EventsSnapshot,
  PopupItem,
  ExhibitionItem,
  FestivalItem,
} from "../../shared/types.ts";

// 2026-08-02 사고 재현용 픽스처.
// 그날 02:18 큐레이션이 실패해 네이버 검색 원본(source="naver-raw")으로 폴백했는데,
// 알림 코드가 source 를 보지 않아 '팝업 24건'(실제로는 블로그 글 제목)이 정상인 척 발송됐다.

function popup(name: string): PopupItem {
  return {
    name,
    region: "성수",
    period: "2026.08.01~08.10",
    startDate: "2026-08-01",
    endDate: "2026-08-10",
    summary: "요약",
    link: "https://example.com/p",
    category: null,
    tag: null,
  };
}

function exhibition(title: string): ExhibitionItem {
  return {
    title,
    venue: "코엑스",
    period: "2026.08.01~08.05",
    startDate: "2026-08-01",
    endDate: "2026-08-05",
    summary: "요약",
    link: "https://example.com/e",
    tag: null,
  };
}

function festival(name: string): FestivalItem {
  return {
    name,
    region: "전남 함평",
    period: "2026.08.01~08.03",
    startDate: "2026-08-01",
    endDate: "2026-08-03",
    summary: "요약",
    link: "https://example.com/f",
    tag: null,
  };
}

function snapshot(over: Partial<EventsSnapshot> = {}): EventsSnapshot {
  return {
    date: "2026-08-02",
    updatedAt: "2026-08-02T02:18:53.652Z",
    source: "llm",
    popups: [popup("팝업 A")],
    exhibitions: { venues: [{ name: "코엑스", items: [exhibition("전시 A")] }] },
    festivals: [festival("축제 A")],
    notes: null,
    ...over,
  };
}

/** 큐레이션 실패 → 네이버 검색 원본 폴백(제목이 팝업이 아니라 블로그 글) */
function rawFallback(): EventsSnapshot {
  return snapshot({
    source: "naver-raw",
    popups: Array.from({ length: 24 }, (_, i) => popup(`성수동 팝업 다녀왔어요 후기 ${i}`)),
    notes: "네이버 검색 결과 원본 (AI 큐레이션 실패 또는 비활성)",
  });
}

const AT = "2026-08-02T02:00:00.000Z";

// ── 알림 품질 게이트 ─────────────────────────────────────────────────────────

test("source=naver-raw(원본 폴백)면 이메일·iMessage 를 보내지 않는다", () => {
  const d = decideEventsPublish(rawFallback(), AT, "schedule");
  assert.equal(d.notify, false);
  assert.match(String(d.skipReason), /원본 폴백/);
  assert.match(String(d.skipReason), /naver-raw/);
});

test("건수가 많아도 폴백이면 발송하지 않는다(24건 전부 블로그 글이었던 실측 사례)", () => {
  const d = decideEventsPublish(rawFallback(), AT);
  assert.equal(d.attempt.total, 26); // 팝업 24 + 전시 1 + 축제 1
  assert.equal(d.notify, false);
});

test("source=llm 이면 기존대로 발송한다", () => {
  const d = decideEventsPublish(snapshot(), AT, "schedule");
  assert.equal(d.notify, true);
  assert.equal(d.skipReason, null);
});

test("llm 이면 항목이 0건이어도 발송 판정 자체는 통과한다(0건 차단은 알림 모듈의 몫)", () => {
  // sendEventsEmail/sendEventsIMessage 가 자체 0건 게이트를 갖고 있어 여기서 중복 판정하지 않는다.
  const d = decideEventsPublish(
    snapshot({ popups: [], exhibitions: { venues: [] }, festivals: [] }),
    AT
  );
  assert.equal(d.notify, true);
  assert.equal(d.attempt.total, 0);
});

// ── 시도 성패 판정 ───────────────────────────────────────────────────────────

test("이벤트 시도 성패는 source==='llm' 일 때만 성공", () => {
  const ok = decideEventsPublish(snapshot(), AT, "schedule").attempt;
  assert.deepEqual(ok, {
    ok: true,
    at: AT,
    source: "llm",
    trigger: "schedule",
    total: 3,
    error: null,
  });

  const bad = decideEventsPublish(rawFallback(), AT, "catchup").attempt;
  assert.equal(bad.ok, false);
  assert.equal(bad.source, "naver-raw");
  assert.match(String(bad.error), /원본|실패/);
});

test("deriveEventsAttempt: 폴백은 건수와 무관하게 실패로 본다", () => {
  assert.deepEqual(deriveEventsAttempt(snapshot()), {
    ok: true,
    at: "2026-08-02T02:18:53.652Z",
    source: "llm",
  });
  assert.equal(deriveEventsAttempt(rawFallback())?.ok, false);
  assert.equal(deriveEventsAttempt(null), null);
});

test("getEventsLastAttempt: 스케줄러와의 계약(ok/at/source)만 노출한다", () => {
  const a = getEventsLastAttempt(); // 로컬 data/ 상태에 따라 null 일 수 있다
  if (a !== null) {
    assert.deepEqual(Object.keys(a).sort(), ["at", "ok", "source"]);
    assert.equal(typeof a.ok, "boolean");
    assert.equal(typeof a.at, "string");
    assert.equal(typeof a.source, "string");
  }
});
