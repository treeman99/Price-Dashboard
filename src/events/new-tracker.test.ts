import { test } from "node:test";
import assert from "node:assert/strict";
import { detectNew, type SeenLedger } from "./new-tracker.ts";

const OPTS = { gapDays: 7, showDays: 3, retentionDays: 60 };
const empty = (): SeenLedger => ({ since: "", items: {} });

test("콜드스타트: 첫 실행에서는 전부 신규 아님(원래 있던 것과 구분 불가)", () => {
  const { ledger, isNew } = detectNew(empty(), ["p:a", "p:b"], "2026-01-01", OPTS);
  assert.equal(ledger.since, "2026-01-01");
  assert.equal(isNew.get("p:a"), false);
  assert.equal(isNew.get("p:b"), false);
  assert.equal(ledger.items["p:a"].lastSeen, "2026-01-01");
});

test("워밍업 중(gapDays 미만)에는 새 항목이 들어와도 신규 아님", () => {
  const ledger: SeenLedger = { since: "2026-01-01", items: {} };
  const { isNew } = detectNew(ledger, ["p:new"], "2026-01-05", OPTS); // 4일 경과 < 7
  assert.equal(isNew.get("p:new"), false);
});

test("워밍업 이후 처음 등장한 항목은 신규", () => {
  const ledger: SeenLedger = { since: "2026-01-01", items: {} };
  const { ledger: next, isNew } = detectNew(ledger, ["p:x"], "2026-01-11", OPTS); // 10일 경과
  assert.equal(isNew.get("p:x"), true);
  assert.equal(next.items["p:x"].newSince, "2026-01-11");
});

test("계속 보이던 항목(공백 짧음)은 신규 아님", () => {
  const ledger: SeenLedger = {
    since: "2026-01-01",
    items: { "p:x": { firstSeen: "2026-01-05", lastSeen: "2026-01-10", newSince: null } },
  };
  const { isNew } = detectNew(ledger, ["p:x"], "2026-01-11", OPTS); // 공백 1일
  assert.equal(isNew.get("p:x"), false);
});

test("7일 이상 없다가 재등장하면 신규(수집은 계속되던 중)", () => {
  const ledger: SeenLedger = {
    since: "2025-12-01",
    lastRun: "2026-01-08", // 어제도 수집 성공 → 수집 공백 아님
    items: { "p:x": { firstSeen: "2025-12-20", lastSeen: "2026-01-01", newSince: null } },
  };
  const { ledger: next, isNew } = detectNew(ledger, ["p:x"], "2026-01-09", OPTS); // 항목 공백 8일
  assert.equal(isNew.get("p:x"), true);
  assert.equal(next.items["p:x"].newSince, "2026-01-09");
});

test("수집 공백(맥북 장기 종료/연속 폴백) 후 재개된 회차는 신규 판정 보류", () => {
  // 진행 중이던 A·B가 마지막 수집(2026-01-01) 이후 10일간 미수집 → 2026-01-11 재개.
  const ledger: SeenLedger = {
    since: "2025-12-01",
    lastRun: "2026-01-01",
    items: {
      "p:a": { firstSeen: "2025-12-20", lastSeen: "2026-01-01", newSince: null },
      "p:b": { firstSeen: "2025-12-20", lastSeen: "2026-01-01", newSince: null },
    },
  };
  const { ledger: next, isNew } = detectNew(ledger, ["p:a", "p:b"], "2026-01-11", OPTS);
  // 계속 있던 행사인데 수집만 못 한 것이므로 오탐하지 않는다.
  assert.equal(isNew.get("p:a"), false);
  assert.equal(isNew.get("p:b"), false);
  // lastRun/lastSeen 은 오늘로 갱신되어 다음 회차부터 정상 판정.
  assert.equal(next.lastRun, "2026-01-11");
  assert.equal(next.items["p:a"].lastSeen, "2026-01-11");
});

test("신규 배지는 재등장 후 showDays 이내 유지되고 이후 사라진다", () => {
  const base: SeenLedger = {
    since: "2025-12-01",
    items: { "p:x": { firstSeen: "2025-12-20", lastSeen: "2026-01-09", newSince: "2026-01-09" } },
  };
  // 재등장 2일 뒤(<=3): 유지
  assert.equal(detectNew(base, ["p:x"], "2026-01-11", OPTS).isNew.get("p:x"), true);
  // 재등장 4일 뒤(>3): 사라짐
  assert.equal(detectNew(base, ["p:x"], "2026-01-13", OPTS).isNew.get("p:x"), false);
});

test("2일짜리 반짝 공백은 신규로 오탐하지 않는다(LLM 표기 흔들림 방어)", () => {
  const ledger: SeenLedger = {
    since: "2025-12-01",
    items: { "e:코엑스:쇼": { firstSeen: "2025-12-20", lastSeen: "2026-01-05", newSince: null } },
  };
  const { isNew } = detectNew(ledger, ["e:코엑스:쇼"], "2026-01-07", OPTS); // 공백 2일
  assert.equal(isNew.get("e:코엑스:쇼"), false);
});

test("오래(retention 초과) 안 보인 항목은 원장에서 정리된다", () => {
  const ledger: SeenLedger = {
    since: "2025-01-01",
    items: {
      "p:stale": { firstSeen: "2025-10-01", lastSeen: "2025-10-01", newSince: null },
      "p:fresh": { firstSeen: "2025-12-25", lastSeen: "2025-12-25", newSince: null },
    },
  };
  const { ledger: next } = detectNew(ledger, ["p:fresh"], "2026-01-01", OPTS); // stale 92일 전
  assert.equal(next.items["p:stale"], undefined);
  assert.ok(next.items["p:fresh"]);
});
