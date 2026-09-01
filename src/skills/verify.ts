import { log } from "../util/log.ts";
import type { SkillRepo } from "../../shared/skills.ts";

/**
 * 저장소 링크 생사 검증 — **죽은 링크를 목록에서 뺀다.**
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────────────────
 * GitHub 검색 인덱스와 저장소의 실제 상태 사이에는 시차가 있다. 삭제되거나 비공개로 바뀐
 * 저장소가 검색 결과에 그대로 남아, 사용자는 클릭할 때마다 404 를 만난다. 수집 시점에 한 번
 * 두드려 확인하면 그 클릭이 사라진다.
 *
 * ── 검증 방법 (실측 기준) ────────────────────────────────────────────────────
 *   HEAD https://github.com/<owner>/<name>
 *     200          → 정상
 *     301/302/…    → 이름 변경. **정상이다.** 따라간 최종 URL 을 SkillRepo.url 에 반영한다.
 *     404/410/451  → 사망. 목록에서 제외.
 *   건당 0.07~0.9초. **GitHub API 레이트리밋(x-ratelimit)을 소모하지 않는다** — 이것이
 *   `GET /repos/{full_name}` 대신 웹 HEAD 를 쓰는 이유다. core 리밋은 무인증 60회/시간이라
 *   100건 검증에 쓸 수 없다.
 *
 * ── ★ 이 파일의 제1원칙: fail-open ──────────────────────────────────────────
 * **'이 저장소가 없다'가 명확할 때만 제외한다.** 타임아웃·DNS 실패·429·5xx·네트워크 오류는
 * 절대 제외 사유가 아니다. 판단 불가는 전부 '살아 있음'으로 접고 경고만 남긴다.
 *
 * 이 원칙이 왜 타협 불가인가: 우리 쪽 사정(집 인터넷이 잠깐 끊겼다, github.com 이 5분간
 * 느렸다)으로 100건을 전부 '사망'으로 판정하면 그 주 랭킹이 통째로 빈다. 그리고 그 빈 목록은
 * '수집 성공'으로 저장돼 다음 주까지 유지된다. 네이버 후보 링크 사망 검증에서 세운 원칙과
 * 정확히 같다 — 검증은 목록을 다듬는 장치이지, 목록을 없앨 권한이 있는 장치가 아니다.
 */

/** 검증 기능 on/off. 끄면 수집 결과를 그대로 통과시킨다(문제 시 이 한 줄로 무력화). */
export const SKILLS_VERIFY_LINKS = true;

/** 요청 1건 상한. 실측 최악이 0.9초라 6초면 느린 날도 흡수하면서 100건이 늘어지지 않는다. */
export const VERIFY_TIMEOUT_MS = 6_000;

/** 동시 요청 수. github.com 을 100건 동시에 두드리지 않는다. */
export const VERIFY_CONCURRENCY = 6;

/** 같은 워커의 요청 간 간격(ms). 6병렬 × 120ms ≈ 초당 50건 미만으로 억제한다. */
export const VERIFY_GAP_MS = 120;

/** 리다이렉트 추적 상한. 이걸 넘으면 판단 불가(= 살아 있음)로 접는다. */
const MAX_HOPS = 5;

/**
 * 라운드 상한.
 *
 * 죽은 항목을 빼면 그 자리에 다음 후보가 올라오고, 그 후보는 아직 검증되지 않았다. 그래서
 * "노출 후보를 뽑아 → 검증 → 죽은 것 제외 → 다시 뽑기"를 반복한다. 보통 1라운드(0건 사망)로
 * 끝나고, 3건이 죽으면 2라운드에서 새로 올라온 3건만 추가로 두드린다.
 * 상한에 걸리면 검증되지 않은 후보가 남지만 **제외하지 않는다**(fail-open).
 */
const MAX_ROUNDS = 4;

/** 명확한 사망 신호. 이 세 가지 외에는 어떤 것도 제외 사유가 아니다. */
const DEAD_STATUSES = new Set([404, 410, 451]);

export type LinkVerdict =
  /** 살아 있다(200대). 리다이렉트를 따라간 경우도 여기다. */
  | "alive"
  /** 명확히 없다(404/410/451) 또는 URL 형식 자체가 깨졌다. **유일한 제외 사유다.** */
  | "dead"
  /** 판단 불가(타임아웃·5xx·429·네트워크 오류·리다이렉트 루프). fail-open 으로 살린다. */
  | "unknown";

export interface LinkCheck {
  verdict: LinkVerdict;
  /** 리다이렉트를 따라갔으면 최종 URL, 아니면 원 URL. 화면 링크는 이 값을 쓴다. */
  finalUrl: string;
  status: number | null;
  reason: string | null;
}

export interface VerifyDeps {
  fetchFn: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  concurrency: number;
  gapMs: number;
}

function defaultDeps(): VerifyDeps {
  return {
    fetchFn: (...args) => fetch(...args),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    timeoutMs: VERIFY_TIMEOUT_MS,
    concurrency: VERIFY_CONCURRENCY,
    gapMs: VERIFY_GAP_MS,
  };
}

/** http(s) URL 인지. 그 외 스킴은 브라우저에서 열 수 없으니 형식 이상이다. */
function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * URL 1건의 생사 판정.
 *
 * ⚠️ `redirect: "manual"` 로 리다이렉트를 **직접** 따라간다. `follow` 에 맡기면 몇 번을 따라갔는지,
 *    최종 URL 이 무엇인지를 런타임마다 다르게 관측하게 되고, 무엇보다 테스트에서 이 동작을
 *    재현할 수 없다. 이 함수의 판정 하나가 항목 노출 여부를 결정하므로 관측 가능해야 한다.
 */
export async function checkRepoUrl(
  url: string,
  overrides: Partial<VerifyDeps> = {}
): Promise<LinkCheck> {
  const deps: VerifyDeps = { ...defaultDeps(), ...overrides };

  // 형식이 깨진 URL 은 네트워크 사정과 무관하게 확정적으로 못 쓴다 — fail-open 의 예외가
  // 아니라, 애초에 '판단 불가'가 성립하지 않는 경우다.
  if (!isHttpUrl(url)) {
    return { verdict: "dead", finalUrl: url, status: null, reason: "http(s) URL 이 아니다" };
  }

  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    timer.unref?.();
    let res: Response;
    try {
      res = await deps.fetchFn(current, {
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "daily-price-dashboard/skills" },
      });
    } catch (e) {
      // 타임아웃·DNS 실패·연결 거부 전부 여기로 온다. **제외하지 않는다.**
      return {
        verdict: "unknown",
        finalUrl: current,
        status: null,
        reason: (e as Error).message || "네트워크 오류",
      };
    } finally {
      clearTimeout(timer);
    }

    const status = res.status;

    if (status >= 200 && status < 300) {
      return { verdict: "alive", finalUrl: current, status, reason: null };
    }
    if (DEAD_STATUSES.has(status)) {
      return { verdict: "dead", finalUrl: current, status, reason: `HTTP ${status}` };
    }
    if (status >= 300 && status < 400) {
      // 이름 변경은 **정상**이다. 최종 URL 을 들고 계속 따라간다.
      const location = res.headers.get("location");
      if (!location) {
        return { verdict: "unknown", finalUrl: current, status, reason: "Location 헤더 없음" };
      }
      try {
        current = new URL(location, current).toString();
      } catch {
        return { verdict: "unknown", finalUrl: current, status, reason: "Location 파싱 실패" };
      }
      continue;
    }
    // 429 · 5xx · 403 등. github.com 쪽 사정이지 저장소가 없다는 뜻이 아니다.
    return { verdict: "unknown", finalUrl: current, status, reason: `HTTP ${status}` };
  }

  return { verdict: "unknown", finalUrl: current, status: null, reason: "리다이렉트 과다" };
}

/**
 * 여러 URL 을 제한된 동시성으로 검증한다.
 *
 * 워커 N개가 하나의 커서를 나눠 갖는 방식이다. 각 워커는 요청 전에 gapMs 만큼 쉬어, 6병렬이
 * 그대로 6배의 순간 부하가 되지 않게 한다.
 */
export async function verifyUrls(
  urls: string[],
  overrides: Partial<VerifyDeps> = {}
): Promise<Map<string, LinkCheck>> {
  const deps: VerifyDeps = { ...defaultDeps(), ...overrides };
  const out = new Map<string, LinkCheck>();
  const queue = [...new Set(urls)];
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= queue.length) return;
      if (deps.gapMs > 0) await deps.sleep(deps.gapMs);
      const url = queue[i];
      // checkRepoUrl 은 스스로 예외를 삼키지만, 계약이 깨져도 워커 하나가 죽으면 나머지
      // 검증이 통째로 멈춘다. 그때도 fail-open 으로 접는다.
      try {
        out.set(url, await checkRepoUrl(url, deps));
      } catch (e) {
        out.set(url, {
          verdict: "unknown",
          finalUrl: url,
          status: null,
          reason: (e as Error).message,
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(deps.concurrency, queue.length)) }, worker)
  );
  return out;
}

export interface PruneResult {
  /** 살아남은 풀. 리다이렉트를 따라간 항목은 url 이 최종 URL 로 갱신돼 있다. */
  repos: SkillRepo[];
  /** 사망 확인으로 제외한 저장소들. 로그·notes 근거다 — 조용히 사라지면 원인을 못 찾는다. */
  removed: SkillRepo[];
  /** 실제로 HEAD 를 친 건수 */
  checked: number;
  /** 판단 불가로 살려 둔 건수(fail-open 이 실제로 몇 건을 구했는지) */
  unknown: number;
  /** 최종 URL 이 바뀐 건수(이름 변경) */
  redirected: number;
  rounds: number;
}

/**
 * 노출 후보의 링크를 검증하고 죽은 것을 풀에서 뺀다.
 *
 * ⚠️ **제외는 순위를 매기기 전에 일어나야 한다.** 순위를 매긴 뒤에 빼면 1~50위에 구멍이
 *    생기고(47개짜리 TOP 50), 그 자리를 채웠어야 할 51번째 후보가 영영 올라오지 못한다.
 *    그래서 이 함수는 랭킹 결과가 아니라 **풀**을 돌려주고, 호출부가 그 풀로 다시 순위를 매긴다.
 *
 * @param repos    추적 풀 전체(최대 400건)
 * @param exposed  풀을 주면 '이번 회차에 화면에 노출될 후보'를 돌려주는 함수
 *                 (= byStars TOP 50 ∪ byGrowth TOP 50). 400건 전부를 두드릴 이유가 없다.
 */
export async function pruneDeadLinks(
  repos: SkillRepo[],
  exposed: (pool: SkillRepo[]) => SkillRepo[],
  overrides: Partial<VerifyDeps> = {}
): Promise<PruneResult> {
  if (!SKILLS_VERIFY_LINKS) {
    return { repos, removed: [], checked: 0, unknown: 0, redirected: 0, rounds: 0 };
  }

  let pool = repos;
  const removed: SkillRepo[] = [];
  const seen = new Set<number>(); // 이미 검증한 repo id (라운드를 넘어 재사용)
  let checked = 0;
  let unknown = 0;
  let redirected = 0;
  let rounds = 0;
  const t0 = Date.now();

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const pending = exposed(pool).filter((r) => !seen.has(r.id));
    if (pending.length === 0) break;
    rounds = round;

    const results = await verifyUrls(
      pending.map((r) => r.url),
      overrides
    );

    const deadIds = new Set<number>();
    const patched = new Map<number, string>(); // id → 최종 URL
    for (const repo of pending) {
      seen.add(repo.id);
      const check = results.get(repo.url);
      if (!check) continue; // 이론상 없다. 없으면 건드리지 않는다(= 살린다).
      checked += 1;
      if (check.verdict === "dead") {
        deadIds.add(repo.id);
        removed.push(repo);
        log.warn(`스킬 링크 사망 확인 → 제외: ${repo.fullName} (${check.reason}) ${repo.url}`);
        continue;
      }
      if (check.verdict === "unknown") {
        unknown += 1;
        // ★ 여기가 fail-open 의 실체다. 판단이 안 서면 목록에 남긴다.
        log.warn(
          `스킬 링크 판정 불가 → 유지: ${repo.fullName} (${check.reason}) — ` +
            "네트워크 사정으로 목록을 지우지 않는다"
        );
        continue;
      }
      if (check.finalUrl !== repo.url) {
        patched.set(repo.id, check.finalUrl);
        redirected += 1;
      }
    }

    if (patched.size > 0) {
      pool = pool.map((r) => (patched.has(r.id) ? { ...r, url: patched.get(r.id)! } : r));
    }
    if (deadIds.size === 0) break; // 새로 올라올 후보가 없으니 여기서 끝이다
    pool = pool.filter((r) => !deadIds.has(r.id));
  }

  log.info(
    `스킬 링크 검증 완료 — ${checked}건 확인 / 사망 ${removed.length}건 제외 / ` +
      `판정 불가 ${unknown}건 유지(fail-open) / 이름 변경 ${redirected}건 (${rounds}라운드, ` +
      `${Math.round((Date.now() - t0) / 1000)}초)`
  );
  return { repos: pool, removed, checked, unknown, redirected, rounds };
}
