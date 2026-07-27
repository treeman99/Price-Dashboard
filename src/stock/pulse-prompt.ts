import { horizonDescription, horizonLabel, formatPnlPct } from "../../shared/holdings.ts";
import { formatPrice } from "../../shared/stock.ts";
import {
  fingerprint,
  findActionPhrases,
  normalizeDirection,
  normalizeSeverity,
  normalizeTrigger,
} from "../../shared/pulse.ts";
import type {
  PulseImpact,
  PulseSource,
  StockHoldingSummary,
  StockMarket,
} from "../../shared/types.ts";
import type { SavetickerItem } from "./saveticker.ts";
import { savetickerTable } from "./saveticker.ts";

/**
 * 시간당 펄스의 프롬프트와 정규화. **순수 함수만** 둔다(네트워크·전역 상태 없음) —
 * 이 모듈의 판정 규칙이 곧 문자로 나가는 내용이라, 테스트로 못박을 수 있어야 한다.
 */

/** 정규화를 통과한 판정 + 지문. 원장에 넣기 직전 형태. */
export interface NormalizedImpact {
  impact: PulseImpact;
  fingerprint: string;
  /** LLM 이 낸 이슈 키(지문 원재료). 유사도 비교에도 쓴다. */
  issueKey: string;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** 보유 종목 표. 손익·기간·메모가 전부 판정의 입력이다. */
function holdingsTable(holdings: StockHoldingSummary[]): string {
  if (!holdings.length)
    return "(보유 종목이 등록되지 않았습니다. impacts 는 거시·섹터 항목만 내거나 빈 배열로 두라.)";
  return holdings
    .map((h) => {
      const price = formatPrice(h.close, h.currency);
      const avg = formatPrice(h.avgPrice, h.currency);
      const target = h.targetPrice != null ? formatPrice(h.targetPrice, h.currency) : "미설정";
      const stop = h.stopPrice != null ? formatPrice(h.stopPrice, h.currency) : "미설정";
      const memo = h.memo ? `\n  · 보유 이유(사용자 메모): ${h.memo}` : "";
      return (
        `- ${h.name} (${h.symbol} / ${h.market === "kr" ? "한국장" : "미국장"})\n` +
        `  · 현재가 ${price} · 평단 ${avg} · 평가손익 ${formatPnlPct(h.pnlPct)}\n` +
        `  · 목표가 ${target} · 손절가 ${stop}\n` +
        `  · 투자기간: ${horizonLabel(h.horizon)} — ${horizonDescription(h.horizon)}${memo}`
      );
    })
    .join("\n");
}

export interface PulsePromptInput {
  /** "YYYY-MM-DD HH:mm" 현재 시각 라벨. */
  now: string;
  /** 이 펄스가 귀속되는 슬롯("HH:mm"). */
  slot: string;
  holdings: StockHoldingSummary[];
  /** 결정론적으로 가져온 세이브티커 속보. */
  breaking: SavetickerItem[];
  /**
   * 최근 이미 알린 이슈 헤드라인들. 같은 걸 또 내지 말라고 알려주기 위한 것이다.
   * (서버가 지문으로 한 번 더 거르지만, 프롬프트 단계에서 줄이면 토큰과 오탐이 함께 준다.)
   */
  recentHeadlines: string[];
}

export function buildPulsePrompt(input: PulsePromptInput): string {
  const recent = input.recentHeadlines.length
    ? input.recentHeadlines.map((h) => `- ${h}`).join("\n")
    : "(없음)";

  return `너는 한국어 증시 실시간 감시 담당이다. 지금 시각은 ${input.now} (KST), 이번 펄스 슬롯은 ${input.slot} 이다.
지난 **1시간 안팎**에 새로 나온 재료 중, 아래 [내 보유 종목]에 영향을 줄 만한 것만 골라낸다.

[내 보유 종목] — 이 종목들에 대한 영향만이 관심사다
${holdingsTable(input.holdings)}

[세이브티커 속보] — 서버가 직접 가져온 **확정 목록**이다. 지어낸 것이 아니니 그대로 신뢰하고 우선 검토하라.
${savetickerTable(input.breaking)}

[최근 이미 알린 이슈] — 아래와 **같은 사건은 다시 내지 마라.** 상황이 크게 바뀐 경우(강도 상승, 새 사실 추가)만 예외다.
${recent}

⛔ **도구는 반드시 한 번에 하나씩만 호출하라. 여러 WebSearch 를 한 턴에 병렬로 날리지 마라.**
(병렬 호출 시 tool_use id 가 중복돼 API 가 400 을 뱉고 펄스 전체가 실패한다 — 실측된 실패다.)

조사 순서(주제별로 하나씩 순차 검색):
1. 위 [세이브티커 속보] 중 보유 종목·섹터와 연결되는 건의 **배경과 시장 반응** 확인
2. **시장을 움직이는 인물의 최신 발언·게시글** — 트럼프·머스크·연준 인사·주요 CEO·유명 투자자 등.
   X(트위터)·페이스북은 비로그인 접근이 막혀 있으므로 **언론이 인용한 형태**로 찾아라
   ("트럼프 트루스소셜 게시", "머스크 X 발언" 등으로 검색). 원 게시글 URL 이 없으면
   **그 발언을 보도한 기사 URL** 을 출처로 적어라.
3. 세계 각국 실시간 뉴스 — 미국·유럽·중국·일본·중동. 지정학·관세·규제·금리.
4. 보유 종목 각각의 신규 재료(실적·가이던스·공시·소송·경영진 변화·대형 계약)

⛔ 절대 규칙 1 — **매매 행동을 지시하지 마라**:
- "매수", "매도", "비중확대", "비중축소", "익절", "손절하라", "사라/팔아라", 목표주가 제시 — 전부 금지다.
- 네가 하는 일은 **"이 재료가 어느 방향으로 얼마나 세게 작용하는가"의 판정**까지다.
  행동은 사용자가 정한다. (사용자가 이미 입력해 둔 목표가·손절가를 **언급**하는 것은 사실 인용이라 괜찮다.)

⛔ 절대 규칙 2 — **출처 없는 판정은 금지**:
- 모든 항목에 실제로 열어본 페이지의 URL 을 최소 1개 넣어라. URL 을 지어내면 그 항목은 폐기된다.
- 인물 발언은 **언제 어디서 한 말인지**를 반드시 적어라. 날짜 불명확한 발언은 넣지 마라.

⛔ 절대 규칙 3 — **새 것이 없으면 빈 배열을 내라**:
- 이 펄스는 매시간 돈다. 억지로 채우면 사용자에게 매시간 쓸모없는 문자가 간다.
- 지난 1시간에 새 재료가 없으면 \`"impacts": []\` 가 **정답**이다. 부끄러워할 일이 아니다.

강도(severity) 기준 — **투자기간을 반영해서** 매겨라. 같은 재료도 기간에 따라 달라진다:
- \`urgent\`(긴급) — 해당 종목의 매매 판단을 **당장** 바꿀 만한 사건. 실적 쇼크, 대형 소송, 규제 직격,
  CEO 교체, 인수합병, 급락/급등을 유발한 확정 사실. 새벽에도 사용자를 깨울 값어치가 있는 것만.
- \`important\`(중요) — 방향성에 유의미하게 작용하지만 즉각적이지 않은 재료.
- \`info\`(참고) — 배경·맥락. 문자로는 나가지 않고 일일 리포트 요약에만 남는다.
  판단이 서지 않으면 \`info\` 를 골라라. 과대 평가가 과소 평가보다 훨씬 나쁘다(알림 피로).

issueKey — **같은 사건이면 매 실행마다 같은 문자열이 나와야 한다.**
사건의 핵심만 담은 소문자 슬러그로 적어라: \`주체-행위-대상\` 형태.
예: \`trump-tariff-semiconductor\`, \`nvidia-openai-datacenter-guarantee\`, \`fed-powell-rate-comment\`.
날짜·수식어·문장은 넣지 마라(그러면 매번 달라져서 중복 차단이 무력해진다).

출력 형식 — 조사를 마친 뒤 **아래 JSON 한 개만** 출력(다른 텍스트 없이):
{"impacts":[{
  "symbol": string|null,      // 보유 종목 심볼. 거시·섹터 전반이면 null
  "market": "kr"|"us"|null,
  "name": string,             // 종목명. symbol 이 null 이면 섹터·테마명("반도체 섹터")
  "issueKey": string,
  "direction": "positive"|"negative"|"neutral",
  "severity": "urgent"|"important"|"info",
  "trigger": "person"|"company"|"macro",
  "headline": string,         // 한 줄 요지(문자 제목이 된다. 60자 이내)
  "rationale": string,        // 판정 근거 — 필수
  "risks": string,            // 이 판정이 틀릴 수 있는 조건 — 필수
  "sources":[{"title":string,"origin":string,"url":string,"publishedAt":string|null}]
}],
"notes": string|null}`;
}

/** 출처 1건 정규화. url 이 http(s) 가 아니면 버린다(상대경로·지어낸 문자열 차단). */
function normalizeSource(r: unknown): PulseSource | null {
  const o = r as Record<string, unknown> | null;
  const url = str(o?.url, 500);
  if (!/^https?:\/\//i.test(url)) return null;
  const title = str(o?.title, 200);
  if (!title) return null;
  return {
    title,
    origin: str(o?.origin, 100),
    url,
    publishedAt: str(o?.publishedAt, 60) || null,
  };
}

const VALID_MARKETS: StockMarket[] = ["kr", "us"];

/**
 * 판정 1건 정규화. 아래 조건 중 하나라도 어기면 **폐기(null)** 한다:
 *  - headline 없음 → 문자로 보낼 제목이 없다
 *  - rationale·risks 없음 → 근거 없는 판정은 "그럴듯하지만 검증 불가"라 가장 위험하다
 *    (브리핑의 normalizeAnalysisNarrative 와 같은 정책)
 *  - 유효한 출처 0건 → 지어낸 발언을 막는 유일한 방어선이다. 이 규칙만은 절대 완화하지 말 것.
 *
 * 액션 표현은 **폐기 사유가 아니다.** 판정 자체(방향·강도·출처)는 유효한데 서술 한 줄 때문에
 * 재료를 통째로 잃는 것이 더 큰 손실이라, 해당 문장을 잘라내고 살린다.
 * `strippedAction` 으로 호출부가 그 사실을 로그에 남길 수 있게 한다.
 */
export function normalizeImpact(
  r: unknown,
  knownSymbols: Set<string>
): { value: NormalizedImpact; strippedAction: string[] } | null {
  const o = r as Record<string, unknown> | null;
  const headline = str(o?.headline, 300);
  const rationale = str(o?.rationale, 1500);
  const risks = str(o?.risks, 1000);
  if (!headline || !rationale || !risks) return null;

  const sources = (Array.isArray(o?.sources) ? o.sources : [])
    .map(normalizeSource)
    .filter((x): x is PulseSource => !!x);
  if (!sources.length) return null;

  // 심볼은 **보유 목록에 있는 것만** 인정한다. LLM 이 보유하지도 않은 종목을 지어내면
  // 상한 집계가 그 심볼로 새고, 사용자는 "내가 안 들고 있는 종목 알림"을 받는다.
  const rawSymbol = str(o?.symbol, 20).toUpperCase();
  const symbol = rawSymbol && knownSymbols.has(rawSymbol) ? rawSymbol : null;
  const rawMarket = str(o?.market, 4) as StockMarket;
  const market = VALID_MARKETS.includes(rawMarket) ? rawMarket : null;

  const stripped: string[] = [];
  const clean = (text: string): string => {
    const hits = findActionPhrases(text);
    if (!hits.length) return text;
    stripped.push(...hits);
    // 문장 단위로 잘라낸다. 단어만 지우면 "…를 권한다" 같은 잔해가 남아 더 이상하다.
    return (
      text
        .split(/(?<=[.!?。])\s+|\n+/)
        .filter((s) => !findActionPhrases(s).length)
        .join(" ")
        .trim() || "(투자 권유 표현이 포함되어 해당 서술을 제외했습니다.)"
    );
  };

  const impact: PulseImpact = {
    symbol,
    // symbol 이 확정됐는데 market 이 비면 거시로 오분류된다(상한이 갈린다). 심볼이 있으면
    // 시장은 호출부가 보유 원장에서 채워 넣는다 — 여기서는 LLM 값만 검증한다.
    market: symbol ? market : null,
    name: str(o?.name, 100) || headline.slice(0, 40),
    direction: normalizeDirection(o?.direction),
    severity: normalizeSeverity(o?.severity),
    headline: clean(headline),
    rationale: clean(rationale),
    risks: clean(risks),
    sources,
    // 심볼이 없으면 종목 트리거일 수 없다 — 'company' 로 오면 'macro' 로 바로잡는다.
    // 그러지 않으면 거시 이슈가 종목 상한을 먹는다.
    trigger: symbol ? normalizeTrigger(o?.trigger) : "macro",
  };

  const issueKey = str(o?.issueKey, 200) || impact.headline;
  return {
    value: { impact, fingerprint: fingerprint(symbol, issueKey), issueKey },
    strippedAction: stripped,
  };
}

export interface NormalizedPulse {
  impacts: NormalizedImpact[];
  notes: string | null;
  /** 폐기된 항목 수(근거·출처 누락). 로그로 프롬프트 품질을 관찰하기 위한 것. */
  dropped: number;
  /** 액션 표현이 잘린 항목들의 원문 조각. 프롬프트가 새고 있는지 관찰한다. */
  strippedActions: string[];
}

/** 파싱된 JSON → 정규화된 판정 묶음. 순수 함수(테스트 대상). */
export function normalizePulse(parsed: unknown, knownSymbols: Set<string>): NormalizedPulse {
  const p = parsed as Record<string, unknown> | null;
  const rows = Array.isArray(p?.impacts) ? p.impacts : [];
  const impacts: NormalizedImpact[] = [];
  const strippedActions: string[] = [];
  let dropped = 0;

  for (const r of rows) {
    const n = normalizeImpact(r, knownSymbols);
    if (!n) {
      dropped++;
      continue;
    }
    impacts.push(n.value);
    strippedActions.push(...n.strippedAction);
  }

  return {
    impacts,
    notes: typeof p?.notes === "string" && p.notes.trim() ? p.notes.trim() : null,
    dropped,
    strippedActions,
  };
}
