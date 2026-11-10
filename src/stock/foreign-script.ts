/**
 * 증시 서술의 외국 문자 검출기와 그 결과를 다루는 순수 규칙.
 * 네트워크·전역 상태를 읽지 않는다 — 이 판정이 곧 문장 삭제로 이어지므로 테스트로 못박는다.
 *
 * ## 왜 "한자가 있으면 오염"이 아닌가
 * 2026-11-10 펄스 원장 253건을 직접 읽어 보니 비한글 문자는 대부분 한국 경제 기사의 정상 표기였다
 * ("美 8월 CPI", "전분기比 70%↑"). 그렇다고 단독 한자를 전부 통과시키면 실제 누출 사례
 * "취합为" 를 놓친다. 그래서 단독 한자는 **실측 용례가 확인된 글자만** 허용한다.
 *
 * 영문(라틴 문자)은 검사하지 않는다 — 티커·기관명·약어가 정상적으로 많다.
 */

/**
 * 단독으로 쓰일 때 정상으로 보는 한자. 전부 위 원장의 실제 용례다.
 * 실측에 없는 글자(英·北 등)는 일부러 넣지 않았다 — 걸려도 교정이 '영국'으로 고칠 뿐이고,
 * 근거 없이 넓히면 간체·일본어의 단독 누출을 놓친다. 간체(证·说·战)도 같은 이유로 뺐다.
 */
const ALLOWED_SINGLE_HAN = new Set([
  "美", // 미국 — "SK하이닉스, 美 HBM 팹 착공"
  "中", // 중국 — "로이터 \"中 CXMT, 베이징 신공장"
  "日", // 일본 — "'美·日 공장설' 일단 진화"
  "韓", // 한국 — "호르무즈 선 그은 韓"
  "李", // 대통령 성(姓) 약칭 — "李대통령 \"레버리지 ETF 도입"
  "比", // 대비 — "2분기 낸드 매출 전분기比 70%↑"
  "證", // 증권사 약칭 — "대신證 \"초기 검토"
  "反", // 필라델피아 반도체지수 약칭 — "필라反 +1.81%"
  "說", // 소문·설 — "기업용 AI 서버 개발說"
  "年", // 연간 — "인디애나서 年수십만장"
  "株", // 주식 — "반도체 대형株"
  "人", // 사람 수 — "핵심 부회장 3人"
  "前", // 이전 — "뉴욕증시 마감 60분 前"
  "戰", // 전쟁 — "트럼프 \"이란戰 중대 기로"
  "行", // 행선지 — "부회장 3인 하이닉스行"
]);

const HAN_RUN = /\p{Script=Han}+/gu;

/**
 * 한자 외의 비라틴 외국 문자(가나·키릴·태국·아랍·히브리·데바나가리 등) 구간.
 * 제외 목록이 허용 목록보다 안전하다 — 예상 못 한 문자권도 자동으로 걸린다.
 *
 * 그리스 문자만 2자 이상일 때 잡는다. 단독 α·β·Δ·μ 는 금융 서술의 기호("베타(β)")다.
 * Common 제외로 '·'(U+30FB) 같은 가운뎃점과 이모지·기호는 걸리지 않는다.
 */
const OTHER_FOREIGN_RUN =
  /\p{Script=Greek}{2,}|(?:(?![\p{Script=Latin}\p{Script=Hangul}\p{Script=Han}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}])[\p{L}\p{M}])+/gu;

export interface ForeignSpan {
  text: string;
  index: number;
}

/** 텍스트 안의 외국 문자 구간을 등장 순서대로 돌려준다. 없으면 빈 배열. */
export function findForeignSpans(text: string): ForeignSpan[] {
  const spans: ForeignSpan[] = [];
  for (const m of text.matchAll(HAN_RUN)) {
    // 2자 이상 연속이면 허용 글자끼리여도 오염이다(美中 → 교정이 '미중'으로 고친다).
    if (ALLOWED_SINGLE_HAN.has(m[0])) continue;
    spans.push({ text: m[0], index: m.index });
  }
  for (const m of text.matchAll(OTHER_FOREIGN_RUN)) {
    spans.push({ text: m[0], index: m.index });
  }
  return spans.sort((a, b) => a.index - b.index);
}

/**
 * 문장 경계. '4.998%' 의 소수점이 끊기지 않도록 라틴 구두점은 뒤따르는 공백을 요구하고,
 * 전각 구두점은 원래 공백 없이 이어지므로 요구하지 않는다.
 */
const SENTENCE_BREAK = /(?<=[.!?])\s+|(?<=[。！？])\s*|\n+/;

/** 외국 문자가 든 문장만 제거한다. 남는 문장이 없으면 "". */
export function dropForeignSentences(text: string): string {
  return text
    .split(SENTENCE_BREAK)
    .filter((s) => s.trim() && !findForeignSpans(s).length)
    .join(" ")
    .trim();
}

/** 숫자 토큰(천 단위 구분·소수 포함)을 정렬해 돌려준다. 다중집합 비교용. */
export function numberTokens(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).sort();
}
