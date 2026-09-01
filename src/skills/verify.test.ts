import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRepoUrl, pruneDeadLinks, verifyUrls } from "./verify.ts";
import type { SkillRepo } from "../../shared/skills.ts";

/**
 * 링크 사망 검증 회귀 테스트.
 *
 * ★ 이 파일에서 가장 중요한 것은 **fail-open** 이다. '이 저장소가 없다'가 명확한 404/410/451
 *   일 때만 제외하고, 타임아웃·5xx·429·네트워크 오류는 절대 제외 사유가 아니다.
 *   그 규칙이 깨지면 집 인터넷이 1분 끊긴 것만으로 그 주 랭킹이 통째로 비고, 그 빈 목록이
 *   '수집 성공'으로 저장돼 다음 주까지 유지된다.
 */

/** HEAD 응답 1건을 흉내 내는 최소 Response. */
function res(status: number, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response;
}

const fast = { sleep: async () => {}, gapMs: 0, concurrency: 4, timeoutMs: 50 };

// ── 판정 4종 ──

test("200 이면 살아 있다", async () => {
  const check = await checkRepoUrl("https://github.com/anthropics/skills", {
    ...fast,
    fetchFn: async () => res(200),
  });
  assert.equal(check.verdict, "alive");
  assert.equal(check.finalUrl, "https://github.com/anthropics/skills");
  assert.equal(check.status, 200);
});

test("301 리다이렉트는 정상이고, 따라간 최종 URL 을 돌려준다(이름 변경)", async () => {
  const seen: string[] = [];
  const check = await checkRepoUrl("https://github.com/old-owner/old-name", {
    ...fast,
    fetchFn: async (url) => {
      seen.push(String(url));
      if (String(url).includes("old-name")) {
        return res(301, { location: "https://github.com/new-owner/new-name" });
      }
      return res(200);
    },
  });
  assert.equal(check.verdict, "alive", "이름이 바뀐 것이지 죽은 것이 아니다");
  assert.equal(check.finalUrl, "https://github.com/new-owner/new-name");
  assert.equal(seen.length, 2, "리다이렉트를 직접 따라간다");
});

test("상대 경로 Location 도 원 URL 기준으로 해석한다", async () => {
  const check = await checkRepoUrl("https://github.com/a/b", {
    ...fast,
    fetchFn: async (url) => (String(url).endsWith("/a/b") ? res(302, { location: "/c/d" }) : res(200)),
  });
  assert.equal(check.finalUrl, "https://github.com/c/d");
});

test("404 / 410 / 451 은 사망이다 — 유일한 제외 사유", async () => {
  for (const status of [404, 410, 451]) {
    const check = await checkRepoUrl("https://github.com/gone/repo", {
      ...fast,
      fetchFn: async () => res(status),
    });
    assert.equal(check.verdict, "dead", `HTTP ${status} 는 사망이어야 한다`);
    assert.equal(check.status, status);
  }
});

test("★ 타임아웃은 제외로 이어지지 않는다(fail-open)", async () => {
  // signal 을 존중하며 영원히 기다리는 fetch. 실제 타임아웃 경로를 그대로 탄다.
  const check = await checkRepoUrl("https://github.com/slow/repo", {
    ...fast,
    timeoutMs: 30,
    fetchFn: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      }),
  });
  assert.equal(check.verdict, "unknown", "판단 불가는 '살아 있음'으로 접는다");
  assert.notEqual(check.verdict, "dead", "우리 쪽 사정으로 목록을 지우면 안 된다");
});

test("5xx · 429 · 403 · DNS 실패도 전부 판단 불가다(제외 금지)", async () => {
  for (const status of [429, 500, 502, 503, 403]) {
    const check = await checkRepoUrl("https://github.com/a/b", {
      ...fast,
      fetchFn: async () => res(status),
    });
    assert.equal(check.verdict, "unknown", `HTTP ${status} 는 저장소가 없다는 뜻이 아니다`);
  }
  const dns = await checkRepoUrl("https://github.com/a/b", {
    ...fast,
    fetchFn: async () => {
      throw new Error("getaddrinfo ENOTFOUND github.com");
    },
  });
  assert.equal(dns.verdict, "unknown");
  assert.match(dns.reason ?? "", /ENOTFOUND/);
});

test("Location 없는 3xx · 리다이렉트 루프도 판단 불가다", async () => {
  const noLoc = await checkRepoUrl("https://github.com/a/b", {
    ...fast,
    fetchFn: async () => res(301),
  });
  assert.equal(noLoc.verdict, "unknown");

  const loop = await checkRepoUrl("https://github.com/a/b", {
    ...fast,
    fetchFn: async (url) => res(302, { location: `${String(url)}x` }),
  });
  assert.equal(loop.verdict, "unknown", "무한히 따라가지 않는다");
});

test("http(s) 가 아닌 URL 은 형식 이상으로 제외한다", async () => {
  // 네트워크 불확실성이 아니라 확정적으로 못 쓰는 값이라 fail-open 의 예외가 아니다.
  for (const bad of ["javascript:alert(1)", "not a url", ""]) {
    const check = await checkRepoUrl(bad, { ...fast, fetchFn: async () => res(200) });
    assert.equal(check.verdict, "dead", `"${bad}" 는 열 수 없는 링크다`);
  }
});

// ── 동시성 ──

test("동시 요청 수 상한을 지킨다", async () => {
  let inFlight = 0;
  let peak = 0;
  const urls = Array.from({ length: 20 }, (_, i) => `https://github.com/o/r${i}`);
  await verifyUrls(urls, {
    sleep: async () => {},
    gapMs: 0,
    concurrency: 3,
    timeoutMs: 50,
    fetchFn: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      return res(200);
    },
  });
  assert.ok(peak <= 3, `동시 ${peak}건 — github.com 을 한꺼번에 두드리면 안 된다`);
});

test("중복 URL 은 한 번만 두드린다", async () => {
  let calls = 0;
  const out = await verifyUrls(["https://github.com/a/b", "https://github.com/a/b"], {
    ...fast,
    fetchFn: async () => {
      calls += 1;
      return res(200);
    },
  });
  assert.equal(calls, 1);
  assert.equal(out.size, 1);
});

// ── 풀 정리 ──

function repo(over: Partial<SkillRepo> & { id: number; stars: number }): SkillRepo {
  return {
    fullName: `owner/repo-${over.id}`,
    owner: "owner",
    name: `repo-${over.id}`,
    url: `https://github.com/owner/repo-${over.id}`,
    description: null,
    summary: null,
    forks: 0,
    watchers: 0,
    openIssues: 0,
    language: null,
    license: null,
    topics: [],
    createdAt: "2026-01-01T00:00:00Z",
    pushedAt: "2026-01-01T00:00:00Z",
    archived: false,
    ...over,
  };
}

/** star 상위 3건만 '노출 후보'로 삼는 축소판 랭킹(실제는 TOP 50 두 벌의 합집합). */
const topThree = (pool: SkillRepo[]) => [...pool].sort((a, b) => b.stars - a.stars).slice(0, 3);

test("죽은 항목을 빼면 그 자리에 다음 후보가 올라오고, 그 후보도 검증된다", async () => {
  const pool = [
    repo({ id: 1, stars: 500 }),
    repo({ id: 2, stars: 400 }), // 사망
    repo({ id: 3, stars: 300 }),
    repo({ id: 4, stars: 200 }), // 2번이 빠지면 노출 후보로 올라온다
    repo({ id: 5, stars: 100 }),
  ];
  const probed: string[] = [];
  const result = await pruneDeadLinks(pool, topThree, {
    ...fast,
    fetchFn: async (url) => {
      probed.push(String(url));
      return res(String(url).endsWith("repo-2") ? 404 : 200);
    },
  });

  assert.deepEqual(
    result.repos.map((r) => r.id),
    [1, 3, 4, 5],
    "사망한 2번만 풀에서 빠진다"
  );
  assert.deepEqual(result.removed.map((r) => r.id), [2]);
  assert.ok(
    probed.some((u) => u.endsWith("repo-4")),
    "빈자리를 채운 4번도 검증해야 한다 — 안 그러면 검증되지 않은 항목이 노출된다"
  );
  assert.ok(
    !probed.some((u) => u.endsWith("repo-5")),
    "노출되지 않는 항목까지 두드릴 이유는 없다"
  );
  assert.equal(result.rounds, 2);
});

test("★ 전부 타임아웃이어도 목록이 비지 않는다(fail-open 의 최종 방어선)", async () => {
  const pool = [repo({ id: 1, stars: 300 }), repo({ id: 2, stars: 200 }), repo({ id: 3, stars: 100 })];
  const result = await pruneDeadLinks(pool, topThree, {
    ...fast,
    timeoutMs: 20,
    fetchFn: (_url, init) =>
      new Promise<Response>((_r, reject) => {
        (init as RequestInit | undefined)?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      }),
  });
  assert.equal(result.repos.length, 3, "네트워크가 통째로 죽어도 목록은 그대로다");
  assert.equal(result.removed.length, 0);
  assert.equal(result.unknown, 3, "몇 건을 fail-open 으로 구했는지 셀 수 있어야 한다");
});

test("리다이렉트를 따라간 항목은 풀의 url 이 최종 URL 로 갱신된다", async () => {
  const pool = [repo({ id: 1, stars: 300, url: "https://github.com/old/name" })];
  const result = await pruneDeadLinks(pool, topThree, {
    ...fast,
    fetchFn: async (url) =>
      String(url).includes("old/name")
        ? res(301, { location: "https://github.com/new/name" })
        : res(200),
  });
  assert.equal(result.repos[0].url, "https://github.com/new/name");
  assert.equal(result.redirected, 1);
  assert.equal(result.removed.length, 0);
});

test("입력 배열과 원본 객체를 제자리에서 고치지 않는다", async () => {
  const original = repo({ id: 1, stars: 300, url: "https://github.com/old/name" });
  const pool = [original];
  await pruneDeadLinks(pool, topThree, {
    ...fast,
    fetchFn: async (url) =>
      String(url).includes("old/name")
        ? res(301, { location: "https://github.com/new/name" })
        : res(200),
  });
  assert.equal(original.url, "https://github.com/old/name");
  assert.equal(pool.length, 1);
});

test("모두 살아 있으면 1라운드로 끝나고 풀이 그대로다", async () => {
  const pool = [repo({ id: 1, stars: 300 }), repo({ id: 2, stars: 200 })];
  const result = await pruneDeadLinks(pool, topThree, { ...fast, fetchFn: async () => res(200) });
  assert.equal(result.rounds, 1);
  assert.equal(result.checked, 2);
  assert.deepEqual(result.repos.map((r) => r.id), [1, 2]);
});
