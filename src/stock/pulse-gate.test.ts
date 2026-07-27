import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, isQuietHour, prioritize, type GateCounts } from "./pulse-gate.ts";
import type { NormalizedImpact } from "./pulse-prompt.ts";
import type { PulseAlertRecord, PulseImpact, PulseSeverity } from "../../shared/types.ts";

const CAPS = { perSymbolCap: 3, dailyCap: 10, macroCap: 2 };

function impact(over: Partial<PulseImpact> = {}): PulseImpact {
  return {
    symbol: "NVDA",
    market: "us",
    name: "엔비디아",
    direction: "negative",
    severity: "important",
    headline: "엔비디아 데이터센터 매출 가이던스 하향",
    rationale: "근거",
    risks: "리스크",
    sources: [{ title: "t", origin: "블룸버그", url: "https://x.test/a", publishedAt: null }],
    trigger: "company",
    ...over,
  };
}

function candidate(over: Partial<PulseImpact> = {}, fp = "NVDA:guidance-cut"): NormalizedImpact {
  const i = impact(over);
  return { impact: i, fingerprint: fp, issueKey: fp };
}

function record(over: Partial<PulseImpact> = {}, fp = "NVDA:guidance-cut"): PulseAlertRecord {
  return {
    id: 1,
    fingerprint: fp,
    date: "2026-07-27",
    slot: "10:00",
    impact: impact(over),
    status: "sent",
    createdAt: "2026-07-27T10:00:00.000Z",
    sentAt: "2026-07-27T10:00:00.000Z",
  };
}

const zero: GateCounts = { total: 0, bySymbol: {}, macro: 0 };
const base = { recent: [], counts: zero, caps: CAPS, threshold: "important" as PulseSeverity, quiet: false };

test("문턱 미달(info)은 below — 문자로 나가지 않는다", () => {
  const d = decide({ ...base, candidate: candidate({ severity: "info" }) });
  assert.equal(d.status, "below");
});

test("문턱 이상(important/urgent)은 발송", () => {
  assert.equal(decide({ ...base, candidate: candidate({ severity: "important" }) }).status, "sent");
  assert.equal(decide({ ...base, candidate: candidate({ severity: "urgent" }) }).status, "sent");
});

test("같은 지문 + 같은 강도는 dup", () => {
  const d = decide({ ...base, candidate: candidate(), recent: [record()] });
  assert.equal(d.status, "dup");
});

test("같은 지문이라도 강도가 오르면(중요→긴급) 다시 보낸다", () => {
  const d = decide({
    ...base,
    candidate: candidate({ severity: "urgent" }),
    recent: [record({ severity: "important" })],
  });
  assert.equal(d.status, "sent");
  assert.match(d.reason, /강도 상승/);
});

test("강도가 내려가면(긴급→중요) dup — 재발송하지 않는다", () => {
  const d = decide({
    ...base,
    candidate: candidate({ severity: "important" }),
    recent: [record({ severity: "urgent" })],
  });
  assert.equal(d.status, "dup");
});

test("지문이 달라도 같은 종목 안에서 헤드라인이 유사하면 dup", () => {
  const d = decide({
    ...base,
    candidate: candidate({ headline: "엔비디아 데이터센터 매출 가이던스 하향 발표" }, "NVDA:nvda-dc-guide"),
    recent: [record({ headline: "엔비디아 데이터센터 매출 가이던스 하향" }, "NVDA:guidance-cut")],
  });
  assert.equal(d.status, "dup");
});

test("헤드라인이 유사해도 **다른 종목**이면 dup 이 아니다 (종목별 알림이 삼켜지면 안 된다)", () => {
  const d = decide({
    ...base,
    candidate: candidate(
      { symbol: "INTC", name: "인텔", headline: "관세로 반도체 업종 전반 타격" },
      "INTC:tariff-semi"
    ),
    recent: [record({ headline: "관세로 반도체 업종 전반 타격" }, "NVDA:tariff-semi")],
  });
  assert.equal(d.status, "sent");
});

test("종목당 상한 초과는 capped", () => {
  const d = decide({
    ...base,
    candidate: candidate(),
    counts: { total: 3, bySymbol: { NVDA: 3 }, macro: 0 },
  });
  assert.equal(d.status, "capped");
  assert.match(d.reason, /종목 일일 상한/);
});

test("전체 일일 상한 초과는 capped", () => {
  const d = decide({
    ...base,
    candidate: candidate(),
    counts: { total: 10, bySymbol: { NVDA: 1 }, macro: 0 },
  });
  assert.equal(d.status, "capped");
  assert.match(d.reason, /전체 일일 상한/);
});

test("거시·섹터는 종목 상한과 **별도 예산**을 쓴다 (전체 상한이 차도 나간다)", () => {
  const macro = candidate({ symbol: null, market: null, name: "반도체 섹터", trigger: "macro" }, "macro:tariff");
  const d = decide({
    ...base,
    candidate: macro,
    counts: { total: 10, bySymbol: {}, macro: 0 }, // 종목 예산은 소진, 거시는 남음
  });
  assert.equal(d.status, "sent");
});

test("거시 상한을 넘으면 capped", () => {
  const macro = candidate({ symbol: null, market: null, name: "반도체 섹터", trigger: "macro" }, "macro:tariff");
  const d = decide({ ...base, candidate: macro, counts: { total: 0, bySymbol: {}, macro: 2 } });
  assert.equal(d.status, "capped");
  assert.match(d.reason, /거시·섹터 일일 상한/);
});

test("야간에는 중요=보류(queued), 긴급=즉시 발송", () => {
  assert.equal(
    decide({ ...base, quiet: true, candidate: candidate({ severity: "important" }) }).status,
    "queued"
  );
  assert.equal(
    decide({ ...base, quiet: true, candidate: candidate({ severity: "urgent" }) }).status,
    "sent"
  );
});

test("판정 순서: 문턱 미달은 야간이어도 below (참고 건이 큐를 채우면 안 된다)", () => {
  const d = decide({ ...base, quiet: true, candidate: candidate({ severity: "info" }) });
  assert.equal(d.status, "below");
});

test("판정 순서: 중복 건은 상한을 소진하지 않는다 (dup 이 capped 보다 먼저)", () => {
  const d = decide({
    ...base,
    candidate: candidate(),
    recent: [record()],
    counts: { total: 10, bySymbol: { NVDA: 3 }, macro: 0 },
  });
  assert.equal(d.status, "dup");
});

test("isQuietHour: 자정을 넘는 창(23~7)을 정확히 판정한다", () => {
  assert.equal(isQuietHour(23, 23, 7), true);
  assert.equal(isQuietHour(2, 23, 7), true);
  assert.equal(isQuietHour(6, 23, 7), true);
  assert.equal(isQuietHour(7, 23, 7), false); // 종료 시각은 조용 시간이 아니다(=플러시 시각)
  assert.equal(isQuietHour(12, 23, 7), false);
  assert.equal(isQuietHour(22, 23, 7), false);
});

test("isQuietHour: 자정을 넘지 않는 창(1~5)도 동작한다", () => {
  assert.equal(isQuietHour(3, 1, 5), true);
  assert.equal(isQuietHour(0, 1, 5), false);
  assert.equal(isQuietHour(5, 1, 5), false);
});

test("isQuietHour: start===end 면 창이 없다(야간 억제 꺼짐)", () => {
  assert.equal(isQuietHour(3, 7, 7), false);
});

test("prioritize: 강도 내림차순, 같은 강도면 종목직격 > 인물 > 거시", () => {
  const items = [
    candidate({ severity: "important", trigger: "macro", symbol: null }, "a"),
    candidate({ severity: "urgent", trigger: "person" }, "b"),
    candidate({ severity: "important", trigger: "company" }, "c"),
    candidate({ severity: "important", trigger: "person" }, "d"),
  ];
  assert.deepEqual(
    prioritize(items).map((i) => i.fingerprint),
    ["b", "c", "d", "a"]
  );
});

test("prioritize 는 원본 배열을 변형하지 않는다", () => {
  const items = [
    candidate({ severity: "info" }, "a"),
    candidate({ severity: "urgent" }, "b"),
  ];
  prioritize(items);
  assert.deepEqual(items.map((i) => i.fingerprint), ["a", "b"]);
});
