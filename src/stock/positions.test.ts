import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, normalizeCurated, normalizePositionNarrative, type StockPromptInput, type PositionPromptRow } from "./curate.ts";
import { summarizeHolding } from "../../shared/holdings.ts";
import type { StockHolding } from "../../shared/types.ts";

const HOLD: StockHolding = {
  id: 1,
  market: "kr",
  symbol: "005930",
  name: "삼성전자",
  quoteCode: "005930",
  exchange: "코스피",
  quantity: 50,
  avgPrice: 71000,
  targetPrice: 90000,
  stopPrice: 65000,
  horizon: "long",
  memo: "HBM 증설 사이클",
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const ROW: PositionPromptRow = {
  holding: summarizeHolding(HOLD, { close: 80000, changePct: 1.2, currency: "KRW" }),
  pulseNotes: ["[14:00] 반도체 관세 예외 논의 (문자 발송됨)", "[16:00] 외국인 순매수 전환"],
};

function input(over: Partial<StockPromptInput> = {}): StockPromptInput {
  return {
    market: "kr",
    today: "2026-07-27",
    sessionDate: "2026-07-27",
    role: "both",
    now: "2026-07-27 08:00",
    quotes: [],
    indices: [],
    exchangeRate: null,
    ...over,
  };
}

test("보유 종목이 없으면 포지션 섹션을 통째로 생략한다", () => {
  const p = buildPrompt(input({ positions: [] }));
  assert.doesNotMatch(p, /내 보유 종목/);
  assert.doesNotMatch(p, /positions/);
});

test("보유 종목이 있으면 손익·기간·목표가·손절가·메모가 프롬프트에 들어간다", () => {
  const p = buildPrompt(input({ positions: [ROW] }));
  assert.match(p, /내 보유 종목/);
  assert.match(p, /삼성전자/);
  assert.match(p, /\+12\.68%/); // 71000 → 80000
  assert.match(p, /장기/);
  assert.match(p, /90,000원/); // 목표가
  assert.match(p, /65,000원/); // 손절가
  assert.match(p, /HBM 증설 사이클/);
});

test("지난 24시간 펄스 판정이 프롬프트에 실린다 (문턱 미달 건의 유일한 회수 경로)", () => {
  const p = buildPrompt(input({ positions: [ROW] }));
  assert.match(p, /반도체 관세 예외 논의/);
  assert.match(p, /외국인 순매수 전환/);
  assert.match(p, /이 브리핑이 유일한 전달 경로다/);
});

test("펄스 판정이 없으면 '특이사항 없음'으로 명시한다", () => {
  const p = buildPrompt(input({ positions: [{ ...ROW, pulseNotes: [] }] }));
  assert.match(p, /지난 24시간 실시간 취합: 특이사항 없음/);
});

test("포지션 섹션에도 매매 행동 지시 금지가 명시된다", () => {
  const p = buildPrompt(input({ positions: [ROW] }));
  assert.match(p, /행동 지시는 여기서도 금지/);
  assert.match(p, /거리를 사실로 서술/);
});

test("positions 가 있을 때만 출력 스키마에 positions 키가 들어간다", () => {
  assert.match(buildPrompt(input({ positions: [ROW] })), /"positions":\[\{"symbol"/);
  assert.doesNotMatch(buildPrompt(input({ positions: [] })), /"positions"/);
});

test("normalizePositionNarrative: 심볼이 없으면 폐기(어느 종목인지 특정 불가)", () => {
  assert.equal(normalizePositionNarrative({ symbol: "", factors: "x" }), null);
});

test("normalizePositionNarrative: factors 가 비어도 **폐기하지 않는다**", () => {
  // 분석 항목과 정반대 정책이다 — 폐기하면 내가 보유한 종목이 포트폴리오 점검에서 통째로
  // 빠지고 손익 숫자(서버 계산값)까지 함께 사라진다.
  const n = normalizePositionNarrative({ symbol: "005930", factors: "", pulseSummary: "" });
  assert.ok(n);
  assert.equal(n.symbol, "005930");
  assert.equal(n.factors, "");
  assert.equal(n.pulseSummary, null);
});

test("normalizeCurated: positions 배열을 정규화해 넘긴다", () => {
  const out = normalizeCurated(
    { positions: [{ symbol: "005930", factors: "환율 하락", pulseSummary: "요약" }, { symbol: "" }] },
    "kr"
  );
  assert.equal(out.positions.length, 1);
  assert.equal(out.positions[0].factors, "환율 하락");
});

test("normalizeCurated: positions 키가 없어도 빈 배열 (구 응답 호환)", () => {
  assert.deepEqual(normalizeCurated({ news: [] }, "kr").positions, []);
});
