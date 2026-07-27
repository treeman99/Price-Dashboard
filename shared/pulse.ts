import type { PulseDirection, PulseImpact, PulseSeverity } from "./types.ts";

/**
 * 펄스(시간당 실시간 취합)의 순수 규칙 — 지문·강도·표기.
 * 서버 원장과 알림 포맷터가 같은 함수를 쓴다(shared/holdings.ts 상단 주석과 같은 이유).
 */

/**
 * 강도 순위. **문자열 비교를 쓰면 안 된다** — 사전순으로는 "important" < "info" < "urgent" 라
 * info 가 important 보다 높게 나온다. 중복 억제의 '강도 상승 시 재발송' 규칙이 정확히 이 비교에
 * 걸려 있어서, 여기가 틀리면 참고 등급 알림이 중요 등급을 밀어내고 재발송된다.
 */
const SEVERITY_RANK: Record<PulseSeverity, number> = { info: 0, important: 1, urgent: 2 };

export function severityRank(s: PulseSeverity): number {
  return SEVERITY_RANK[s] ?? 0;
}

export function isAtLeast(s: PulseSeverity, min: PulseSeverity): boolean {
  return severityRank(s) >= severityRank(min);
}

export const SEVERITY_LABEL: Record<PulseSeverity, string> = {
  urgent: "긴급",
  important: "중요",
  info: "참고",
};

export const DIRECTION_LABEL: Record<PulseDirection, string> = {
  positive: "긍정",
  negative: "부정",
  neutral: "중립",
};

/** 문자 본문 머리의 부호 이모지. 브리핑의 verdict 이모지와 같은 어휘를 쓴다. */
export const DIRECTION_EMOJI: Record<PulseDirection, string> = {
  positive: "📈",
  negative: "📉",
  neutral: "➡️",
};

export const TRIGGER_LABEL: Record<PulseImpact["trigger"], string> = {
  person: "인물 발언",
  company: "종목 직격",
  macro: "거시·섹터",
};

/** 허용 목록 밖이면 가장 보수적인 값으로 접는다(참고/중립). */
export function normalizeSeverity(v: unknown): PulseSeverity {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "urgent" || s === "긴급") return "urgent";
  if (s === "important" || s === "중요") return "important";
  return "info";
}

export function normalizeDirection(v: unknown): PulseDirection {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "positive" || s === "긍정") return "positive";
  if (s === "negative" || s === "부정") return "negative";
  return "neutral";
}

export function normalizeTrigger(v: unknown): PulseImpact["trigger"] {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "person" || s === "인물") return "person";
  if (s === "macro" || s === "거시") return "macro";
  return "company";
}

/**
 * 지문 토큰화. 한글·영문·숫자만 남기고 2글자 미만 토큰은 버린다.
 *
 * 조사·불용어는 **의도적으로 제거하지 않는다.** 한국어 조사 제거는 형태소 분석 없이는
 * 오탐이 크고("관세" vs "관세는"은 여기서 다른 토큰이 된다), 아래 유사도 판정이 정확
 * 일치가 아니라 **비율** 기준이라 토큰 몇 개가 어긋나도 흡수된다. 어설픈 정규화로
 * 서로 다른 사건을 같은 지문으로 뭉치는 쪽이 훨씬 위험하다(진짜 긴급 건이 조용히 삼켜진다).
 */
export function tokenize(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/**
 * 이슈 지문. `symbol`(없으면 "macro") + 정규화된 이슈 키로 만든다.
 *
 * 이슈 키는 LLM 이 낸 `issueKey` 를 우선 쓰고, 없으면 headline 으로 대체한다. LLM 키를
 * 우선하는 이유는 **표현이 흔들려도 사건이 같으면 같은 키가 나오길 기대**하기 때문이다
 * (headline 은 실행마다 문장이 바뀐다). 다만 LLM 키도 드리프트하므로 정확 일치만으로는
 * 부족하고, isSimilarIssue 의 토큰 유사도가 2차 방어선이다.
 */
export function fingerprint(symbol: string | null, issueKey: string): string {
  const scope = (symbol ?? "macro").toUpperCase();
  const key = tokenize(issueKey).sort().join("-");
  return `${scope}:${key || "unknown"}`;
}

/**
 * 두 이슈가 같은 사건인지 (지문 정확 일치의 2차 방어선).
 *
 * Jaccard 유사도 0.6 이상이면 같은 사건으로 본다. 임계값 근거: 같은 사건을 두 번 서술하면
 * 핵심 명사(주체·행위·대상)가 공유되어 보통 0.6~0.9 가 나오고, 다른 사건은 공통 토큰이
 * 시장·종목명 정도라 0.3 을 넘기 어렵다. 애매한 구간(0.4~0.6)은 **보내는 쪽**으로 판정한다 —
 * 중복 한 통이 진짜 긴급 건 누락보다 낫다.
 */
export function isSimilarIssue(a: string, b: string, threshold = 0.6): boolean {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union > 0 && inter / union >= threshold;
}

/**
 * 액션 표현 검열기.
 *
 * 사용자가 인터뷰에서 **'영향도 판정까지만'** 을 선택했다. 프롬프트로도 금지하지만
 * 프롬프트는 확률적 방어라 새는 날이 있고, 새면 그대로 문자로 나간다. 발송 직전에
 * 결정론적으로 한 번 더 막는다.
 *
 * ⚠️ 여기 걸린 항목은 **버리지 않고 문구만 표시**한다. 판정 자체(방향·강도·출처)는 유효한데
 *    서술 한 줄 때문에 재료를 통째로 잃으면 그게 더 큰 손실이다. 호출부가 이 결과를 보고
 *    해당 문장을 잘라내거나 경고 라벨을 붙인다.
 */
const ACTION_PATTERNS: RegExp[] = [
  /매수(하|를|해|가|\s|$)/,
  /매도(하|를|해|가|\s|$)/,
  // 목적격 조사(을/를)만 허용한다. 주격(이/가)까지 넣으면 "지수 내 비중이 축소됐다" 같은
  // **사실 서술**이 매매 지시로 오인돼 멀쩡한 근거 문장이 잘려 나간다.
  /비중[을를]?\s*(확대|축소|조절|조정)/,
  /(익절|손절)\s*(하|해|를|권|추천)/,
  /(사|팔)(라|아라|세요|십시오)/,
  /추천\s*(종목|매매)/,
  /목표\s*주?가\s*(제시|설정|는)/,
  /\b(buy|sell|overweight|underweight)\b/i,
];

export function findActionPhrases(text: string): string[] {
  const hits: string[] = [];
  for (const re of ACTION_PATTERNS) {
    const m = re.exec(text ?? "");
    if (m) hits.push(m[0].trim());
  }
  return hits;
}

export function hasActionPhrase(text: string): boolean {
  return findActionPhrases(text).length > 0;
}
