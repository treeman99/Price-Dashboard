import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPulsePrompt, normalizeImpact, normalizePulse } from "./pulse-prompt.ts";
import { fingerprint, isSimilarIssue, findActionPhrases, severityRank } from "../../shared/pulse.ts";
import { summarizeHolding } from "../../shared/holdings.ts";
import type { StockHolding, StockHoldingSummary } from "../../shared/types.ts";

const HOLD: StockHolding = {
  id: 1,
  market: "us",
  symbol: "NVDA",
  name: "엔비디아",
  quoteCode: "NVDA.O",
  exchange: "나스닥",
  quantity: 10,
  avgPrice: 100,
  targetPrice: 150,
  stopPrice: 80,
  horizon: "short",
  memo: "HBM 사이클 베팅",
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const SUMMARY: StockHoldingSummary = summarizeHolding(HOLD, {
  close: 120,
  changePct: 1.5,
  currency: "USD",
});

const KNOWN = new Set(["NVDA"]);

function raw(over: Record<string, unknown> = {}) {
  return {
    symbol: "NVDA",
    market: "us",
    name: "엔비디아",
    issueKey: "nvidia-guidance-cut",
    direction: "negative",
    severity: "urgent",
    trigger: "company",
    headline: "엔비디아 가이던스 하향",
    rationale: "회사가 4분기 매출 전망을 낮췄다",
    risks: "일회성 재고 조정일 수 있다",
    sources: [
      { title: "NVDA cuts outlook", origin: "블룸버그", url: "https://x.test/a", publishedAt: "2026-07-27" },
    ],
    ...over,
  };
}

// ── 폐기 규칙 ──

test("근거(rationale)가 없으면 폐기한다", () => {
  assert.equal(normalizeImpact(raw({ rationale: "" }), KNOWN), null);
});

test("리스크(risks)가 없으면 폐기한다", () => {
  assert.equal(normalizeImpact(raw({ risks: "  " }), KNOWN), null);
});

test("헤드라인이 없으면 폐기한다", () => {
  assert.equal(normalizeImpact(raw({ headline: "" }), KNOWN), null);
});

test("유효한 출처가 0건이면 폐기한다 (지어낸 발언 차단의 마지막 방어선)", () => {
  assert.equal(normalizeImpact(raw({ sources: [] }), KNOWN), null);
});

test("http(s) 가 아닌 url 은 출처로 인정하지 않는다 → 전부 무효면 폐기", () => {
  const r = normalizeImpact(
    raw({ sources: [{ title: "t", origin: "o", url: "/news/1", publishedAt: null }] }),
    KNOWN
  );
  assert.equal(r, null);
});

test("제목 없는 출처는 버리되, 유효 출처가 하나라도 있으면 항목은 살린다", () => {
  const r = normalizeImpact(
    raw({
      sources: [
        { title: "", origin: "o", url: "https://x.test/bad", publishedAt: null },
        { title: "good", origin: "로이터", url: "https://x.test/good", publishedAt: null },
      ],
    }),
    KNOWN
  );
  assert.ok(r);
  assert.equal(r.value.impact.sources.length, 1);
  assert.equal(r.value.impact.sources[0].url, "https://x.test/good");
});

// ── 심볼·시장 검증 ──

test("보유 목록에 없는 심볼은 null 로 접고 거시(macro)로 취급한다", () => {
  const r = normalizeImpact(raw({ symbol: "TSLA" }), KNOWN);
  assert.ok(r);
  assert.equal(r.value.impact.symbol, null);
  assert.equal(r.value.impact.trigger, "macro"); // 종목 상한을 먹지 않게
  assert.equal(r.value.impact.market, null);
});

test("심볼이 없으면 trigger 가 company 로 와도 macro 로 바로잡는다", () => {
  const r = normalizeImpact(raw({ symbol: null, trigger: "company" }), KNOWN);
  assert.ok(r);
  assert.equal(r.value.impact.trigger, "macro");
});

test("허용 목록 밖 market 은 null", () => {
  const r = normalizeImpact(raw({ market: "jp" }), KNOWN);
  assert.ok(r);
  assert.equal(r.value.impact.market, null);
});

// ── 액션 표현 검열 ──

test("액션 표현이 있으면 항목을 버리지 않고 **그 문장만** 제거한다", () => {
  const r = normalizeImpact(
    raw({ rationale: "매출 전망이 낮아졌다. 지금 매도하라. 재고가 늘었다." }),
    KNOWN
  );
  assert.ok(r);
  assert.ok(r.strippedAction.length > 0, "제거된 표현이 보고되어야 한다");
  assert.doesNotMatch(r.value.impact.rationale, /매도/);
  assert.match(r.value.impact.rationale, /매출 전망이 낮아졌다/);
  assert.match(r.value.impact.rationale, /재고가 늘었다/);
});

test("모든 문장이 액션이면 대체 문구를 넣는다(빈 문자열로 남기지 않는다)", () => {
  const r = normalizeImpact(raw({ risks: "비중을 축소하라." }), KNOWN);
  assert.ok(r);
  assert.match(r.value.impact.risks, /제외했습니다/);
});

test("findActionPhrases: 한글·영문 매매 지시를 모두 잡는다", () => {
  assert.ok(findActionPhrases("지금 매수하세요").length);
  assert.ok(findActionPhrases("비중 확대 의견").length);
  assert.ok(findActionPhrases("strong BUY").length);
  assert.equal(findActionPhrases("매출이 늘었다").length, 0, "'매출'은 매매 지시가 아니다");
  assert.equal(findActionPhrases("매수세가 유입됐다").length, 0, "수급 사실 서술은 지시가 아니다");
  assert.ok(findActionPhrases("비중을 축소하라").length, "조사가 붙어도 잡아야 한다");
  assert.equal(
    findActionPhrases("지수 내 비중이 축소됐다").length,
    0,
    "주격 조사(이/가)는 사실 서술이라 잘라내면 안 된다"
  );
});

// ── 정규화 폴백 ──

test("알 수 없는 severity/direction 은 가장 보수적인 값으로 접는다", () => {
  const r = normalizeImpact(raw({ severity: "catastrophic", direction: "up" }), KNOWN);
  assert.ok(r);
  assert.equal(r.value.impact.severity, "info");
  assert.equal(r.value.impact.direction, "neutral");
});

test("한글 severity/direction 도 받아들인다", () => {
  const r = normalizeImpact(raw({ severity: "긴급", direction: "부정" }), KNOWN);
  assert.ok(r);
  assert.equal(r.value.impact.severity, "urgent");
  assert.equal(r.value.impact.direction, "negative");
});

test("issueKey 가 없으면 headline 으로 지문을 만든다", () => {
  const r = normalizeImpact(raw({ issueKey: "" }), KNOWN);
  assert.ok(r);
  assert.ok(r.value.fingerprint.startsWith("NVDA:"));
});

test("normalizePulse: 폐기 건수와 제거된 액션 표현을 집계한다", () => {
  const out = normalizePulse(
    { impacts: [raw(), raw({ rationale: "" }), raw({ risks: "지금 매도하라." })], notes: " 메모 " },
    KNOWN
  );
  assert.equal(out.impacts.length, 2);
  assert.equal(out.dropped, 1);
  assert.ok(out.strippedActions.length > 0);
  assert.equal(out.notes, "메모");
});

test("normalizePulse: impacts 가 배열이 아니면 빈 결과", () => {
  const out = normalizePulse({ impacts: "없음" }, KNOWN);
  assert.deepEqual(out.impacts, []);
  assert.equal(out.notes, null);
});

// ── 지문·유사도 ──

test("fingerprint: 토큰 순서가 달라도 같은 지문이 나온다", () => {
  assert.equal(fingerprint("NVDA", "guidance cut nvidia"), fingerprint("NVDA", "nvidia cut guidance"));
});

test("fingerprint: 종목이 다르면 지문이 다르다", () => {
  assert.notEqual(fingerprint("NVDA", "tariff"), fingerprint("INTC", "tariff"));
});

test("fingerprint: 심볼이 없으면 macro 스코프", () => {
  assert.ok(fingerprint(null, "tariff").startsWith("MACRO:"));
});

test("isSimilarIssue: 같은 사건의 다른 표현은 유사로 잡는다", () => {
  assert.equal(
    isSimilarIssue(
      "엔비디아 데이터센터 매출 가이던스 하향",
      "엔비디아 데이터센터 매출 가이던스 하향 발표"
    ),
    true
  );
});

test("isSimilarIssue: 다른 사건은 유사가 아니다", () => {
  assert.equal(
    isSimilarIssue("엔비디아 데이터센터 매출 가이던스 하향", "연준 파월 금리 인하 시사 발언"),
    false
  );
});

test("severityRank: 문자열 사전순이 아니라 실제 강도 순이다", () => {
  assert.ok(severityRank("urgent") > severityRank("important"));
  assert.ok(severityRank("important") > severityRank("info"));
});

// ── 프롬프트 ──

test("프롬프트에 보유 종목의 손익·기간·메모가 주입된다", () => {
  const p = buildPulsePrompt({
    now: "2026-07-27 14:00",
    slot: "14:00",
    holdings: [SUMMARY],
    breaking: [],
    recentHeadlines: [],
  });
  assert.match(p, /엔비디아/);
  assert.match(p, /\+20\.00%/); // 평단 100 → 현재가 120
  assert.match(p, /단기/);
  assert.match(p, /HBM 사이클 베팅/);
});

test("프롬프트가 매매 행동 지시를 명시적으로 금지한다", () => {
  const p = buildPulsePrompt({
    now: "2026-07-27 14:00",
    slot: "14:00",
    holdings: [SUMMARY],
    breaking: [],
    recentHeadlines: [],
  });
  assert.match(p, /매매 행동을 지시하지 마라/);
  assert.match(p, /출처 없는 판정은 금지/);
});

test("최근 이슈가 없으면 '(없음)' 으로 표기한다(빈 칸이면 LLM 이 헷갈린다)", () => {
  const p = buildPulsePrompt({
    now: "2026-07-27 14:00",
    slot: "14:00",
    holdings: [SUMMARY],
    breaking: [],
    recentHeadlines: [],
  });
  assert.match(p, /\(없음\)/);
});

test("보유 종목이 없으면 그 사실을 프롬프트에 명시한다", () => {
  const p = buildPulsePrompt({
    now: "2026-07-27 14:00",
    slot: "14:00",
    holdings: [],
    breaking: [],
    recentHeadlines: [],
  });
  assert.match(p, /보유 종목이 등록되지 않았습니다/);
});
