import { log } from "../util/log.ts";
import { config } from "../config.ts";
import { runAgentQueryText } from "../util/agent-query.ts";
import { localDate } from "../util/date.ts";
import type {
  StockMarket,
  StockSnapshot,
  StockNewsItem,
  StockAnalysis,
  StockWatchItem,
  StockIndex,
  StockPoint,
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

export interface StockPromptInput {
  market: StockMarket;
  /** 서버 로컬 수집일(KST) YYYY-MM-DD. */
  today: string;
  /** 브리핑이 다루는 거래소 로컬 거래일. */
  sessionDate: string | null;
  /** "YYYY-MM-DD HH:mm" 형태의 현재 시각 라벨. */
  now: string;
  /** 사용자 등록 종목 + 확정 시세. */
  quotes: StockQuoteRow[];
  indices: IndexQuoteRow[];
  /** 원달러 환율. 없으면 null. */
  exchangeRate: { value: number; changePct: number | null } | null;
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

/** 미국장(뉴욕 종가 결산 + 오늘 밤 개장 프리뷰) 조사 지침. */
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
  const section = input.market === "kr" ? krSection(input) : usSection(input);
  const fx = input.exchangeRate
    ? `- 원달러 환율: ${fmtNum(input.exchangeRate.value)} (${fmtPct(input.exchangeRate.changePct)})`
    : "- 원달러 환율: 조회실패";

  return `너는 한국어 증시 정보 정리 담당이다. 지금 시각은 ${input.now}. 대상 시장은 **${marketName}**,
대상 거래일은 **${input.sessionDate ?? "(거래일 미상)"}**, 수집일은 ${input.today} 이다.
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
  · symbol: 한국 종목이면 6자리 코드("005930"), 미국 종목이면 티커("NVDA"). 서버가 이 값으로 시세를 사후 조회한다.
  · attention(${ATTENTIONS.join(" · ")}) / levels(주목 가격대 서술, 없으면 null)
  · **추천이 아니라 "왜 거론되는지"의 사실 요약**임을 잊지 마라. rationale·risks 는 여기서도 필수다.

출력 형식 — 조사를 마친 뒤 **아래 JSON 한 개만** 출력(다른 텍스트 없이):
{"indices":[{"name":string,"comment":string,"outlook":string,"rationale":string}],
"news":[{"title":string,"source":string,"date":"YYYY-MM-DD","summary":string,"link":string|null,"bucket":string}],
"analyses":[{"symbol":string,"name":string,"summary":string,"outlook":string,"rationale":string,"risks":string,"verdict":"📈|📉|➡️"}],
"watchlist":[{"symbol":string,"name":string,"summary":string,"outlook":string,"rationale":string,"risks":string,"verdict":"📈|📉|➡️","attention":"🔥강|⚡중|💧약","levels":string|null}],
"notes":string|null}`;
}

/** 응답 텍스트에서 첫 '{' ~ 마지막 '}' 를 잘라 JSON 파싱. (뉴스/유튜브 큐레이터와 동일 관례) */
export function extractJson(text: string): unknown {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e <= s) throw new Error("JSON 미발견");
  return JSON.parse(text.slice(s, e + 1));
}

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

/** bucket 이 시장별 허용 목록 밖이면 마지막 값("관심 종목 후보")으로 접는다. */
export function normalizeBucket(v: unknown, market: StockMarket): string {
  const buckets = NEWS_BUCKETS[market];
  const s = typeof v === "string" ? v.trim() : "";
  return buckets.includes(s) ? s : buckets[buckets.length - 1];
}

export function normalizeNewsItem(r: unknown, market: StockMarket): StockNewsItem | null {
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
    bucket: normalizeBucket(o?.bucket, market),
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

/** LLM 서술을 시세와 합치기 전의 중간 결과. */
export interface CuratedNarratives {
  indices: IndexNarrative[];
  news: StockNewsItem[];
  analyses: AnalysisNarrative[];
  watchlist: WatchNarrative[];
  notes: string | null;
}

/** 파싱된 JSON → 정규화된 서술 묶음. 순수 함수(테스트 대상). */
export function normalizeCurated(parsed: unknown, market: StockMarket): CuratedNarratives {
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
      .map((r) => normalizeNewsItem(r, market))
      .filter((x): x is StockNewsItem => !!x),
    analyses,
    // 관심 종목은 등록 종목과 겹치지 않는다(StockSnapshot.watchlist 주석 §601).
    watchlist: arr(p?.watchlist)
      .map(normalizeWatchNarrative)
      .filter((x): x is WatchNarrative => !!x)
      .filter((w) => !analysisSymbols.has(w.symbol.toUpperCase())),
    notes: typeof p?.notes === "string" && p.notes.trim() ? p.notes.trim() : null,
  };
}

/** 빈(실패) 스냅샷. source="empty" — 호출자의 후퇴 방지 가드가 이 값을 본다. */
export function emptySnapshot(
  market: StockMarket,
  date: string,
  note: string,
  sessionDate: string | null = null
): StockSnapshot {
  return {
    market,
    date,
    sessionDate,
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

/** 휴장 스냅샷. LLM 호출 없이 만들어지는 **정상 결과**라 source="holiday". */
export function holidaySnapshot(
  market: StockMarket,
  date: string,
  sessionDate: string | null,
  reason: string | null
): StockSnapshot {
  return {
    market,
    date,
    sessionDate,
    updatedAt: new Date().toISOString(),
    source: "holiday",
    closed: true,
    closedReason: reason,
    indices: [],
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
  indexHistories: Map<string, StockPoint[]>
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

  return {
    market: input.market,
    date: input.today,
    sessionDate: input.sessionDate,
    updatedAt: new Date().toISOString(),
    source: "llm",
    closed: false,
    closedReason: null,
    indices,
    news: n.news,
    analyses,
    watchlist,
    disclaimer: STOCK_DISCLAIMER,
    notes: n.notes,
  };
}

export interface CurateStockInput extends StockPromptInput {
  /** symbol(대문자) → 20거래일 시계열. 스냅샷에 그대로 붙는다. */
  histories?: Map<string, StockPoint[]>;
  /** 지수 표시명 → 20거래일 시계열. */
  indexHistories?: Map<string, StockPoint[]>;
}

/**
 * 증시 브리핑을 Claude Agent SDK(WebSearch/WebFetch)로 조사·서술한다.
 * **숫자는 전부 input 의 확정 시세에서 나온다** — LLM 이 되돌린 숫자 필드는 읽지 않는다.
 * 실패 시 빈 스냅샷(source="empty") 반환.
 */
export async function curateStock(input: CurateStockInput): Promise<StockSnapshot> {
  const marketName = input.market === "kr" ? "한국장" : "미국장";
  try {
    const finalText = await runAgentQueryText(
      buildPrompt({ ...input, now: input.now || nowLabel() }),
      {
        // tools = 가용 도구 제한(웹 조사 외 Bash/Write 등 차단 — 외부 페이지 프롬프트 인젝션 방어),
        // allowedTools = 그 도구들을 무프롬프트 허용.
        tools: ["WebSearch", "WebFetch"],
        allowedTools: ["WebSearch", "WebFetch"],
        permissionMode: "bypassPermissions",
        settingSources: [],
        maxTurns: 60,
        systemPrompt:
          "도구는 한 번에 하나씩만 호출한다(병렬 도구 호출 금지 — tool_use id 중복으로 API 400 이 난다). " +
          "너는 한국어 증시 정보 정리 담당이다. 매수·매도·비중확대 등 투자 권유 표현을 절대 쓰지 않고, " +
          "관측 가능한 사실(뉴스·공시·수급·거래대금·컨센서스 변화)과 그 출처만 정리한다. " +
          "'오늘의 관심 종목'은 추천이 아니라 '시장에서 왜 거론되는지'의 사실 요약이다. " +
          "주가·등락률·지수 값은 프롬프트의 [확정 시세] 표에 있는 숫자만 인용하고, " +
          "추정·계산·기억으로 숫자를 만들지 않는다. 마지막에 지정된 JSON 한 개만 출력한다.",
      },
      config.agentQueryTimeoutMs,
      `증시 큐레이션(${marketName})`
    );
    if (!finalText) {
      return emptySnapshot(input.market, input.today, "증시 큐레이션 결과가 비어 있습니다.", input.sessionDate);
    }

    const n = normalizeCurated(extractJson(finalText), input.market);
    const snapshot = toSnapshot(
      input,
      n,
      input.histories ?? new Map(),
      input.indexHistories ?? new Map()
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
      input.sessionDate
    );
  }
}
