import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillRepo } from "../../shared/skills.ts";

/**
 * 주간 차분·랭킹 회귀 테스트.
 *
 * 이 기능의 전부가 여기 걸려 있다 — GitHub 이 과거 star 수를 주지 않으므로(근거는
 * shared/skills.ts 머리말) "이번 주에 얼마나 늘었나"는 **우리 DB 스냅샷의 차분**으로만 나온다.
 * 그래서 아래 세 불변식이 깨지면 증가 랭킹은 조용히 거짓말을 시작한다:
 *
 *   1. 첫 회차에는 window 가 null 이고 증가 랭킹이 비어 있다(0 으로 채우지 않는다).
 *   2. 저장소 **이름이 바뀌어도** 증가분이 끊기지 않는다(조인 키가 id 이기 때문).
 *   3. window.days 는 두 스냅샷의 **실제 간격**이다(7 하드코딩 금지 — 월요일을 놓치면 14일이다).
 *
 * ⚠️ 실제 SQLite 를 쓴다(임시 파일). config 가 모듈 초기화 시점에 DB_PATH 를 읽으므로
 *    **import 보다 먼저** 환경변수를 세워야 한다 → 동적 import (lotto/cycle.store.test.ts 와 동일).
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-store-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");

const {
  buildRankings,
  daysBetween,
  loadStarsAt,
  previousSnapshotDate,
  rankMapByGrowth,
  rankMapByStars,
  saveWeeklySnapshot,
  summarySourceHash,
  loadSummaries,
  saveSummary,
} = await import("./store.ts");
const { closeDb } = await import("../db/index.ts");

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function repo(over: Partial<SkillRepo> & { id: number; stars: number }): SkillRepo {
  return {
    fullName: `owner/repo-${over.id}`,
    owner: "owner",
    name: `repo-${over.id}`,
    url: `https://github.com/owner/repo-${over.id}`,
    description: `설명 ${over.id}`,
    summary: null,
    forks: 1,
    watchers: over.stars,
    openIssues: 0,
    language: "TypeScript",
    license: "MIT",
    topics: ["agent-skills"],
    createdAt: "2026-01-01T00:00:00Z",
    pushedAt: "2026-08-01T00:00:00Z",
    archived: false,
    ...over,
  };
}

// ── 저장 ──

test("주간 스냅샷 저장은 멱등이다 — 같은 날 두 번 돌려도 값만 덮인다", () => {
  saveWeeklySnapshot("2026-09-07", [repo({ id: 101, stars: 100 })]);
  saveWeeklySnapshot("2026-09-07", [repo({ id: 101, stars: 150 })]);
  const stars = loadStarsAt("2026-09-07");
  assert.equal(stars.size, 1, "행이 늘지 않아야 한다");
  assert.equal(stars.get(101), 150, "마지막 값으로 덮인다");
});

test("직전 스냅샷 날짜는 '7일 전'이 아니라 '있는 것 중 가장 최근'이다", () => {
  // 맥이 자서 월요일을 통째로 놓치면 직전 스냅샷은 14일 전이다. 7일 전을 조회하면 그 주의
  // 증가 랭킹이 통째로 사라진다.
  saveWeeklySnapshot("2026-09-21", [repo({ id: 101, stars: 300 })]);
  assert.equal(previousSnapshotDate("2026-09-21"), "2026-09-07");
  assert.equal(previousSnapshotDate("2026-09-07"), null, "첫 회차에는 직전이 없다");
});

test("존재하지 않는 날짜의 star 맵은 빈 맵이다(null 도 안전하다)", () => {
  assert.equal(loadStarsAt("1999-01-01").size, 0);
  assert.equal(loadStarsAt(null).size, 0);
});

// ── 간격 계산 ──

test("두 날짜의 실제 간격을 센다 — 7 을 가정하지 않는다", () => {
  assert.equal(daysBetween("2026-09-07", "2026-09-14"), 7);
  assert.equal(daysBetween("2026-09-07", "2026-09-21"), 14, "월요일을 놓친 주");
  assert.equal(daysBetween("2026-09-07", "2026-09-13"), 6, "배포일이 월요일이 아닌 첫 구간");
  // 서머타임 전환이 낀 구간도 UTC 자정 기준이라 정수로 떨어진다.
  assert.equal(daysBetween("2026-03-02", "2026-03-09"), 7);
});

// ── 랭킹 ──

test("첫 회차: 증가 랭킹은 빈 배열이고 window 는 null 이다", () => {
  const r = buildRankings({
    date: "2026-09-07",
    repos: [repo({ id: 1, stars: 300 }), repo({ id: 2, stars: 100 })],
    prevDate: null,
    prevStars: new Map(),
  });
  assert.equal(r.window, null, "비교 대상이 없는데 구간을 지어내면 안 된다");
  assert.deepEqual(r.byGrowth, [], "증가분 0 으로 채우면 '아무것도 안 늘었다'는 거짓말이 된다");
  assert.equal(r.byStars.length, 2);
  assert.equal(r.byStars[0].rank, 1);
  assert.equal(r.byStars[0].starsGained, null, "비교 기준이 없으면 증가분도 null 이다");
  assert.equal(r.byStars[0].prevRank, null, "= 화면의 NEW 배지");
});

test("2회차: 증가분·순위·구간이 실제 스냅샷 차분에서 나온다", () => {
  const r = buildRankings({
    date: "2026-09-14",
    repos: [
      repo({ id: 1, stars: 1000 }), // +100
      repo({ id: 2, stars: 900 }), // +400  ← 증가 1위
      repo({ id: 3, stars: 50 }), // 직전 스냅샷에 없음 → NEW
    ],
    prevDate: "2026-09-07",
    prevStars: new Map([
      [1, 900],
      [2, 500],
    ]),
  });

  assert.deepEqual(r.window, { fromDate: "2026-09-07", toDate: "2026-09-14", days: 7 });
  assert.deepEqual(
    r.byStars.map((e) => [e.rank, e.repo.id, e.starsGained]),
    [
      [1, 1, 100],
      [2, 2, 400],
      [3, 3, null],
    ],
    "총합 랭킹에도 증가분을 참고값으로 함께 싣는다"
  );
  assert.deepEqual(
    r.byGrowth.map((e) => [e.rank, e.repo.id, e.starsGained]),
    [
      [1, 2, 400],
      [2, 1, 100],
    ],
    "직전 스냅샷에 없던 저장소(id=3)는 증가 랭킹에 오르지 않는다 — 비교 기준이 없다"
  );
});

test("이름이 바뀐 저장소도 id 로 이어져 증가분이 끊기지 않는다", () => {
  // 실제 DB 를 거쳐 확인한다. full_name 으로 조인했다면 여기서 starsGained 가 null 이 되고
  // 리네임된 저장소가 매주 '신규 진입'으로 둔갑한다.
  saveWeeklySnapshot("2026-10-05", [
    repo({ id: 777, stars: 1000, fullName: "old-owner/old-name", owner: "old-owner", name: "old-name" }),
  ]);
  const renamed = repo({
    id: 777,
    stars: 1400,
    fullName: "new-owner/new-name",
    owner: "new-owner",
    name: "new-name",
  });
  saveWeeklySnapshot("2026-10-12", [renamed]);

  const prevDate = previousSnapshotDate("2026-10-12");
  assert.equal(prevDate, "2026-10-05");
  const r = buildRankings({
    date: "2026-10-12",
    repos: [renamed],
    prevDate,
    prevStars: loadStarsAt(prevDate),
  });
  assert.equal(r.byGrowth.length, 1);
  assert.equal(r.byGrowth[0].repo.id, 777);
  assert.equal(r.byGrowth[0].repo.fullName, "new-owner/new-name", "이름은 최신값으로 갱신된다");
  assert.equal(r.byGrowth[0].starsGained, 400, "이름이 바뀌어도 증가분은 이어진다");
});

test("맥이 월요일을 놓쳐 14일이 지나도 그 간격을 그대로 화면에 올린다", () => {
  const r = buildRankings({
    date: "2026-09-21",
    repos: [repo({ id: 1, stars: 1200 })],
    prevDate: "2026-09-07",
    prevStars: new Map([[1, 900]]),
  });
  assert.equal(r.window?.days, 14, '"7일간 +300" 이라고 적으면 그게 거짓말이다');
  assert.equal(r.byGrowth[0].starsGained, 300);
});

test("prevRank 는 직전 스냅샷으로 같은 랭킹을 재계산해 얻는다(3회차)", () => {
  // 직전 회차(prev) 의 증가 순위: id1 +100, id2 +400 → 1위 id2, 2위 id1
  // 이번 회차(cur)   의 증가 순위: id1 +500, id2 +50  → 1위 id1, 2위 id2  (자리가 뒤집힌다)
  const r = buildRankings({
    date: "2026-09-21",
    repos: [repo({ id: 1, stars: 1500 }), repo({ id: 2, stars: 950 })],
    prevDate: "2026-09-14",
    prevStars: new Map([
      [1, 1000],
      [2, 900],
    ]),
    prevPrevStars: new Map([
      [1, 900],
      [2, 500],
    ]),
  });
  assert.deepEqual(
    r.byGrowth.map((e) => [e.rank, e.repo.id, e.prevRank]),
    [
      [1, 1, 2], // 지난주 2위 → 이번 주 1위 (▲1)
      [2, 2, 1], // 지난주 1위 → 이번 주 2위 (▼1)
    ]
  );
  assert.deepEqual(
    r.byStars.map((e) => [e.repo.id, e.prevRank]),
    [
      [1, 1],
      [2, 2],
    ],
    "총합 랭킹의 prevRank 는 직전 스냅샷 star 로 매긴 순위다"
  );
});

test("prevPrev 가 없으면 증가 랭킹의 prevRank 는 전부 null(=NEW)", () => {
  const r = buildRankings({
    date: "2026-09-14",
    repos: [repo({ id: 1, stars: 1000 })],
    prevDate: "2026-09-07",
    prevStars: new Map([[1, 900]]),
    prevPrevStars: null,
  });
  assert.equal(r.byGrowth[0].prevRank, null);
});

test("랭킹 맵은 star/증가 내림차순으로 1부터 매긴다", () => {
  assert.deepEqual(
    [...rankMapByStars(new Map([[10, 5], [20, 50], [30, 500]]))],
    [
      [30, 1],
      [20, 2],
      [10, 3],
    ]
  );
  assert.deepEqual(
    [...rankMapByGrowth(new Map([[1, 110], [2, 300], [3, 7]]), new Map([[1, 100], [2, 100]]))],
    [
      [2, 1], // +200
      [1, 2], // +10
    ],
    "직전에 없던 id=3 은 순위 자체가 없다"
  );
});

// ── 요약 캐시 ──

test("요약 해시는 이름+원문에만 반응한다(star 가 변해도 재요약하지 않는다)", () => {
  const base = repo({ id: 9, stars: 100 });
  assert.equal(summarySourceHash(base), summarySourceHash(repo({ id: 9, stars: 999999 })));
  assert.notEqual(
    summarySourceHash(base),
    summarySourceHash(repo({ id: 9, stars: 100, description: "바뀐 설명" }))
  );
  assert.notEqual(
    summarySourceHash(base),
    summarySourceHash(repo({ id: 9, stars: 100, fullName: "other/name" })),
    "리네임은 대개 성격 변경을 동반한다 — 요약도 낡는다"
  );
});

test("요약 캐시는 저장·조회되고 id 가 비면 쿼리하지 않는다", () => {
  saveSummary(42, "파일을 정리해 주는 스킬이다.", "hash-a");
  saveSummary(42, "갱신된 요약이다.", "hash-b");
  const map = loadSummaries([42, 43]);
  assert.equal(map.size, 1);
  assert.equal(map.get(42)?.summary, "갱신된 요약이다.");
  assert.equal(map.get(42)?.sourceHash, "hash-b");
  assert.equal(loadSummaries([]).size, 0);
});
