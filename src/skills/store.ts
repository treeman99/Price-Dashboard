import { createHash } from "node:crypto";
import { db } from "../db/index.ts";
import { log } from "../util/log.ts";
import { SKILLS_RANK_SIZE } from "../../shared/skills.ts";
import type { SkillRankEntry, SkillRepo, SkillWindow } from "../../shared/skills.ts";

/**
 * 스킬 랭킹의 저장소 + 주간 차분.
 *
 * SQL 을 `src/db/repo.ts` 에 넣지 않고 여기 모은 이유는 `src/lotto/store.ts` 와 같다:
 * 이 세 표는 스킬 탭 전용이고 다른 탭이 절대 읽지 않는다. repo.ts 는 이미 800줄에 가까워
 * 여기 SQL 을 얹으면 '증시 저장소'를 읽으려는 다음 사람이 상관없는 코드를 먼저 지나야 한다.
 *
 * ── 이 파일의 핵심 계약 ──────────────────────────────────────────────────────
 * 조인 키는 **repo_id**(GitHub 저장소 고유 id)다. full_name 으로 조인하면 리네임된 저장소가
 * 매주 '신규 진입'으로 둔갑해 증가분이 거짓말을 한다. GitHub 이 과거 star 를 주지 않으므로
 * (근거: shared/skills.ts 머리말) 이 표의 차분이 증가 랭킹의 **유일한** 근거다.
 */

// ── 저장 ────────────────────────────────────────────────

/** 주간 스냅샷 1행(DB 관측값). SkillRepo 와 달리 '그 주에 실제로 찍힌 값'만 담는다. */
export interface SkillPoint {
  repoId: number;
  date: string;
  stars: number;
  forks: number | null;
  watchers: number | null;
  openIssues: number | null;
  pushedAt: string | null;
  archived: boolean;
}

/**
 * 이번 주 스냅샷 저장. **멱등**이다 — 같은 date 로 두 번 돌려도 값만 덮이고 행이 늘지 않는다
 * (skill_repo_points PK 가 (repo_id, date)).
 *
 * skill_repos 는 신원(이름·설명·라이선스)만 담고 매번 최신값으로 덮는다. 단 `first_seen` 은
 * 유지한다 — "언제부터 우리가 보고 있었나"는 덮어쓰면 영영 복구되지 않는 정보다.
 *
 * @returns 실제로 저장한 저장소 수
 */
export function saveWeeklySnapshot(date: string, repos: SkillRepo[]): number {
  if (repos.length === 0) return 0;
  const conn = db();
  const now = new Date().toISOString();

  const upsertRepo = conn.prepare(`
    INSERT INTO skill_repos (id, full_name, owner, name, url, description, language, license, topics, created_at, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      full_name = excluded.full_name,
      owner = excluded.owner,
      name = excluded.name,
      url = excluded.url,
      description = excluded.description,
      language = excluded.language,
      license = excluded.license,
      topics = excluded.topics,
      created_at = excluded.created_at
  `);
  const upsertPoint = conn.prepare(`
    INSERT INTO skill_repo_points (repo_id, date, stars, forks, watchers, open_issues, pushed_at, archived)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_id, date) DO UPDATE SET
      stars = excluded.stars,
      forks = excluded.forks,
      watchers = excluded.watchers,
      open_issues = excluded.open_issues,
      pushed_at = excluded.pushed_at,
      archived = excluded.archived
  `);

  conn.exec("BEGIN");
  try {
    for (const r of repos) {
      upsertRepo.run(
        r.id,
        r.fullName,
        r.owner,
        r.name,
        r.url,
        r.description,
        r.language,
        r.license,
        JSON.stringify(r.topics ?? []),
        r.createdAt || null,
        now
      );
      upsertPoint.run(
        r.id,
        date,
        r.stars,
        r.forks,
        r.watchers,
        r.openIssues,
        r.pushedAt || null,
        r.archived ? 1 : 0
      );
    }
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
  log.info(`스킬 주간 스냅샷 저장 — ${date} ${repos.length}건`);
  return repos.length;
}

/**
 * `before` **직전**의 가장 최근 스냅샷 날짜. 없으면 null(= 첫 회차).
 *
 * "7일 전"을 계산해 찾지 않는다. 맥이 자서 월요일을 통째로 놓치면 직전 스냅샷은 14일 전이고,
 * 그때 7일 전을 조회하면 아무것도 못 찾아 증가 랭킹이 통째로 사라진다. 실제 간격이 몇 일이든
 * '있는 것 중 가장 최근'을 쓰고, 그 간격은 SkillWindow.days 로 화면까지 그대로 올린다.
 */
export function previousSnapshotDate(before: string): string | null {
  const row = db()
    .prepare("SELECT MAX(date) AS d FROM skill_repo_points WHERE date < ?")
    .get(before) as { d: string | null } | undefined;
  return row?.d ?? null;
}

/** 특정 날짜 스냅샷의 star 맵(repo_id → stars). 없는 날짜면 빈 맵. */
export function loadStarsAt(date: string | null): Map<number, number> {
  const map = new Map<number, number>();
  if (!date) return map;
  const rows = db()
    .prepare("SELECT repo_id, stars FROM skill_repo_points WHERE date = ?")
    .all(date) as Array<{ repo_id: number; stars: number }>;
  for (const r of rows) map.set(Number(r.repo_id), Number(r.stars));
  return map;
}

/** 저장된 스냅샷 날짜 목록(최신순). 화면 각주·디버깅용. */
export function listSnapshotDates(limit = 12): string[] {
  const rows = db()
    .prepare("SELECT DISTINCT date FROM skill_repo_points ORDER BY date DESC LIMIT ?")
    .all(limit) as Array<{ date: string }>;
  return rows.map((r) => r.date);
}

// ── 요약 캐시 ────────────────────────────────────────────

export interface SummaryRecord {
  summary: string;
  sourceHash: string | null;
  updatedAt: string;
}

/**
 * 요약의 입력 해시.
 *
 * 원문 description 만이 아니라 **full_name 도 넣는다.** 요약문은 "이 저장소가 어떤 스킬인가"를
 * 말하므로 이름이 바뀌면 문장도 낡는다(리네임은 대개 성격 변경을 동반한다). 반대로 topics 나
 * star 는 넣지 않는다 — 매주 흔들리는 값을 해시에 넣으면 캐시가 사실상 꺼진다.
 */
export function summarySourceHash(repo: Pick<SkillRepo, "fullName" | "description">): string {
  return createHash("sha256")
    .update(`${repo.fullName}\n${repo.description ?? ""}`)
    .digest("hex");
}

/** 요약 캐시 조회. ids 가 비면 빈 맵(쿼리도 하지 않는다). */
export function loadSummaries(ids: number[]): Map<number, SummaryRecord> {
  const map = new Map<number, SummaryRecord>();
  if (ids.length === 0) return map;
  // node:sqlite 는 배열 바인딩이 없다 → 자리표시자를 개수만큼 만든다(값은 전부 숫자라 안전).
  const holes = ids.map(() => "?").join(",");
  const rows = db()
    .prepare(`SELECT repo_id, summary, source_hash, updated_at FROM skill_summaries WHERE repo_id IN (${holes})`)
    .all(...ids) as Array<{
    repo_id: number;
    summary: string;
    source_hash: string | null;
    updated_at: string;
  }>;
  for (const r of rows) {
    map.set(Number(r.repo_id), {
      summary: r.summary,
      sourceHash: r.source_hash,
      updatedAt: r.updated_at,
    });
  }
  return map;
}

/** 요약 1건 저장(덮어쓰기). */
export function saveSummary(repoId: number, summary: string, sourceHash: string): void {
  db()
    .prepare(`
      INSERT INTO skill_summaries (repo_id, summary, source_hash, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(repo_id) DO UPDATE SET
        summary = excluded.summary,
        source_hash = excluded.source_hash,
        updated_at = excluded.updated_at
    `)
    .run(repoId, summary, sourceHash, new Date().toISOString());
}

// ── 차분·랭킹 ────────────────────────────────────────────

/** YYYY-MM-DD 두 날짜의 간격(일). UTC 자정 기준이라 서머타임·타임존에 흔들리지 않는다. */
export function daysBetween(fromDate: string, toDate: string): number {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * star 총합 순위 맵(repo_id → 1부터의 순위).
 *
 * prevRank 를 얻으려면 **직전 스냅샷 데이터로 같은 랭킹을 다시 계산**해야 한다. 순위를 따로
 * 저장해 두지 않는 이유: 랭킹 규칙(정렬 키·동점 처리)이 바뀌면 저장된 옛 순위와 새 순위가
 * 서로 다른 규칙으로 비교돼 변동 화살표가 통째로 거짓말이 된다. 규칙은 한 곳에만 둔다.
 */
export function rankMapByStars(stars: Map<number, number>): Map<number, number> {
  const sorted = [...stars.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const map = new Map<number, number>();
  sorted.forEach(([id], i) => map.set(id, i + 1));
  return map;
}

/** 증가 순위 맵. 두 스냅샷 **모두**에 있는 저장소만 순위를 갖는다(비교 기준이 없으면 순위도 없다). */
export function rankMapByGrowth(
  current: Map<number, number>,
  previous: Map<number, number>
): Map<number, number> {
  const gains: Array<[number, number]> = [];
  for (const [id, stars] of current) {
    const prev = previous.get(id);
    if (prev === undefined) continue;
    gains.push([id, stars - prev]);
  }
  gains.sort((a, b) => b[1] - a[1] || (current.get(b[0]) ?? 0) - (current.get(a[0]) ?? 0) || a[0] - b[0]);
  const map = new Map<number, number>();
  gains.forEach(([id], i) => map.set(id, i + 1));
  return map;
}

/** 랭킹 계산 입력. 전부 이미 로드된 값이라 이 함수는 순수하다(테스트에서 DB 없이 돈다). */
export interface RankingInput {
  /** 이번 스냅샷 날짜 */
  date: string;
  /** 이번에 수집한 추적 풀(star 내림차순일 필요는 없다 — 여기서 정렬한다) */
  repos: SkillRepo[];
  /** 직전 스냅샷 날짜. 없으면 첫 회차 */
  prevDate: string | null;
  /** 직전 스냅샷의 star 맵 */
  prevStars: Map<number, number>;
  /**
   * 직전의 **직전** 스냅샷 star 맵. 증가 랭킹의 prevRank 를 계산하는 데만 쓴다
   * (직전 회차의 증가 순위 = prev 와 prevPrev 의 차분). 없으면 증가 랭킹은 전부 NEW 다.
   */
  prevPrevStars?: Map<number, number> | null;
}

export interface RankingResult {
  byStars: SkillRankEntry[];
  byGrowth: SkillRankEntry[];
  window: SkillWindow | null;
}

/**
 * 두 랭킹을 만든다.
 *
 * ⚠️ **첫 회차(prevDate === null)에는 byGrowth 가 빈 배열이고 window 는 null 이다.** 비교 대상이
 *    없는데 증가분을 0 으로 채우면 "이번 주에 하나도 안 늘었다"는 거짓말이 된다(계약 주석 참고).
 *
 * ⚠️ window.days 는 두 날짜의 **실제 간격**이다. 7 로 하드코딩하면 맥이 자서 월요일을 놓친 주에
 *    "최근 7일간 +2,400"이 화면에 뜨는데 실제로는 14일치다.
 */
export function buildRankings(input: RankingInput): RankingResult {
  const { date, repos, prevDate, prevStars } = input;
  const currentStars = new Map<number, number>(repos.map((r) => [r.id, r.stars]));
  const byId = new Map<number, SkillRepo>(repos.map((r) => [r.id, r]));

  const prevStarRank = rankMapByStars(prevStars);
  const prevGrowthRank = input.prevPrevStars
    ? rankMapByGrowth(prevStars, input.prevPrevStars)
    : new Map<number, number>();

  const gained = (id: number): number | null => {
    const before = prevStars.get(id);
    if (before === undefined) return null;
    return (currentStars.get(id) ?? 0) - before;
  };

  // ── star 총합 랭킹 ──
  const sortedByStars = [...repos].sort(
    (a, b) => b.stars - a.stars || a.fullName.localeCompare(b.fullName)
  );
  const byStars: SkillRankEntry[] = sortedByStars.slice(0, SKILLS_RANK_SIZE).map((repo, i) => ({
    rank: i + 1,
    repo,
    prevRank: prevStarRank.get(repo.id) ?? null,
    starsGained: gained(repo.id),
  }));

  // ── 주간 증가 랭킹 ──
  if (!prevDate) return { byStars, byGrowth: [], window: null };

  const growthRank = rankMapByGrowth(currentStars, prevStars);
  const byGrowth: SkillRankEntry[] = [...growthRank.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, SKILLS_RANK_SIZE)
    .map(([id, rank]) => ({
      rank,
      repo: byId.get(id)!,
      prevRank: prevGrowthRank.get(id) ?? null,
      starsGained: gained(id),
    }));

  return {
    byStars,
    byGrowth,
    window: { fromDate: prevDate, toDate: date, days: daysBetween(prevDate, date) },
  };
}
