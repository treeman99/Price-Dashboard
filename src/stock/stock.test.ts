import { test } from "node:test";
import assert from "node:assert/strict";
import { indexCards, pickWatchCandidate, resolveSession } from "./stock.ts";
import { holidaySnapshot } from "./curate.ts";
import { isMarketClosed } from "./calendar.ts";
import type { StockSearchCandidate } from "../../shared/types.ts";

// verifyWatchlist 는 searchTicker/fetchHistory 를 모듈 최상위에서 import 해 단위 테스트가
// 어렵다. 라우팅 판정(어느 시장 후보를 고르는가)만 순수 함수로 분리해 여기서 못박는다.
// 네트워크 경로(fetchHistory 에 hit.market 을 넘기는지)는 코드 리뷰·로그로 확인한다.

const SAMSUNG: StockSearchCandidate = {
  market: "kr",
  symbol: "005930",
  name: "삼성전자",
  quoteCode: "005930",
  exchange: "코스피",
};
const NVDA: StockSearchCandidate = {
  market: "us",
  symbol: "NVDA",
  name: "엔비디아",
  quoteCode: "NVDA.O",
  exchange: "나스닥",
};

test("한국장: KRX 종목은 그대로 관심 종목으로 채택된다", () => {
  const hit = pickWatchCandidate([SAMSUNG, NVDA], "kr", "005930", "삼성전자");
  assert.equal(hit?.market, "kr");
  assert.equal(hit?.symbol, "005930");
});

test("한국장에 미국 티커가 오면 타 시장 후보로 라우팅된다(해외 참고 + 그 시장 quoteCode)", () => {
  // 네이버 자동완성은 시장 필터를 하지 않아 KOR·USA 후보가 한 응답에 온다 →
  // 추가 검색 호출 없이 해외 라우팅을 판정할 수 있다.
  const hit = pickWatchCandidate([NVDA], "kr", "NVDA", "엔비디아");
  assert.equal(hit?.market, "us", "한국장 브리핑이어도 후보의 실제 시장은 us 여야 한다");
  // quoteCode 는 시장과 짝이다 — 호출부는 이 market 으로 fetchHistory 를 불러야 한다.
  assert.equal(hit?.quoteCode, "NVDA.O");
});

test("미국장의 한국 종목도 대칭으로 라우팅된다", () => {
  const hit = pickWatchCandidate([SAMSUNG], "us", "005930", "삼성전자");
  assert.equal(hit?.market, "kr");
  assert.equal(hit?.quoteCode, "005930");
});

test("자국 후보가 있으면 타 시장보다 우선한다", () => {
  // 같은 심볼이 양쪽 시장에 있을 때 브리핑 시장이 이겨야 한다.
  const dupUs = { ...NVDA, symbol: "005930", quoteCode: "X.O" };
  const hit = pickWatchCandidate([dupUs, SAMSUNG], "kr", "005930", "삼성전자");
  assert.equal(hit?.market, "kr");
});

test("심볼 불일치는 타 시장에서도 폴백하지 않는다 → 드롭(엉뚱한 시세 부착 방지)", () => {
  // '첫 후보' 폴백을 허용하면 LLM 이 심볼을 틀렸을 때 엉뚱한 종목 시세가 붙고
  // 표시명까지 교체돼 화면상 앞뒤가 맞아 보인다. 이 보수성은 타 시장 경로에도 동일하다.
  assert.equal(pickWatchCandidate([SAMSUNG, NVDA], "kr", "999999", "없는종목"), null);
});

test("심볼이 없으면 이름 완전일치만 허용한다", () => {
  assert.equal(pickWatchCandidate([NVDA], "kr", "", "엔비디아")?.market, "us");
  assert.equal(pickWatchCandidate([NVDA], "kr", "", "엔비디아 주식"), null);
});

test("후보가 하나도 없으면 null(→ 드롭)", () => {
  assert.equal(pickWatchCandidate([], "kr", "NVDA", "엔비디아"), null);
});

// ── 표기 흔들림 회복 ──────────────────────────────────────────
// 드롭 정책 전환 이후 '심볼 표기가 조금 다르다'는 곧 소멸이다. KRX 에서 흔한 A접두/선행0 누락과
// LLM 이 symbol 자리에 종목명을 넣는 실수까지는 회복해야 그날 watchlist 가 통째로 비지 않는다.

test("KR 심볼 표기 변형(A005930 / 5930)은 정규화 후 일치한다", () => {
  assert.equal(pickWatchCandidate([SAMSUNG], "kr", "A005930", "삼성전자")?.symbol, "005930");
  assert.equal(pickWatchCandidate([SAMSUNG], "kr", "5930", "삼성전자")?.symbol, "005930");
});

test("symbol 자리에 종목명이 온 경우도 이름 완전일치로 회복한다", () => {
  // normalizeSymbol("삼성전자","kr") 은 숫자가 없어 "" 라 심볼 경로로는 회복 불가능하다.
  assert.equal(pickWatchCandidate([SAMSUNG], "kr", "삼성전자", "삼성전자")?.symbol, "005930");
});

test("정규화 결과가 빈 심볼은 아무 후보에나 매칭되지 않는다(이름도 다르면 드롭)", () => {
  // "" 가 와일드카드가 되면 엉뚱한 종목 시세가 붙는 최악의 경로가 열린다.
  assert.equal(pickWatchCandidate([SAMSUNG, NVDA], "kr", "###", "존재하지않는종목"), null);
});

test("이름 폴백도 완전일치만 — 부분일치는 드롭", () => {
  assert.equal(pickWatchCandidate([SAMSUNG], "kr", "A999999", "삼성"), null);
});

test("심볼 일치가 이름 일치보다 우선한다(같은 시장 안에서)", () => {
  // 다른 종목이 우연히 같은 이름을 쓸 때 심볼 근거가 이겨야 한다.
  const 동명이인: StockSearchCandidate = { ...SAMSUNG, symbol: "111111", quoteCode: "111111" };
  const hit = pickWatchCandidate([동명이인, SAMSUNG], "kr", "005930", "삼성전자");
  assert.equal(hit?.symbol, "005930");
});

// ── resolveSession: 역할별 거래일 결정 ────────────────────────────────
//
// 예전에는 이 함수가 private 이라 단위 테스트가 0건이었다. 아래 두 성질은 **테스트 없이는
// 회귀를 감지할 방법이 전혀 없어** 반드시 못박아야 한다:
//   1) 역할별 sessionDate 의 의미 (close=직전 마감 세션 / preview=오늘 밤 세션)
//   2) '모든 뉴욕 세션이 정확히 1회씩 다음 거래일 아침에 결산된다' 불변식
//
// 시각 규약: KST 08:00 (아침 결산 슬롯) = 전일 23:00 UTC / KST 17:00 (오후 프리뷰 슬롯) = 당일 08:00 UTC.

/** KST 날짜 D 의 08:00 에 해당하는 절대 시각. */
function kstMorning(kstDate: string): Date {
  const [y, m, d] = kstDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1, 23, 0, 0));
}

/** KST 날짜 D 의 17:00 에 해당하는 절대 시각. */
function kstAfternoon(kstDate: string): Date {
  const [y, m, d] = kstDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 8, 0, 0));
}

test("resolveSession(us/close) — 월요일 아침은 금요일 마감 세션을 결산한다", async () => {
  // 2026-07-20(월) 08:00 KST = 뉴욕 07-19(일) 19:00. 일·토는 휴장이라 07-17(금)까지 역스캔.
  // 금요일 마감 결산이 주말을 건너 월요일 아침으로 이월되는 것이 설계된 동작이다.
  const r = await resolveSession("us", kstMorning("2026-07-20"), "2026-07-20", "close");
  assert.equal(r.holiday, false);
  assert.equal(r.sessionDate, "2026-07-17");
});

test("resolveSession(us/preview) — 오후 런은 '오늘 밤 열릴' 세션을 대상으로 한다", async () => {
  const r = await resolveSession("us", kstAfternoon("2026-07-20"), "2026-07-20", "preview");
  assert.equal(r.holiday, false);
  // close 의 2026-07-17 과 달리 **오늘**(KST 날짜 = 오늘 밤 뉴욕 날짜)이다.
  assert.equal(r.sessionDate, "2026-07-20");
});

test("resolveSession — 오늘 저녁 프리뷰한 세션을 내일 아침에 결산한다(불변식)", async () => {
  const preview = await resolveSession("us", kstAfternoon("2026-07-20"), "2026-07-20", "preview");
  const nextClose = await resolveSession("us", kstMorning("2026-07-21"), "2026-07-21", "close");
  assert.equal(preview.sessionDate, "2026-07-20");
  assert.equal(nextClose.sessionDate, "2026-07-20", "전날 밤 프리뷰한 세션이 다음 아침 결산 대상이어야 한다");
});

test("resolveSession(us/both) — 혼합 역할의 거래일은 close 와 동일(현행 동작 보존)", async () => {
  const both = await resolveSession("us", kstMorning("2026-07-20"), "2026-07-20", "both");
  const close = await resolveSession("us", kstMorning("2026-07-20"), "2026-07-20", "close");
  assert.equal(both.sessionDate, close.sessionDate);
});

// ── 제약: 주말·공휴일에 새 알림이 생기면 안 된다 ──────────────────────

test("주말은 역할과 무관하게 휴장 — 토요일 아침 결산이 새로 생기지 않는다", async () => {
  // 금요일 뉴욕장은 토요일 05:00 KST 에 이미 마감됐지만, 결산 게이트를 '직전 마감 세션이
  // 있는가'로 바꾸면 여기서 **요청된 적 없는 토요일 아침 이메일**이 신설된다.
  // 게이트를 isMarketClosed("us", today_KST) 로 유지했음을 이 테스트가 못박는다.
  for (const role of ["close", "preview", "both"] as const) {
    const sat = await resolveSession("us", kstMorning("2026-07-18"), "2026-07-18", role);
    assert.equal(sat.holiday, true, `토요일 ${role} 이 휴장이 아니다`);
    assert.equal(sat.reason, "주말");
    const sun = await resolveSession("us", kstMorning("2026-07-19"), "2026-07-19", role);
    assert.equal(sun.holiday, true, `일요일 ${role} 이 휴장이 아니다`);
  }
});

test("휴장 스냅샷의 sessionDate 는 역할과 무관하게 '직전 마감 세션'이다", async () => {
  // preview 휴장에서 today 를 넣으면 "2026-07-18(토) 세션" 이라는 존재하지 않는 세션을 표시하게 된다.
  const sat = await resolveSession("us", kstMorning("2026-07-18"), "2026-07-18", "preview");
  assert.equal(sat.sessionDate, "2026-07-17");
});

test("미국 공휴일(2026-07-03 독립기념일 대체휴장)은 두 역할 모두 스킵된다", async () => {
  assert.equal((await isMarketClosed("us", "2026-07-03")).closed, true);
  for (const role of ["close", "preview"] as const) {
    const r = await resolveSession("us", kstMorning("2026-07-03"), "2026-07-03", role);
    assert.equal(r.holiday, true);
  }
  // 다음 거래일(월) 아침이 공휴일 직전 세션(07-02 목)을 이어받는다 — 누락되지 않는다.
  const mon = await resolveSession("us", kstMorning("2026-07-06"), "2026-07-06", "close");
  assert.equal(mon.holiday, false);
  assert.equal(mon.sessionDate, "2026-07-02");
});

test("불변식 — 모든 뉴욕 세션이 정확히 1회씩 결산된다(추수감사절 주 시뮬레이션)", async () => {
  // 게이트가 통과한 KST 날짜마다 아침 결산 대상을 모아, 중복·누락이 없는지 확인한다.
  const collected: string[] = [];
  for (let d = 20; d <= 30; d++) {
    const kstDate = `2026-11-${String(d).padStart(2, "0")}`;
    const r = await resolveSession("us", kstMorning(kstDate), kstDate, "close");
    if (r.holiday) continue; // 이 날은 런이 아예 발화하지 않는다(= 알림 없음)
    collected.push(r.sessionDate as string);
  }
  // 중복 0
  assert.equal(new Set(collected).size, collected.length, `결산이 중복됐다: ${collected.join(",")}`);
  // 엄격 증가 (건너뛴 세션이 있으면 아래 포함 검사에서 걸린다)
  for (let i = 1; i < collected.length; i++) {
    assert.ok(collected[i] > collected[i - 1], `결산 순서가 역전됐다: ${collected.join(",")}`);
  }
  // 추수감사절(11-26 목)은 휴장이라 결산 대상이 될 수 없고,
  // 그 앞뒤 세션(11-25 수 / 11-27 금 조기폐장)은 각각 정확히 1회 결산돼야 한다.
  assert.ok(!collected.includes("2026-11-26"), "휴장일이 결산 대상이 됐다");
  assert.ok(collected.includes("2026-11-25"), "추수감사절 전날 세션이 결산되지 않았다");
  assert.ok(collected.includes("2026-11-27"), "추수감사절 다음날 세션이 결산되지 않았다");
});

// ── 서머타임: EDT/EST 양 체제에서 같은 판정이 나와야 한다 ─────────────

test("EST(겨울) 에서도 아침=직전 마감 / 오후=오늘 밤 세션 대응이 유지된다", async () => {
  // 2026-01-13(화). EST 는 KST = ET + 14 라 08:00 KST = 전일 18:00 ET(마감 후), 17:00 KST = 당일 03:00 ET(개장 전).
  const close = await resolveSession("us", kstMorning("2026-01-13"), "2026-01-13", "close");
  assert.equal(close.holiday, false);
  assert.equal(close.sessionDate, "2026-01-12", "EST 아침 런이 전일 마감 세션을 못 잡았다");

  const preview = await resolveSession("us", kstAfternoon("2026-01-13"), "2026-01-13", "preview");
  assert.equal(preview.sessionDate, "2026-01-13", "EST 오후 런이 오늘 밤 세션을 못 잡았다");
});

test("한국장은 role 과 무관하게 항상 '오늘 세션(개장 전 프리뷰)'이다", async () => {
  // 2026-07-16(목). 밴드는 뉴욕 기준이라 kr 에 새어 들어오면 안 된다.
  // (07-17 은 제헌절 KRX 휴장이라 이 단언에 못 쓴다.)
  for (const role of ["close", "preview", "both"] as const) {
    const r = await resolveSession("kr", kstMorning("2026-07-16"), "2026-07-16", role);
    assert.equal(r.holiday, false, `kr/${role} 이 휴장으로 판정됐다`);
    assert.equal(r.sessionDate, "2026-07-16");
  }
});

test("한국장 휴장(제헌절)은 다음 거래일을 sessionDate 로 돌려준다", async () => {
  const r = await resolveSession("kr", kstMorning("2026-07-17"), "2026-07-17", "both");
  assert.equal(r.holiday, true);
  assert.equal(r.reason, "제헌절");
  assert.equal(r.sessionDate, "2026-07-20");
});

// ── catch-up 게이트 ──────────────────────────────────────────────────
//
// 슬롯 기준 스냅샷 조회(snapshotForSlot)의 테스트는 **snapshot-store.test.ts** 에 있다.
// 여기 있던 사본(coversSlot)은 삭제했다 — 실제 술어가 아니라 자기 자신을 검사해서,
// 구현에서 슬롯 검사를 통째로 제거해도 초록으로 통과했다(회귀 방어력 0).
// 그 계층은 config.dbPath 기반 디스크 I/O 를 타므로, import 전에 DB_PATH 를 임시 디렉터리로
// 돌릴 수 있는 별도 파일이 필요하다(이 파일은 stock.ts 를 정적 import 해 그럴 수 없다).

// ── 휴장일 지수 유지 ──────────────────────────────────────────────────
//
// 휴장이어도 지수 흐름은 계속 보여야 한다. 예전에는 holidaySnapshot 이 indices 를 무조건
// 빈 배열로 만들어서, 휴장 스냅샷이 최신본으로 뜨는 순간 화면에서 지수 섹션이 통째로 사라지고
// 등록 종목(원장 기반이라 placeholder 로 항상 그려진다)만 남았다.

test("indexCards: 값·등락률을 시계열 마지막 점에서 뽑고 서술은 비운다", () => {
  const cards = indexCards([
    {
      name: "코스피",
      points: [
        { date: "2026-07-23", close: 6000, prevClose: 5940, changePct: 1, volume: null, currency: "KRW" },
        { date: "2026-07-24", close: 6690.62, prevClose: 7096.6, changePct: -5.72, volume: null, currency: "KRW" },
      ],
    },
  ]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].value, 6690.62, "마지막 거래일 종가가 아니다");
  assert.equal(cards[0].changePct, -5.72);
  assert.equal(cards[0].history.length, 2, "스파크라인용 시계열이 보존돼야 한다");
  // 휴장 런은 LLM 을 호출하지 않는다 — 없는 서술을 지어내지 않고 null 로 둔다.
  assert.equal(cards[0].comment, null);
  assert.equal(cards[0].outlook, null);
  assert.equal(cards[0].rationale, null);
});

test("indexCards: 빈 시계열은 값을 null 로 둔다(0 으로 채우면 '보합'처럼 보이는 가짜 시세)", () => {
  const cards = indexCards([{ name: "코스닥", points: [] }]);
  assert.equal(cards[0].value, null);
  assert.equal(cards[0].changePct, null);
  assert.deepEqual(cards[0].history, []);
});

test("holidaySnapshot: 지수를 실어도 휴장 표식(source/closed)은 그대로다", () => {
  const indices = indexCards([
    {
      name: "코스피",
      points: [
        { date: "2026-07-24", close: 6690.62, prevClose: 7096.6, changePct: -5.72, volume: null, currency: "KRW" },
      ],
    },
  ]);
  const snap = holidaySnapshot("kr", "2026-07-25", "2026-07-27", "주말", { role: "both" }, indices);
  assert.equal(snap.source, "holiday", "후퇴 방지 가드가 보는 값이라 'empty' 로 바뀌면 안 된다");
  assert.equal(snap.closed, true);
  assert.equal(snap.indices.length, 1);
  assert.equal(snap.indices[0].value, 6690.62);
  // 지수 기준일(07-24)과 sessionDate(07-27, 다음 거래일)는 다르다. 렌더는 history 에서 읽어야 한다.
  assert.equal(snap.indices[0].history[0].date, "2026-07-24");
  assert.equal(snap.sessionDate, "2026-07-27");
  // 뉴스·분석은 여전히 비어 있다 — 휴장에 채우는 것은 지수뿐이다.
  assert.deepEqual(snap.news, []);
  assert.deepEqual(snap.analyses, []);
});

test("holidaySnapshot: 지수 인자를 생략하면 기존 동작(빈 배열) — 조회 실패 시의 폴백", () => {
  const snap = holidaySnapshot("us", "2026-07-25", "2026-07-24", "주말");
  assert.deepEqual(snap.indices, []);
});
