import { log } from "../util/log.ts";
import { config } from "../config.ts";
import { SKILLS_TOPICS, SKILLS_TRACK_POOL } from "../../shared/skills.ts";
import type { SkillRepo } from "../../shared/skills.ts";

/**
 * GitHub 검색 API 로 "스킬" 저장소 후보 풀을 만든다.
 *
 * ── 검증된 경로 (2026-09-01 실호출로 확인) ────────────────────────────────────
 *   GET https://api.github.com/search/repositories
 *       ?q=topic:<topic>&sort=stars&order=desc&per_page=100&page=N
 *   - 무인증으로 200 OK. 응답 헤더 `x-ratelimit-limit: 10`, `x-ratelimit-resource: search`.
 *   - `q=topic:agent-skills` → total_count 20,115. per_page=100 · page=2 까지 정상.
 *   - item 에서 실제로 확인한 필드: id, full_name, name, owner.login, html_url, description,
 *     stargazers_count, forks_count, watchers_count, open_issues_count, topics[],
 *     license{spdx_id}, language, created_at, pushed_at, archived, fork.
 *   - 실측 주의: 1위 anthropics/skills 는 **license 가 null** 이다. 라이선스·설명은 반드시
 *     nullable 로 다뤄야 한다(계약도 그렇게 돼 있다).
 *
 * ── 왜 여기서 star '증가'를 못 구하는가 ──────────────────────────────────────
 * GitHub 은 과거 star 수를 주지 않는다(근거는 shared/skills.ts 머리말). 이 파일은 **현재값만**
 * 정확히 가져오는 책임을 지고, 증가분은 우리 DB 의 주간 스냅샷 차분(src/skills/store.ts)이
 * 전담한다. 둘을 섞지 않는 것이 "숫자는 전부 실측값" 규칙의 출발점이다.
 */

export const GITHUB_SEARCH_ENDPOINT = "https://api.github.com/search/repositories";

/** 한 번에 받는 최대치. GitHub 검색 API 의 per_page 상한이 100 이다. */
export const GITHUB_PER_PAGE = 100;

/**
 * topic 당 받아올 페이지 수. 2 페이지 = topic 당 상위 200개.
 *
 * 4 topic × 200 = 최대 800 후보 → 중복 제거 후 star 상위 400(SKILLS_TRACK_POOL)을 추적한다.
 * 3 페이지로 늘리면 호출이 12회가 되어 무인증 레이트리밋(10회/분) 안에서 1분을 넘겨야 한다.
 * 그 대가로 얻는 것은 "star 하위권 저장소"뿐이라 풀 400개를 채우는 데 기여하지 않는다.
 */
export const SKILLS_SEARCH_PAGES = 2;

/** 무인증 검색 레이트리밋(2026-09-01 응답 헤더 실측). 토큰을 붙이면 30회/분. */
export const GITHUB_SEARCH_RPM_ANON = 10;
export const GITHUB_SEARCH_RPM_TOKEN = 30;

/** 페이지 1건당 재시도 상한(레이트리밋 대기·네트워크 오류 공통). */
const MAX_ATTEMPTS = 3;

/**
 * 레이트리밋 리셋 대기의 상한.
 *
 * `x-ratelimit-reset` 을 그대로 믿고 무한정 자면, 서버 시계가 어긋났거나 GitHub 이 먼 미래
 * 값을 주는 순간 주간 수집 하나가 몇 시간을 붙잡는다(그 사이 LLM 슬롯도 함께 묶인다).
 * 검색 리밋 창은 1분이라 2분이면 정상 경로를 전부 흡수한다.
 */
const MAX_RESET_WAIT_MS = 120_000;

/** 응답 헤더에서 읽어 로그·대기 판정에 쓰는 값들. */
interface RateInfo {
  limit: number | null;
  remaining: number | null;
  /** epoch seconds */
  reset: number | null;
  /** Retry-After (초). 2차 리밋에서만 온다. */
  retryAfter: number | null;
}

/** 테스트에서 네트워크·시계를 갈아끼우기 위한 주입 지점. 운영은 기본값을 쓴다. */
export interface GithubDeps {
  fetchFn: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** GITHUB_TOKEN. 빈 문자열이면 무인증(정상 경로다). */
  token: string;
}

function defaultDeps(): GithubDeps {
  return {
    fetchFn: (...args) => fetch(...args),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    token: config.githubToken,
  };
}

/**
 * 숫자 변환. **null/undefined/빈 문자열은 0 이 아니라 null 이다.**
 *
 * `Number(null) === 0` 이라 이 가드가 없으면 두 곳이 조용히 망가진다:
 *   1. 응답에 stargazers_count 가 없는 item 이 star 0 짜리 정상 저장소로 통과한다.
 *   2. `x-ratelimit-remaining` 헤더가 없는 응답이 remaining=0(= 리밋 소진)으로 읽혀,
 *      레이트리밋과 무관한 403 을 매번 리셋까지 기다렸다 재시도한다.
 */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function readRate(res: { headers: { get(name: string): string | null } }): RateInfo {
  return {
    limit: num(res.headers.get("x-ratelimit-limit")),
    remaining: num(res.headers.get("x-ratelimit-remaining")),
    reset: num(res.headers.get("x-ratelimit-reset")),
    retryAfter: num(res.headers.get("retry-after")),
  };
}

/**
 * 검색 응답 item 1건 → SkillRepo.
 *
 * 파싱 실패는 예외가 아니라 null 이다 — 800건 중 한 건이 이상하다고 그 주 수집을 통째로
 * 버리는 것은 손해가 훨씬 크다. 필수는 id·full_name·stars 셋뿐이고 나머지는 전부 폴백한다.
 *
 * ⚠️ `summary` 는 여기서 항상 null 이다. 요약은 LLM 이 별도 경로(src/skills/curate.ts)에서
 *    만들고, 이 파서는 **API 실측값만** 다룬다. 숫자와 생성 문장의 경로를 섞지 않는다.
 */
export function parseSearchItem(raw: unknown): SkillRepo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const id = num(r.id);
  const fullName = typeof r.full_name === "string" ? r.full_name.trim() : "";
  const stars = num(r.stargazers_count);
  if (id === null || !fullName || stars === null) return null;

  const owner =
    (r.owner && typeof r.owner === "object"
      ? String((r.owner as Record<string, unknown>).login ?? "")
      : "") || fullName.split("/")[0] || "";
  const name = typeof r.name === "string" && r.name ? r.name : fullName.split("/")[1] || fullName;
  const license =
    r.license && typeof r.license === "object"
      ? (() => {
          const spdx = (r.license as Record<string, unknown>).spdx_id;
          // GitHub 은 라이선스 미상을 spdx_id:"NOASSERTION" 으로 준다 — 표기할 값이 아니다.
          const s = typeof spdx === "string" ? spdx.trim() : "";
          return s && s !== "NOASSERTION" ? s : null;
        })()
      : null;

  return {
    id,
    fullName,
    owner,
    name,
    url: typeof r.html_url === "string" ? r.html_url : `https://github.com/${fullName}`,
    description: typeof r.description === "string" && r.description.trim() ? r.description.trim() : null,
    summary: null,
    stars,
    forks: num(r.forks_count) ?? 0,
    // 실측 주의: GitHub REST 의 watchers_count 는 **star 수와 같은 값**이다(구독자 수가 아니다).
    // 화면에서 star 와 나란히 두면 같은 숫자가 두 번 보이므로, 이 값의 해석은 화면 쪽 판단에
    // 맡기고 여기서는 응답 그대로 싣는다.
    watchers: num(r.watchers_count) ?? 0,
    openIssues: num(r.open_issues_count) ?? 0,
    language: typeof r.language === "string" && r.language ? r.language : null,
    license,
    topics: Array.isArray(r.topics) ? r.topics.filter((t): t is string => typeof t === "string") : [],
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
    pushedAt: typeof r.pushed_at === "string" ? r.pushed_at : "",
    archived: r.archived === true,
  };
}

/** 검색 응답 1페이지 파싱 결과. `forks` 는 fork 저장소(=제외 대상) 건수 — 로그용이다. */
export interface SearchPage {
  repos: SkillRepo[];
  totalCount: number;
  incomplete: boolean;
  /** 이 페이지에서 fork 라서 제외한 건수 */
  forksDropped: number;
  /** 파싱 자체가 안 된 건수 */
  malformed: number;
}

/**
 * 검색 응답 본문 파싱.
 *
 * ── fork / archived 처리 근거 ────────────────────────────────────────────────
 * **fork 는 제외한다.** 스킬 저장소는 "복제해서 쓰는" 성격이라 인기 저장소일수록 fork 가
 * 수백 개 붙는다. 그 복제본은 원본과 내용이 같으므로 목록에 올라오면 같은 스킬이 두 번
 * 보이고, 무엇보다 **증가 랭킹을 오염시킨다** — 어느 유튜버가 소개한 fork 하나가 그 주에
 * 급상승하면 원본을 제치고 1위에 오르는데, 그건 "무엇이 뜨고 있는가"의 답이 아니다.
 *
 * **archived 는 포함한다.** 보관된 저장소도 여전히 그 분야의 표준일 수 있고("지금 무엇이
 * 표준인가"는 star 총합 랭킹의 질문 그대로다), 관리가 멈췄다는 사실은 SkillRepo.archived 로
 * 화면에 배지를 띄워 알린다. 목록에서 지워 버리면 사용자는 "왜 그게 없지?"를 알 방법이 없고,
 * 증가분이 0 에 수렴하는 모습 자체가 죽은 저장소를 알아보는 가장 정직한 신호다.
 */
export function parseSearchPage(body: unknown): SearchPage {
  const b = (body ?? {}) as Record<string, unknown>;
  const items = Array.isArray(b.items) ? b.items : [];
  const repos: SkillRepo[] = [];
  let forksDropped = 0;
  let malformed = 0;
  for (const raw of items) {
    if (raw && typeof raw === "object" && (raw as Record<string, unknown>).fork === true) {
      forksDropped += 1;
      continue;
    }
    const repo = parseSearchItem(raw);
    if (!repo) {
      malformed += 1;
      continue;
    }
    repos.push(repo);
  }
  return {
    repos,
    totalCount: num(b.total_count) ?? repos.length,
    incomplete: b.incomplete_results === true,
    forksDropped,
    malformed,
  };
}

/**
 * topic 별 페이지들을 하나의 추적 풀로 합친다.
 *
 * - 중복 제거 키는 **id**(full_name 이 아니다). 같은 저장소가 4개 topic 에 모두 달려 있는 것이
 *   정상이고, 리네임된 저장소도 id 로 묶여야 이력이 이어진다.
 * - 같은 id 가 여러 번 오면 **star 가 큰 쪽**을 남긴다. 페이지 간 시간차로 값이 미세하게
 *   다를 수 있는데, 아무 쪽이나 고르면 같은 주에 수집 순서만 바뀌어도 결과가 흔들린다.
 * - 정렬은 star 내림차순, 동점은 full_name 오름차순(안정 정렬 — 순위 변동이 이름 때문에
 *   무작위로 튀지 않게 한다).
 */
export function mergeSkillRepos(pages: SkillRepo[][], limit = SKILLS_TRACK_POOL): SkillRepo[] {
  const byId = new Map<number, SkillRepo>();
  for (const page of pages) {
    for (const repo of page) {
      const prev = byId.get(repo.id);
      if (!prev || repo.stars > prev.stars) byId.set(repo.id, repo);
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.stars - a.stars || a.fullName.localeCompare(b.fullName))
    .slice(0, limit);
}

/** 수집 1회의 결과. warnings 는 화면에 올리지 않고 로그·notes 근거로만 쓴다. */
export interface CollectResult {
  repos: SkillRepo[];
  warnings: string[];
  /** 실제로 성공한 검색 호출 수 / 시도한 호출 수 */
  pagesOk: number;
  pagesTried: number;
}

function searchUrl(topic: string, page: number): string {
  const q = new URLSearchParams({
    q: `topic:${topic}`,
    sort: "stars",
    order: "desc",
    per_page: String(GITHUB_PER_PAGE),
    page: String(page),
  });
  return `${GITHUB_SEARCH_ENDPOINT}?${q}`;
}

/**
 * 호출 간 최소 간격(ms).
 *
 * 레이트리밋을 **맞고 나서 기다리는** 것보다 애초에 맞지 않는 편이 낫다. 리밋을 맞으면 창
 * 하나가 통째로 리셋될 때까지(최대 60초) 아무것도 못 하는데, 8회를 6.2초 간격으로 나눠 쏘면
 * 총 50초에 리밋 없이 끝난다. 10% 여유는 우리 시계와 GitHub 창 경계가 어긋나는 몫이다.
 */
export function pacingIntervalMs(rpm: number): number {
  return Math.ceil((60_000 / Math.max(1, rpm)) * 1.1);
}

/**
 * SKILLS_TOPICS 를 순회하며 상위 저장소를 모아 추적 풀(최대 SKILLS_TRACK_POOL)을 만든다.
 *
 * 실패 정책:
 * - 페이지 1건의 네트워크 오류·5xx 는 **던지지 않는다.** 재시도 후에도 실패하면 경고로 남기고
 *   다음 페이지로 넘어간다 — 4개 topic 중 하나가 죽었다고 그 주 랭킹을 통째로 포기할 이유가 없다.
 * - 다만 **최종 0건이면 던진다.** 0건 스냅샷을 저장하면 그것이 '이번 주는 수집됨'으로 읽혀
 *   catch-up 이 봉인된다(뉴스 탭에서 실제로 겪은 사고 — src/news/news.ts isNewsSuccess 주석).
 */
export async function collectSkillRepos(
  overrides: Partial<GithubDeps> = {},
  topics: readonly string[] = SKILLS_TOPICS,
  pages: number = SKILLS_SEARCH_PAGES
): Promise<CollectResult> {
  const deps: GithubDeps = { ...defaultDeps(), ...overrides };
  const rpm = deps.token ? GITHUB_SEARCH_RPM_TOKEN : GITHUB_SEARCH_RPM_ANON;
  const interval = pacingIntervalMs(rpm);
  const warnings: string[] = [];
  const collected: SkillRepo[][] = [];
  let lastCallAt = 0;
  let pagesOk = 0;
  let pagesTried = 0;

  log.info(
    `스킬 저장소 수집 시작 — topic ${topics.length}종 × ${pages}페이지 ` +
      `(${deps.token ? "인증" : "무인증"} ${rpm}회/분, 호출 간격 ${interval}ms)`
  );

  for (const topic of topics) {
    for (let page = 1; page <= pages; page++) {
      pagesTried += 1;
      const url = searchUrl(topic, page);
      let ok = false;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !ok; attempt++) {
        // 페이싱: 직전 호출로부터 interval 이 지나지 않았으면 그만큼 잔다.
        const since = deps.now() - lastCallAt;
        if (lastCallAt > 0 && since < interval) await deps.sleep(interval - since);
        lastCallAt = deps.now();

        try {
          const res = await deps.fetchFn(url, {
            headers: {
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              // UA 는 GitHub 이 요구한다(없으면 403). 토큰은 있을 때만 붙인다.
              "User-Agent": "daily-price-dashboard/skills",
              ...(deps.token ? { Authorization: `Bearer ${deps.token}` } : {}),
            },
          });
          const rate = readRate(res);

          if (res.status === 403 || res.status === 429) {
            const waitMs = rateLimitWaitMs(rate, deps.now());
            if (waitMs !== null && attempt < MAX_ATTEMPTS) {
              log.warn(
                `GitHub 검색 레이트리밋 (${topic} p${page}, HTTP ${res.status}, ` +
                  `remaining=${rate.remaining ?? "?"}) — ${Math.round(waitMs / 1000)}초 대기 후 재시도 ${attempt}/${MAX_ATTEMPTS}`
              );
              await deps.sleep(waitMs);
              continue;
            }
            throw new Error(`HTTP ${res.status} (레이트리밋, remaining=${rate.remaining ?? "?"})`);
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          const parsed = parseSearchPage(await res.json());
          collected.push(parsed.repos);
          pagesOk += 1;
          ok = true;
          if (parsed.incomplete) {
            warnings.push(`${topic} p${page}: GitHub 이 incomplete_results 를 반환(부분 결과)`);
          }
          log.info(
            `GitHub 검색 ${topic} p${page} — ${parsed.repos.length}건 채택` +
              (parsed.forksDropped ? `, fork ${parsed.forksDropped}건 제외` : "") +
              (parsed.malformed ? `, 파싱 실패 ${parsed.malformed}건` : "") +
              ` (총 ${parsed.totalCount}건, 잔여 ${rate.remaining ?? "?"}/${rate.limit ?? "?"})`
          );
        } catch (e) {
          const msg = (e as Error).message;
          if (attempt < MAX_ATTEMPTS) {
            log.warn(`GitHub 검색 실패 (${topic} p${page}) 재시도 ${attempt}/${MAX_ATTEMPTS}: ${msg}`);
            continue;
          }
          warnings.push(`${topic} p${page}: ${msg}`);
          log.error(`GitHub 검색 포기 (${topic} p${page}): ${msg}`);
        }
      }
    }
  }

  const repos = mergeSkillRepos(collected);
  if (repos.length === 0) {
    // 0건은 부분 실패가 아니라 완전 실패다. 빈 스냅샷이 '수집됨'으로 읽히지 않게 여기서 끊는다.
    throw new Error(
      `GitHub 검색 결과 0건 (${pagesOk}/${pagesTried} 페이지 성공)` +
        (warnings.length ? ` — ${warnings.join(" / ")}` : "")
    );
  }
  log.info(
    `스킬 저장소 수집 완료 — 추적 풀 ${repos.length}건 ` +
      `(${pagesOk}/${pagesTried} 페이지 성공, 최다 star ${repos[0].stars.toLocaleString()})`
  );
  return { repos, warnings, pagesOk, pagesTried };
}

/**
 * 레이트리밋 응답에서 '얼마나 기다려야 하는가'를 뽑는다. 기다릴 이유가 없으면 null.
 *
 * 403 은 레이트리밋 말고도(잘못된 토큰 등) 나오므로, **remaining === 0 이거나 Retry-After 가
 * 붙었을 때만** 대기로 판정한다. 그렇지 않은 403 을 기다렸다 재시도하면 같은 실패를 세 번
 * 반복하며 3분을 태울 뿐이다.
 */
export function rateLimitWaitMs(rate: RateInfo, nowMs: number): number | null {
  if (rate.retryAfter !== null && rate.retryAfter > 0) {
    return Math.min(rate.retryAfter * 1000, MAX_RESET_WAIT_MS);
  }
  if (rate.remaining !== 0 || rate.reset === null) return null;
  // +1초는 경계에서 다시 걸리지 않기 위한 여유다.
  const waitMs = rate.reset * 1000 - nowMs + 1000;
  if (waitMs <= 0) return 0;
  return Math.min(waitMs, MAX_RESET_WAIT_MS);
}
