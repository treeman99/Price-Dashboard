import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOTTO_AGENT_MODEL,
  buildEvolvePrompt,
  isLottoUsageLimit,
  type LottoEvolveContext,
} from "./agent.ts";
import { SEED_SPEC } from "./strategy.ts";
import { isFailureSignal } from "../util/agent-query.ts";
import { isCodexUsageLimitNotice } from "../util/codex-query.ts";
import { LOTTO_BASELINE_PER_ROUND } from "../../shared/lotto.ts";

const ctx: LottoEvolveContext = {
  run: 1,
  nextRound: 51,
  scoredRounds: 50,
  current: {
    version: 1,
    run: 1,
    fromRound: 1,
    spec: SEED_SPEC,
    rationale: "실험의 기준점.",
    hypothesis: "무작위 추출.",
    author: "seed",
    model: "",
    createdAt: "2026-07-29T00:00:00.000Z",
  },
  generations: [
    {
      version: 1,
      fromRound: 1,
      toRound: 50,
      rounds: 50,
      totalScore: -520,
      avgScore: -10.4,
      bestScore: 8,
      worstScore: -42,
      avgMatches: 0.94,
      zeroSetRate: 0.33,
      hit3Rate: 0.32,
      hit3Rounds: 16,
      hit3Sets: 19,
      bestMatch: 4,
    },
  ],
  runs: [
    {
      run: 1,
      fromRound: 1,
      toRound: 50,
      rounds: 50,
      firstVersion: 1,
      lastVersion: 1,
      hit3Rate: 0.32,
      hit3Rounds: 16,
      avgScore: -10.4,
      avgMatches: 0.94,
      bestMatch: 4,
      inProgress: true,
    },
  ],
  recent: [
    { round: 49, drawDate: "2003-11-08", version: 1, sets: [], matches: [], score: -12, cumScore: -508 },
    { round: 50, drawDate: "2003-11-15", version: 1, sets: [], matches: [], score: -12, cumScore: -520 },
  ],
};

test("모델은 프로젝트 공용 설정과 무관하게 Opus 5 로 고정된다", () => {
  // 사용자 요구(2026-07-29)이자 실험의 통제 변인. 바뀌면 곡선의 원인을 분리할 수 없다.
  assert.equal(LOTTO_AGENT_MODEL, "claude-opus-5");
});

test("프롬프트가 목표 지표(3+ 적중률)를 규칙·현재 사양과 함께 싣는다", () => {
  const p = buildEvolvePrompt(ctx);
  assert.match(p, /보너스 1개 = 7개/);
  assert.match(p, /3\+ 적중률/);
  assert.match(p, /51회차부터/);
  assert.match(p, /"explore": 1/); // 현재 사양 JSON
  assert.match(p, /maxSetOverlap/); // 노브 설명서
  assert.match(p, /walk-forward/);
  assert.match(p, /1번째 바퀴/);
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

test("바퀴별·세대별 성적표가 3+ 적중률과 함께 표로 들어간다", () => {
  const p = buildEvolvePrompt(ctx);
  assert.match(p, /\| 1 \(진행중\) \| 50 \| v1~v1 \| \*\*32\.0%\*\* \| 16 \|/);
  assert.match(p, /\| 1 \| 1~50 \| 50 \| \*\*32\.0%\*\* \| 16 \| 19 \| 4 \| -10\.40 \|/);
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
 * "JSON 미발견" 으로 둔갑해 4시간 대기 대신 '사양 승계' 세대가 찍히고, 남은 진화 호출이
 * 전부 같은 방식으로 실패해 이후 세대가 전원 직전 사양의 복사본이 된다 — 완주할 때까지
 * 아무 신호도 없다. 4시간 자동 재개가 이 한 줄에 걸려 있으므로 6종 전부를 못박는다.
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
  // 오인하면 실험이 4시간마다 되살아나며 같은 실패를 반복한다.
  assert.equal(isLottoUsageLimit(new Error("JSON 미발견")), false);
  assert.equal(isLottoUsageLimit(new Error("Agent 응답 시간 초과(600s)")), false);
  assert.equal(isLottoUsageLimit(new Error("Agent 비정상 종료(error_max_turns)")), false);
  assert.equal(isLottoUsageLimit(null), false);
});
