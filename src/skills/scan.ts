import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { SKILLS_SCAN_CAP } from "../../shared/skills.ts";
import type {
  SkillAccess,
  SkillAccessKind,
  SkillRankEntry,
  SkillRepo,
  SkillUnit,
} from "../../shared/skills.ts";

/**
 * 네트워크 접근 스캐너 — "이 스킬은 로컬에서만 도는가, 외부 URL 로 나가는가".
 *
 * ── 판정 근거는 오직 파일 내용이다 ───────────────────────────────────────────
 * 저장소의 SKILL.md 를 실제로 읽어 런타임 네트워크 신호를 찾는다. LLM 은 이 판정에 일절
 * 관여하지 않는다 — 태그는 사실처럼 읽히므로, 틀리면 사용자가 "로컬"을 믿고 외부로 나가는
 * 스킬을 돌린다. 검증 가능한 값과 생성된 문장의 경로를 분리하는 이 탭의 원칙 그대로다.
 *
 * ── 검증된 경로 (2026-09-02 실호출) ─────────────────────────────────────────
 * 1) 파일 목록: `GET repos/{owner}/{repo}/git/trees/{branch}?recursive=1` **1회**.
 *    anthropics/skills 기준 511 엔트리를 한 번에 받았고 `truncated:false` 였다.
 *    ★ 이것이 **유일한 core 쿼터 소비 지점**이다(무인증 60회/시간).
 * 2) 파일 내용: `https://raw.githubusercontent.com/{repo}/{branch}/{path}`.
 *    실측 200 응답에 **레이트리밋 헤더가 없다 = API 쿼터를 쓰지 않는다.** 그래서 파일은
 *    마음껏 읽고, 아끼는 것은 트리 호출뿐이다. 상위 50 저장소의 SKILL.md 876건을 10초에 읽었다.
 *
 * ── 왜 표본인가 ─────────────────────────────────────────────────────────────
 * 상위 50 저장소의 SKILL.md 합계가 10,607건, 최대 보유 저장소 하나가 6,632건이다. 전수는
 * 불가능하다. 그래서 저장소당 SKILLS_SCAN_CAP(40) 까지만 읽고, **표본이었다는 사실을
 * kind 로 드러낸다**(`local-sampled`). 아래 비대칭 규칙이 이 파일의 전부다.
 */

// ── 신호 ────────────────────────────────────────────────

/**
 * 런타임 네트워크 신호. 질문은 하나다 — **"이 스킬이 돌 때 네트워크로 나가는가."**
 *
 * ⚠️ **문서에 링크가 있다고 외부 접근이 아니다.** 산문 속 맨 URL(참고 문서 링크, 저장소
 *    주소, 배지 이미지)은 신호가 아니다. 그래서 `https?://` 를 통째로 잡지 않고, 호출 형태
 *    (curl -X / fetch("http…") / requests.get)와 api·graph 호스트만 좁게 잡는다.
 *    실측 분리: claude-api → WebFetch·WebSearch·curl 검출(정답) / brand-guidelines·docx·
 *    algorithmic-art → 신호 없음(정답).
 */
export const NETWORK_SIGNALS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // 에이전트 도구 이름. frontmatter 의 allowed-tools 에 적힌 것도 신호다 — "이 스킬은 웹을
  // 쓸 수 있다"는 선언 자체가 우리가 답하려는 질문의 답이다.
  { name: "WebFetch", re: /\bWebFetch\b/ },
  { name: "WebSearch", re: /\bWebSearch\b/ },
  // 셸 호출. `curl` 단어만으로는 산문("curl 로도 됩니다")과 구분이 안 되므로 옵션이 붙은
  // 실제 호출 형태만 잡는다. 줄머리·공백·코드펜스 백틱 뒤가 시작점이다.
  { name: "curl", re: /(^|[\s`])curl\s+-/m },
  { name: "wget", re: /(^|[\s`])wget\s/m },
  // 코드 안의 HTTP 호출.
  { name: "fetch()", re: /\bfetch\(\s*[`'"]https?:\/\// },
  { name: "requests", re: /\brequests\.(get|post|put)\b/ },
  { name: "httpx", re: /\bhttpx\.(get|post|Client)/ },
  { name: "axios", re: /\baxios\b/ },
  { name: "urllib", re: /\burllib\.request\b/ },
  // api·graph 호스트. 문서에 적혀 있어도 "이 스킬이 부르는 곳"일 확률이 압도적이다.
  { name: "api호스트", re: /https?:\/\/[a-z0-9.-]*(api|graph)\.[a-z0-9.-]+/i },
  // MCP 서버 참조. 도구 이름(mcp__x__y)이든 서버 선언(mcpServers)이든 외부 프로세스로 나간다.
  { name: "MCP", re: /mcp__|mcpServers/ },
];

/** SKILL.md 본문 1건에서 발견된 신호 이름들(중복 없음, NETWORK_SIGNALS 순서 유지). */
export function detectSignals(text: string): string[] {
  const out: string[] = [];
  for (const s of NETWORK_SIGNALS) {
    if (s.re.test(text)) out.push(s.name);
  }
  return out;
}

// ── ★★ 판정 (이 파일의 핵심) ────────────────────────────

/**
 * 집계 판정. **의도적으로 비대칭이다.**
 *
 *   - 신호를 **찾으면 확정**이다. 표본만 봤어도 "찾았다"는 사실은 참이다.
 *       검사한 것 전부에서 발견 → external
 *       일부에서만 발견        → partial
 *   - 신호를 **못 찾은 것은 없다는 증거가 아니다.**
 *       전수(checked >= total)에서 0건 → local          (단정 OK)
 *       표본(checked <  total)에서 0건 → local-sampled  (단정 금지)
 *
 * 864개 중 40개만 보고 "로컬"이라 적는 것은 사실상 거짓말이다. 그 한 줄을 막는 것이
 * 이 함수가 존재하는 유일한 이유이고, scan.test.ts 가 그것만 붙들고 시험한다.
 */
export function decideAccessKind(input: {
  /** 트리 조회가 성공했는가. 실패면 total 0 이 'SKILL.md 가 없다'는 뜻이 아니다. */
  treeOk: boolean;
  total: number;
  checked: number;
  network: number;
}): SkillAccessKind {
  // 트리를 못 봤으면 아무것도 모른다. '로컬'이 아니라 '모른다'다.
  if (!input.treeOk) return "unknown";
  // 트리는 봤는데 SKILL.md 가 0개 = awesome 목록·도구 저장소. 상위 50 중 실제로 6건.
  if (input.total <= 0) return "no-skill";
  // SKILL.md 는 있는데 한 건도 못 읽었다 → 판정 불가.
  if (input.checked <= 0) return "unknown";
  if (input.network > 0) return input.network >= input.checked ? "external" : "partial";
  return input.checked >= input.total ? "local" : "local-sampled";
}

// ── 트리 → SKILL.md 경로 ────────────────────────────────

/** git tree 응답의 blob 중 SKILL.md 만 골라 경로를 돌려준다(사전순 — 표본이 재현 가능해야 한다). */
export function pickSkillPaths(tree: unknown): string[] {
  const t = (tree ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(t.tree) ? t.tree : [];
  const paths: string[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (e.type !== "blob") continue;
    const p = typeof e.path === "string" ? e.path : "";
    if (!p) continue;
    // 대소문자를 가리지 않는다. 규약은 SKILL.md 지만 skill.md 로 적은 저장소를 놓칠 이유가 없다.
    if (p.slice(p.lastIndexOf("/") + 1).toLowerCase() === "skill.md") paths.push(p);
  }
  return paths.sort();
}

/**
 * cap 개를 **고르게** 뽑는다(앞에서 자르지 않는다).
 *
 * 사전순 앞 40개만 자르면 6,632개짜리 저장소에서 `a…` 로 시작하는 한 디렉터리만 보게 된다.
 * 그 표본에서 신호가 안 나왔다는 사실은 저장소 전체에 대해 거의 아무것도 말해 주지 않는다.
 * 일정 간격으로 훑으면 같은 40건으로 훨씬 넓게 본다. 인덱스 계산이라 **결정적**이다 —
 * 같은 저장소를 두 번 스캔하면 같은 표본이 나온다(캐시·재현성이 여기에 걸려 있다).
 */
export function sampleEvenly<T>(items: T[], cap: number): T[] {
  if (cap <= 0 || items.length <= cap) return items;
  const out: T[] = [];
  for (let i = 0; i < cap; i++) out.push(items[Math.floor((i * items.length) / cap)]);
  return out;
}

/** SKILL.md 경로 → 스킬 이름. 디렉터리명이 곧 스킬 이름이고, 루트면 저장소 이름을 쓴다. */
export function unitName(path: string, repoName: string): string {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return repoName; // 루트의 SKILL.md
  const dir = path.slice(0, slash);
  const seg = dir.slice(dir.lastIndexOf("/") + 1);
  return seg || repoName;
}

/** raw/blob URL 에 쓸 경로 인코딩. 공백·한글이 든 디렉터리가 실제로 있다. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// ── 실행 ────────────────────────────────────────────────

/** 저장소 1건의 스캔 결과. access 는 그대로 SkillRepo.access 로, units 는 .units 로 간다. */
export interface RepoScan {
  repoId: number;
  fullName: string;
  /** 실제로 읽은 브랜치(캐시·디버깅용). 트리 조회 실패면 null. */
  branch: string | null;
  access: SkillAccess;
  units: SkillUnit[];
}

export interface ScanDeps {
  fetchFn: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  token: string;
  /** 요청 1건 상한. 트리·raw 공통. */
  timeoutMs: number;
  /** 동시에 스캔할 저장소 수(실측 조합: 저장소 5 × 파일 8). */
  repoConcurrency: number;
  /** 한 저장소 안에서 동시에 읽을 파일 수. */
  fileConcurrency: number;
  /** 저장소당 읽을 SKILL.md 상한. */
  cap: number;
  /** 기본 브랜치 후보. SkillRepo 에 default_branch 가 없어 순서대로 시도한다. */
  branches: readonly string[];
}

export const SCAN_TIMEOUT_MS = 10_000;
export const SCAN_REPO_CONCURRENCY = 5;
export const SCAN_FILE_CONCURRENCY = 8;
/** main → master 순. 상위 50 저장소에서 이 두 개로 조회 실패 0건이었다(2026-09-02 실측). */
export const SCAN_BRANCHES = ["main", "master"] as const;

function defaultDeps(): ScanDeps {
  return {
    fetchFn: (...args) => fetch(...args),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    token: config.githubToken,
    timeoutMs: SCAN_TIMEOUT_MS,
    repoConcurrency: SCAN_REPO_CONCURRENCY,
    fileConcurrency: SCAN_FILE_CONCURRENCY,
    cap: SKILLS_SCAN_CAP,
    branches: SCAN_BRANCHES,
  };
}

/** 타임아웃이 걸린 fetch. 실패는 예외가 아니라 null 이다(스캔은 회차를 죽이지 않는다). */
async function getText(
  url: string,
  headers: Record<string, string>,
  deps: ScanDeps
): Promise<{ status: number; text: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  timer.unref?.();
  try {
    const res = await deps.fetchFn(url, { headers, signal: controller.signal });
    if (!res.ok) return { status: res.status, text: "" };
    return { status: res.status, text: await res.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 제한된 동시성으로 items 를 처리한다(워커 N개가 커서 하나를 나눠 갖는다). */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** 트리 조회 결과. rateLimited 면 호출부가 **남은 저장소 스캔을 접는다**(불필요한 재시도 금지). */
interface TreeResult {
  paths: string[] | null;
  branch: string | null;
  rateLimited: boolean;
  reason: string | null;
}

/**
 * 저장소 파일 목록. **core 쿼터를 쓰는 유일한 호출이다.**
 *
 * SkillRepo 에 default_branch 가 없어 main → master 순으로 시도한다. 404 는 "그 브랜치가
 * 없다"는 뜻이라 다음 후보로 넘어가고, 403/429(레이트리밋)는 브랜치를 바꿔 봐야 소용없으므로
 * 즉시 접는다 — 무인증 60회/시간에서 한 저장소가 쿼터를 두 번 태우면 안 된다.
 */
async function fetchTree(repo: SkillRepo, deps: ScanDeps): Promise<TreeResult> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "daily-price-dashboard/skills",
    ...(deps.token ? { Authorization: `Bearer ${deps.token}` } : {}),
  };
  let lastReason: string | null = null;

  for (const branch of deps.branches) {
    const url =
      `https://api.github.com/repos/${repo.fullName}/git/trees/` +
      `${encodeURIComponent(branch)}?recursive=1`;
    const got = await getText(url, headers, deps);
    if (!got) {
      lastReason = "네트워크 오류/타임아웃";
      continue;
    }
    if (got.status === 403 || got.status === 429) {
      return { paths: null, branch: null, rateLimited: true, reason: `HTTP ${got.status}` };
    }
    if (got.status === 404 || got.status === 409) {
      // 409 = 빈 저장소. 둘 다 "이 브랜치로는 못 본다"이지 실패가 아니다.
      lastReason = `HTTP ${got.status}`;
      continue;
    }
    if (got.status !== 200) {
      lastReason = `HTTP ${got.status}`;
      continue;
    }
    let body: unknown;
    try {
      body = JSON.parse(got.text);
    } catch {
      lastReason = "트리 JSON 파싱 실패";
      continue;
    }
    const paths = pickSkillPaths(body);
    const truncated = (body as Record<string, unknown>)?.truncated === true;
    if (truncated) {
      // 트리가 잘렸으면 total 이 과소평가된다 → 전수 검사가 아니게 된다. 그 사실을 보이도록
      // paths 를 그대로 쓰되, 아래에서 total 을 paths.length 로 두고 cap 을 적용하면
      // checked >= total 이 되어 'local' 로 단정될 수 있다. 그래서 total 을 +1 해 둔다.
      log.warn(`스킬 스캔 — ${repo.fullName} 트리가 잘렸다(truncated) → 전수 단정 금지`);
      return { paths, branch, rateLimited: false, reason: "truncated" };
    }
    return { paths, branch, rateLimited: false, reason: null };
  }
  return { paths: null, branch: null, rateLimited: false, reason: lastReason ?? "조회 실패" };
}

/**
 * 저장소 1건 스캔. **예외를 던지지 않는다** — 실패는 kind="unknown" 으로 표현한다.
 * 스캔은 목록에 태그를 붙이는 부가 장치이지, 수집 회차를 폐기할 권한이 있는 장치가 아니다.
 */
export async function scanRepo(
  repo: SkillRepo,
  overrides: Partial<ScanDeps> = {}
): Promise<RepoScan & { rateLimited: boolean }> {
  const deps: ScanDeps = { ...defaultDeps(), ...overrides };
  const tree = await fetchTree(repo, deps);

  if (!tree.paths || !tree.branch) {
    return {
      repoId: repo.id,
      fullName: repo.fullName,
      branch: null,
      access: {
        kind: decideAccessKind({ treeOk: false, total: 0, checked: 0, network: 0 }),
        total: 0,
        checked: 0,
        network: 0,
        signals: [],
      },
      units: [],
      rateLimited: tree.rateLimited,
    };
  }

  const branch = tree.branch;
  // 트리가 잘렸으면 우리가 본 목록이 전부가 아니다. total 을 하나 올려 checked >= total 이
  // 성립하지 못하게 만든다 = 'local' 단정이 원천 봉쇄되고 'local-sampled' 로 내려간다.
  const total = tree.paths.length + (tree.reason === "truncated" ? 1 : 0);
  const sample = sampleEvenly(tree.paths, deps.cap);

  const results = await mapPool(sample, deps.fileConcurrency, async (path) => {
    const raw = `https://raw.githubusercontent.com/${repo.fullName}/${encodeURIComponent(branch)}/${encodePath(path)}`;
    const got = await getText(raw, { "User-Agent": "daily-price-dashboard/skills" }, deps);
    if (!got || got.status !== 200) return null; // 못 읽은 파일은 '신호 없음'이 아니라 '미검사'다
    return {
      name: unitName(path, repo.name),
      path,
      url: `https://github.com/${repo.fullName}/blob/${encodeURIComponent(branch)}/${encodePath(path)}`,
      signals: detectSignals(got.text),
    } satisfies SkillUnit;
  });

  const units = results.filter((u): u is SkillUnit => u !== null);
  const network = units.filter((u) => u.signals.length > 0).length;
  const signals = [...new Set(units.flatMap((u) => u.signals))];

  return {
    repoId: repo.id,
    fullName: repo.fullName,
    branch,
    access: {
      kind: decideAccessKind({ treeOk: true, total, checked: units.length, network }),
      total,
      checked: units.length,
      network,
      signals,
    },
    units,
    rateLimited: false,
  };
}

export interface ScanSummary {
  /** repo_id → 스캔 결과. 캐시 재사용분도 여기 들어 있다. */
  scans: Map<number, RepoScan>;
  /** 캐시를 그대로 쓴 저장소 수(트리 호출을 아낀 건수). */
  cached: number;
  /** 실제로 트리를 조회한 저장소 수 = 이번에 소비한 core 쿼터. */
  fetched: number;
  /** 레이트리밋으로 스캔을 접은 저장소 수(전부 unknown). */
  skipped: number;
  ms: number;
}

/**
 * 노출 후보를 스캔한다.
 *
 * @param repos     스캔 대상(= byStars TOP 50 ∪ byGrowth TOP 50, 링크 사망 검증 통과분)
 * @param cacheHit  repo → 재사용 가능한 캐시(없으면 null). pushed_at 이 같을 때만 준다.
 *
 * ★ 레이트리밋을 만나면 **남은 저장소를 즉시 포기한다**(kind="unknown"). 무인증 60회/시간
 *   창이 리셋되기를 기다리면 주간 회차가 한 시간을 붙잡는다. 태그 하나 때문에 그럴 수 없다.
 */
export async function scanRepos(
  repos: SkillRepo[],
  cacheHit: (repo: SkillRepo) => RepoScan | null = () => null,
  overrides: Partial<ScanDeps> = {}
): Promise<ScanSummary> {
  const deps: ScanDeps = { ...defaultDeps(), ...overrides };
  const t0 = Date.now();
  const scans = new Map<number, RepoScan>();
  let cached = 0;
  let fetched = 0;
  let skipped = 0;
  let rateLimited = false;

  const pending: SkillRepo[] = [];
  for (const repo of repos) {
    const hit = cacheHit(repo);
    if (hit) {
      scans.set(repo.id, hit);
      cached += 1;
      continue;
    }
    pending.push(repo);
  }

  log.info(
    `스킬 네트워크 스캔 시작 — 대상 ${repos.length}건 (캐시 재사용 ${cached}건, 신규 조회 ${pending.length}건, ` +
      `${deps.token ? "인증 5000회/시간" : "무인증 60회/시간"})`
  );

  await mapPool(pending, deps.repoConcurrency, async (repo) => {
    if (rateLimited) {
      // 창이 리셋될 때까지 기다리지 않는다. 남은 것은 전부 '모른다'로 둔다.
      skipped += 1;
      scans.set(repo.id, unknownScan(repo));
      return;
    }
    try {
      const r = await scanRepo(repo, deps);
      if (r.rateLimited) {
        rateLimited = true;
        skipped += 1;
        scans.set(repo.id, unknownScan(repo));
        log.warn(
          `스킬 네트워크 스캔 — GitHub core 레이트리밋 도달(${repo.fullName}) → ` +
            "남은 저장소는 판정 없이 넘어간다(태그를 안 붙일 뿐, 목록은 그대로다)"
        );
        return;
      }
      fetched += 1;
      scans.set(repo.id, r);
    } catch (e) {
      // 여기까지 오면 안 되지만, 워커 하나의 예외가 전체 스캔을 죽이지 않게 한 번 더 접는다.
      skipped += 1;
      scans.set(repo.id, unknownScan(repo));
      log.warn(`스킬 네트워크 스캔 예외 → ${repo.fullName} 판정 생략: ${(e as Error).message}`);
    }
  });

  const ms = Date.now() - t0;
  log.info(
    `스킬 네트워크 스캔 완료 — ${Math.round(ms / 1000)}초, ` +
      `조회 ${fetched}건 / 캐시 ${cached}건 / 생략 ${skipped}건 · ${formatKindCounts(scans)}`
  );
  return { scans, cached, fetched, skipped, ms };
}

/** 판정 불가 결과 1건. '로컬'이 아니라 '모른다'다 — 이 구분이 태그의 신뢰를 지킨다. */
function unknownScan(repo: SkillRepo): RepoScan {
  return {
    repoId: repo.id,
    fullName: repo.fullName,
    branch: null,
    access: { kind: "unknown", total: 0, checked: 0, network: 0, signals: [] },
    units: [],
  };
}

/** kind 별 건수 로그 문구. 매주 이 한 줄로 판정 분포가 흔들렸는지 본다. */
export function formatKindCounts(scans: Map<number, RepoScan>): string {
  const counts = new Map<SkillAccessKind, number>();
  for (const s of scans.values()) counts.set(s.access.kind, (counts.get(s.access.kind) ?? 0) + 1);
  const order: SkillAccessKind[] = [
    "external",
    "partial",
    "local",
    "local-sampled",
    "no-skill",
    "unknown",
  ];
  return order
    .filter((k) => counts.has(k))
    .map((k) => `${k} ${counts.get(k)}`)
    .join(" / ");
}

/**
 * 랭킹 항목에 판정을 붙인다(attachSummaries 와 같은 모양 — 원본을 변형하지 않는다).
 * 스캔 결과가 없는 항목은 access 를 **아예 넣지 않는다** — 화면은 없으면 칩을 그리지 않는다.
 */
export function attachAccess(
  entries: SkillRankEntry[],
  scans: Map<number, RepoScan>
): SkillRankEntry[] {
  return entries.map((e) => {
    const scan = scans.get(e.repo.id);
    if (!scan) return e;
    return { ...e, repo: { ...e.repo, access: scan.access, units: scan.units } };
  });
}
