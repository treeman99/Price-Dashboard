import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOTTO_AGENT_MODEL,
  LOTTO_AGENT_WINDOW,
  buildEvolvePrompt,
  isLottoUsageLimit,
  type LottoEvolveContext,
} from "./agent.ts";
import { SEED_SPEC } from "./strategy.ts";
import { isFailureSignal } from "../util/agent-query.ts";
import { isCodexUsageLimitNotice } from "../util/codex-query.ts";
import type { LottoRecentRound, LottoSummary } from "../../shared/lotto.ts";
import { LOTTO_BASELINE_PER_ROUND } from "../../shared/lotto.ts";

const summary = (patch: Partial<LottoSummary> = {}): LottoSummary => ({
  rounds: 1234,
  avgScore: -10.98,
  avgMatches: 0.93,
  hit3Rounds: 412,
  hit4Rounds: 38,
  hit5Rounds: 2,
  hit3Sets: 486,
  hit3Rate: 0.334,
  weightedRate: 0.4,
  bestMatch: 5,
  ...patch,
});

/** 방금 채점된 회차 — 이번 호출의 유일한 새 정보다. */
const latest: LottoRecentRound = {
  round: 1235,
  drawDate: "2026-08-01",
  version: 169,
  sets: [
    [3, 11, 20, 28, 36, 44],
    [1, 9, 17, 25, 33, 41],
    [5, 13, 21, 29, 37, 45],
    [2, 10, 18, 26, 34, 42],
    [7, 15, 23, 31, 39, 43],
    [4, 12, 19, 27, 35, 40],
    [6, 14, 22, 30, 38, 45],
    [8, 16, 24, 32, 36, 44],
    [1, 11, 21, 31, 41, 43],
    [2, 12, 22, 32, 42, 45],
  ],
  matches: [2, 0, 1, 0, 1, 0, 0, 1, 3, 0],
  score: -19,
  cumScore: -13540,
  drawNumbers: [1, 11, 20, 21, 31, 36],
  drawBonus: 43,
};

const ctx: LottoEvolveContext = {
  nextRound: 1236,
  current: {
    version: 169,
    run: 8,
    fromRound: 1201,
    spec: SEED_SPEC,
    rationale: "기준점.",
    hypothesis: "무작위 추출.",
    author: "agent",
    model: "claude-opus-5",
    createdAt: "2026-07-29T00:00:00.000Z",
  },
  latest,
  recent: [latest],
  overall: summary(),
  window: summary({ rounds: 100, hit3Rounds: 34, hit3Rate: 0.34, weightedRate: 0.41 }),
  history: [
    {
      version: 169,
      run: 8,
      fromRound: 1201,
      spec: SEED_SPEC,
      rationale: "기준점.",
      hypothesis: "searchSteps 를 0으로 되돌리면 가중점수가 표준오차 안에서 구별되지 않을 것이다.",
      author: "agent",
      model: "claude-opus-5",
      createdAt: "2026-07-29T00:00:00.000Z",
    },
  ],
};

test("모델은 프로젝트 공용 설정과 무관하게 Opus 5 로 고정된다", () => {
  // 사용자 요구(2026-07-29). 한도 소진 시에도 다른 모델로 갈아타지 않는다.
  assert.equal(LOTTO_AGENT_MODEL, "claude-opus-5");
});

test("프롬프트가 목표 지표·현재 사양·적용 회차를 함께 싣는다", () => {
  const p = buildEvolvePrompt(ctx);
  assert.match(p, /보너스 1개 = 7개/);
  assert.match(p, /가중 회차 점수/);
  assert.match(p, /1236회차/); // 새 세대가 적용될 회차
  assert.match(p, /"explore": 1/); // 현재 사양 JSON
  assert.match(p, /maxSetOverlap/); // 노브 설명서
  assert.match(p, /walk-forward/);
});

/**
 * **이번 주 새 정보가 프롬프트의 주인공이어야 한다.**
 * 지난주에 추천한 10세트와 실제 당첨번호가 나란히 들어가지 않으면, 사용자가 요청한
 * "비교 결과를 에이전트에 업데이트"가 실제로는 일어나지 않는다.
 */
test("방금 채점된 회차의 제출 번호와 실제 당첨번호를 대조표로 싣는다", () => {
  const p = buildEvolvePrompt(ctx);
  assert.match(p, /1235회차 \(2026-08-01\)/);
  assert.match(p, /당첨번호 1, 11, 20, 21, 31, 36 \+ 보너스 43/);
  // 적중한 번호는 굵게 표시된다(1번 세트의 11·20 등).
  assert.match(p, /\*\*11\*\*/);
  // 10세트 전부 들어간다.
  assert.match(p, /\| 10 \|/);
  assert.match(p, /최고적중 \*\*3개\*\*/);
});

/**
 * 주간 운영의 가장 큰 위험은 **회차 1개에 맞춰 매주 노브를 흔드는 것**이다(사용자가 반복
 * 학습을 중단한 이유). 프롬프트가 '유지도 정답'이라고 말하지 않으면 모델은 매주 무언가를
 * 바꾼다 — 그래서 이 문구를 테스트로 못박는다.
 */
test("표본 1회차로 사양을 흔들지 말라는 제약이 프롬프트에 들어 있다", () => {
  const p = buildEvolvePrompt(ctx);
  assert.match(p, /표본 1/);
  assert.match(p, /그대로 반복해서 출력하고 changed 를 빈 배열로/);
  assert.match(p, /매주 한 번/);
});

test("전체·최근 구간 요약을 표준오차와 함께 두 벌 싣는다", () => {
  const p = buildEvolvePrompt(ctx);
  assert.match(p, /전체: 1234회차/);
  assert.match(p, new RegExp(`최근 ${LOTTO_AGENT_WINDOW}회차: 100회차`));
  assert.match(p, /±\d+\.\d%p/);
});

test("이미 시도한 전략을 실어 같은 방향을 반복하지 않게 한다", () => {
  const p = buildEvolvePrompt(ctx);
  assert.match(p, /이미 시도한 전략/);
  assert.match(p, /v169 \| 1201~ \| fullCover=false overlap≤6 search=0 explore=1/);
});

/**
 * 답을 알려주면 실험이 아니라 받아쓰기가 된다. 우리는 최적 구조가
 * '45개 전부 커버 + 세트간 중복 1' 이고 천장이 36.4% 라는 것을 이미 알고 있지만,
 * 그 값들이 프롬프트에 새면 에이전트의 '발견'은 아무것도 증명하지 못한다.
 */
test("정답(최적 구조·천장 수치)을 프롬프트에 흘리지 않는다", () => {
  const p = buildEvolvePrompt(ctx);
  assert.doesNotMatch(p, /36\.4|36\.1|33\.36/);
  assert.doesNotMatch(p, /천장|최적 구조|정답/);
});

test("대조군(점수·3+세트수)임을 명시해 개선 지표로 오인하지 않게 한다", () => {
  const p = buildEvolvePrompt(ctx);
  assert.match(p, /대조군/);
  assert.match(p, new RegExp(LOTTO_BASELINE_PER_ROUND.toFixed(2).replace(".", "\\.")));
});

test("채점할 회차가 없는 재시도에서도 프롬프트가 성립한다", () => {
  // 토큰 한도로 미룬 갱신을 4시간 뒤 재시도하는 경로. latest 가 null 이어도 터지면 안 된다.
  const p = buildEvolvePrompt({ ...ctx, latest: null });
  assert.match(p, /새로 채점된 회차가 없다/);
  assert.match(p, /1236회차/);
});

test("토큰 한도 오류를 알아본다", () => {
  // agent-query 가 실패로 승격시켜 넘기는 실제 형태들
  assert.ok(isLottoUsageLimit(new Error("Agent API 오류: You've hit your limit · resets 6pm (Asia/Seoul)")));
  assert.ok(isLottoUsageLimit(new Error("Agent API 오류: Claude AI usage limit reached")));
  assert.ok(isLottoUsageLimit(new Error("Agent API 오류: Credit balance is too low")));
  assert.ok(isLottoUsageLimit(new Error("API Error: 429 too many requests")));
});

/**
 * 번들 CLI 는 `You've hit your ${라벨}` 로 한도를 통보하고 라벨이 6종이다.
 * 예전에는 `You'?ve hit your limit` 한 종류만 실패로 승격돼, **Opus 5 에서 가장 유력한
 * 두 라벨(Opus limit · session limit)이 통째로 미탐**이었다. 그러면 한도 소진이
 * "JSON 미발견" 으로 둔갑해 재시도 예약 없이 '사양 유지'로 넘어가고, 그 주의 전략 갱신이
 * 조용히 사라진다. 4시간 재시도가 이 한 줄에 걸려 있으므로 6종 전부를 못박는다.
 */
test("한도 통보 6종이 모두 실패로 승격되고 한도로 분류된다", () => {
  const labels = ["limit", "session limit", "Opus limit", "weekly limit", "Sonnet limit", "usage limit"];
  for (const l of labels) {
    const notice = `You've hit your ${l} · resets 3pm (Asia/Seoul)`;
    assert.ok(isFailureSignal(notice), `실패로 승격되지 않음: ${l}`);
    // 승격된 뒤 호출부가 받는 형태
    assert.ok(isLottoUsageLimit(new Error(`Agent API 오류: ${notice}`)), `한도로 분류되지 않음: ${l}`);
    // FAILURE_SIGNALS 가 다시 뒤처져도 에이전트 쪽 2차 방어선이 잡는다
    assert.ok(isCodexUsageLimitNotice(notice), `2차 방어선 미탐: ${l}`);
  }
});

test("정상 큐레이션 결과를 한도 통보로 오인하지 않는다", () => {
  // 넓힌 패턴이 정상 결과를 잡아먹으면 전 탭이 조용히 빈 스냅샷이 된다.
  assert.equal(isFailureSignal('{"spec":{},"rationale":"요금제 한도를 다룬 기사"}'), false);
  assert.equal(isCodexUsageLimitNotice('{"spec":{"explore":1},"rationale":"hit your limit 이라는 문구"}'), false);
});

test("한도가 아닌 실패를 한도로 오인하지 않는다", () => {
  // 오인하면 4시간마다 같은 실패를 반복한다.
  assert.equal(isLottoUsageLimit(new Error("JSON 미발견")), false);
  assert.equal(isLottoUsageLimit(new Error("Agent 응답 시간 초과(600s)")), false);
  assert.equal(isLottoUsageLimit(new Error("Agent 비정상 종료(error_max_turns)")), false);
  assert.equal(isLottoUsageLimit(null), false);
});
