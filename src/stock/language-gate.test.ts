import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StockAnalysis, StockSnapshot, StockWatchItem } from "../../shared/types.ts";

/**
 * 증시 언어 게이트. 실제 data/ 를 건드리지 않도록 config 를 읽기 전에 DB_PATH 를 갈아끼우고,
 * LLM 은 실행기 주입으로 대체한다.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-language-gate-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");

const { __setAgentQueryDepsForTest } = await import("../util/agent-query.ts");
const { fingerprint } = await import("../../shared/pulse.ts");
const { curateStock } = await import("./curate.ts");
const { applyLanguageGate, correctionRejection, gatePulseLanguage, gateSnapshotLanguage } =
  await import("./language-gate.ts");
type NormalizedPulse = import("./pulse-prompt.ts").NormalizedPulse;

interface AgentCall {
  prompt: string;
  options: Record<string, unknown>;
  timeoutMs: number;
  label: string;
}
const calls: AgentCall[] = [];
let reply: (call: AgentCall) => string = () => "{}";

const record = async (
  prompt: string,
  options: unknown,
  timeoutMs: number,
  label: string
): Promise<string> => {
  const call = { prompt, options: options as Record<string, unknown>, timeoutMs, label };
  calls.push(call);
  return reply(call);
};
const restoreAgent = __setAgentQueryDepsForTest({
  runClaude: record,
  runCodex: record,
  recordFallback: () => false,
  clearFallback: () => false,
});

after(() => {
  restoreAgent();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  reply = () => "{}";
});

/** 프롬프트에 담긴 입력 JSON 을 꺼낸다. */
function payloadOf(call: AgentCall): Record<string, string> {
  return JSON.parse(call.prompt.slice(call.prompt.indexOf("입력:\n") + 4));
}

const DIRTY = "服务器过去24小时实时 취합为 특이사항 없음이다. 둘째 문장은 +12.1% 이다.";
const FIXED = "지난 24시간 실시간 취합은 특이사항 없음이다. 둘째 문장은 +12.1% 이다.";
const AFTER_DROP = "둘째 문장은 +12.1% 이다.";

function field(text: string, extra: { whole?: boolean; maxLen?: number } = {}) {
  const out = { value: text };
  return {
    out,
    field: {
      path: "t",
      text,
      maxLen: extra.maxLen ?? 1000,
      whole: extra.whole,
      apply: (t: string) => {
        out.value = t;
      },
    },
  };
}

// ── 교정 결과 검증 ──

test("교정 검증 — 정상 교정은 통과한다", () => {
  assert.equal(correctionRejection(DIRTY, FIXED, 1000), null);
});

test("교정 검증 — 숫자 변조를 거부한다(바뀜·빠짐·추가)", () => {
  assert.equal(correctionRejection(DIRTY, FIXED.replace("+12.1%", "+13.1%"), 1000), "숫자 변조");
  assert.equal(correctionRejection(DIRTY, FIXED.replace("24시간", "하루"), 1000), "숫자 변조");
  assert.equal(correctionRejection(DIRTY, `${FIXED} 목표 300달러.`, 1000), "숫자 변조");
});

test("교정 검증 — 비었거나 형식이 틀리면 거부한다", () => {
  assert.equal(correctionRejection(DIRTY, "   ", 1000), "결과 없음");
  assert.equal(correctionRejection(DIRTY, undefined, 1000), "결과 없음");
  assert.equal(correctionRejection(DIRTY, 123, 1000), "결과 없음");
});

test("교정 검증 — 외국 문자가 남으면 거부한다", () => {
  assert.equal(correctionRejection(DIRTY, `为 ${FIXED}`, 1000), "외국 문자 잔존");
});

test("교정 검증 — 길이 상한을 넘으면 거부한다", () => {
  assert.equal(correctionRejection("为 짧다", "가".repeat(11), 10), "길이 초과");
  // 폴백처럼 원문이 상한보다 긴 필드는 원문 길이까지 허용한다.
  assert.equal(correctionRejection("为" + "가".repeat(19), "나".repeat(20), 10), null);
});

test("교정 검증 — 원문에 없던 매매 지시 표현이 생기면 거부한다", () => {
  assert.equal(
    correctionRejection("분析师 买入 의견", "애널리스트는 매수를 권고했다", 1000),
    "매매 지시 표현 추가"
  );
  // 원문에도 있던 표현(외국인 순매수 서술)은 교정 때문에 생긴 것이 아니다.
  assert.equal(correctionRejection("외국인 매수 우위 为", "외국인 매수 우위다", 1000), null);
});

// ── 처리 순서 ──

test("오염이 없으면 LLM 을 부르지 않고 텍스트도 그대로다", async () => {
  const a = field("美 8월 CPI 발표를 앞두고 전분기比 70%↑ 흐름이다.");
  const r = await applyLanguageGate([a.field], "t");
  assert.equal(calls.length, 0);
  assert.deepEqual(r, { detected: 0, corrected: 0, replaced: 0 });
  assert.equal(a.out.value, "美 8월 CPI 발표를 앞두고 전분기比 70%↑ 흐름이다.");
});

test("오염 필드만 교정 모드(무도구·1턴·짧은 타임아웃)로 1회 넘긴다", async () => {
  reply = () => JSON.stringify({ f1: FIXED });
  const clean = field("깨끗한 문장이다.");
  const dirty = field(DIRTY);
  const r = await applyLanguageGate([clean.field, dirty.field], "라벨");

  assert.equal(calls.length, 1);
  assert.deepEqual(payloadOf(calls[0]), { f1: DIRTY });
  assert.deepEqual(calls[0].options.tools, []);
  assert.equal(calls[0].options.allowedTools, undefined);
  assert.equal(calls[0].options.maxTurns, 1);
  assert.equal(calls[0].timeoutMs, 120_000);
  assert.equal(calls[0].label, "증시 에이전트[language-fix](라벨)");
  assert.deepEqual(r, { detected: 1, corrected: 1, replaced: 0 });
  assert.equal(dirty.out.value, FIXED);
  assert.equal(clean.out.value, "깨끗한 문장이다.");
});

test("교정 예외 → 삼키고 오염 문장 제거로 대체한다", async () => {
  reply = () => {
    throw new Error("Codex 응답 없음");
  };
  const a = field(DIRTY);
  const r = await applyLanguageGate([a.field], "t");
  assert.deepEqual(r, { detected: 1, corrected: 0, replaced: 1 });
  assert.equal(a.out.value, AFTER_DROP);
});

test("JSON 이 아닌 응답 → 문장 제거로 대체한다", async () => {
  reply = () => "죄송합니다";
  const a = field(DIRTY);
  await applyLanguageGate([a.field], "t");
  assert.equal(a.out.value, AFTER_DROP);
});

test("숫자를 바꾼 교정은 그 필드만 버리고 나머지 필드의 교정은 살린다", async () => {
  reply = () =>
    JSON.stringify({ f1: FIXED.replace("+12.1%", "+13.1%"), f2: "취합은 정상이다." });
  const a = field(DIRTY);
  const b = field("취합为 정상이다.");
  const r = await applyLanguageGate([a.field, b.field], "t");
  assert.deepEqual(r, { detected: 2, corrected: 1, replaced: 1 });
  assert.equal(a.out.value, AFTER_DROP);
  assert.equal(b.out.value, "취합은 정상이다.");
});

test("whole 필드는 교정 실패 시 문장을 남기지 않고 비운다", async () => {
  const a = field("정상 문장이다. 为 포함 문장이다.", { whole: true });
  await applyLanguageGate([a.field], "t");
  assert.equal(a.out.value, "");
});

// ── 브리핑 ──

function analysis(over: Partial<StockAnalysis> = {}): StockAnalysis {
  return {
    symbol: "AAPL",
    name: "애플",
    quoteCode: "AAPL.O",
    close: 100,
    changePct: 1,
    weekChangePct: 1,
    currency: "USD",
    history: [],
    ma5: null,
    ma20: null,
    summary: "요약",
    outlook: "전망",
    rationale: "근거",
    risks: "리스크",
    verdict: "➡️",
    verified: true,
    ...over,
  };
}

function snapshot(over: Partial<StockSnapshot> = {}): StockSnapshot {
  return {
    market: "us",
    date: "2026-11-10",
    sessionDate: "2026-11-10",
    updatedAt: "2026-11-10T00:00:00Z",
    source: "llm",
    closed: false,
    closedReason: null,
    indices: [],
    news: [],
    analyses: [],
    watchlist: [],
    disclaimer: "면책",
    notes: null,
    ...over,
  };
}

const holding = {
  symbol: "AMZN",
  name: "아마존",
  market: "us",
  currency: "USD",
} as unknown as NonNullable<StockSnapshot["positions"]>[number];

test("브리핑: 교정 실패 시 필드별 빈값 정책을 따른다", async () => {
  reply = () => {
    throw new Error("실패");
  };
  const watch = {
    ...analysis({ symbol: "NVDA", summary: "为 요약" }),
    attention: "⚡중",
    levels: "为 가격대",
  } as StockWatchItem;
  const s = snapshot({
    indices: [
      {
        name: "나스닥",
        value: 1,
        changePct: 1,
        history: [],
        comment: "为 코멘트",
        outlook: "전망은 유지된다.",
        rationale: "为 근거",
      },
    ],
    news: [
      { title: "服务器 제목", source: "매체", date: "2026-11-10", summary: "요약", link: null, bucket: "b" },
      { title: "정상 제목", source: "IT之家", date: "2026-11-10", summary: "为 요약", link: null, bucket: "b" },
    ],
    analyses: [analysis({ rationale: "为 근거" }), analysis({ symbol: "MSFT", risks: "为 위험" })],
    watchlist: [watch],
    positions: [{ ...holding, factors: "为 요인", pulseSummary: "服务器 요약" }],
    notes: "为 메모",
  });

  await gateSnapshotLanguage(s, "t");

  // 지수: rationale 이 비면 outlook 도 표시하지 않는다.
  assert.deepEqual(
    [s.indices[0].comment, s.indices[0].outlook, s.indices[0].rationale],
    [null, null, null]
  );
  // 뉴스: 제목을 못 고치면 폐기, source 는 검사 대상이 아니다.
  assert.equal(s.news.length, 1);
  assert.equal(s.news[0].source, "IT之家");
  assert.equal(s.news[0].summary, "");
  // 분석: rationale/risks 가 비면 항목 폐기.
  assert.equal(s.analyses.length, 0);
  // 관심 종목: rationale/risks 는 멀쩡하므로 유지, levels 는 null.
  assert.equal(s.watchlist.length, 1);
  assert.equal(s.watchlist[0].summary, "");
  assert.equal(s.watchlist[0].levels, null);
  // 포지션: 항목은 유지하고 factors 는 빈 문자열.
  assert.equal(s.positions?.length, 1);
  assert.equal(s.positions?.[0].factors, "");
  assert.equal(s.positions?.[0].pulseSummary, null);
  assert.equal(s.notes, null);
  assert.equal(calls.length, 1);
});

test("브리핑: 제외 필드(source·name 등)만 외국 문자면 LLM 을 부르지 않는다", async () => {
  const s = snapshot({
    news: [{ title: "정상", source: "IT之家", date: "2026-11-10", summary: "정상", link: "https://a/为", bucket: "b" }],
    analyses: [analysis({ name: "騰訊" })],
  });
  await gateSnapshotLanguage(s, "t");
  assert.equal(calls.length, 0);
  assert.equal(s.news.length, 1);
  assert.equal(s.analyses[0].name, "騰訊");
});

function watchItem(name: string): StockWatchItem {
  return {
    ...analysis({ symbol: "TCEHY", name }),
    attention: "⚡중",
    levels: null,
  } as StockWatchItem;
}

test("브리핑 watchlist name: 교정에 성공하면 그 값을 쓴다", async () => {
  reply = () => JSON.stringify({ f1: "텐센트" });
  const s = snapshot({ watchlist: [watchItem("騰訊")] });
  await gateSnapshotLanguage(s, "t");
  assert.deepEqual(payloadOf(calls[0]), { f1: "騰訊" });
  assert.equal(s.watchlist[0].name, "텐센트");
});

test("브리핑 watchlist name: 교정 실패 시 symbol 로 채우고 항목은 유지한다", async () => {
  reply = () => {
    throw new Error("실패");
  };
  const s = snapshot({ watchlist: [watchItem("騰訊")] });
  await gateSnapshotLanguage(s, "t");
  assert.equal(s.watchlist.length, 1);
  assert.equal(s.watchlist[0].name, "TCEHY");
});

test("브리핑 watchlist name: 교정 결과에 외국 문자가 남아도 symbol 로 채운다", async () => {
  reply = () => JSON.stringify({ f1: "騰訊 홀딩스" });
  const s = snapshot({ watchlist: [watchItem("騰訊")] });
  await gateSnapshotLanguage(s, "t");
  assert.equal(s.watchlist[0].name, "TCEHY");
});

test("curateStock: pulseSummary 폴백(원장 헤드라인)까지 게이트를 지나고 source 는 llm 이다", async () => {
  reply = (call) => {
    if (call.label.includes("language-fix")) {
      const p = payloadOf(call);
      return JSON.stringify(Object.fromEntries(Object.keys(p).map((k) => [k, "취합은 특이사항 없음"])));
    }
    return JSON.stringify({ positions: [{ symbol: "AMZN", factors: "정상 요인", pulseSummary: null }] });
  };
  const snap = await curateStock({
    market: "us",
    today: "2026-11-10",
    sessionDate: "2026-11-10",
    role: "preview",
    now: "2026-11-10 17:00",
    quotes: [],
    indices: [],
    exchangeRate: null,
    positions: [{ holding: { ...holding }, pulseNotes: ["취합为 특이사항 없음"] }],
  });
  assert.equal(snap.source, "llm");
  assert.equal(snap.positions?.[0].pulseSummary, "취합은 특이사항 없음");
  assert.equal(calls.length, 2);
});

test("curateStock: 교정이 실패해도 브리핑은 실패하지 않는다", async () => {
  reply = (call) => {
    if (call.label.includes("language-fix")) throw new Error("타임아웃");
    return JSON.stringify({
      positions: [{ symbol: "AMZN", factors: `${DIRTY}`, pulseSummary: null }],
    });
  };
  const snap = await curateStock({
    market: "us",
    today: "2026-11-10",
    sessionDate: "2026-11-10",
    role: "preview",
    now: "2026-11-10 17:00",
    quotes: [],
    indices: [],
    exchangeRate: null,
    positions: [{ holding: { ...holding }, pulseNotes: [] }],
  });
  assert.equal(snap.source, "llm");
  assert.equal(snap.positions?.[0].factors, AFTER_DROP);
});

// ── 펄스 ──

function pulse(headline: string, name = "애플"): NormalizedPulse {
  return {
    impacts: [
      {
        issueKey: "apple-supply",
        fingerprint: fingerprint("AAPL", "apple-supply"),
        impact: {
          symbol: "AAPL",
          market: "us",
          name,
          direction: "negative",
          severity: "urgent",
          headline,
          rationale: "근거 문장이다.",
          risks: "리스크 문장이다.",
          sources: [{ title: "服务器 원문 제목", origin: "IT之家", url: "https://a", publishedAt: null }],
          trigger: "company",
        },
      },
    ],
    notes: null,
    dropped: 0,
    strippedActions: [],
  };
}

test("펄스: 교정해도 fingerprint·issueKey 는 그대로고 근거 원문 제목은 건드리지 않는다", async () => {
  reply = () => JSON.stringify({ f1: "애플 공급망 차질" });
  const p = pulse("애플 供应链 차질");
  const before = p.impacts[0].fingerprint;
  await gatePulseLanguage(p, "13:00");
  assert.equal(p.impacts[0].impact.headline, "애플 공급망 차질");
  assert.equal(p.impacts[0].fingerprint, before);
  assert.equal(p.impacts[0].issueKey, "apple-supply");
  assert.equal(p.impacts[0].impact.sources[0].title, "服务器 원문 제목");
  assert.equal(p.impacts[0].impact.name, "애플");
});

test("펄스: 교정 후에도 headline 이 오염이면 그 판정을 폐기한다", async () => {
  reply = () => JSON.stringify({ f1: "애플 供应链 차질" });
  const p = pulse("애플 供应链 차질");
  await gatePulseLanguage(p, "13:00");
  assert.equal(p.impacts.length, 0);
});

test("펄스: rationale 에서 문장이 모두 빠지면 판정을 폐기한다", async () => {
  reply = () => {
    throw new Error("실패");
  };
  const p = pulse("정상 헤드라인");
  p.impacts[0].impact.rationale = "为 근거";
  await gatePulseLanguage(p, "13:00");
  assert.equal(p.impacts.length, 0);
});

test("펄스: rationale 에 남는 문장이 있으면 판정을 유지한다", async () => {
  reply = () => {
    throw new Error("실패");
  };
  const p = pulse("정상 헤드라인");
  p.impacts[0].impact.rationale = "为 근거. 정상 근거 문장이다.";
  await gatePulseLanguage(p, "13:00");
  assert.equal(p.impacts.length, 1);
  assert.equal(p.impacts[0].impact.rationale, "정상 근거 문장이다.");
});

test("펄스: headline 앞부분으로 채워진 name 은 교정된 headline 으로 다시 채운다", async () => {
  const raw = "애플 供应链 차질";
  reply = () => JSON.stringify({ f1: "애플 공급망 차질" });
  const p = pulse(raw, raw.slice(0, 40));
  await gatePulseLanguage(p, "13:00");
  // headline 에서 파생된 name 은 별도 필드로 넘기지 않는다.
  assert.deepEqual(payloadOf(calls[0]), { f1: raw });
  assert.equal(p.impacts[0].impact.name, "애플 공급망 차질");
});

test("펄스 name: symbol 유무와 무관하게 검사하고 교정에 성공하면 그 값을 쓴다", async () => {
  for (const symbol of ["AAPL", null]) {
    calls.length = 0;
    reply = () => JSON.stringify({ f1: "반도체 섹터" });
    const p = pulse("정상 헤드라인", "半导体 섹터");
    p.impacts[0].impact.symbol = symbol;
    await gatePulseLanguage(p, "13:00");
    assert.deepEqual(payloadOf(calls[0]), { f1: "半导体 섹터" });
    assert.equal(p.impacts[0].impact.name, "반도체 섹터");
  }
});

test("펄스 name: 교정 예외 시 headline 앞 40자로 채운다", async () => {
  reply = () => {
    throw new Error("실패");
  };
  const headline = "정상 헤드라인 ".repeat(10).trim();
  const p = pulse(headline, "半导体 섹터");
  await gatePulseLanguage(p, "13:00");
  assert.equal(p.impacts.length, 1);
  assert.equal(p.impacts[0].impact.name, headline.slice(0, 40));
});

test("펄스 name: 못 살리면 교정이 끝난 headline 으로 채운다(headline 먼저 처리)", async () => {
  const fixed = "애플 공급망 차질 ".repeat(8).trim();
  reply = () => JSON.stringify({ f1: fixed, f2: "半导体 잔존" });
  const p = pulse("애플 供应链 차질", "半导体 섹터");
  await gatePulseLanguage(p, "13:00");
  assert.deepEqual(payloadOf(calls[0]), { f1: "애플 供应链 차질", f2: "半导体 섹터" });
  assert.equal(p.impacts[0].impact.headline, fixed);
  assert.equal(p.impacts[0].impact.name, fixed.slice(0, 40));
});

test("펄스: 오염이 없으면 LLM 을 부르지 않는다", async () => {
  const p = pulse("美 관세에 애플 약세");
  await gatePulseLanguage(p, "13:00");
  assert.equal(calls.length, 0);
  assert.equal(p.impacts[0].impact.headline, "美 관세에 애플 약세");
});
