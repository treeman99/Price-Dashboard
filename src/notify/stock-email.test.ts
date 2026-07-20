import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStockEmailHtml, stockIMessageText, subjectOf } from "./stock-email.ts";
import type { StockAnalysis, StockSnapshot, StockWatchItem } from "../../shared/types.ts";

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

test("buildStockEmailHtml: 상승=빨강(#e74c3c) · 하락=파랑(#2563eb)", () => {
  const html = buildStockEmailHtml(snapshot());
  assert.match(html, /color:#e74c3c[^>]*>▲0\.8%/); // 코스피 +0.8%
  assert.match(html, /color:#2563eb[^>]*>▼1\.2%/); // 코스닥 -1.2%
  // 쇼핑 리포트(email.ts)의 '하락=초록'이 새어 들어오면 안 된다.
  assert.ok(!html.includes("#2ecc71"));
});

test("buildStockEmailHtml: 보합·값 없음은 회색 '-'", () => {
  const html = buildStockEmailHtml(
    snapshot({ analyses: [analysis({ changePct: 0, weekChangePct: null })], indices: [], watchlist: [] })
  );
  assert.match(html, /color:#888888[^>]*>-</);
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
  const order = ["🌍 24시간 뉴스 브리핑", "📊 지수 분석", "📈 등록 종목 분석", "💡 오늘의 관심 종목", "📋 종합 테이블"];
  let at = -1;
  for (const s of order) {
    const i = html.indexOf(s);
    assert.ok(i > at, `${s} 섹션 순서 오류`);
    at = i;
  }
  assert.ok(html.indexOf(DISCLAIMER) > at); // 면책은 마지막
});

test("buildStockEmailHtml: 뉴스는 bucket 별로 그룹된다", () => {
  const html = buildStockEmailHtml(snapshot());
  assert.ok(html.includes("📌 해외 시장"));
  assert.ok(html.includes("📌 환율·금리"));
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
  assert.ok(!html.includes("🔗 원문 보기"));
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
  assert.ok(html.includes("😴 휴장일 (설날)입니다."));
  assert.ok(html.includes(DISCLAIMER));
  assert.ok(!html.includes("📋 종합 테이블")); // 본문 섹션은 렌더하지 않는다
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
  const foreignAt = html.indexOf("🌐 해외 참고");
  assert.ok(foreignAt > 0, "해외 참고 섹션이 렌더되어야 한다");
  // 관심 종목 섹션은 비었으므로 플레이스홀더가 뜬다(해외 항목이 그 자리를 차지하면 안 된다).
  assert.ok(html.includes("오늘 추려진 관심 종목이 없습니다."));
  // 통화는 항목 기준 — 원화로 새면 안 된다.
  assert.ok(html.includes("$187.42"));
  assert.ok(!html.includes("187원"));
});

test("buildStockEmailHtml: 해외 참고는 관심 종목 뒤·종합 테이블 앞에 온다", () => {
  const html = buildStockEmailHtml(snapshot({ watchlist: [foreignWatch()] }));
  const order = ["💡 오늘의 관심 종목", "🌐 해외 참고", "📋 종합 테이블"];
  let at = -1;
  for (const s of order) {
    const i = html.indexOf(s);
    assert.ok(i > at, `${s} 섹션 순서 오류`);
    at = i;
  }
});

test("buildStockEmailHtml: 해외 참고가 0건이면 섹션 자체를 렌더하지 않는다", () => {
  // 평소 0건이 정상이라 '해외 참고 없음' 플레이스홀더는 매일 뜨는 노이즈가 된다.
  assert.ok(!buildStockEmailHtml(snapshot()).includes("🌐 해외 참고"));
});

test("buildStockEmailHtml: 종합 테이블에서 해외 항목은 🌐 + 시장명으로 구분된다", () => {
  // 표에는 시장 컬럼이 없어 라벨에 안 넣으면 카드에서 분리한 게 표에서 다시 섞인다.
  const html = buildStockEmailHtml(snapshot({ watchlist: [foreignWatch()] }));
  assert.ok(html.includes("🌐 엔비디아(미국장)"));
  assert.ok(!html.includes("💡 엔비디아"));
});

test("buildStockEmailHtml: 미국장 브리핑의 한국 종목은 '국내(한국) 참고'로 부른다", () => {
  // 한국 사용자에게 삼성전자를 '해외'라 부르면 틀린 말이다 — 라벨은 시장 상대적이다.
  const kr: StockWatchItem = { ...analysis(), attention: "⚡중", levels: null, market: "kr" };
  const html = buildStockEmailHtml(snapshot({ market: "us", watchlist: [kr] }));
  assert.ok(html.includes("🌐 국내(한국) 참고"));
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
  assert.ok(!html.includes("🌐 해외 참고"));
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
