import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrompt,
  extractJson,
  normalizeVerdict,
  normalizeAttention,
  normalizeBucket,
  normalizeNewsItem,
  normalizeAnalysisNarrative,
  normalizeWatchNarrative,
  normalizeIndexNarrative,
  normalizeCurated,
  emptySnapshot,
  holidaySnapshot,
  STOCK_DISCLAIMER,
  NEWS_BUCKETS,
  type StockPromptInput,
} from "./curate.ts";

// ── 픽스처 ──

function krInput(over: Partial<StockPromptInput> = {}): StockPromptInput {
  return {
    market: "kr",
    today: "2026-07-17",
    sessionDate: "2026-07-17",
    now: "2026-07-17 08:00",
    quotes: [
      {
        symbol: "005930",
        name: "삼성전자",
        quoteCode: "005930",
        exchange: "코스피",
        close: 346500,
        changePct: 1.23,
        weekChangePct: -2.5,
        ma5: 344000,
        ma20: 339000,
        currency: "KRW",
      },
      {
        symbol: "000660",
        name: "SK하이닉스",
        quoteCode: "000660",
        exchange: "코스피",
        close: null,
        changePct: null,
        weekChangePct: null,
        ma5: null,
        ma20: null,
        currency: "KRW",
      },
    ],
    indices: [
      { name: "코스피", value: 3120.55, changePct: 0.42 },
      { name: "코스닥", value: 837.43, changePct: -0.11 },
    ],
    exchangeRate: { value: 1385.5, changePct: 0.2 },
    ...over,
  };
}

function usInput(over: Partial<StockPromptInput> = {}): StockPromptInput {
  return {
    market: "us",
    today: "2026-07-17",
    sessionDate: "2026-07-16",
    now: "2026-07-17 18:00",
    quotes: [
      {
        symbol: "NVDA",
        name: "엔비디아",
        quoteCode: "NVDA.O",
        exchange: "나스닥 증권거래소",
        close: 295.95,
        changePct: -1.63,
        weekChangePct: 3.1,
        ma5: 298.2,
        ma20: 290.11,
        currency: "USD",
      },
    ],
    indices: [
      { name: "다우", value: 44100.2, changePct: 0.31 },
      { name: "S&P 500", value: 6300.1, changePct: 0.12 },
      { name: "나스닥", value: 20500.9, changePct: -0.44 },
    ],
    exchangeRate: null,
    ...over,
  };
}

// ── buildPrompt: 시장별 분기 ──

test("buildPrompt(kr) — 한국장 개장 전 프리뷰 문구와 KR 전용 주제를 담는다", () => {
  const p = buildPrompt(krInput());
  assert.match(p, /한국장\(KRX\)/);
  assert.match(p, /개장 전/);
  assert.match(p, /한국은행/);
  assert.match(p, /원달러 환율/);
  assert.match(p, /전일 미국장 결과가 오늘 한국장에 미치는 영향/);
  assert.match(p, /아시아 증시/);
  assert.match(p, /외국인·기관 수급/);
  // 미국장 전용 주제는 들어오면 안 된다.
  assert.doesNotMatch(p, /프리마켓/);
  assert.doesNotMatch(p, /FOMC/);
});

test("buildPrompt(us) — 어젯밤 결산 + 오늘 밤 프리뷰 두 성격을 모두 담는다", () => {
  const p = buildPrompt(usInput());
  assert.match(p, /미국장\(뉴욕\)/);
  assert.match(p, /뉴욕 종가 결산/);
  assert.match(p, /오늘 밤 개장 프리뷰/);
  assert.match(p, /CPI·고용·FOMC/);
  assert.match(p, /선물·프리마켓/);
  assert.match(p, /연준/);
  // 한국장 전용 주제는 들어오면 안 된다.
  assert.doesNotMatch(p, /한국은행/);
});

test("buildPrompt — 시장별 뉴스 bucket 목록을 프롬프트에 명시한다", () => {
  const kr = buildPrompt(krInput());
  for (const b of NEWS_BUCKETS.kr) assert.ok(kr.includes(b), `kr 프롬프트에 bucket "${b}" 누락`);
  // 미국장 전용 bucket 이 한국장 프롬프트에 새어 들어가면 안 된다.
  // ("전일 마감"은 KR 조사 주제 문장에도 등장하는 표현이라 판별에 못 쓴다 — US 고유 bucket 으로 확인)
  assert.doesNotMatch(kr, /금리·통화/);
  assert.doesNotMatch(kr, /오늘 밤 일정/);

  const us = buildPrompt(usInput());
  for (const b of NEWS_BUCKETS.us) assert.ok(us.includes(b), `us 프롬프트에 bucket "${b}" 누락`);
  assert.doesNotMatch(us, /"수급"/); // KR 전용 bucket
});

// ── buildPrompt: 시세 표 주입 (LLM 이 숫자를 지어내지 않게 하는 핵심) ──

test("buildPrompt — 등록 종목의 확정 시세를 표로 주입한다", () => {
  const p = buildPrompt(krInput());
  assert.match(p, /삼성전자/);
  assert.match(p, /005930/);
  assert.match(p, /346,500/); // 종가
  assert.match(p, /\+1\.23%/); // 등락률(양수는 + 부호)
  assert.match(p, /-2\.50%/); // 5일 등락률
  assert.match(p, /344,000/); // MA5
  assert.match(p, /339,000/); // MA20
});

test("buildPrompt — 조회 실패 종목은 '조회실패'로 표기해 남긴다(숫자를 지어내지 않게)", () => {
  const p = buildPrompt(krInput());
  assert.match(p, /SK하이닉스/);
  assert.match(p, /조회실패/);
  assert.match(p, /표에 "조회실패"면 그 숫자를 언급하지 마라/);
});

test("buildPrompt — 지수와 환율의 확정 값을 주입한다", () => {
  const p = buildPrompt(krInput());
  assert.match(p, /코스피: 3,120\.55 \(\+0\.42%\)/);
  assert.match(p, /코스닥: 837\.43 \(-0\.11%\)/);
  assert.match(p, /원달러 환율: 1,385\.5 \(\+0\.2/);
});

test("buildPrompt — 환율 조회 실패 시 '조회실패'로 표기한다", () => {
  const p = buildPrompt(usInput());
  assert.match(p, /원달러 환율: 조회실패/);
});

test("buildPrompt — 등록 종목이 없으면 analyses 를 빈 배열로 내라고 지시한다", () => {
  const p = buildPrompt(krInput({ quotes: [] }));
  assert.match(p, /등록된 종목이 없습니다/);
  assert.match(p, /analyses 는 빈 배열로 출력하라/);
});

test("buildPrompt — 대상 거래일/수집일/현재 시각을 명시한다", () => {
  const p = buildPrompt(usInput());
  assert.ok(p.includes("2026-07-16"), "sessionDate 누락");
  assert.ok(p.includes("2026-07-17"), "today 누락");
  assert.ok(p.includes("2026-07-17 18:00"), "now 라벨 누락");
});

test("buildPrompt — sessionDate 가 null 이어도 throw 하지 않는다", () => {
  const p = buildPrompt(krInput({ sessionDate: null }));
  assert.match(p, /거래일 미상/);
});

// ── buildPrompt: 절대 규칙 (투자 권유 금지 / 숫자 위조 금지) ──

test("buildPrompt — 투자 권유 금지 문구가 두 시장 모두에 들어간다", () => {
  for (const p of [buildPrompt(krInput()), buildPrompt(usInput())]) {
    assert.match(p, /투자 권유 금지/);
    assert.match(p, /매수·매도·비중확대/);
    assert.match(p, /절대 쓰지 마라/);
    assert.match(p, /관측 가능한 사실/);
    // 관심 종목이 추천이 아님을 명시
    assert.match(p, /추천이 아니다|추천이 아니라/);
    assert.match(p, /시장에서 왜 거론되는지/);
  }
});

test("buildPrompt — 숫자 위조 금지 문구가 두 시장 모두에 들어간다", () => {
  for (const p of [buildPrompt(krInput()), buildPrompt(usInput())]) {
    assert.match(p, /숫자를 지어내지 마라/);
    assert.match(p, /표의 숫자만 인용하라/);
    assert.match(p, /추정·계산·기억으로 숫자를 채우지 마라/);
    // 서술문 안의 숫자는 서버가 덮어쓸 수 없다는 경고가 핵심이다.
    assert.match(p, /서술문.*안의 숫자는 덮어쓸 수 없다/);
  }
});

test("buildPrompt — rationale/risks 가 필수임을 알린다(비면 폐기)", () => {
  const p = buildPrompt(krInput());
  assert.match(p, /rationale 과 risks 는 필수다/);
  assert.match(p, /폐기된다/);
});

test("buildPrompt — verdict 허용 이모지를 명시한다", () => {
  const p = buildPrompt(krInput());
  for (const v of ["📈", "📉", "➡️"]) assert.ok(p.includes(v), `verdict 이모지 ${v} 누락`);
});

// ── extractJson ──

test("extractJson — 앞뒤 잡텍스트가 있어도 JSON 을 뽑는다", () => {
  const o = extractJson('설명 텍스트\n{"news":[],"notes":null}\n끝') as Record<string, unknown>;
  assert.deepEqual(o, { news: [], notes: null });
});

test("extractJson — JSON 이 없으면 throw", () => {
  assert.throws(() => extractJson("JSON 없음"), /JSON 미발견/);
});

// ── 정규화: verdict / attention / bucket ──

test("normalizeVerdict — 허용 이모지는 통과, 그 외는 중립(➡️)", () => {
  assert.equal(normalizeVerdict("📈"), "📈");
  assert.equal(normalizeVerdict("📉"), "📉");
  assert.equal(normalizeVerdict(" ➡️ "), "➡️");
  assert.equal(normalizeVerdict("매수"), "➡️"); // 투자 권유 표현이 새어 나오면 중립으로 접는다
  assert.equal(normalizeVerdict(undefined), "➡️");
  assert.equal(normalizeVerdict(42), "➡️");
});

test("normalizeAttention — 이모지 누락은 복원하고, 미지 값은 중립(⚡중)", () => {
  assert.equal(normalizeAttention("🔥강"), "🔥강");
  assert.equal(normalizeAttention("강"), "🔥강");
  assert.equal(normalizeAttention("약"), "💧약");
  assert.equal(normalizeAttention("아주강함"), "⚡중");
  assert.equal(normalizeAttention(null), "⚡중");
});

test("normalizeBucket — 시장별 허용 목록 밖이면 마지막 값으로 접는다", () => {
  assert.equal(normalizeBucket("수급", "kr"), "수급");
  assert.equal(normalizeBucket("전일 마감", "us"), "전일 마감");
  // kr 목록에 "전일 마감"은 없다 → fallback
  assert.equal(normalizeBucket("전일 마감", "kr"), "관심 종목 후보");
  assert.equal(normalizeBucket("지어낸분류", "us"), "관심 종목 후보");
  assert.equal(normalizeBucket(undefined, "kr"), "관심 종목 후보");
});

// ── 정규화: 뉴스 ──

test("normalizeNewsItem — 정상 항목을 통과시킨다", () => {
  const n = normalizeNewsItem(
    {
      title: "코스피 상승 마감",
      source: "연합뉴스",
      date: "2026-07-16",
      summary: "외국인 순매수",
      link: "https://example.com/a",
      bucket: "수급",
    },
    "kr"
  );
  assert.deepEqual(n, {
    title: "코스피 상승 마감",
    source: "연합뉴스",
    date: "2026-07-16",
    summary: "외국인 순매수",
    link: "https://example.com/a",
    bucket: "수급",
  });
});

test("normalizeNewsItem — 제목/날짜가 없거나 형식이 틀리면 버린다", () => {
  assert.equal(normalizeNewsItem({ date: "2026-07-16", title: "" }, "kr"), null);
  assert.equal(normalizeNewsItem({ title: "제목", date: "2026/07/16" }, "kr"), null);
  assert.equal(normalizeNewsItem({ title: "제목", date: "어제" }, "kr"), null);
  assert.equal(normalizeNewsItem({ title: "제목" }, "kr"), null);
  assert.equal(normalizeNewsItem(null, "kr"), null);
});

test("normalizeNewsItem — 빈 링크는 null 로 접는다", () => {
  const n = normalizeNewsItem({ title: "t", date: "2026-07-16", link: "   " }, "kr");
  assert.equal(n?.link, null);
});

// ── 정규화: 분석 (rationale/risks 필수) ──

const goodAnalysis = {
  symbol: "005930",
  name: "삼성전자",
  summary: "HBM 공급 계약 보도",
  outlook: "수급 개선 관측",
  rationale: "외국인 5일 연속 순매수",
  risks: "메모리 가격 조정 가능성",
  verdict: "📈",
};

test("normalizeAnalysisNarrative — 정상 항목을 통과시킨다", () => {
  const a = normalizeAnalysisNarrative(goodAnalysis);
  assert.equal(a?.symbol, "005930");
  assert.equal(a?.rationale, "외국인 5일 연속 순매수");
  assert.equal(a?.verdict, "📈");
});

test("normalizeAnalysisNarrative — rationale 이 비면 항목을 폐기한다", () => {
  assert.equal(normalizeAnalysisNarrative({ ...goodAnalysis, rationale: "" }), null);
  assert.equal(normalizeAnalysisNarrative({ ...goodAnalysis, rationale: "   " }), null);
  assert.equal(normalizeAnalysisNarrative({ ...goodAnalysis, rationale: undefined }), null);
});

test("normalizeAnalysisNarrative — risks 가 비면 항목을 폐기한다", () => {
  assert.equal(normalizeAnalysisNarrative({ ...goodAnalysis, risks: "" }), null);
  assert.equal(normalizeAnalysisNarrative({ ...goodAnalysis, risks: "  \n " }), null);
  assert.equal(normalizeAnalysisNarrative({ ...goodAnalysis, risks: null }), null);
});

test("normalizeAnalysisNarrative — symbol 이 없으면 폐기한다(시세를 붙일 수 없다)", () => {
  assert.equal(normalizeAnalysisNarrative({ ...goodAnalysis, symbol: "" }), null);
});

// ── 정규화: 관심 종목 ──

test("normalizeWatchNarrative — attention/levels 를 포함해 통과시킨다", () => {
  const w = normalizeWatchNarrative({ ...goodAnalysis, attention: "🔥강", levels: "35만원 지지" });
  assert.equal(w?.attention, "🔥강");
  assert.equal(w?.levels, "35만원 지지");
});

test("normalizeWatchNarrative — 빈 levels 는 null, rationale 이 비면 폐기(분석과 동일 규칙)", () => {
  assert.equal(normalizeWatchNarrative({ ...goodAnalysis, levels: "" })?.levels, null);
  assert.equal(normalizeWatchNarrative({ ...goodAnalysis, rationale: "" }), null);
});

// ── 정규화: 지수 ──

test("normalizeIndexNarrative — rationale 이 없으면 outlook 을 표시하지 않는다", () => {
  const i = normalizeIndexNarrative({ name: "코스피", comment: "상승", outlook: "추가 상승 관측" });
  assert.equal(i?.comment, "상승");
  assert.equal(i?.outlook, null, "근거(rationale) 없는 전망은 노출하지 않아야 한다");
  assert.equal(i?.rationale, null);
});

test("normalizeIndexNarrative — rationale 이 있으면 outlook 을 유지한다", () => {
  const i = normalizeIndexNarrative({
    name: "코스피",
    comment: "상승",
    outlook: "추가 상승 관측",
    rationale: "반도체 수출 지표 개선",
  });
  assert.equal(i?.outlook, "추가 상승 관측");
  assert.equal(i?.rationale, "반도체 수출 지표 개선");
});

test("normalizeIndexNarrative — name 이 없으면 폐기한다(값을 붙일 수 없다)", () => {
  assert.equal(normalizeIndexNarrative({ comment: "상승" }), null);
});

// ── normalizeCurated ──

test("normalizeCurated — 유효 항목만 남기고 무효 항목을 폐기한다", () => {
  const n = normalizeCurated(
    {
      indices: [{ name: "코스피", comment: "c", rationale: "r", outlook: "o" }, { comment: "이름없음" }],
      news: [
        { title: "정상", date: "2026-07-16", bucket: "수급" },
        { title: "날짜없음" },
      ],
      analyses: [goodAnalysis, { ...goodAnalysis, symbol: "000660", risks: "" }],
      watchlist: [{ ...goodAnalysis, symbol: "035420", name: "네이버", attention: "⚡중" }],
      notes: "  메모  ",
    },
    "kr"
  );
  assert.equal(n.indices.length, 1);
  assert.equal(n.news.length, 1);
  assert.equal(n.analyses.length, 1, "risks 빈 분석은 폐기되어야 한다");
  assert.equal(n.analyses[0].symbol, "005930");
  assert.equal(n.watchlist.length, 1);
  assert.equal(n.notes, "메모");
});

test("normalizeCurated — 등록 종목과 겹치는 watchlist 항목을 제거한다", () => {
  const n = normalizeCurated(
    {
      analyses: [goodAnalysis],
      // 같은 종목(005930)이 관심 종목에도 올라온 경우 — 중복 노출 방지
      watchlist: [{ ...goodAnalysis, attention: "🔥강" }, { ...goodAnalysis, symbol: "035420" }],
    },
    "kr"
  );
  assert.equal(n.watchlist.length, 1);
  assert.equal(n.watchlist[0].symbol, "035420");
});

test("normalizeCurated — 배열이 아닌/누락된 필드를 빈 배열로 접는다", () => {
  const n = normalizeCurated({ news: "배열아님", analyses: null }, "us");
  assert.deepEqual(n.indices, []);
  assert.deepEqual(n.news, []);
  assert.deepEqual(n.analyses, []);
  assert.deepEqual(n.watchlist, []);
  assert.equal(n.notes, null);
});

test("normalizeCurated — 완전 빈 입력에도 throw 하지 않는다", () => {
  const n = normalizeCurated({}, "kr");
  assert.equal(n.news.length, 0);
  assert.equal(normalizeCurated(null, "kr").news.length, 0);
});

// ── 스냅샷 상수 ──

test("emptySnapshot — source='empty' + 면책 문구 포함", () => {
  const s = emptySnapshot("kr", "2026-07-17", "실패 사유");
  assert.equal(s.source, "empty");
  assert.equal(s.market, "kr");
  assert.equal(s.date, "2026-07-17");
  assert.equal(s.closed, false);
  assert.equal(s.disclaimer, STOCK_DISCLAIMER);
  assert.equal(s.notes, "실패 사유");
});

test("holidaySnapshot — source='holiday'(empty 아님) + closed=true", () => {
  const s = holidaySnapshot("kr", "2026-07-17", "2026-07-20", "설날");
  // 'empty'와 구분되어야 후퇴 방지 가드가 휴장을 실패로 오인하지 않는다.
  assert.equal(s.source, "holiday");
  assert.equal(s.closed, true);
  assert.equal(s.closedReason, "설날");
  // ⚠️ date 는 수집일(오늘)이어야 catch-up 이 무한 재시도하지 않는다.
  assert.equal(s.date, "2026-07-17");
  assert.equal(s.sessionDate, "2026-07-20");
  assert.equal(s.disclaimer, STOCK_DISCLAIMER);
});

test("STOCK_DISCLAIMER — 추천 아님·책임 소재를 모두 명시한다", () => {
  assert.match(STOCK_DISCLAIMER, /투자 판단의 근거로 사용하지 마세요/);
  assert.match(STOCK_DISCLAIMER, /매수 추천이 아니며/);
  assert.match(STOCK_DISCLAIMER, /투자 손실 책임은 투자자 본인/);
});
