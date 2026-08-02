import { test } from "node:test";
import assert from "node:assert/strict";
import { decideNewsSnapshot, deriveNewsAttempt, getNewsLastAttempt } from "./news.ts";
import type { NewsSnapshot, NewsCategory, NewsItem } from "../../shared/types.ts";

// 2026-08-02 사고 재현용 픽스처.
// 그날 00:36 큐레이션이 타임아웃해 `총 0건, source=empty` 스냅샷이 어제(08-01) 성공본을 덮었고,
// 그 빈 스냅샷의 date 가 오늘이라 catch-up 게이트가 통과돼 그날 재시도가 영구 봉인됐다.

function item(over: Partial<NewsItem> = {}): NewsItem {
  return {
    title: "AI 모델 공개",
    source: "TechCrunch",
    date: "2026-08-01",
    summary: "새 모델이 공개됐다.",
    link: "https://example.com/a",
    related: [],
    ...over,
  };
}

function category(items: NewsItem[]): NewsCategory {
  return { key: "ai", label: "AI / LLM", emoji: "🤖", color: "#4361ee", items } as NewsCategory;
}

/** 성공한 어제자 스냅샷 */
function prevOk(over: Partial<NewsSnapshot> = {}): NewsSnapshot {
  return {
    date: "2026-08-01",
    updatedAt: "2026-08-01T08:07:04.029Z",
    source: "llm",
    categories: [category([item()])],
    notes: "24시간 이내 기사만 채택했다.",
    ...over,
  };
}

/** 큐레이션 타임아웃 결과(오늘자 빈 스냅샷) */
function freshEmpty(over: Partial<NewsSnapshot> = {}): NewsSnapshot {
  return {
    date: "2026-08-02",
    updatedAt: "2026-08-02T00:36:09.038Z",
    source: "empty",
    categories: [category([])],
    notes: "뉴스 큐레이션 실패: timeout",
    ...over,
  };
}

/** 정상 수집 결과(오늘자) */
function freshOk(over: Partial<NewsSnapshot> = {}): NewsSnapshot {
  return {
    date: "2026-08-02",
    updatedAt: "2026-08-02T08:07:00.000Z",
    source: "llm",
    categories: [category([item({ date: "2026-08-02" })])],
    notes: null,
    ...over,
  };
}

const AT = "2026-08-02T00:00:00.000Z";

// ── 스냅샷 보호 ──────────────────────────────────────────────────────────────

test("빈 결과 + 직전 성공 스냅샷 → 덮어쓰지 않고 직전 것을 유지한다(어제자여도 유지)", () => {
  const prev = prevOk();
  const d = decideNewsSnapshot(prev, freshEmpty(), AT, "catchup");

  assert.equal(d.action, "keep");
  assert.equal(d.snapshot.date, "2026-08-01"); // 어제 뉴스가 보이는 게 빈 화면보다 낫다
  assert.equal(d.snapshot.updatedAt, prev.updatedAt); // 스케줄러가 보는 값 — 손대지 않는다
  assert.equal(d.snapshot.categories[0].items.length, 1);
  assert.match(String(d.snapshot.notes), /수집 실패/); // 날짜 오해 방지용 안내
  assert.match(String(d.snapshot.notes), /2026-08-01 스냅샷을 유지/);
});

test("보호가 발동한 회차는 알림을 보내지 않는다(어제 다이제스트 재발송 금지)", () => {
  const d = decideNewsSnapshot(prevOk(), freshEmpty(), AT);
  assert.equal(d.notify, false);
});

test("보호 발동 회차의 성패는 실패로 기록된다(자기봉인 차단의 핵심)", () => {
  const d = decideNewsSnapshot(prevOk(), freshEmpty(), AT, "catchup");
  assert.equal(d.attempt.ok, false);
  assert.equal(d.attempt.at, AT);
  assert.equal(d.attempt.source, "empty");
  assert.equal(d.attempt.trigger, "catchup");
  assert.equal(d.attempt.total, 0);
  assert.match(String(d.attempt.error), /timeout/);
});

test("빈 결과 + 직전 스냅샷 없음 → 그대로 저장한다(첫 실행 시 빈 화면은 정상)", () => {
  const fresh = freshEmpty();
  const d = decideNewsSnapshot(null, fresh, AT);

  assert.equal(d.action, "save");
  assert.equal(d.snapshot, fresh);
  assert.equal(d.notify, false); // 0건이면 알림도 없다
  assert.equal(d.attempt.ok, false);
});

test("빈 결과 + 직전도 실패성이면 지키지 않고 저장한다", () => {
  const fresh = freshEmpty();
  const d = decideNewsSnapshot(freshEmpty({ date: "2026-08-01" }), fresh, AT);
  assert.equal(d.action, "save");
  assert.equal(d.snapshot, fresh);
});

test("source=llm 이어도 총 0건이면 실패성 — 직전 성공본을 지킨다", () => {
  // 큐레이션은 돌았지만 신선도 필터에서 전부 탈락한 경우. 화면이 비는 건 실패와 구분되지 않는다.
  const d = decideNewsSnapshot(prevOk(), freshOk({ categories: [category([])] }), AT);
  assert.equal(d.action, "keep");
  assert.equal(d.attempt.ok, false);
  assert.equal(d.attempt.source, "llm");
});

test("성공 결과는 직전 성공본을 정상적으로 덮어쓴다", () => {
  const fresh = freshOk();
  const d = decideNewsSnapshot(prevOk(), fresh, AT, "schedule");

  assert.equal(d.action, "save");
  assert.equal(d.snapshot, fresh);
  assert.equal(d.snapshot.date, "2026-08-02");
  assert.equal(d.notify, true);
  assert.deepEqual(d.attempt, {
    ok: true,
    at: AT,
    source: "llm",
    trigger: "schedule",
    total: 1,
    error: null,
  });
});

test("보호가 연속으로 걸려도 notes 가 누적되지 않는다(매번 통째로 다시 쓴다)", () => {
  const first = decideNewsSnapshot(prevOk(), freshEmpty(), AT);
  const second = decideNewsSnapshot(first.snapshot, freshEmpty(), "2026-08-02T01:00:00.000Z");

  assert.equal(second.action, "keep");
  assert.equal(String(second.snapshot.notes).split("⚠️").length - 1, 1);
  assert.match(String(second.snapshot.notes), /2026-08-02T01:00:00.000Z/);
});

// ── 시도 성패 판정 ───────────────────────────────────────────────────────────

test("deriveNewsAttempt: llm + 1건 이상만 성공", () => {
  assert.deepEqual(deriveNewsAttempt(prevOk()), {
    ok: true,
    at: "2026-08-01T08:07:04.029Z",
    source: "llm",
  });
  assert.equal(deriveNewsAttempt(freshEmpty())?.ok, false); // source=empty
  assert.equal(deriveNewsAttempt(freshOk({ categories: [category([])] }))?.ok, false); // 0건
  assert.equal(deriveNewsAttempt(null), null); // 스냅샷 자체가 없음
});

test("getNewsLastAttempt: 스케줄러와의 계약(ok/at/source)만 노출한다", () => {
  const a = getNewsLastAttempt(); // 로컬 data/ 상태에 따라 null 일 수 있다
  if (a !== null) {
    assert.deepEqual(Object.keys(a).sort(), ["at", "ok", "source"]);
    assert.equal(typeof a.ok, "boolean");
    assert.equal(typeof a.at, "string");
    assert.equal(typeof a.source, "string");
  }
});
