import { log } from "../util/log.ts";
import { runStockAgent, extractJson as extractAgentJson } from "./agent.ts";
import { localDate } from "../util/date.ts";
import { horizonLabel, formatPnlPct } from "../../shared/holdings.ts";
import { formatPrice } from "../../shared/stock.ts";
import type {
  StockMarket,
  StockSnapshot,
  StockNewsItem,
  StockAnalysis,
  StockWatchItem,
  StockIndex,
  StockPoint,
  StockSlotRole,
  StockHoldingSummary,
  StockPositionReview,
} from "../../shared/types.ts";

/**
 * 전 채널(화면·메일·iMessage) 공통 면책 문구.
 * 이 모듈이 단일 출처 — 스냅샷 생성 경로가 늘어나도 문구가 갈라지지 않게 상수로 고정한다.
 */
export const STOCK_DISCLAIMER =
  "본 분석은 AI가 생성한 참고자료이며, 투자 판단의 근거로 사용하지 마세요. " +
  "관심 종목은 시장에서 거론되는 사실을 정리한 것으로 매수 추천이 아니며, " +
  "투자 손실 책임은 투자자 본인에게 있습니다.";

/** 뉴스 분류(bucket) 후보. LLM 이 엉뚱한 분류를 지어내면 이 목록의 마지막 값으로 접는다. */
export const NEWS_BUCKETS: Record<StockMarket, string[]> = {
  kr: ["해외 시장", "환율·금리", "산업·기업", "수급", "관심 종목 후보"],
  us: ["전일 마감", "금리·통화", "산업·기업", "오늘 밤 일정", "관심 종목 후보"],
};

/**
 * 미국장 **역할별** 뉴스 분류. NEWS_BUCKETS.us 는 결산용("전일 마감")과 프리뷰용
 * ("오늘 밤 일정")이 섞인 혼합(both) 목록이라, 역할을 나누면 각각 반대쪽 버킷이 부적합해진다.
 *
 * ⚠️ **마지막 원소는 의도적으로 "산업·기업" 이다.** normalizeBucket 은 목록 밖 값을 드롭하지
 * 않고 배열의 **마지막 원소로 접는다**. 프리뷰 런에서 모델이 "전일 마감" 을 뱉었을 때 그것이
 * "관심 종목 후보"(= 투자 추천으로 오해될 소지가 있는 자리)로 둔갑하면 안 되므로, 폴백
 * 목적지를 가장 중립적인 버킷으로 고정한다. **목록 순서를 나중에 건드리지 말 것.**
 * (렌더는 이메일·웹 모두 `bucket || "기타"` 동적 그룹핑이라 목록 변경만으로는 깨지지 않는다.)
 */
export const US_NEWS_BUCKETS_BY_ROLE: Record<"close" | "preview", string[]> = {
  close: ["전일 마감", "금리·통화", "관심 종목 후보", "산업·기업"],
  preview: ["오늘 밤 일정", "선물·프리마켓", "금리·통화", "관심 종목 후보", "산업·기업"],
};

/** 이 브리핑에 쓸 뉴스 분류 목록. 미국장 close/preview 만 좁히고 나머지는 현행 목록. */
export function bucketsFor(market: StockMarket, role: StockSlotRole): string[] {
  if (market === "us" && (role === "close" || role === "preview"))
    return US_NEWS_BUCKETS_BY_ROLE[role];
  return NEWS_BUCKETS[market];
}

/** verdict 로 허용되는 이모지. 그 외 값은 중립(➡️)으로 접는다. */
const VERDICTS = ["📈", "📉", "➡️"];

/** 주목 강도 표기. 그 외 값은 중( ⚡ )으로 접는다. */
const ATTENTIONS = ["🔥강", "⚡중", "💧약"];

/**
 * 프롬프트에 주입할 종목 1건의 **확정된 시세**.
 * 이 값들은 전부 quote.ts(네이버) 가 가져온 것이며, LLM 은 인용만 한다.
 */
export interface StockQuoteRow {
  symbol: string;
  name: string;
  /** 네이버 시세 조회용 내부 코드(KR="005930", US="AAPL.O"). 스냅샷에 그대로 실린다. */
  quoteCode: string;
  exchange: string;
  close: number | null;
  changePct: number | null;
  weekChangePct: number | null;
  ma5: number | null;
  ma20: number | null;
  currency: string;
}

/** 프롬프트에 주입할 지수 1건의 확정된 값. */
export interface IndexQuoteRow {
  name: string;
  value: number | null;
  changePct: number | null;
}

/**
 * 브리핑 프롬프트에 주입할 보유 종목 1건 + 지난 24시간 펄스 요약.
 *
 * `pulseNotes` 가 이 구조의 존재 이유다. 펄스는 화면도 이메일도 없어서(인터뷰 결정)
 * 문자 문턱을 넘지 못한 판정은 원장에만 남는다. 그것들이 사용자에게 도달하는 **유일한
 * 경로**가 일일 브리핑의 이 섹션이다 — 여기가 빠지면 매시간 태운 토큰의 대부분이 증발한다.
 */
export interface PositionPromptRow {
  holding: StockHoldingSummary;
  /** 지난 24시간 펄스 판정 헤드라인들(문턱 미달 포함). 없으면 빈 배열. */
  pulseNotes: string[];
}

export interface StockPromptInput {
  market: StockMarket;
  /** 서버 로컬 수집일(KST) YYYY-MM-DD. */
  today: string;
  /** 브리핑이 다루는 거래소 로컬 거래일. role 별로 의미가 다르다(StockSnapshot.sessionDate 주석). */
  sessionDate: string | null;
  /**
   * 브리핑 성격. **필수 필드로 둔다** — 옵셔널이면 호출부가 빠뜨렸을 때 조용히 'both' 로
   * 빠져 회귀를 못 잡는다. 호출부는 stock.ts 한 곳뿐이라 파급이 작다.
   */
  role: StockSlotRole;
  /** "YYYY-MM-DD HH:mm" 형태의 현재 시각 라벨. */
  now: string;
  /** 사용자 등록 종목 + 확정 시세. */
  quotes: StockQuoteRow[];
  indices: IndexQuoteRow[];
  /** 원달러 환율. 없으면 null. */
  exchangeRate: { value: number; changePct: number | null } | null;
  /** 이 시장의 보유 종목 + 24시간 펄스 요약. 없으면 포지션 섹션을 통째로 생략한다. */
  positions?: PositionPromptRow[];
}

function fmtNum(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v)
    ? v.toLocaleString("ko-KR", { maximumFractionDigits: 2 })
    : "조회실패";
}

function fmtPct(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "조회실패";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

/** 현재 시각 라벨 "YYYY-MM-DD HH:mm" (뉴스/유튜브 큐레이터와 동일 포맷). */
function nowLabel(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${localDate(d)} ${hh}:${mm}`;
}

/** 종목 시세표(마크다운 표). 조회 실패 종목도 남겨 LLM 이 '숫자 없음'을 알게 한다. */
function quoteTable(rows: StockQuoteRow[]): string {
  if (!rows.length) return "(등록된 종목이 없습니다. analyses 는 빈 배열로 출력하라.)";
  const head =
    "| 종목명 | symbol | 거래소 | 종가 | 등락률 | 5일등락률 | MA5 | MA20 | 통화 |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = rows
    .map(
      (r) =>
        `| ${r.name} | ${r.symbol} | ${r.exchange} | ${fmtNum(r.close)} | ${fmtPct(r.changePct)} | ` +
        `${fmtPct(r.weekChangePct)} | ${fmtNum(r.ma5)} | ${fmtNum(r.ma20)} | ${r.currency} |`
    )
    .join("\n");
  return `${head}\n${body}`;
}

function indexTable(rows: IndexQuoteRow[]): string {
  if (!rows.length) return "(지수 조회 실패 — indices 는 빈 배열로 출력하라.)";
  return rows.map((r) => `- ${r.name}: ${fmtNum(r.value)} (${fmtPct(r.changePct)})`).join("\n");
}

/**
 * 보유 종목 섹션. **손익 숫자는 서버가 계산해 넣고 LLM 은 인용만** 한다
 * (등록 종목 시세표와 같은 원칙 — 프롬프트 단계에서 막지 않으면 서술문 안의 숫자가 오염된다).
 */
function positionSection(rows: PositionPromptRow[]): string {
  const body = rows
    .map(({ holding: h, pulseNotes }) => {
      const target = h.targetPrice != null ? formatPrice(h.targetPrice, h.currency) : "미설정";
      const stop = h.stopPrice != null ? formatPrice(h.stopPrice, h.currency) : "미설정";
      const memo = h.memo ? `\n  · 보유 이유(사용자 메모): ${h.memo}` : "";
      const pulse = pulseNotes.length
        ? `\n  · 지난 24시간 실시간 취합에서 잡힌 것:\n${pulseNotes.map((n) => `    - ${n}`).join("\n")}`
        : "\n  · 지난 24시간 실시간 취합: 특이사항 없음";
      return (
        `- ${h.name} (${h.symbol}) · 투자기간 ${horizonLabel(h.horizon)}\n` +
        `  · 현재가 ${formatPrice(h.close, h.currency)} · 평단 ${formatPrice(h.avgPrice, h.currency)} · ` +
        `평가손익 ${formatPnlPct(h.pnlPct)}\n` +
        `  · 목표가 ${target} · 손절가 ${stop}${memo}${pulse}`
      );
    })
    .join("\n");

  return `[내 보유 종목] (서버가 계산한 확정 손익. 이 숫자만 인용하라)
${body}

포지션 점검 작성 지침 — positions[] 에 **위 보유 종목 각각에 대해** 한 항목씩 쓴다:
- symbol 은 위 목록과 **정확히 동일하게** 적는다(서버가 symbol 로 손익 숫자를 붙인다).
- factors: 오늘 이 종목에 작용하는 요인을 관측된 사실로 정리한다. 위 '지난 24시간 실시간 취합'에
  잡힌 것이 있으면 **반드시 반영**하라 — 그 내용은 사용자가 아직 문자로 받지 못한 것이 섞여 있어,
  이 브리핑이 유일한 전달 경로다.
- pulseSummary: 지난 24시간 취합 내용을 1~2문장으로 압축한다. 특이사항이 없으면 null.
- ⛔ **매수·매도·비중조절·익절·손절 같은 행동 지시는 여기서도 금지다.** 목표가·손절가는 사용자가
  이미 입력해 둔 값이므로 "현재가가 손절가 대비 -4.2%" 처럼 **거리를 사실로 서술**하는 것까지만 하라.`;
}

/** 한국장(개장 전 프리뷰) 조사 지침. */
function krSection(input: StockPromptInput): string {
  return `이 브리핑은 **한국장 개장 전(09:00 개장) 프리뷰**다. 오늘 ${
    input.sessionDate ?? "(거래일 미상)"
  } 한국장을 앞두고
알아야 할 사실을 정리한다.

⛔ **도구는 반드시 한 번에 하나씩만 호출하라. 여러 WebSearch 를 한 턴에 병렬로 날리지 마라.**
(병렬 호출 시 tool_use id 가 중복돼 API 가 400 을 뱉고 브리핑 전체가 실패한다 — 실측된 실패다.)
검색 → 결과 확인 → 다음 검색 순서로 진행하라.

조사 주제(주제별로 하나씩 순차 WebSearch — 한 주제가 결과를 독식하면 안 된다):
1. 코스피·코스닥 시황과 전일 마감 배경
2. 아래 등록 종목 각각의 관련 뉴스·공시
3. 한국 경제 지표(환율·금리), 한국은행 정책·발언
4. 원달러 환율 동향
5. **전일 미국장 결과가 오늘 한국장에 미치는 영향**
6. 글로벌 무역·관세 이슈
7. AI·반도체 업황
8. 유가·금·달러 등 원자재/통화
9. 아시아 증시(일본·중국) 동향
10. 외국인·기관 수급
11. 특징주·급등주, 증권사 목표주가 상향
12. 주도주·테마 수급

뉴스 분류(bucket) — 반드시 이 중 하나로만 표기: ${NEWS_BUCKETS.kr.map((b) => `"${b}"`).join(", ")}`;
}

/** 전 미국장 섹션이 공유하는 도구 호출 규칙(병렬 호출 금지). */
const US_TOOL_RULE = `⛔ **도구는 반드시 한 번에 하나씩만 호출하라. 여러 WebSearch 를 한 턴에 병렬로 날리지 마라.**
(병렬 호출 시 tool_use id 가 중복돼 API 가 400 을 뱉고 브리핑 전체가 실패한다 — 실측된 실패다.)
검색 → 결과 확인 → 다음 검색 순서로 진행하라.`;

function bucketRule(market: StockMarket, role: StockSlotRole): string {
  return `뉴스 분류(bucket) — 반드시 이 중 하나로만 표기: ${bucketsFor(market, role)
    .map((b) => `"${b}"`)
    .join(", ")}`;
}

/**
 * 미국장 **마감결산**(role='close') 조사 지침 — 아침 슬롯.
 *
 * sessionDate 는 **이미 마감된** 뉴욕 세션이다. 확정된 결과만 다루고, 오늘 밤 전망은
 * 같은 날 오후의 별도 프리뷰 브리핑이 담당한다. 두 브리핑이 같은 내용을 반복하면
 * 슬롯을 나눈 의미가 없어진다.
 */
function usCloseSection(input: StockPromptInput): string {
  return `이 브리핑은 **간밤에 마감된 뉴욕 세션(${
    input.sessionDate ?? "(거래일 미상)"
  })의 마감 결산**이다.
이미 **확정된 결과**만 다뤄라. **오늘 밤 개장 전망은 담지 마라** — 오늘 오후에 별도의
'개장 프리뷰' 브리핑이 따로 나가므로, 여기서 전망을 쓰면 같은 내용이 하루 두 번 반복된다.

${US_TOOL_RULE}

조사 주제(주제별로 하나씩 순차 WebSearch):
1. 해당 거래일 뉴욕 3대 지수(다우·S&P500·나스닥) 마감 결과와 **그 원인**
2. 섹터별 등락(무엇이 오르고 무엇이 빠졌는지)
3. 아래 등록 종목 각각의 관련 뉴스·실적·공시
4. **마감 후 시간외(after-hours) 실적 발표와 그 반응**
5. 미국 국채금리·달러 인덱스·유가의 그날 움직임
6. 연준(Fed) 인사 발언·정책 기대
7. AI·반도체 업황

${bucketRule(input.market, "close")}`;
}

/**
 * 미국장 **개장프리뷰**(role='preview') 조사 지침 — 오후 슬롯.
 *
 * ⚠️ sessionDate 가 **아직 열리지 않은** 세션이라는 점이 이 프롬프트의 핵심 위험이다.
 * 모델이 그 날짜의 '종가'를 지어낼 유인이 결산보다 훨씬 크므로 명시적으로 금지한다.
 * (숫자 필드 자체는 quote.ts 값으로 덮어써지지만, 서술문 안의 숫자는 덮어쓸 수 없다.)
 */
function usPreviewSection(input: StockPromptInput): string {
  return `이 브리핑은 **오늘 밤(한국시간) 열릴 뉴욕 세션(${
    input.sessionDate ?? "(거래일 미상)"
  })의 개장 프리뷰**다.
⛔ 이 세션은 **아직 열리지 않았다.** 이 날짜의 확정 종가·등락률은 존재하지 않으니 **절대 지어내지 마라.**
   [확정 시세] 표의 숫자는 전부 **직전 마감 세션 기준**이다 — 인용할 때 그 사실을 명시하라.
⛔ 직전 세션 마감 결산은 **오늘 아침에 이미 별도 브리핑으로 나갔다.** 배경으로 한 줄만 언급하고
   상세 복기(지수별 마감·섹터 등락 나열)를 반복하지 마라.

${US_TOOL_RULE}

조사 주제(주제별로 하나씩 순차 WebSearch):
1. **오늘 밤 예정된 실적발표·경제지표**(CPI·고용·FOMC 등) 일정
2. 선물·프리마켓 동향
3. 오늘 밤 시장에서 주목받는 종목과 그 이유
4. 아래 등록 종목 각각의 관련 뉴스·실적·공시
5. 간밤 아시아·유럽장 흐름이 오늘 밤 뉴욕장에 주는 신호
6. 미국 국채금리·달러 인덱스·유가
7. 연준(Fed) 인사 발언·정책 기대
8. AI·반도체 업황

${bucketRule(input.market, "preview")}`;
}

/**
 * 미국장 **혼합**(role='both') 조사 지침 — 결산과 프리뷰를 한 브리핑에 담는 현행 동작.
 *
 * 역할 분리가 비활성일 때(슬롯 1개, 같은 밴드 슬롯만, 안전대 밖 슬롯, 수동 갱신) 쓰인다.
 * ⚠️ **이 함수의 문구는 한 글자도 바꾸지 마라.** 단일 슬롯 사용자의 브리핑이 배포로 인해
 * 달라지지 않는다는 하위호환 보증이 여기 걸려 있다.
 */
function usSection(input: StockPromptInput): string {
  return `이 브리핑은 성격이 둘이다: **어젯밤 뉴욕 종가 결산(${
    input.sessionDate ?? "(거래일 미상)"
  })** + **오늘 밤 개장 프리뷰**. 둘 다 담아라.

⛔ **도구는 반드시 한 번에 하나씩만 호출하라. 여러 WebSearch 를 한 턴에 병렬로 날리지 마라.**
(병렬 호출 시 tool_use id 가 중복돼 API 가 400 을 뱉고 브리핑 전체가 실패한다 — 실측된 실패다.)
검색 → 결과 확인 → 다음 검색 순서로 진행하라.

조사 주제(주제별로 하나씩 순차 WebSearch):
1. 전일 뉴욕 3대 지수(다우·S&P500·나스닥) 마감 결과와 **그 원인**
2. 섹터별 등락(무엇이 오르고 무엇이 빠졌는지)
3. 아래 등록 종목 각각의 관련 뉴스·실적·공시
4. **오늘 밤 예정된 실적발표·경제지표**(CPI·고용·FOMC 등) 일정
5. 선물·프리마켓 동향
6. 미국 국채금리·달러 인덱스·유가
7. 연준(Fed) 인사 발언·정책 기대
8. AI·반도체 업황
9. 오늘 밤 시장에서 주목받는 종목

뉴스 분류(bucket) — 반드시 이 중 하나로만 표기: ${NEWS_BUCKETS.us.map((b) => `"${b}"`).join(", ")}`;
}

/**
 * 증시 브리핑 프롬프트. **순수 함수** — 네트워크·전역 상태를 읽지 않는다(테스트 대상).
 *
 * 핵심 설계: 시세 표를 프롬프트에 주입하고 "이 표의 숫자만 인용하라"고 못 박는다.
 * LLM 이 되돌려준 숫자 필드는 호출자가 어차피 전부 덮어쓰지만(stock.ts),
 * 프롬프트 단계에서도 막아야 **서술문 안의 숫자**(덮어쓸 수 없는 자유 텍스트)가 오염되지 않는다.
 */
export function buildPrompt(input: StockPromptInput): string {
  const marketName = input.market === "kr" ? "한국장(KRX)" : "미국장(뉴욕)";
  // 한국장은 슬롯이 하나이고 krSection 이 이미 '개장 전 프리뷰' 전용 문안이라 역할 분기가 없다.
  // 미국장만 3분기 — 'both' 는 기존 usSection 을 그대로 재사용해 현행 동작을 보존한다.
  const section =
    input.market === "kr"
      ? krSection(input)
      : input.role === "close"
        ? usCloseSection(input)
        : input.role === "preview"
          ? usPreviewSection(input)
          : usSection(input);

  // 헤더의 거래일 문장도 역할별로 가른다. preview 에서 "대상 거래일은 X" 로만 두면 모델이
  // 'X 의 확정 결과'를 쓰려 하고, 그 날짜는 아직 열리지도 않았다.
  const sessionLine =
    input.market === "us" && input.role === "close"
      ? `대상 거래일은 **${input.sessionDate ?? "(거래일 미상)"}** (이미 마감된 뉴욕 세션)`
      : input.market === "us" && input.role === "preview"
        ? `대상 세션은 **${input.sessionDate ?? "(거래일 미상)"}** (오늘 밤 열릴 뉴욕 세션 — 아직 개장 전이다)`
        : `대상 거래일은 **${input.sessionDate ?? "(거래일 미상)"}**`;
  const fx = input.exchangeRate
    ? `- 원달러 환율: ${fmtNum(input.exchangeRate.value)} (${fmtPct(input.exchangeRate.changePct)})`
    : "- 원달러 환율: 조회실패";

  // ⚠️ watchlist 심볼 규칙은 **반드시 시장별로 분기한다.**
  // 예전엔 이 문장이 시장 공용이었고 하필 예시가 미국 티커("NVDA")였다. 한국장 프롬프트에도
  // 그 예시가 그대로 들어갔고, krSection 의 조사 주제("전일 미국장 영향", "AI·반도체 업황")가
  // 엔비디아를 조사 범위로 끌어오면서 모델이 **지시대로** NVDA 를 한국장 watchlist 에 올렸다.
  //
  // 그리고 여기서 '해외 종목은 서버가 해외 참고로 분리해준다'는 사실을 **알리지 않는다.**
  // 칸이 있다고 알려주면 모델이 그 칸을 채우기 시작한다. 해외 참고 라우팅은 오염을 버리지 않고
  // 건지는 **구제 경로**이지 제품 목표가 아니다 — 프롬프트는 예방, 라우팅은 그물로 역할을 나눈다.
  const watchSymbolRule =
    input.market === "kr"
      ? `  · **KRX 상장 종목만** 올려라. symbol 은 **6자리 KRX 종목코드**("005930") — 종목명이 아니다.
    서버가 이 값으로 시세를 사후 조회한다.
  · **미국·일본 등 해외 상장 종목을 watchlist 에 넣지 마라.** 오늘 한국장에 영향을 주는 해외 종목은
    watchlist 가 아니라 news[] 나 지수 comment 에서 다뤄라.`
      : `  · **미국 상장 종목만** 올려라. symbol 은 **티커**("AAPL") — 회사명이 아니다.
    서버가 이 값으로 시세를 사후 조회한다.
  · **한국 등 해외 상장 종목을 watchlist 에 넣지 마라.** 미국장에 영향을 주는 해외 종목은
    watchlist 가 아니라 news[] 나 지수 comment 에서 다뤄라.`;

  return `너는 한국어 증시 정보 정리 담당이다. 지금 시각은 ${input.now}. 대상 시장은 **${marketName}**,
${sessionLine}, 수집일은 ${input.today} 이다.
모든 서술은 **반드시 한국어**로 작성한다(영문 소스도 번역).

${section}

⛔ 절대 규칙 1 — 투자 권유 금지:
- **매수·매도·비중확대·비중축소·목표가 제시·"지금 사라/팔아라" 등 투자 권유 표현을 절대 쓰지 마라.**
- 너는 **관측 가능한 사실**(뉴스·공시·수급·거래대금·컨센서스 변화)과 **그 출처**만 정리한다.
- '오늘의 관심 종목'(watchlist)은 **추천이 아니다**. "시장에서 왜 거론되는지"의 **사실 요약**이다.
  "○○증권이 목표주가를 상향했다"는 사실 인용은 되지만, 네가 목표가나 매매 의견을 만들지 마라.

⛔ 절대 규칙 2 — 숫자를 지어내지 마라:
- 아래 **[확정 시세]** 표의 숫자만 인용하라. **추정·계산·기억으로 숫자를 채우지 마라.**
- 표에 없는 종목의 주가·등락률·지수 값을 서술문에 쓰지 마라. 표에 "조회실패"면 그 숫자를 언급하지 마라.
- 서버가 모든 숫자 필드를 **확정 시세로 덮어쓴다** — 네가 숫자 필드에 무엇을 적든 폐기된다.
  그러니 숫자 필드(close/changePct/history/value 등)는 신경 쓰지 말고 **서술만** 채워라.
- 단, **서술문(summary/outlook/rationale/risks/comment/levels) 안의 숫자는 덮어쓸 수 없다.**
  그래서 서술문에 잘못된 숫자를 적으면 그대로 사용자에게 나간다 — 표에 있는 숫자만 써라.
- 뉴스에서 본 숫자(거래대금·수급 규모·지표 수치 등)를 인용할 때는 **출처 기사에 적힌 값**만 쓰고,
  기억이나 추정으로 보정하지 마라.

[확정 시세 — 등록 종목] (서버가 네이버 증권에서 조회한 값. 이 표의 숫자만 인용하라)
${quoteTable(input.quotes)}

[확정 시세 — 지수]
${indexTable(input.indices)}
${fx}
${input.positions?.length ? `\n${positionSection(input.positions)}\n` : ""}

작성 지침:
- indices[]: 위 지수 각각에 대해 comment(관측된 사실 요약) / outlook(전망 서술) / rationale(전망 사유)를 쓴다.
  **name 은 위 [확정 시세 — 지수] 의 표기를 그대로** 쓴다(서버가 name 으로 값을 붙인다).
- news[]: 조사한 뉴스를 bucket 별로 정리한다. date 는 발행일 "YYYY-MM-DD". 링크는 실제 기사 URL.
  최근(1~2일 내) 기사를 우선하고, 날짜가 불명확하면 넣지 마라.
- analyses[]: **위 표의 등록 종목만**, symbol 을 표와 **정확히 동일하게** 적는다(서버가 symbol 로 시세를 붙인다).
  summary(관찰된 사실) / outlook(전망) / rationale(전망 사유) / risks(리스크 요인) / verdict(${VERDICTS.join(
    " · "
  )} 중 하나).
  **rationale 과 risks 는 필수다 — 비어 있으면 그 종목 분석은 통째로 폐기된다.**
- watchlist[]: 시장에서 거론되는 종목(등록 종목과 겹치지 않게). 각 항목에 symbol 과 name 을 반드시 적는다.
${watchSymbolRule}
  · attention(${ATTENTIONS.join(" · ")}) / levels(주목 가격대 서술, 없으면 null)
  · **추천이 아니라 "왜 거론되는지"의 사실 요약**임을 잊지 마라. rationale·risks 는 여기서도 필수다.

출력 형식 — 조사를 마친 뒤 **아래 JSON 한 개만** 출력(다른 텍스트 없이):
{${
    input.positions?.length
      ? `"positions":[{"symbol":string,"factors":string,"pulseSummary":string|null}],
`
      : ""
  }"indices":[{"name":string,"comment":string,"outlook":string,"rationale":string}],
"news":[{"title":string,"source":string,"date":"YYYY-MM-DD","summary":string,"link":string|null,"bucket":string}],
"analyses":[{"symbol":string,"name":string,"summary":string,"outlook":string,"rationale":string,"risks":string,"verdict":"📈|📉|➡️"}],
"watchlist":[{"symbol":string,"name":string,"summary":string,"outlook":string,"rationale":string,"risks":string,"verdict":"📈|📉|➡️","attention":"🔥강|⚡중|💧약","levels":string|null}],
"notes":string|null}`;
}

/**
 * 응답 텍스트에서 첫 '{' ~ 마지막 '}' 를 잘라 JSON 파싱.
 * 구현은 증시 에이전트(agent.ts)로 옮겼다 — 브리핑과 펄스가 같은 파서를 쓰게 하기 위함이다.
 * 이 이름은 기존 호출부·테스트를 위해 재노출한다.
 */
export const extractJson = extractAgentJson;

function normDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** 허용된 이모지가 아니면 중립(➡️)으로 접는다 — 임의 문자열이 화면에 뜨는 것을 막는다. */
export function normalizeVerdict(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  return VERDICTS.includes(s) ? s : "➡️";
}

export function normalizeAttention(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (ATTENTIONS.includes(s)) return s;
  // "강"/"중"/"약" 만 온 경우 이모지를 붙여 살린다(LLM 이 이모지를 자주 흘린다).
  const hit = ATTENTIONS.find((a) => a.endsWith(s) && s.length === 1);
  return hit ?? "⚡중";
}

/**
 * bucket 이 허용 목록 밖이면 **목록의 마지막 값으로 접는다**(드롭하지 않는다).
 * role 을 받는 이유는 미국장 목록이 역할별로 좁혀지기 때문이다 — 폴백 목적지가 무엇인지가
 * 곧 오분류의 착지점이므로 US_NEWS_BUCKETS_BY_ROLE 의 순서 주석을 함께 볼 것.
 * 기본값 'both' 는 현행 목록 그대로라, role 을 넘기지 않는 호출부의 동작이 변하지 않는다.
 */
export function normalizeBucket(
  v: unknown,
  market: StockMarket,
  role: StockSlotRole = "both"
): string {
  const buckets = bucketsFor(market, role);
  const s = typeof v === "string" ? v.trim() : "";
  return buckets.includes(s) ? s : buckets[buckets.length - 1];
}

export function normalizeNewsItem(
  r: unknown,
  market: StockMarket,
  role: StockSlotRole = "both"
): StockNewsItem | null {
  const o = r as Record<string, unknown> | null;
  const title = str(o?.title, 200);
  const date = normDate(o?.date);
  // 제목·발행일이 없으면 버린다(신선도·신뢰도 판정 불가).
  if (!title || !date) return null;
  return {
    title,
    source: str(o?.source, 80),
    date,
    summary: str(o?.summary, 1000),
    link: typeof o?.link === "string" && o.link.trim() ? o.link.trim() : null,
    bucket: normalizeBucket(o?.bucket, market, role),
  };
}

/** LLM 이 채우는 서술 필드만 담는 중간 표현. 숫자는 호출자가 붙인다. */
export interface AnalysisNarrative {
  symbol: string;
  name: string;
  summary: string;
  outlook: string;
  rationale: string;
  risks: string;
  verdict: string;
}

/**
 * 종목 분석의 서술부 정규화.
 * **rationale 또는 risks 가 비면 null 을 반환해 항목을 폐기한다** — 근거 없는 전망은
 * "그럴듯하지만 검증 불가"라서 투자 권유로 읽히기 쉽다. 타입 주석(§558-561)의 요구사항.
 */
export function normalizeAnalysisNarrative(r: unknown): AnalysisNarrative | null {
  const o = r as Record<string, unknown> | null;
  const symbol = str(o?.symbol, 20);
  const rationale = str(o?.rationale, 1000);
  const risks = str(o?.risks, 1000);
  if (!symbol || !rationale || !risks) return null;
  return {
    symbol,
    name: str(o?.name, 80),
    summary: str(o?.summary, 1000),
    outlook: str(o?.outlook, 1000),
    rationale,
    risks,
    verdict: normalizeVerdict(o?.verdict),
  };
}

export interface WatchNarrative extends AnalysisNarrative {
  attention: string;
  levels: string | null;
}

export function normalizeWatchNarrative(r: unknown): WatchNarrative | null {
  const base = normalizeAnalysisNarrative(r);
  if (!base) return null;
  const o = r as Record<string, unknown>;
  const levels = str(o?.levels, 300);
  return { ...base, attention: normalizeAttention(o?.attention), levels: levels || null };
}

export interface IndexNarrative {
  name: string;
  comment: string | null;
  outlook: string | null;
  rationale: string | null;
}

/**
 * 지수 서술 정규화. rationale 이 비면 outlook 을 버린다 —
 * StockIndex.rationale 주석(§521)의 "없으면 outlook 을 표시하지 않는다" 규칙.
 */
export function normalizeIndexNarrative(r: unknown): IndexNarrative | null {
  const o = r as Record<string, unknown> | null;
  const name = str(o?.name, 40);
  if (!name) return null;
  const rationale = str(o?.rationale, 1000);
  const outlook = str(o?.outlook, 1000);
  const comment = str(o?.comment, 1000);
  return {
    name,
    comment: comment || null,
    outlook: rationale && outlook ? outlook : null,
    rationale: rationale || null,
  };
}

/** 포지션 점검의 LLM 서술부. 숫자는 전부 서버 계산값이라 여기 없다. */
export interface PositionNarrative {
  symbol: string;
  factors: string;
  pulseSummary: string | null;
}

/**
 * 포지션 서술 정규화.
 *
 * ⚠️ **factors 가 비어도 폐기하지 않는다.** 등록 종목 분석(normalizeAnalysisNarrative)과
 * 정반대의 정책인데, 이유는 폐기의 결과가 다르기 때문이다. 분석 항목이 사라지면 '그 종목
 * 얘기가 없다'로 끝나지만, **포지션 항목이 사라지면 내가 들고 있는 종목이 포트폴리오
 * 점검에서 통째로 빠진다** — 손익도 안 보이고, 24시간 펄스 요약도 함께 사라진다.
 * 손익 숫자는 서버가 이미 갖고 있으므로 서술이 비어도 실을 값이 있다.
 */
export function normalizePositionNarrative(r: unknown): PositionNarrative | null {
  const o = r as Record<string, unknown> | null;
  const symbol = str(o?.symbol, 20);
  if (!symbol) return null; // 심볼이 없으면 어느 보유 종목인지 특정할 수 없다
  const summary = str(o?.pulseSummary, 1000);
  return {
    symbol,
    factors: str(o?.factors, 1500),
    pulseSummary: summary || null,
  };
}

/** LLM 서술을 시세와 합치기 전의 중간 결과. */
export interface CuratedNarratives {
  indices: IndexNarrative[];
  news: StockNewsItem[];
  analyses: AnalysisNarrative[];
  watchlist: WatchNarrative[];
  positions: PositionNarrative[];
  notes: string | null;
}

/** 파싱된 JSON → 정규화된 서술 묶음. 순수 함수(테스트 대상). */
export function normalizeCurated(
  parsed: unknown,
  market: StockMarket,
  role: StockSlotRole = "both"
): CuratedNarratives {
  const p = parsed as Record<string, unknown> | null;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const analyses = arr(p?.analyses)
    .map(normalizeAnalysisNarrative)
    .filter((x): x is AnalysisNarrative => !!x);
  const analysisSymbols = new Set(analyses.map((a) => a.symbol.toUpperCase()));
  return {
    indices: arr(p?.indices)
      .map(normalizeIndexNarrative)
      .filter((x): x is IndexNarrative => !!x),
    news: arr(p?.news)
      .map((r) => normalizeNewsItem(r, market, role))
      .filter((x): x is StockNewsItem => !!x),
    analyses,
    // 관심 종목은 등록 종목과 겹치지 않는다(StockSnapshot.watchlist 주석 §601).
    watchlist: arr(p?.watchlist)
      .map(normalizeWatchNarrative)
      .filter((x): x is WatchNarrative => !!x)
      .filter((w) => !analysisSymbols.has(w.symbol.toUpperCase())),
    positions: arr(p?.positions)
      .map(normalizePositionNarrative)
      .filter((x): x is PositionNarrative => !!x),
    notes: typeof p?.notes === "string" && p.notes.trim() ? p.notes.trim() : null,
  };
}

/**
 * 스냅샷에 실리는 역할 메타. 스냅샷 생성 경로가 3곳(empty/holiday/toSnapshot)이라
 * 한 곳이라도 빠뜨리면 그 경로의 브리핑만 화면·메일에서 역할 라벨을 잃는다.
 */
export interface SnapshotRoleMeta {
  role?: StockSlotRole;
  roleReason?: string;
  slot?: string;
}

/** 빈(실패) 스냅샷. source="empty" — 호출자의 후퇴 방지 가드가 이 값을 본다. */
export function emptySnapshot(
  market: StockMarket,
  date: string,
  note: string,
  sessionDate: string | null = null,
  meta: SnapshotRoleMeta = {}
): StockSnapshot {
  return {
    market,
    date,
    sessionDate,
    ...meta,
    updatedAt: new Date().toISOString(),
    source: "empty",
    closed: false,
    closedReason: null,
    indices: [],
    news: [],
    analyses: [],
    watchlist: [],
    disclaimer: STOCK_DISCLAIMER,
    notes: note,
  };
}

/**
 * 휴장 스냅샷. LLM 호출 없이 만들어지는 **정상 결과**라 source="holiday".
 *
 * `indices` 는 **최종 거래일 종가 기준의 지수 카드**다(기본값 없음 = 빈 배열, 조회 실패 시의 현행 동작).
 * 휴장이어도 지수 흐름은 계속 보여야 한다는 요구 때문에 싣는다 — 휴장 스냅샷이 최신본으로 뜨면서
 * 화면에서 지수 섹션이 통째로 사라지고 등록 종목만 남던 증상이 여기서 비롯됐다.
 * 서술(comment/outlook/rationale)은 전부 null 이다: 휴장 런은 LLM 을 호출하지 않으므로
 * 값·차트만 채운다. 지어낸 서술을 붙이는 것보다 비워 두는 편이 정직하다.
 *
 * ⚠️ 지수의 기준일은 **sessionDate 와 다를 수 있다.** 한국장 휴장의 sessionDate 는 '다음 거래일'
 *    (미래)이고 지수는 '직전 거래일'(과거) 종가다. 렌더 계층은 반드시 history 마지막 점의
 *    date 를 기준일로 표기해야 한다 — sessionDate 를 지수 기준일처럼 쓰면 날짜가 뒤집힌다.
 */
export function holidaySnapshot(
  market: StockMarket,
  date: string,
  sessionDate: string | null,
  reason: string | null,
  meta: SnapshotRoleMeta = {},
  indices: StockIndex[] = []
): StockSnapshot {
  return {
    market,
    date,
    sessionDate,
    ...meta,
    updatedAt: new Date().toISOString(),
    source: "holiday",
    closed: true,
    closedReason: reason,
    indices,
    news: [],
    analyses: [],
    watchlist: [],
    disclaimer: STOCK_DISCLAIMER,
    notes: reason ? `휴장(${reason}) — 브리핑을 생성하지 않았습니다.` : "휴장일입니다.",
  };
}

/** 서술 + 확정 시세를 합쳐 최종 스냅샷을 만든다(숫자는 전부 quotes/indices 쪽 값). */
function toSnapshot(
  input: StockPromptInput,
  n: CuratedNarratives,
  histories: Map<string, StockPoint[]>,
  indexHistories: Map<string, StockPoint[]>,
  meta: SnapshotRoleMeta
): StockSnapshot {
  const byName = new Map(n.indices.map((i) => [i.name, i]));
  const indices: StockIndex[] = input.indices.map((q) => {
    const d = byName.get(q.name);
    return {
      name: q.name,
      value: q.value,
      changePct: q.changePct,
      history: indexHistories.get(q.name) ?? [],
      comment: d?.comment ?? null,
      outlook: d?.outlook ?? null,
      rationale: d?.rationale ?? null,
    };
  });

  const quoteBySymbol = new Map(input.quotes.map((q) => [q.symbol.toUpperCase(), q]));
  const analyses: StockAnalysis[] = [];
  for (const a of n.analyses) {
    const q = quoteBySymbol.get(a.symbol.toUpperCase());
    // 표에 없는 종목을 LLM 이 지어낸 경우 — 붙일 확정 시세가 없으므로 버린다.
    if (!q) {
      log.warn(`증시 큐레이션: 등록 종목이 아닌 analyses 항목 폐기 — ${a.symbol}`);
      continue;
    }
    analyses.push({
      symbol: q.symbol,
      name: q.name,
      quoteCode: q.quoteCode,
      close: q.close,
      changePct: q.changePct,
      weekChangePct: q.weekChangePct,
      currency: q.currency,
      history: histories.get(q.symbol.toUpperCase()) ?? [],
      ma5: q.ma5,
      ma20: q.ma20,
      summary: a.summary,
      outlook: a.outlook,
      rationale: a.rationale,
      risks: a.risks,
      verdict: a.verdict,
      verified: q.close != null,
    });
  }

  // watchlist 의 시세는 호출자(stock.ts)가 searchTicker+fetchHistory 로 사후 조회해 채운다.
  const watchlist: StockWatchItem[] = n.watchlist.map((w) => ({
    symbol: w.symbol,
    name: w.name,
    quoteCode: "",
    close: null,
    changePct: null,
    weekChangePct: null,
    // ⚠️ placeholder 다. 이 시점엔 종목의 **실제 시장을 알 수 없다**(시장 판정은 시세 조회에서만 가능).
    // verifyWatchlist 가 실제 시세의 통화로 반드시 덮어쓰며, 못 덮어쓴 항목은 드롭된다 —
    // 즉 이 임시값이 디스크까지 살아남는 경로는 이제 구조적으로 닫혀 있다.
    // (한국장 브리핑의 NVDA 에 currency:"KRW" 가 붙어 저장된 사건이 정확히 이 임시값의 생존이었다.
    //  당시엔 검증 실패 항목을 verified=false 로 남겼기 때문이다.)
    currency: input.market === "kr" ? "KRW" : "USD",
    history: [],
    ma5: null,
    ma20: null,
    summary: w.summary,
    outlook: w.outlook,
    rationale: w.rationale,
    risks: w.risks,
    verdict: w.verdict,
    verified: false,
    attention: w.attention,
    levels: w.levels,
  }));

  // 포지션은 **보유 원장이 기준**이다. LLM 이 낸 목록이 아니라 input.positions 를 훑으며
  // 서술을 붙인다 — 반대로 하면 LLM 이 빠뜨린 보유 종목이 포트폴리오에서 조용히 사라진다.
  const narrativeBySymbol = new Map(n.positions.map((p) => [p.symbol.toUpperCase(), p]));
  const positions: StockPositionReview[] = (input.positions ?? []).map((row) => {
    const d = narrativeBySymbol.get(row.holding.symbol.toUpperCase());
    return {
      ...row.holding,
      factors: d?.factors ?? "",
      // 서술이 없으면 원장에서 뽑아 온 헤드라인을 그대로 쓴다. LLM 이 요약을 빠뜨렸다고
      // 24시간 취합 결과가 사라지면 안 된다(그게 유일한 회수 경로다).
      pulseSummary: d?.pulseSummary ?? (row.pulseNotes.length ? row.pulseNotes.join(" / ") : null),
    };
  });

  return {
    market: input.market,
    date: input.today,
    sessionDate: input.sessionDate,
    ...meta,
    updatedAt: new Date().toISOString(),
    source: "llm",
    closed: false,
    closedReason: null,
    indices,
    news: n.news,
    analyses,
    watchlist,
    positions,
    disclaimer: STOCK_DISCLAIMER,
    notes: n.notes,
  };
}

export interface CurateStockInput extends StockPromptInput {
  /** symbol(대문자) → 20거래일 시계열. 스냅샷에 그대로 붙는다. */
  histories?: Map<string, StockPoint[]>;
  /** 지수 표시명 → 20거래일 시계열. */
  indexHistories?: Map<string, StockPoint[]>;
  /** 역할 판정 근거. 프롬프트에는 쓰지 않고 스냅샷에만 실린다(로그·화면 툴팁용). */
  roleReason?: string;
  /** 귀속 슬롯. 프롬프트에는 쓰지 않고 스냅샷에만 실린다(catch-up 게이트용). */
  slot?: string;
}

/**
 * 증시 브리핑을 Claude Agent SDK(WebSearch/WebFetch)로 조사·서술한다.
 * **숫자는 전부 input 의 확정 시세에서 나온다** — LLM 이 되돌린 숫자 필드는 읽지 않는다.
 * 실패 시 빈 스냅샷(source="empty") 반환.
 */
export async function curateStock(input: CurateStockInput): Promise<StockSnapshot> {
  // 라벨에 역할을 붙인다. 이게 없으면 같은 날 두 런이 로그에서 완전히 구분되지 않는다
  // (실측 로그가 정확히 그 상태였다: "증시 큐레이션(미국장)" 두 줄).
  const roleTag = input.role === "close" ? "·마감결산" : input.role === "preview" ? "·개장프리뷰" : "";
  const marketName = `${input.market === "kr" ? "한국장" : "미국장"}${roleTag}`;
  const meta: SnapshotRoleMeta = {
    role: input.role,
    roleReason: input.roleReason,
    slot: input.slot,
  };
  try {
    // 도구·시스템 프롬프트·모델·타임아웃은 전부 증시 전용 에이전트가 소유한다(agent.ts).
    // 여기서는 **무엇을 조사할지**(프롬프트)만 정한다.
    const finalText = await runStockAgent({
      mode: "briefing",
      prompt: buildPrompt({ ...input, now: input.now || nowLabel() }),
      label: marketName,
    });
    if (!finalText) {
      return emptySnapshot(
        input.market,
        input.today,
        "증시 큐레이션 결과가 비어 있습니다.",
        input.sessionDate,
        meta
      );
    }

    const n = normalizeCurated(extractJson(finalText), input.market, input.role);
    const snapshot = toSnapshot(
      input,
      n,
      input.histories ?? new Map(),
      input.indexHistories ?? new Map(),
      meta
    );
    log.info(
      `증시 큐레이션(LLM) 완료 [${marketName}] — 지수 ${snapshot.indices.length} / 뉴스 ${snapshot.news.length} / ` +
        `분석 ${snapshot.analyses.length} / 관심 ${snapshot.watchlist.length}`
    );
    return snapshot;
  } catch (e) {
    log.warn(`증시 큐레이션 실패 [${marketName}]: ${(e as Error).message}`);
    return emptySnapshot(
      input.market,
      input.today,
      `증시 큐레이션 실패: ${(e as Error).message}`,
      input.sessionDate,
      meta
    );
  }
}
