import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { LottoDraw } from "../../shared/lotto.ts";

/**
 * **추천 번호 못박기 계약** — 이 기능 전체가 여기에 걸려 있다.
 *
 * 전에는 화면을 열 때마다 다음 회차 번호를 새로 생성했다. 그러면 다음 주에 채점할 대상이
 * 요청마다 달라져 "추천했던 번호와 실제 추첨 결과를 비교"라는 말이 성립하지 않는다.
 * 아래 두 불변식이 그것을 막는다:
 *   1. 한 번 못박은 회차의 번호는 **전략이 갱신돼도 바뀌지 않는다**
 *   2. 채점은 **못박아 둔 그 번호로만** 하고, 같은 회차를 두 번 채점하지 않는다
 *
 * ⚠️ 이 테스트는 실제 SQLite 를 쓴다(임시 파일). config 가 모듈 초기화 시점에 DB_PATH 를
 *    읽으므로, **import 보다 먼저** 환경변수를 세워야 한다 → 아래 동적 import.
 * ⚠️ 사이클 상태 파일(lotto-state.json)은 **DB 옆**에 생긴다. tmpdir 바로 아래에 DB 를 두면
 *    다른 실행과 상태 파일을 공유하므로 전용 임시 디렉터리를 쓴다.
 */
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lotto-cycle-test-"));
const DB_FILE = path.join(TMP_DIR, "price.db");
process.env.DB_PATH = DB_FILE;

const { saveDraws } = await import("./draws.ts");
const {
  clearUpcoming,
  ensureSeedStrategy,
  getLottoState,
  getUpcoming,
  insertStrategy,
  lastScored,
  latestStrategy,
  recentResultsWithDraw,
  saveUpcoming,
  summarize,
} = await import("./store.ts");
const {
  LOTTO_RETRY_WAIT_MS,
  __setCycleDepsForTest,
  runWeeklyCycle,
  scorePendingPicks,
  shouldCatchUpCycle,
  shouldRunCycle,
  writeUpcomingPicks,
} = await import("./cycle.ts");
const { __setAgentQueryDepsForTest } = await import("../util/agent-query.ts");
const { LOTTO_AGENT_MODEL } = await import("./agent.ts");
const { closeDb } = await import("../db/index.ts");

after(() => {
  closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

const RUN = 1;

/** 결정적인 가짜 회차. 번호는 고정이라 적중 수를 손으로 계산할 수 있다. */
const draw = (round: number, numbers: number[], bonus: number): LottoDraw => ({
  round,
  drawDate: `2026-01-0${(round % 9) + 1}`,
  numbers,
  bonus,
});

test("못박은 번호는 전략이 갱신돼도 덮어써지지 않는다", () => {
  saveDraws([draw(1, [1, 2, 3, 4, 5, 6], 7), draw(2, [8, 9, 10, 11, 12, 13], 14)]);
  const seed = ensureSeedStrategy(RUN, 3);

  const round = writeUpcomingPicks(RUN, seed, 3);
  assert.equal(round, 3);
  const first = getUpcoming();
  assert.ok(first, "추천 번호가 저장되지 않았다");
  assert.equal(first.round, 3);
  assert.equal(first.version, seed.version);
  assert.equal(first.sets.length, 10);

  // 전략이 갱신된 뒤 같은 회차로 다시 불러도 번호와 세대가 그대로여야 한다.
  const next = insertStrategy({
    run: RUN,
    fromRound: 4,
    spec: { ...seed.spec, explore: 0, design: { ...seed.spec.design, fullCover: true } },
    author: "agent",
  });
  writeUpcomingPicks(RUN, next, 3);
  const again = getUpcoming();
  assert.deepEqual(again?.sets, first.sets);
  assert.equal(again?.version, seed.version, "새 세대로 번호가 다시 뽑혔다");
});

test("추첨 결과가 들어오면 못박아 둔 번호로만 채점한다", () => {
  const pinned = getUpcoming();
  assert.ok(pinned);

  // 3회차 당첨번호를 **1번 세트의 앞 3개 + 나머지**로 만들어 적중 수를 확정한다.
  const s0 = pinned.sets[0];
  const winning = [s0[0], s0[1], s0[2]];
  for (let n = 1; n <= 45 && winning.length < 6; n++) {
    if (!pinned.sets.some((set) => set.includes(n))) winning.push(n);
  }
  // 세트가 45개 번호를 다 덮는 사양이면 위 루프가 못 채운다 — 그때는 다른 세트의 번호로 채운다.
  for (let n = 1; n <= 45 && winning.length < 6; n++) {
    if (!winning.includes(n)) winning.push(n);
  }
  const bonus = [...Array(45).keys()]
    .map((i) => i + 1)
    .find((n) => !winning.includes(n)) as number;
  saveDraws([draw(3, [...winning].sort((a, b) => a - b), bonus)]);

  const scored = scorePendingPicks();
  assert.equal(scored, 3);
  assert.equal(getUpcoming(), null, "채점 후에는 추천 번호 레코드가 남아 있어서는 안 된다");

  const rows = recentResultsWithDraw(RUN, 5);
  const row = rows.at(-1);
  assert.ok(row);
  assert.equal(row.round, 3);
  assert.deepEqual(row.sets, pinned.sets, "저장해 둔 번호가 아닌 것으로 채점됐다");
  assert.equal(row.version, pinned.version);
  // 1번 세트는 당첨 6개 중 3개를 포함하도록 만들었으므로 최소 3개 적중이다.
  assert.ok(row.matches[0] >= 3, `1번 세트 적중 ${row.matches[0]}`);
  assert.equal(lastScored(RUN)?.round, 3);
  assert.equal(summarize(RUN).rounds, 1);
});

test("같은 회차를 두 번 채점하지 않는다", () => {
  // 사이클이 두 번 돌거나 재시도가 겹쳐도 누적 점수가 어긋나면 안 된다.
  const before = lastScored(RUN);
  saveUpcoming(RUN, {
    round: 3,
    sets: Array.from({ length: 10 }, () => [1, 2, 3, 4, 5, 6]),
    version: 1,
    createdAt: new Date().toISOString(),
  });
  assert.equal(scorePendingPicks(), null);
  assert.equal(getUpcoming(), null, "중복 채점 시도 후 레코드가 정리되지 않았다");
  assert.deepEqual(lastScored(RUN), before);
  assert.equal(summarize(RUN).rounds, 1);
});

test("추첨 전 회차는 채점하지 않고 그대로 둔다", () => {
  clearUpcoming();
  const seed = ensureSeedStrategy(RUN, 4);
  writeUpcomingPicks(RUN, seed, 4); // 4회차 추첨 결과는 아직 없다
  assert.equal(scorePendingPicks(), null);
  assert.equal(getUpcoming()?.round, 4, "추첨 전 추천 번호가 사라졌다");
});

/* ------------------------------------------------------------------------- *
 * Claude 인증 실패 → 전략 갱신만 미루고 4시간 뒤 재시도
 *
 * 2026-10-04 사고: 구독 OAuth 세션 만료로 v178→v179 갱신이 실패했는데 사이클은 이를 '그냥
 * 실패'로 보고 lastEvolvedRound 를 진행시켰다(그 주 갱신 포기). 인증은 재로그인하면 그대로
 * 회복되는 환경 장애라 한도 소진처럼 미뤄야 한다. 아래는 SDK 스트림 층만 가짜로 두고
 * agent-query → 로또 에이전트 → 사이클의 실제 분류 경로를 그대로 태운다.
 * ------------------------------------------------------------------------- */

const AUTH_EXPIRED = "Failed to authenticate: OAuth session expired and could not be refreshed";

/** 하위 CLI 가 실제로 내보낸 모양: is_error 결과 뒤 "returned an error result" 로 스트림 종료. */
function authExpiredStream(): AsyncIterable<SDKMessage> {
  return (async function* () {
    yield { type: "result", subtype: "success", is_error: true, result: AUTH_EXPIRED } as unknown as SDKMessage;
    throw new Error(`Claude Code returned an error result: ${AUTH_EXPIRED}`);
  })();
}

function okStream(text: string): AsyncIterable<SDKMessage> {
  return (async function* () {
    yield { type: "result", subtype: "success", is_error: false, result: text } as unknown as SDKMessage;
  })();
}

/** 동행복권을 부르지 않는 수집기. 수집 실패의 retry 가 검증 대상 분기를 가리지 않게 한다. */
const noNetworkSync = async () => ({ added: 0, latest: 4 });

/**
 * 추첨~결과 공개 금지 구간(토 20:00~24:00) 판정용 시계. 그 구간에는 번호 확정을 미루므로,
 * 실제 시계를 쓰면 이 파일을 토요일 밤에 돌릴 때만 실패한다. 평일 정오로 고정한다.
 */
const weekdayNoon = () => new Date(2026, 6, 29, 12, 0); // 2026-07-29(수)

test("Claude 인증 실패면 갱신을 미루고(재시도 예약·lastEvolvedRound 유지) 번호는 직전 세대로 확정한다", async () => {
  // 4회차 추첨 결과가 들어와, 못박아 둔 4회차 번호를 채점하고 에이전트를 부를 차례다.
  saveDraws([draw(4, [1, 2, 3, 4, 5, 6], 7)]);
  const before = latestStrategy();
  assert.ok(before);
  const models: unknown[] = [];
  const restoreCycle = __setCycleDepsForTest({ syncDraws: noNetworkSync, now: weekdayNoon });
  const restoreAgent = __setAgentQueryDepsForTest({
    sdkQuery: ({ options }) => {
      models.push(options.model);
      return authExpiredStream();
    },
  });
  try {
    const startedAt = Date.now();
    const r = await runWeeklyCycle("test");

    assert.equal(models.length, 1, "에이전트가 한 번 불려야 한다");
    assert.equal(models[0], LOTTO_AGENT_MODEL);
    assert.equal(r.scoredRound, 4);
    assert.equal(r.reason, "auth-failed");
    assert.equal(r.usageLimited, false, "한도 소진과 구분돼야 한다");
    assert.equal(r.newVersion, null);
    assert.equal(latestStrategy()?.version, before.version, "실패한 갱신이 새 세대를 찍으면 안 된다");

    const st = getLottoState();
    assert.match(st.lastError ?? "", /인증/);
    assert.doesNotMatch(st.lastError ?? "", /JSON 미발견|한도/);
    assert.ok(st.retryAt, "재시도가 예약돼야 한다");
    const retryAt = new Date(st.retryAt).getTime();
    assert.ok(
      retryAt >= startedAt + LOTTO_RETRY_WAIT_MS && retryAt <= Date.now() + LOTTO_RETRY_WAIT_MS,
      `retryAt=${st.retryAt} 가 4시간 뒤가 아니다`
    );
    // ★ 핵심: 포기(진행)하면 재로그인 뒤에도 4회차 결과가 영영 반영되지 않는다.
    assert.equal(st.lastEvolvedRound, null, "인증 실패로 lastEvolvedRound 가 진행됐다");

    // 번호 추출은 미루지 않는다 — 직전 세대로 5회차를 못박는다.
    const pinned = getUpcoming();
    assert.equal(pinned?.round, 5);
    assert.equal(pinned?.version, before.version);
  } finally {
    restoreAgent();
    restoreCycle();
  }
});

test("재로그인 뒤 4시간 재시도에서 미뤘던 갱신이 회복되고, 못박은 번호는 그대로다", async () => {
  const before = latestStrategy();
  const pinned = getUpcoming();
  assert.ok(before && pinned);
  // 예약 시각이 지나면 일요일이 아니어도 사이클이 다시 돈다.
  assert.equal(
    shouldRunCycle(new Date(Date.now() + LOTTO_RETRY_WAIT_MS + 60_000), getLottoState(), true),
    true
  );

  const proposal = JSON.stringify({
    spec: before.spec,
    changed: [],
    hypothesis: "표본 1회차라 사양을 유지한다.",
    rationale: "근거가 표준오차를 넘지 못했다.",
  });
  const restoreCycle = __setCycleDepsForTest({ syncDraws: noNetworkSync, now: weekdayNoon });
  const restoreAgent = __setAgentQueryDepsForTest({ sdkQuery: () => okStream(proposal) });
  try {
    const r = await runWeeklyCycle("retry");
    assert.equal(r.reason, "ok");
    assert.equal(r.error, null);
    assert.equal(r.newVersion, before.version + 1, "미뤘던 4회차 결과로 갱신돼야 한다");

    const st = getLottoState();
    assert.equal(st.lastEvolvedRound, 4);
    assert.equal(st.retryAt, null);
    assert.equal(st.lastError, null);

    // 새 세대는 못박은 5회차 **다음**부터 적용되고, 5회차 번호는 바뀌지 않는다.
    assert.equal(latestStrategy()?.fromRound, 6);
    const again = getUpcoming();
    assert.equal(again?.round, 5);
    assert.equal(again?.version, pinned.version);
    assert.deepEqual(again?.sets, pinned.sets);
  } finally {
    restoreAgent();
    restoreCycle();
  }
});

/* ------------------------------------------------------------------------- *
 * 추첨~결과 공개 구간(토 20:00~24:00)의 번호 확정 가드
 *
 * 사이클은 '다음 회차 = DB 최신 + 1' 로 번호를 확정한다. 토요일 저녁 정시 런이 LLM 큐 대기·전략
 * 갱신으로 추첨(20:45경) 뒤까지 밀리면, DB 최신이 아직 지난 회차라 **방금 추첨된 회차**의 번호를
 * 새로 뽑게 된다. 시작 시각 검증(저장 금지 구간)만으로는 막을 수 없어 확정 시점에 한 번 더 본다.
 * ------------------------------------------------------------------------- */

test("금지 구간에 번호 확정 단계에 닿으면 새로 뽑지 않고 미룬다 → 자정 이후 보충이 확정한다", async () => {
  // 직전 테스트 뒤 상태: 4회차까지 채점·반영, 5회차 번호가 못박혀 있다. 그 번호가 없는 상황
  // (예: 토요일 19시대 런이 4회차를 채점하고 막 지운 직후)을 만든다.
  clearUpcoming();
  const saturdayNight = () => new Date(2026, 7, 1, 21, 0); // 2026-08-01(토) 21:00
  const restore = __setCycleDepsForTest({ syncDraws: noNetworkSync, now: saturdayNight });
  try {
    const r = await runWeeklyCycle("test-draw-window");
    assert.equal(r.reason, "draw-window");
    assert.equal(r.upcomingRound, null);
    assert.equal(getUpcoming(), null, "금지 구간에 5회차 번호가 박혔다(추첨 후에 고른 번호가 될 수 있다)");
    const st = getLottoState();
    assert.match(st.lastError ?? "", /추첨~결과 공개 구간/);
    assert.ok(st.retryAt, "자정 이후 재시도가 예약돼야 한다");

    // 같은 밤의 30분 틱은 번호가 비어 있어도 보충하지 않는다(진입 자체가 막힌다).
    assert.equal(shouldCatchUpCycle(new Date(2026, 7, 1, 21, 30)), false);
    assert.equal(shouldCatchUpCycle(new Date(2026, 7, 1, 23, 59)), false);
    // 자정이 지나면 '번호 없음' 조건으로 곧바로 보충한다.
    assert.equal(shouldCatchUpCycle(new Date(2026, 7, 2, 0, 0)), true);
  } finally {
    restore();
  }

  const restore2 = __setCycleDepsForTest({ syncDraws: noNetworkSync, now: () => new Date(2026, 7, 2, 0, 30) });
  try {
    const r = await runWeeklyCycle("catchup");
    assert.equal(r.upcomingRound, 5, "자정 이후에는 정상적으로 다음 회차 번호를 확정한다");
    assert.equal(getUpcoming()?.round, 5);
  } finally {
    restore2();
  }
});

test("이미 못박힌 번호가 있으면 금지 구간이어도 그대로 둔다(미룸 없음 — 덮어쓰지 않으므로 안전)", async () => {
  const pinned = getUpcoming();
  assert.ok(pinned);
  const restore = __setCycleDepsForTest({
    syncDraws: noNetworkSync,
    now: () => new Date(2026, 7, 8, 21, 0), // 토요일 21:00
  });
  try {
    const r = await runWeeklyCycle("test-pinned");
    assert.equal(r.reason, "ok");
    assert.equal(r.upcomingRound, 5);
    assert.deepEqual(getUpcoming()?.sets, pinned.sets);
  } finally {
    restore();
  }
});
