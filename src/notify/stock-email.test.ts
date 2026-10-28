import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStockEmailHtml, buildStockEmailParts, stockIMessageText, subjectOf } from "./stock-email.ts";
import { MARKET, MUTED } from "./email-kit.ts";
import type { StockAnalysis, StockPositionReview, StockSnapshot, StockWatchItem } from "../../shared/types.ts";

const DISCLAIMER = "본 정보는 투자 권유가 아니며 투자 판단의 책임은 본인에게 있습니다.";

function analysis(over: Partial<StockAnalysis> = {}): StockAnalysis {
  return {
    symbol: "005930",
    name: "삼성전자",
    quoteCode: "005930",
    close: 346500,
    changePct: 1.2,
    weekChangePct: 3.4,
    currency: "KRW",
    history: [],
    ma5: 340000,
    ma20: 330000,
    summary: "외국인 순매수 지속",
    outlook: "박스권 상단 시험",
    rationale: "HBM 수요 코멘트",
    risks: "환율 변동성",
    verdict: "📈",
    verified: true,
    ...over,
  };
}

function snapshot(over: Partial<StockSnapshot> = {}): StockSnapshot {
  return {
    market: "kr",
    date: "2026-07-17",
    sessionDate: "2026-07-17",
    updatedAt: "2026-07-17T18:00:00+09:00",
    source: "llm",
    closed: false,
    closedReason: null,
    indices: [
      {
        name: "코스피",
        value: 3245.12,
        changePct: 0.8,
        history: [],
        comment: "반도체 주도 상승",
        outlook: "상승 흐름 유지",
        rationale: "외국인 수급 개선",
      },
      {
        name: "코스닥",
        value: 837.43,
        changePct: -1.2,
        history: [],
        comment: "개인 매도",
        outlook: "약세",
        rationale: "차익 실현",
      },
    ],
    news: [
      {
        title: "연준 금리 동결",
        source: "연합뉴스",
        date: "2026-07-17",
        summary: "동결 결정",
        link: "https://example.com/a",
        bucket: "해외 시장",
      },
      {
        title: "원화 강세",
        source: "한국경제",
        date: "2026-07-17",
        summary: "환율 하락",
        link: null,
        bucket: "환율·금리",
      },
    ],
    analyses: [analysis()],
    watchlist: [
      { ...analysis({ symbol: "000660", name: "SK하이닉스" }), attention: "🔥강", levels: "20만원 지지" } as StockWatchItem,
    ],
    disclaimer: DISCLAIMER,
    notes: null,
    ...over,
  };
}

const EMPTY = snapshot({ indices: [], news: [], analyses: [], watchlist: [] });

/** 본문 섹션 제목(h2)을 순서대로 — 옆에 붙는 Mono 건수는 떼어 낸다. */
function headings(html: string): string[] {
  return [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").replace(/\s+\d+\s*$/, "").trim()
  );
}

/** 종합 테이블 구간(마지막 섹션 머리 ~ 각주 앞). */
function summarySection(html: string): string {
  return html.slice(html.lastIndexOf("<h2"));
}

// ── stockIMessageText ──────────────────────────────────────────

test("stockIMessageText: 정상 스냅샷 — 헤더·지수·건수·면책", () => {
  const t = stockIMessageText(snapshot());
  assert.match(t, /🇰🇷 국내증시 브리핑 \(2026-07-17\)/);
  assert.match(t, /코스피 3,245\.12 ▲0\.8%/);
  assert.match(t, /코스닥 837\.43 ▼1\.2%/); // 하락은 ▼
  assert.match(t, /등록 1종목 · 관심 1종목/);
  assert.match(t, /📧 메일 확인!/);
  assert.ok(t.includes("투자 권유가 아니며")); // 면책 필수
});

test("stockIMessageText: 미국장이면 국기·제목이 바뀐다", () => {
  const t = stockIMessageText(snapshot({ market: "us" }));
  assert.match(t, /🇺🇸 미국증시 브리핑/);
});

test("stockIMessageText: 휴장이면 사유만 알리고 메일 유도를 하지 않는다", () => {
  const t = stockIMessageText(snapshot({ closed: true, closedReason: "설날", source: "holiday" }));
  assert.match(t, /😴 휴장 — 설날/);
  assert.doesNotMatch(t, /📧 메일 확인!/);
  assert.ok(t.includes("투자 권유가 아니며"));
});

test("stockIMessageText: 빈 스냅샷에서도 throw 없이 문자열", () => {
  const t = stockIMessageText(EMPTY);
  assert.equal(typeof t, "string");
  assert.match(t, /등록 0종목 · 관심 0종목/);
});

test("stockIMessageText: 길이 상한 — 면책이 길어도 500자를 넘지 않는다", () => {
  const t = stockIMessageText(snapshot({ disclaimer: "가".repeat(5000) }));
  assert.ok(t.length <= 500, `실제 길이 ${t.length}`);
  assert.ok(t.endsWith("…")); // 잘렸다는 표시
});

test("stockIMessageText: 지수는 4개까지만 (푸시가 길어지지 않게)", () => {
  const many = Array.from({ length: 8 }, (_, n) => ({
    name: `지수${n}`,
    value: 100,
    changePct: 0,
    history: [],
    comment: null,
    outlook: null,
    rationale: null,
  }));
  const t = stockIMessageText(snapshot({ indices: many, disclaimer: "" }));
  assert.ok(t.includes("지수3"));
  assert.ok(!t.includes("지수4"));
});

// ── buildStockEmailHtml ────────────────────────────────────────

test("buildStockEmailHtml: 상승=빨강(MARKET.up) · 하락=파랑(MARKET.down)", () => {
  const html = buildStockEmailHtml(snapshot());
  assert.match(html, new RegExp(`color:${MARKET.up}[^>]*>▲0\\.80%`)); // 코스피 +0.8%
  assert.match(html, new RegExp(`color:${MARKET.down}[^>]*>▼1\\.20%`)); // 코스닥 -1.2%
  // 쇼핑 리포트(email.ts)의 '하락=초록'이 새어 들어오면 안 된다.
  assert.ok(!html.includes("#2ecc71"));
});

test("buildStockEmailHtml: 보합·값 없음은 회색 '-'", () => {
  const html = buildStockEmailHtml(
    snapshot({ analyses: [analysis({ changePct: 0, weekChangePct: null })], indices: [], watchlist: [] })
  );
  assert.match(html, new RegExp(`color:${MUTED}[^>]*>-<`));
});

test("buildStockEmailHtml: 면책 문구 포함", () => {
  const html = buildStockEmailHtml(snapshot());
  assert.ok(html.includes(DISCLAIMER));
});

test("buildStockEmailHtml: 관심 종목 섹션에 '매수 추천이 아닙니다' 고지", () => {
  const html = buildStockEmailHtml(snapshot());
  assert.ok(html.includes("관심 종목은 시장에서 거론되는 사실을 정리한 것으로 매수 추천이 아닙니다."));
});

test("buildStockEmailHtml: 6개 섹션이 순서대로 렌더된다", () => {
  const html = buildStockEmailHtml(snapshot());
  assert.deepEqual(headings(html), ["24시간 뉴스 브리핑", "지수", "등록 종목", "오늘의 관심 종목", "종합 테이블"]);
  assert.ok(html.indexOf(DISCLAIMER) > html.lastIndexOf("<h2")); // 면책은 마지막
});

test("buildStockEmailHtml: 뉴스는 bucket 별로 그룹된다", () => {
  const html = buildStockEmailHtml(snapshot());
  assert.match(html, /<p [^>]*>해외 시장 <span[^>]*>1<\/span><\/p>/);
  assert.match(html, /<p [^>]*>환율·금리 <span[^>]*>1<\/span><\/p>/);
});

test("buildStockEmailHtml: XSS — 종목명·뉴스의 <script> 가 이스케이프된다", () => {
  const evil = '<script>alert("x")</script>';
  const html = buildStockEmailHtml(
    snapshot({
      analyses: [analysis({ name: evil, summary: evil, rationale: evil, verdict: evil })],
      news: [
        {
          title: evil,
          source: evil,
          date: "2026-07-17",
          summary: evil,
          link: null,
          bucket: evil,
        },
      ],
      notes: evil,
      disclaimer: evil,
    })
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("buildStockEmailHtml: XSS — javascript: 링크는 앵커로 렌더하지 않는다", () => {
  const html = buildStockEmailHtml(
    snapshot({
      news: [
        {
          title: "악성",
          source: "s",
          date: "2026-07-17",
          summary: "x",
          // eslint-disable-next-line no-script-url
          link: "javascript:alert(1)",
          bucket: "기타",
        },
      ],
    })
  );
  assert.ok(!html.includes("javascript:"));
  assert.ok(!html.includes("원문 보기"));
  assert.ok(html.includes("https://example.com") === false);
});

test("buildStockEmailHtml: 빈 배열에서 throw 없이 안내 문구", () => {
  const html = buildStockEmailHtml(EMPTY);
  assert.equal(typeof html, "string");
  assert.ok(html.includes("최근 24시간 내 수집된 뉴스가 없습니다."));
  assert.ok(html.includes("등록된 종목이 없습니다."));
  assert.ok(html.includes("표에 담을 항목이 없습니다."));
  assert.ok(html.includes(DISCLAIMER));
});

test("buildStockEmailHtml: 차트는 chartSymbols 에 든 종목만 img[cid] 를 얻는다", () => {
  const s = snapshot({
    analyses: [analysis({ symbol: "005930" }), analysis({ symbol: "000660", name: "SK하이닉스" })],
  });
  // 미지정 = 차트 없음 (순수 함수 단독 호출 시 첨부가 존재하지 않으므로 img 를 박으면 안 된다)
  assert.ok(!buildStockEmailHtml(s).includes("cid:"));

  const html = buildStockEmailHtml(s, new Set(["005930"]));
  assert.ok(html.includes("cid:chart_kr_005930@dailystock"));
  assert.ok(!html.includes("cid:chart_kr_000660@dailystock"));
});

test("buildStockEmailHtml: 휴장이면 짧은 안내 + 면책만", () => {
  const html = buildStockEmailHtml(snapshot({ closed: true, closedReason: "설날", source: "holiday" }));
  assert.ok(html.includes("휴장일(설날)입니다. 오늘은 브리핑이 없습니다."));
  assert.ok(html.includes(DISCLAIMER));
  assert.deepEqual(headings(html), []); // 본문 섹션은 렌더하지 않는다
});

test("buildStockEmailHtml: rationale 없는 전망은 감춘다(근거 없는 전망 금지)", () => {
  const html = buildStockEmailHtml(
    snapshot({
      indices: [
        {
          name: "코스피",
          value: 3245.12,
          changePct: 0.8,
          history: [],
          comment: "코멘트",
          outlook: "근거없는전망",
          rationale: null,
        },
      ],
      analyses: [],
      watchlist: [],
    })
  );
  assert.ok(!html.includes("근거없는전망"));
});

test("buildStockEmailHtml: verified=false 면 '시세 미검증' 배지", () => {
  const html = buildStockEmailHtml(snapshot({ analyses: [analysis({ verified: false })] }));
  assert.ok(html.includes("시세 미검증"));
  assert.ok(!buildStockEmailHtml(snapshot()).includes("시세 미검증"));
});

// ── 해외 참고 분리 ─────────────────────────────────────────────
// 한국장 브리핑에 NVDA 가 '오늘의 관심 종목'으로, 그것도 원화 표기로 실렸던 사건의 회귀 방지.

function foreignWatch(): StockWatchItem {
  return {
    ...analysis({
      symbol: "NVDA",
      name: "엔비디아",
      quoteCode: "NVDA.O",
      close: 187.42,
      currency: "USD", // verifyWatchlist 가 us 시장 조회 결과로 확정한 통화
    }),
    attention: "🔥강",
    levels: null,
    market: "us",
  };
}

test("buildStockEmailHtml: 타 시장 종목은 관심 종목이 아니라 '해외 참고' 섹션으로 간다", () => {
  const html = buildStockEmailHtml(snapshot({ watchlist: [foreignWatch()] }));
  const foreignAt = html.indexOf("해외 참고");
  assert.ok(foreignAt > 0, "해외 참고 섹션이 렌더되어야 한다");
  // 관심 종목 섹션은 비었으므로 플레이스홀더가 뜬다(해외 항목이 그 자리를 차지하면 안 된다).
  assert.ok(html.includes("오늘 추려진 관심 종목이 없습니다."));
  // 통화는 항목 기준 — 원화로 새면 안 된다.
  assert.ok(html.includes("$187.42"));
  assert.ok(!html.includes("187원"));
});

test("buildStockEmailHtml: 해외 참고는 관심 종목 뒤·종합 테이블 앞에 온다", () => {
  const html = buildStockEmailHtml(snapshot({ watchlist: [foreignWatch()] }));
  const h = headings(html);
  const order = ["오늘의 관심 종목", "해외 참고", "종합 테이블"].map((t) => h.indexOf(t));
  assert.ok(order[0] >= 0 && order[0] < order[1] && order[1] < order[2], `섹션 순서 오류: ${h.join(" / ")}`);
});

test("buildStockEmailHtml: 해외 참고가 0건이면 섹션 자체를 렌더하지 않는다", () => {
  // 평소 0건이 정상이라 '해외 참고 없음' 플레이스홀더는 매일 뜨는 노이즈가 된다.
  assert.ok(!buildStockEmailHtml(snapshot()).includes("해외 참고"));
});

test("buildStockEmailHtml: 종합 테이블에서 해외 항목은 '해외 · 시장명'으로 구분된다", () => {
  // 표에는 시장 컬럼이 없어 묶음 표기에 안 넣으면 섹션에서 분리한 게 표에서 다시 섞인다.
  const table = summarySection(buildStockEmailHtml(snapshot({ watchlist: [foreignWatch()] })));
  const row = table.match(/<tr>(?:(?!<\/tr>)[\s\S])*엔비디아[\s\S]*?<\/tr>/)?.[0] ?? "";
  assert.ok(row.includes("해외 · 미국장"), "해외 항목 행에 시장명이 붙어야 한다");
  assert.ok(!row.includes(">관심<"), "해외 항목이 관심 묶음으로 찍히면 안 된다");
});

test("buildStockEmailHtml: 미국장 브리핑의 종합 테이블에서 한국 종목은 '국내 · 한국장'", () => {
  // 한국 사용자에게 삼성전자를 '해외'라 부르면 틀린 말이다 — 묶음 표기도 시장 상대적이다.
  const kr: StockWatchItem = { ...analysis(), attention: "⚡중", levels: null, market: "kr" };
  const table = summarySection(buildStockEmailHtml(snapshot({ market: "us", watchlist: [kr] })));
  assert.ok(table.includes("국내 · 한국장"));
  assert.ok(!table.includes("해외 · 한국장"));
});

test("buildStockEmailHtml: 미국장 브리핑의 한국 종목은 '국내(한국) 참고'로 부른다", () => {
  // 한국 사용자에게 삼성전자를 '해외'라 부르면 틀린 말이다 — 라벨은 시장 상대적이다.
  const kr: StockWatchItem = { ...analysis(), attention: "⚡중", levels: null, market: "kr" };
  const html = buildStockEmailHtml(snapshot({ market: "us", watchlist: [kr] }));
  assert.ok(html.includes("국내(한국) 참고"));
});

test("stockIMessageText: 관심 건수는 자국 기준이고 해외 참고는 있을 때만 덧붙는다", () => {
  const s = snapshot({ watchlist: [foreignWatch()] });
  assert.match(stockIMessageText(s), /등록 1종목 · 관심 0종목 · 해외참고 1종목/);
  // 해외 항목이 없으면 기존 문구 그대로(불필요한 500자 예산 소모 없음)
  assert.match(stockIMessageText(snapshot()), /등록 1종목 · 관심 1종목$/m);
});

test("하위호환: market 태그 없는 옛 스냅샷은 전부 관심 종목으로 렌더된다", () => {
  // loadFromDisk 가 `as StockSnapshot` 캐스트라 옛 JSON 이 그대로 흐른다.
  // 후퇴 방지 가드 때문에 옛 파일이 며칠씩 서빙될 수 있어 실제로 밟히는 경로다.
  const legacy = snapshot(); // watchlist 항목에 market 키가 없다
  assert.equal(legacy.watchlist[0].market, undefined);
  const html = buildStockEmailHtml(legacy);
  assert.ok(html.includes("SK하이닉스"));
  assert.ok(!html.includes("해외 참고"));
  assert.match(stockIMessageText(legacy), /관심 1종목/);
});

// ── 역할 라벨 (마감결산 / 개장프리뷰) ────────────────────────────────
//
// 역할 분리 전에는 같은 날 두 슬롯의 subject 가 `🇺🇸 미국증시 브리핑 - 2026-07-20` 으로
// **바이트 단위로 동일**했다(s.date 가 KST 수집일이라 두 런이 같은 값). From/To 까지 같아
// Gmail 이 두 통을 한 스레드로 병합했고 두 번째 메일이 접혔다. 아래가 그 회귀 방지선이다.

test("subject — role 이 없으면 현행 문자열 그대로(구 스냅샷·단일 슬롯 하위호환)", () => {
  assert.equal(subjectOf(snapshot()), "🇰🇷 국내증시 브리핑 - 2026-07-17");
  assert.equal(
    subjectOf(snapshot({ market: "us", role: "both" })),
    "🇺🇸 미국증시 브리핑 - 2026-07-17"
  );
});

test("subject — 두 역할의 제목이 서로 달라야 한다(Gmail 스레드 병합 방지)", () => {
  const close = subjectOf(
    snapshot({ market: "us", role: "close", date: "2026-07-20", sessionDate: "2026-07-17" })
  );
  const preview = subjectOf(
    snapshot({ market: "us", role: "preview", date: "2026-07-20", sessionDate: "2026-07-20" })
  );
  assert.notEqual(close, preview, "같은 날 두 슬롯의 제목이 동일하면 Gmail 이 스레드로 묶는다");
  // 역할 토큰이 있어야 한다 — 날짜만 다르면 사용자가 무엇이 결산인지 외워야 한다.
  assert.match(close, /마감결산/);
  assert.match(close, /2026-07-17/);
  assert.match(preview, /개장프리뷰/);
  assert.match(preview, /2026-07-20/);
});

test("본문 h1 도 역할별로 갈린다 — 제목만 바꾸면 메일을 연 순간 다시 구분 불가", () => {
  const close = buildStockEmailHtml(
    snapshot({ market: "us", role: "close", date: "2026-07-20", sessionDate: "2026-07-17" })
  );
  assert.match(close, /미국증시 마감결산/);
  assert.match(close, /간밤 뉴욕장\(2026-07-17\) 마감 결산/);

  const preview = buildStockEmailHtml(
    snapshot({ market: "us", role: "preview", date: "2026-07-20", sessionDate: "2026-07-20" })
  );
  assert.match(preview, /미국증시 개장프리뷰/);
  // ⚠️ 프리뷰는 sessionDate 와 date 가 같다. 예전 `sessionDate !== date` 조건부 병기였다면
  // 대상 세션 표기가 통째로 사라졌을 자리다.
  assert.match(preview, /오늘 밤\(2026-07-20\) 뉴욕장 개장 프리뷰/);
});

test("iMessage head 에도 역할 토큰이 들어간다(잠금화면은 첫 줄만 보인다)", () => {
  const close = stockIMessageText(
    snapshot({ market: "us", role: "close", date: "2026-07-20", sessionDate: "2026-07-17" })
  );
  assert.match(close.split("\n")[0], /마감결산/);
  const preview = stockIMessageText(
    snapshot({ market: "us", role: "preview", date: "2026-07-20", sessionDate: "2026-07-20" })
  );
  assert.match(preview.split("\n")[0], /개장프리뷰/);
  // role 없는 구 스냅샷은 현행 문구 유지.
  assert.match(stockIMessageText(snapshot()).split("\n")[0], /국내증시 브리핑/);
});

// ── 조간 브리핑 지면(email-kit) ───────────────────────────────────────
// 화면과 같은 문법: 상자·굵은 왼쪽 색 테두리·제목 앞 이모지·하드코딩 링크색·노란 경고 상자를 쓰지 않는다.

function position(over: Partial<StockPositionReview> = {}): StockPositionReview {
  return {
    id: 1,
    market: "kr",
    symbol: "005930",
    name: "삼성전자",
    quoteCode: "005930",
    exchange: "KOSPI",
    quantity: 10,
    avgPrice: 213_500,
    targetPrice: 300_000,
    stopPrice: 200_000,
    horizon: "mid",
    memo: "",
    sortOrder: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    close: 346_500,
    changePct: 1.2,
    currency: "KRW",
    pnlPct: 62.3,
    pnlAmount: 1_330_000,
    marketValue: 3_465_000,
    toTargetPct: -13.42,
    toStopPct: -42.28,
    history: [],
    factors: "HBM 공급 계약 보도로 수급 우호적",
    pulseSummary: "장중 외국인 순매수 전환",
    ...over,
  };
}

function points(n: number, start = 330_000): StockAnalysis["history"] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    close: start + i * 1_000,
    prevClose: null,
    changePct: null,
    volume: null,
    currency: "KRW",
  }));
}

test("지면: 옛 카드 모양(상자·왼쪽 굵은 테두리·노란 상자·flex·하드코딩 링크색)이 없다", () => {
  const full = snapshot({ positions: [position()], watchlist: [...snapshot().watchlist, foreignWatch()] });
  for (const html of [
    buildStockEmailHtml(full, new Set(["005930"])),
    buildStockEmailHtml(snapshot({ closed: true, closedReason: "설날", source: "holiday" })),
    buildStockEmailHtml(EMPTY),
  ]) {
    for (const bad of ["border-left:4px", "border-radius:8px", "#fff3cd", "#f8f9fa", "display:flex", "#4361ee"]) {
      assert.ok(!html.includes(bad), `옛 모양 '${bad}' 이 남아 있다`);
    }
  }
});

test("지면: 섹션 제목·행에 장식 이모지가 없다(제목 h1 의 국기 포함)", () => {
  const html = buildStockEmailHtml(snapshot({ positions: [position()], notes: "참고 메모" }));
  for (const e of ["💼", "🌍", "📊", "📈", "📉", "💡", "📋", "📝", "📌", "🔗", "📅", "🎯", "🛡", "⏱", "🔥", "🇰🇷"]) {
    assert.ok(!html.includes(e), `이모지 ${e} 가 남아 있다`);
  }
  assert.match(html, /<h1[^>]*>국내증시 브리핑<\/h1>/);
  assert.ok(html.includes("참고 메모")); // notes 는 이모지만 떼고 그대로 싣는다
  // 메일 제목(subject)은 그대로 국기를 단다 — 필터·검색 보증.
  assert.equal(subjectOf(snapshot()), "🇰🇷 국내증시 브리핑 - 2026-07-17");
});

test("지면: 전망·주목 강도 이모지는 화면과 같은 글씨 태그로 바뀐다", () => {
  const html = buildStockEmailHtml(snapshot());
  assert.match(html, /<span [^>]*>상승 전망<\/span>/); // verdict 📈
  assert.match(html, /<span [^>]*>주목 강<\/span>/); // attention 🔥강
  const down = buildStockEmailHtml(snapshot({ analyses: [analysis({ verdict: "📉" })] }));
  assert.ok(down.includes("하락 전망"));
  const flat = buildStockEmailHtml(snapshot({ analyses: [analysis({ verdict: "➡️" })] }));
  assert.ok(flat.includes("보합 전망"));
});

test("지면: 해외 참고 항목은 시장명 태그를 단다", () => {
  const html = buildStockEmailHtml(snapshot({ watchlist: [foreignWatch()] }));
  assert.match(html, /<span [^>]*>미국장<\/span>/);
});

test("지면: 서술은 화면과 같은 라벨(요약·전망·근거·리스크·주목 가격대)로 싣는다", () => {
  const html = buildStockEmailHtml(snapshot());
  for (const label of ["요약", "전망", "근거", "리스크", "주목 가격대"]) {
    assert.match(html, new RegExp(`>${label}</div>`), `라벨 '${label}' 누락`);
  }
  // 정보는 빠지지 않는다.
  for (const text of ["외국인 순매수 지속", "박스권 상단 시험", "HBM 수요 코멘트", "환율 변동성", "20만원 지지"]) {
    assert.ok(html.includes(text), `'${text}' 누락`);
  }
});

test("지면: 면책 문구는 각주, 관심 종목 고지는 안내 띠(notice)", () => {
  const html = buildStockEmailHtml(snapshot());
  // 각주는 지면 맨 아래 — 본문 마지막 섹션보다 뒤.
  assert.ok(html.indexOf(DISCLAIMER) > html.lastIndexOf("<h2"));
  assert.match(
    html,
    /border-left:3px solid [^;]+;[^>]*>관심 종목은 시장에서 거론되는 사실을 정리한 것으로 매수 추천이 아닙니다\.<\/td>/
  );
});

// ── 내 포지션 점검 ──

test("포지션: 섹션은 맨 앞, 목표·손절은 거리 텍스트, 펄스는 라벨 + 본문", () => {
  const html = buildStockEmailHtml(snapshot({ positions: [position()] }));
  assert.equal(headings(html)[0], "내 포지션 점검");
  assert.ok(html.includes("목표 <strong"));
  assert.match(html, /목표 <strong[^>]*>300,000원<\/strong> \(-13\.42%\)/);
  assert.match(html, /손절 <strong[^>]*>200,000원<\/strong> \(-42\.28%\)/);
  assert.ok(html.includes("+62.30%")); // 손익률
  assert.match(html, new RegExp(`color:${MARKET.up}[^>]*>\\+62\\.30%`)); // 이익은 상승색
  assert.ok(html.includes("평단 213,500원"));
  assert.ok(html.includes("10주"));
  assert.ok(html.includes("HBM 공급 계약 보도로 수급 우호적"));
  assert.match(html, />지난 24시간 실시간 취합<\/div><div[^>]*>장중 외국인 순매수 전환<\/div>/);
  assert.ok(html.includes("손익·거리 수치는 서버가 계산한 값이며, 서술은 AI 영향도 판정입니다. 매매 권유가 아닙니다."));
});

test("포지션: 손실은 하락색, 목표·손절이 없으면 거리 줄을 그리지 않는다", () => {
  const html = buildStockEmailHtml(
    snapshot({ positions: [position({ pnlPct: -4.5, targetPrice: null, stopPrice: null, pulseSummary: null })] })
  );
  assert.match(html, new RegExp(`color:${MARKET.down}[^>]*>-4\\.50%`));
  assert.ok(!html.includes("목표 <strong"));
  assert.ok(!html.includes("손절 <strong"));
  assert.ok(!html.includes("지난 24시간 실시간 취합"));
});

test("포지션: 보유 종목이 없으면 섹션 자체가 없다", () => {
  const html = buildStockEmailHtml(snapshot());
  assert.ok(!headings(html).includes("내 포지션 점검"));
  assert.ok(!html.includes("매매 권유가 아닙니다"));
});

test("포지션: XSS — 서술·이름이 이스케이프된다", () => {
  const evil = '<script>alert("x")</script>';
  const html = buildStockEmailHtml(snapshot({ positions: [position({ name: evil, factors: evil, pulseSummary: evil })] }));
  assert.ok(!html.includes("<script>"));
});

// ── buildStockEmailParts (미리보기·발송 공용) ──

test("buildStockEmailParts: pinned + 시계열 있는 종목만 차트 첨부를 얻고 본문 cid 와 짝이 맞는다", () => {
  const s = snapshot({
    analyses: [
      analysis({ symbol: "005930", history: points(20) }),
      analysis({ symbol: "000660", name: "SK하이닉스", history: points(20, 200_000) }),
      analysis({ symbol: "035420", name: "NAVER", history: [] }),
    ],
  });
  const { html, attachments } = buildStockEmailParts(s, new Set(["005930", "035420"]));
  // 035420 은 pinned 지만 시계열이 비어 건너뛴다. 000660 은 pinned 가 아니다.
  assert.deepEqual(
    attachments.map((a) => a.cid),
    ["chart_kr_005930@dailystock"]
  );
  assert.equal(attachments[0].contentType, "image/png");
  assert.deepEqual(attachments[0].content.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.ok(html.includes('src="cid:chart_kr_005930@dailystock"'));
  assert.ok(!html.includes("cid:chart_kr_000660"));
  assert.ok(!html.includes("cid:chart_kr_035420"));
});

test("buildStockEmailParts: 휴장이면 첨부 없이 휴장 안내만", () => {
  const { html, attachments } = buildStockEmailParts(
    snapshot({ closed: true, closedReason: "설날", source: "holiday", analyses: [analysis({ history: points(5) })] }),
    new Set(["005930"])
  );
  assert.equal(attachments.length, 0);
  assert.ok(!html.includes("cid:"));
  assert.ok(html.includes("휴장일(설날)입니다."));
});

test("buildStockEmailParts: 차트 이미지는 테두리·둥근 모서리 없이 폭만 맞춘다", () => {
  const { html } = buildStockEmailParts(
    snapshot({ analyses: [analysis({ history: points(3) })] }),
    new Set(["005930"])
  );
  const img = html.match(/<img [^>]*>/)?.[0] ?? "";
  assert.ok(img.includes('width="540"'));
  // 로드 전에도 PNG 비율(540:200)만큼 자리를 잡아야 스크롤 중 글이 밀리지 않는다.
  assert.ok(img.includes('height="200"'));
  assert.ok(img.includes("height:auto"));
  assert.ok(img.includes("max-width:540px"));
  assert.ok(!img.includes("border-radius"));
});
