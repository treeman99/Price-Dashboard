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
  nextRound: 51,
  scoredRounds: 50,
  current: {
    version: 1,
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

test("프롬프트에 채점 규칙·기준선·현재 사양이 모두 실린다", () => {
  const p = buildEvolvePrompt(ctx);
  assert.match(p, /보너스 1개 = 7개/);
  assert.match(p, /0개=-6/);
  assert.match(p, new RegExp(LOTTO_BASELINE_PER_ROUND.toFixed(2).replace(".", "\\.")));
  assert.match(p, /51회차부터/);
  assert.match(p, /"explore": 1/); // 현재 사양 JSON
  assert.match(p, /max-coverage/); // 노브 설명서
  assert.match(p, /walk-forward/);
});

test("세대 성적표가 기준선 대비와 함께 표로 들어간다", () => {
  const p = buildEvolvePrompt(ctx);
  assert.match(p, /\| 1 \| 1~50 \| 50 \| -10\.40 \| \+0\.60 \| 0\.94 \| 33\.0% \|/);
});

test("직전 구간 점수가 회차:점수 형태로 들어간다", () => {
  assert.match(buildEvolvePrompt(ctx), /49:-12, 50:-12/);
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
