import { test } from "node:test";
import assert from "node:assert/strict";
import { dropForeignSentences, findForeignSpans, numberTokens } from "./foreign-script.ts";

const spans = (t: string) => findForeignSpans(t).map((s) => s.text);

/** 2026-11-10 미국장 개장 프리뷰 AMZN factors 실제 원문. */
const AMZN_FACTORS =
  "服务器过去24小时实时 취합为 특이사항 없음이다. 별도 웹 확인에서는 AWS가 의료 서비스 접근성 확대를 위한 " +
  "인공지능·클라우드 지원 계획을 발표했다. 사업 활용처 확대에는 약한 긍정 요인이지만 단기 매출 기여는 확인되지 않았다. " +
  "제공된 Q3 2026 실적 자료는 2026-10-30 제출 10-Q 기준 매출 전년 대비 +12.1%, 순이익 -2.4%로 성장과 수익성 신호가 엇갈린다. " +
  "오늘 밤 소비자물가지수와 금리 반응도 공통 변수다.";

test("실제 오염 문장 — 앞 구간과 한글에 붙은 간체 한 글자를 모두 검출한다", () => {
  assert.deepEqual(spans(AMZN_FACTORS), ["服务器过去", "小时实时", "为"]);
});

test("실제 오염 문장 — 문장 제거 시 둘째 문장부터 그대로 남는다", () => {
  const out = dropForeignSentences(AMZN_FACTORS);
  assert.ok(out.startsWith("별도 웹 확인에서는 AWS가"));
  assert.ok(out.includes("+12.1%, 순이익 -2.4%"));
  assert.ok(out.endsWith("공통 변수다."));
  assert.deepEqual(spans(out), []);
});

test("한국 경제 기사의 관용 단독 한자는 정상이다(원장 실측 용례)", () => {
  for (const t of [
    "美 8월 CPI",
    "2분기 낸드 매출 전분기比 70%↑",
    "10년물 4.998%(전일比 +0.051%p)",
    '로이터 "中 CXMT, 베이징 신공장',
    "'美·日 공장설' 일단 진화",
    "호르무즈 선 그은 韓",
    '李대통령 "레버리지 ETF 도입',
    '대신證 "초기 검토',
    "美증시 5일만에 반등, 필라反 +1.81%",
    "기업용 AI 서버 개발說(2029 목표)",
    "인디애나서 年수십만장",
    "반도체 대형株",
    "핵심 부회장 3人",
    "뉴욕증시 마감 60분 前",
    '트럼프 "이란戰 중대 기로',
    "부회장 3인 하이닉스行",
  ]) {
    assert.deepEqual(spans(t), [], t);
  }
});

test("한자 2자 이상 연속은 허용 글자끼리여도 오염이다", () => {
  assert.deepEqual(spans("美中 무역 갈등"), ["美中"]);
  assert.deepEqual(spans("중국 제몐신문(界面新聞)과"), ["界面新聞"]);
});

test("허용 목록에 없는 단독 한자는 오염이다 — 간체 포함", () => {
  assert.deepEqual(spans("대신证 초기 검토"), ["证"]);
  assert.deepEqual(spans("수급 为 변수"), ["为"]);
  assert.deepEqual(spans("英 중앙은행"), ["英"]);
});

test("비라틴 외국 문자는 문자권과 무관하게 오염이다", () => {
  assert.deepEqual(spans("これは 시장"), ["これは"]);
  assert.deepEqual(spans("サーバー 증설"), ["サ", "バ"]); // 장음 부호(ー)는 Common 이라 구간을 끊는다
  assert.deepEqual(spans("Россия 제재"), ["Россия"]);
  assert.deepEqual(spans("ตลาด 동향"), ["ตลาด"]);
  assert.deepEqual(spans("سوق 동향"), ["سوق"]);
  assert.deepEqual(spans("שוק 동향"), ["שוק"]);
  assert.deepEqual(spans("बाजार 동향"), ["बाजार"]);
  assert.deepEqual(spans("Αγορά 동향"), ["Αγορά"]);
});

test("라틴 문자·기호는 검사하지 않는다", () => {
  for (const t of [
    "AAPL 10-Q, S&P500, Nestlé",
    "삼성・SK하이닉스 동반 상승", // U+30FB 가운뎃점
    "삼성·SK하이닉스", // U+00B7
    "베타(β) 1.2, 변동폭 Δ0.3",
    "📈 ➡️ 🔥강 ↑ % ㈜",
  ]) {
    assert.deepEqual(spans(t), [], t);
  }
});

test("문장 제거 — 소수점에서 끊지 않고, 전각 마침표는 공백 없이도 끊는다", () => {
  assert.equal(dropForeignSentences("금리는 4.998% 다. 为 변수다. 끝."), "금리는 4.998% 다. 끝.");
  assert.equal(dropForeignSentences("服务器。정상 문장이다."), "정상 문장이다.");
});

test("문장 제거 — 남는 문장이 없으면 빈 문자열", () => {
  assert.equal(dropForeignSentences("服务器过去 취합为"), "");
});

test("numberTokens — 소수·천 단위를 한 토큰으로 정렬해 돌려준다", () => {
  assert.deepEqual(numberTokens("Q3 +12.1%, 1,234원, 24시간"), ["1,234", "12.1", "24", "3"]);
  assert.deepEqual(numberTokens("숫자 없음"), []);
});
