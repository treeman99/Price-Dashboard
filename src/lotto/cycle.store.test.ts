import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
 */
const DB_FILE = path.join(os.tmpdir(), `lotto-cycle-test-${process.pid}.db`);
process.env.DB_PATH = DB_FILE;

const { saveDraws } = await import("./draws.ts");
const {
  clearUpcoming,
  ensureSeedStrategy,
  getUpcoming,
  insertStrategy,
  lastScored,
  recentResultsWithDraw,
  saveUpcoming,
  summarize,
} = await import("./store.ts");
const { scorePendingPicks, writeUpcomingPicks } = await import("./cycle.ts");
const { closeDb } = await import("../db/index.ts");

after(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${DB_FILE}${suffix}`);
    } catch {
      /* 없으면 지울 것도 없다 */
    }
  }
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
