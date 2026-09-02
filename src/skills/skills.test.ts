import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillRankEntry, SkillRepo, SkillsSnapshot } from "../../shared/skills.ts";
import type { PruneResult } from "./verify.ts";

/**
 * **스냅샷 보호** 회귀 테스트.
 *
 * 뉴스 탭에서 실제로 겪은 사고(2026-08-02)의 스킬 버전이다: 큐레이션이 실패해 만든 빈
 * 스냅샷이 어제자 성공본을 덮었고, 그 빈 스냅샷이 오늘 날짜를 달고 있어 catch-up 게이트가
 * 통과되며 그날 재시도가 영구 봉인됐다. 주간 작업인 스킬 랭킹에서는 그 대가가 **일주일**이다.
 *
 * 지켜야 할 것 셋:
 *   1. 실패한 회차는 직전 성공본을 덮지 않는다(지난주 랭킹이 빈 화면보다 낫다).
 *   2. 보호가 걸린 회차는 **알림을 보내지 않는다**(지난주 랭킹이 이번 주 메일로 또 오면 안 된다).
 *   3. 보호가 걸려도 **시도 기록은 실패로 남는다** — 그래야 스케줄러 백오프가 걸려
 *      30분마다 같은 실패를 반복하지 않는다.
 *
 * ⚠️ skills.ts 는 config.dbPath 에서 스냅샷 경로를 파생하므로, 사용자의 진짜 data/ 를 읽거나
 *    덮지 않도록 **import 전에** DB_PATH 를 임시 디렉터리로 돌린다 → 동적 import.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-snap-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");

const {
  buildNotes,
  decideSkillsSnapshot,
  deriveSkillsAttempt,
  isSkillsSuccess,
  lastSkillsCycleBoundary,
  nextSkillsCycleAt,
} = await import("./skills.ts");

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function repo(id: number, stars: number): SkillRepo {
  return {
    id,
    fullName: `owner/repo-${id}`,
    owner: "owner",
    name: `repo-${id}`,
    url: `https://github.com/owner/repo-${id}`,
    description: "설명",
    summary: null,
    stars,
    forks: 1,
    watchers: stars,
    openIssues: 0,
    language: "TypeScript",
    license: "MIT",
    topics: ["agent-skills"],
    createdAt: "2026-01-01T00:00:00Z",
    pushedAt: "2026-08-01T00:00:00Z",
    archived: false,
  };
}

function entry(rank: number, id: number, stars: number): SkillRankEntry {
  return { rank, repo: repo(id, stars), prevRank: null, starsGained: null };
}

/** 성공한 지난주 스냅샷 */
function prevOk(over: Partial<SkillsSnapshot> = {}): SkillsSnapshot {
  return {
    date: "2026-09-07",
    updatedAt: "2026-09-07T09:04:12.000Z",
    source: "github",
    trackedCount: 400,
    byStars: [entry(1, 1, 172948)],
    byGrowth: [],
    window: null,
    notes: "첫 회차라 증가 랭킹은 다음 회차부터 채워집니다.",
    ...over,
  };
}

/** GitHub 수집이 통째로 실패한 이번 주 결과 */
function freshError(over: Partial<SkillsSnapshot> = {}): SkillsSnapshot {
  return {
    date: "2026-09-14",
    updatedAt: "2026-09-14T09:00:31.000Z",
    source: "error",
    trackedCount: 0,
    byStars: [],
    byGrowth: [],
    window: null,
    notes: "GitHub 수집 실패: GitHub 검색 결과 0건 (0/8 페이지 성공)",
    ...over,
  };
}

/** 정상 수집된 이번 주 결과 */
function freshOk(over: Partial<SkillsSnapshot> = {}): SkillsSnapshot {
  return {
    date: "2026-09-14",
    updatedAt: "2026-09-14T09:06:02.000Z",
    source: "github",
    trackedCount: 400,
    byStars: [entry(1, 1, 173500)],
    byGrowth: [entry(1, 2, 900)],
    window: { fromDate: "2026-09-07", toDate: "2026-09-14", days: 7 },
    ...over,
  };
}

// ── 성공 판정 ──

test("source 만이 아니라 건수까지 봐야 성공이다", () => {
  assert.equal(isSkillsSuccess(freshOk()), true);
  assert.equal(isSkillsSuccess(freshError()), false);
  assert.equal(
    isSkillsSuccess(freshOk({ byStars: [] })),
    false,
    "topic 4종 800건을 훑고 0건이면 그건 정의상 실패다"
  );
  assert.equal(isSkillsSuccess(null), false);
});

// ── 보호 판정 ──

test("실패한 회차는 직전 성공 스냅샷을 덮지 않는다", () => {
  const d = decideSkillsSnapshot(prevOk(), freshError(), "2026-09-14T09:00:00.000Z", "schedule");
  assert.equal(d.action, "keep");
  assert.equal(d.snapshot.date, "2026-09-07", "지난주 날짜가 그대로 남는다");
  assert.deepEqual(d.snapshot.byStars, prevOk().byStars, "랭킹 데이터가 덮이지 않는다");
  assert.equal(d.snapshot.updatedAt, prevOk().updatedAt, "catch-up 이 이 값으로 '언제 자료인지'를 본다");
  assert.match(d.snapshot.notes ?? "", /2026-09-14 수집 실패/);
  assert.match(d.snapshot.notes ?? "", /2026-09-07 스냅샷을 유지/);
});

test("보호가 걸린 회차는 알림을 보내지 않는다", () => {
  const d = decideSkillsSnapshot(prevOk(), freshError(), "2026-09-14T09:00:00.000Z");
  assert.equal(d.notify, false, "지난주 랭킹이 이번 주 메일로 또 오면 안 된다");
});

test("보호가 걸려도 시도 기록은 실패로 남는다(백오프의 근거)", () => {
  const d = decideSkillsSnapshot(prevOk(), freshError(), "2026-09-14T09:00:00.000Z", "catchup");
  assert.equal(d.attempt.ok, false);
  assert.equal(d.attempt.source, "error");
  assert.equal(d.attempt.trigger, "catchup");
  assert.equal(d.attempt.at, "2026-09-14T09:00:00.000Z");
  assert.match(d.attempt.error ?? "", /GitHub 수집 실패/);
  // 스냅샷에서 유도하면 '성공'으로 읽힌다 — 그래서 시도 기록을 따로 두는 것이다.
  assert.equal(deriveSkillsAttempt(d.snapshot)?.ok, true, "이 오판을 시도 기록이 막는다");
});

test("notes 는 매번 통째로 다시 쓴다(실패가 반복돼도 길이가 늘지 않는다)", () => {
  const once = decideSkillsSnapshot(prevOk(), freshError(), "2026-09-14T09:00:00.000Z");
  const twice = decideSkillsSnapshot(once.snapshot, freshError(), "2026-09-14T09:30:00.000Z");
  assert.equal(twice.snapshot.notes?.length, once.snapshot.notes?.length);
  assert.match(twice.snapshot.notes ?? "", /09:30/);
});

test("직전이 없으면(첫 실행) 실패 결과를 그대로 저장한다 — 빈 화면이 정상이다", () => {
  const d = decideSkillsSnapshot(null, freshError(), "2026-09-14T09:00:00.000Z");
  assert.equal(d.action, "save");
  assert.equal(d.snapshot.source, "error");
  assert.equal(d.notify, false);
});

test("직전도 실패성이면 새 결과가 이긴다(낡은 실패를 붙들지 않는다)", () => {
  const d = decideSkillsSnapshot(freshError({ date: "2026-09-07" }), freshError(), "2026-09-14T09:00:00.000Z");
  assert.equal(d.action, "save");
  assert.equal(d.snapshot.date, "2026-09-14");
});

test("성공한 회차는 저장하고 알림 대상이 된다", () => {
  const d = decideSkillsSnapshot(prevOk(), freshOk(), "2026-09-14T09:00:00.000Z", "schedule");
  assert.equal(d.action, "save");
  assert.equal(d.notify, true);
  assert.equal(d.attempt.ok, true);
  assert.equal(d.attempt.error, null);
  assert.equal(d.attempt.tracked, 400);
  assert.equal(d.snapshot.date, "2026-09-14");
});

// ── notes 는 '이상 상황 전용' ──
//
// notes 가 차 있으면 SkillsBoard 가 앰버 경고 배너를 띄운다. 그래서 정상 회차에 한 글자라도
// 넣으면 배너가 상시 점등되고, App.tsx 가동 중단 배너 주석이 경고한 대로 사용자가 배너를
// 배경으로 학습해 정작 진짜 사고 때 읽지 않는다. 그 회귀를 여기서 막는다.

/** 링크 검증이 아무것도 걸러내지 않은 정상 결과 */
function pruneClean(over: Partial<PruneResult> = {}): PruneResult {
  return { repos: [], removed: [], checked: 40, unknown: 0, redirected: 0, rounds: 1, ...over };
}

test("정상 회차의 notes 는 undefined 다(경고 배너가 상시 점등되면 안 된다)", () => {
  assert.equal(buildNotes([], pruneClean()), undefined);
  assert.equal(buildNotes([], null), undefined, "링크 검증이 통째로 꺼져도 마찬가지다");
});

test("링크 사망 제외는 notes 에 남는다(조용히 사라지면 원인을 못 찾는다)", () => {
  const notes = buildNotes([], pruneClean({ removed: [repo(9, 10), repo(10, 20)] }));
  assert.match(notes ?? "", /링크 사망 확인 2건 제외/);
  assert.match(notes ?? "", /owner\/repo-9/);
});

test("판정 불가와 수집 경고도 notes 에 남는다", () => {
  assert.match(buildNotes([], pruneClean({ unknown: 3 })) ?? "", /링크 판정 불가 3건/);
  assert.match(buildNotes(["topic:agent-skills 3페이지 실패"], null) ?? "", /후보가 줄었을 수 있습니다/);
});

test("★ 쿼터 부족으로 못 본 건수는 notes 에 남고, '로컬'이 아니라 '판정 불가'라고 적는다", () => {
  const notes = buildNotes([], pruneClean(), 12) ?? "";
  assert.match(notes, /12건은 네트워크 접근을 판정하지 못했습니다/);
  assert.match(notes, /판정 불가/, "안 본 것을 로컬로 읽히게 두면 태그가 거짓말이 된다");
  assert.match(notes, /GITHUB_TOKEN/, "고치는 방법까지 적어야 다음 주에 또 안 겪는다");
  // 0 건이면 아무 말도 하지 않는다(상시 배너 금지 규약).
  assert.equal(buildNotes([], pruneClean(), 0), undefined);
});

test("추적 저장소 수·첫 회차 안내는 notes 에 넣지 않는다(화면에 이미 있다)", () => {
  // 둘 다 상시 정보다 — trackedCount 는 각주로, 첫 회차는 window === null 빈 상태로 이미 나온다.
  const notes = buildNotes([], pruneClean({ unknown: 1 })) ?? "";
  assert.doesNotMatch(notes, /추적합니다/);
  assert.doesNotMatch(notes, /첫 회차/);
});

// ── 주간 경계 ──

test("직전 경계는 월요일 09:00 이고, 아직 그 시각 전이면 한 주 전이다", () => {
  // 2026-09-14 는 월요일이다.
  const monday0800 = new Date(2026, 8, 14, 8, 0, 0);
  assert.equal(
    lastSkillsCycleBoundary(monday0800).getTime(),
    new Date(2026, 8, 7, 9, 0, 0).getTime(),
    "월요일 08:00 에는 아직 이번 주 회차가 오지 않았다"
  );

  const monday0930 = new Date(2026, 8, 14, 9, 30, 0);
  assert.equal(
    lastSkillsCycleBoundary(monday0930).getTime(),
    new Date(2026, 8, 14, 9, 0, 0).getTime()
  );

  const thursday = new Date(2026, 8, 17, 23, 0, 0);
  assert.equal(
    lastSkillsCycleBoundary(thursday).getTime(),
    new Date(2026, 8, 14, 9, 0, 0).getTime()
  );

  const sunday = new Date(2026, 8, 20, 12, 0, 0);
  assert.equal(lastSkillsCycleBoundary(sunday).getTime(), new Date(2026, 8, 14, 9, 0, 0).getTime());
});

test("다음 실행 예정은 직전 경계 + 7일이다", () => {
  const thursday = new Date(2026, 8, 17, 23, 0, 0);
  assert.equal(nextSkillsCycleAt(thursday).getTime(), new Date(2026, 8, 21, 9, 0, 0).getTime());
});
