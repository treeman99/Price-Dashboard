import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectSkillRepos,
  mergeSkillRepos,
  pacingIntervalMs,
  parseSearchItem,
  parseSearchPage,
  rateLimitWaitMs,
  GITHUB_SEARCH_RPM_ANON,
  GITHUB_SEARCH_RPM_TOKEN,
} from "./github.ts";
import type { SkillRepo } from "../../shared/skills.ts";

/**
 * GitHub 검색 응답 파싱 회귀 테스트.
 *
 * ⚠️ 아래 픽스처는 **꾸며낸 값이 아니다.** 2026-09-01
 *    `GET /search/repositories?q=topic:agent-skills&sort=stars&order=desc&per_page=3&page=1`
 *    를 실제로 호출해 받은 응답의 item 3건을 그대로 옮긴 것이다(응답 헤더도 실측:
 *    x-ratelimit-limit: 10, x-ratelimit-resource: search).
 *
 *    이 저장소에는 합성 픽스처만 보고 만든 파서가 실제 응답과 어긋나 크게 데인 이력이 있다.
 *    그래서 픽스처의 출처를 여기 못박아 둔다 — 나중에 필드를 바꿀 때는 **다시 실호출해서**
 *    응답을 확인하고 이 주석의 날짜를 갱신할 것.
 *
 *    실측에서 드러난 두 함정이 그대로 들어 있다:
 *      1. 1위 anthropics/skills 는 **license 가 null** 이다 (SPDX 를 항상 기대하면 터진다).
 *      2. 3위 nexu-io/open-design 은 **language 가 null** 이다.
 */
const REAL_ITEMS = [
  {
    id: 1061953414,
    name: "skills",
    full_name: "anthropics/skills",
    owner: { login: "anthropics" },
    html_url: "https://github.com/anthropics/skills",
    description: "Public repository for Agent Skills",
    fork: false,
    created_at: "2025-09-22T15:53:31Z",
    pushed_at: "2026-08-21T17:10:55Z",
    stargazers_count: 172948,
    watchers_count: 172948,
    language: "Python",
    forks_count: 20533,
    archived: false,
    open_issues_count: 1196,
    license: null,
    topics: ["agent-skills"],
    score: 1,
  },
  {
    id: 1266797999,
    name: "ponytail",
    full_name: "DietrichGebert/ponytail",
    owner: { login: "DietrichGebert" },
    html_url: "https://github.com/DietrichGebert/ponytail",
    description:
      "Makes your AI agent think like the laziest senior dev in the room. The best code is the code you never wrote.",
    fork: false,
    created_at: "2026-06-12T00:52:37Z",
    pushed_at: "2026-08-07T21:44:01Z",
    stargazers_count: 119526,
    watchers_count: 119526,
    language: "JavaScript",
    forks_count: 6478,
    archived: false,
    open_issues_count: 191,
    license: {
      key: "mit",
      name: "MIT License",
      spdx_id: "MIT",
      url: "https://api.github.com/licenses/mit",
      node_id: "MDc6TGljZW5zZTEz",
    },
    topics: ["agent-skills", "ai-agents", "claude", "claude-code", "llm"],
    score: 1,
  },
  {
    id: 1223170290,
    name: "open-design",
    full_name: "nexu-io/open-design",
    owner: { login: "nexu-io" },
    html_url: "https://github.com/nexu-io/open-design",
    description: "🎨 Best DeepSeek Harness Design Plugin.",
    fork: false,
    created_at: "2026-04-28T04:25:20Z",
    pushed_at: "2026-09-01T14:38:42Z",
    stargazers_count: 93262,
    watchers_count: 93262,
    language: null,
    forks_count: 10763,
    archived: false,
    open_issues_count: 921,
    license: {
      key: "apache-2.0",
      name: "Apache License 2.0",
      spdx_id: "Apache-2.0",
      url: "https://api.github.com/licenses/apache-2.0",
      node_id: "MDc6TGljZW5zZTI=",
    },
    topics: ["agent-skills", "ai-design", "design-systems"],
    score: 1,
  },
];

const REAL_BODY = { total_count: 20115, incomplete_results: false, items: REAL_ITEMS };

test("실제 GitHub 응답 item 을 SkillRepo 로 정확히 파싱한다", () => {
  const repo = parseSearchItem(REAL_ITEMS[0]);
  assert.ok(repo);
  assert.deepEqual(repo, {
    id: 1061953414,
    fullName: "anthropics/skills",
    owner: "anthropics",
    name: "skills",
    url: "https://github.com/anthropics/skills",
    description: "Public repository for Agent Skills",
    summary: null, // 파서는 LLM 요약을 만들지 않는다 — 숫자와 문장의 경로를 분리한다
    stars: 172948,
    forks: 20533,
    watchers: 172948,
    openIssues: 1196,
    language: "Python",
    license: null, // 실측: 1위 저장소가 라이선스 미표기다
    topics: ["agent-skills"],
    createdAt: "2025-09-22T15:53:31Z",
    pushedAt: "2026-08-21T17:10:55Z",
    archived: false,
  } satisfies SkillRepo);
});

test("license 는 spdx_id 만 뽑고 language null 을 그대로 보존한다", () => {
  const mit = parseSearchItem(REAL_ITEMS[1]);
  assert.equal(mit?.license, "MIT");
  const noLang = parseSearchItem(REAL_ITEMS[2]);
  assert.equal(noLang?.license, "Apache-2.0");
  assert.equal(noLang?.language, null, "language 가 null 인 저장소가 실제로 있다");
});

test('license.spdx_id 가 "NOASSERTION" 이면 null 로 접는다', () => {
  const repo = parseSearchItem({
    ...REAL_ITEMS[0],
    license: { key: "other", name: "Other", spdx_id: "NOASSERTION" },
  });
  assert.equal(repo?.license, null, "표기할 값이 아니라 미상이다");
});

test("id / full_name / stargazers_count 중 하나라도 없으면 그 item 만 버린다", () => {
  assert.equal(parseSearchItem({ ...REAL_ITEMS[0], id: undefined }), null);
  assert.equal(parseSearchItem({ ...REAL_ITEMS[0], full_name: "" }), null);
  assert.equal(parseSearchItem({ ...REAL_ITEMS[0], stargazers_count: null }), null);
  assert.equal(parseSearchItem(null), null);
});

test("description 이 빈 문자열이면 null 로 정규화한다", () => {
  assert.equal(parseSearchItem({ ...REAL_ITEMS[0], description: "   " })?.description, null);
});

test("페이지 파싱은 fork 를 제외하고 파싱 실패 건수를 따로 센다", () => {
  const page = parseSearchPage({
    ...REAL_BODY,
    items: [
      REAL_ITEMS[0],
      { ...REAL_ITEMS[1], fork: true }, // 복제본 — 원본과 내용이 같아 증가 랭킹을 오염시킨다
      { id: 1, full_name: "x/y" }, // stars 없음 → 파싱 실패
    ],
  });
  assert.equal(page.repos.length, 1);
  assert.equal(page.repos[0].fullName, "anthropics/skills");
  assert.equal(page.forksDropped, 1);
  assert.equal(page.malformed, 1);
  assert.equal(page.totalCount, 20115);
  assert.equal(page.incomplete, false);
});

test("archived 저장소는 목록에 남기고 플래그로만 표시한다", () => {
  const page = parseSearchPage({
    ...REAL_BODY,
    items: [{ ...REAL_ITEMS[0], archived: true }],
  });
  assert.equal(page.repos.length, 1, "보관된 저장소도 '지금 무엇이 표준인가'의 답일 수 있다");
  assert.equal(page.repos[0].archived, true);
});

// ── 합집합 ──

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

test("topic 페이지들을 id 기준으로 합치고 star 내림차순 상위만 남긴다", () => {
  const merged = mergeSkillRepos(
    [
      [repo({ id: 1, stars: 100 }), repo({ id: 2, stars: 300 })],
      // 같은 저장소가 여러 topic 에 달려 있는 것이 정상이다(id 로 중복 제거).
      [repo({ id: 2, stars: 300 }), repo({ id: 3, stars: 200 })],
    ],
    2
  );
  assert.deepEqual(
    merged.map((r) => r.id),
    [2, 3],
    "star 내림차순 상위 2건"
  );
});

test("같은 id 가 다른 star 로 두 번 오면 큰 쪽을 남긴다(수집 순서로 결과가 흔들리지 않게)", () => {
  const merged = mergeSkillRepos([[repo({ id: 7, stars: 10 })], [repo({ id: 7, stars: 12 })]]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].stars, 12);
});

test("star 동점은 full_name 오름차순으로 안정 정렬한다", () => {
  const merged = mergeSkillRepos([
    [repo({ id: 2, stars: 50, fullName: "b/b" }), repo({ id: 1, stars: 50, fullName: "a/a" })],
  ]);
  assert.deepEqual(
    merged.map((r) => r.fullName),
    ["a/a", "b/b"]
  );
});

// ── 레이트리밋 ──

test("페이싱 간격은 실측 레이트리밋(무인증 10회/분)을 넘지 않는다", () => {
  const anon = pacingIntervalMs(GITHUB_SEARCH_RPM_ANON);
  assert.ok(anon >= 6_000, `무인증 간격이 6초 이상이어야 한다 (실제 ${anon}ms)`);
  // 8회 호출(topic 4 × 2페이지)이 1분 창에서 10회를 넘기지 않는지 직접 계산으로 확인.
  assert.ok(8 * anon >= 48_000);
  assert.ok(pacingIntervalMs(GITHUB_SEARCH_RPM_TOKEN) < anon, "토큰이 있으면 더 촘촘히 쏜다");
});

test("remaining=0 이면 reset 까지 기다리고, 그 외 403 은 기다리지 않는다", () => {
  const now = 1_788_274_000_000; // epoch ms
  assert.equal(
    rateLimitWaitMs({ limit: 10, remaining: 0, reset: 1_788_274_030, retryAfter: null }, now),
    31_000,
    "reset(초) 까지 + 1초 여유"
  );
  assert.equal(
    rateLimitWaitMs({ limit: 10, remaining: 5, reset: 1_788_274_030, retryAfter: null }, now),
    null,
    "레이트리밋이 아닌 403 을 기다렸다 재시도하면 같은 실패만 3번 반복한다"
  );
  assert.equal(
    rateLimitWaitMs({ limit: null, remaining: null, reset: null, retryAfter: 20 }, now),
    20_000,
    "2차 리밋의 Retry-After 는 그대로 따른다"
  );
  assert.equal(
    rateLimitWaitMs({ limit: 10, remaining: 0, reset: 9_999_999_999, retryAfter: null }, now),
    120_000,
    "시계가 어긋나도 상한(2분)을 넘겨 자지 않는다"
  );
});

// ── 수집 루프 ──

/** 응답 1건을 흉내 내는 최소 Response. fetch 를 통째로 갈아끼우기 위한 것이다. */
function fakeRes(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

test("레이트리밋(403 + remaining:0)을 만나면 대기 후 재시도해 결과를 살린다", async () => {
  const slept: number[] = [];
  let calls = 0;
  const result = await collectSkillRepos(
    {
      fetchFn: async () => {
        calls += 1;
        if (calls === 1) {
          return fakeRes(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1788274030" });
        }
        return fakeRes(200, REAL_BODY, { "x-ratelimit-remaining": "9", "x-ratelimit-limit": "10" });
      },
      sleep: async (ms) => {
        slept.push(ms);
      },
      now: () => 1_788_274_000_000,
      token: "",
    },
    ["agent-skills"],
    1
  );
  assert.equal(calls, 2, "리밋 응답 뒤 한 번 더 호출해야 한다");
  assert.ok(slept.includes(31_000), `reset 까지 대기해야 한다 (실제 ${slept.join(",")})`);
  assert.equal(result.repos.length, 3);
  assert.equal(result.pagesOk, 1);
});

test("일부 topic 이 죽어도 부분 결과 + 경고로 흡수한다", async () => {
  const result = await collectSkillRepos(
    {
      fetchFn: async (url) => {
        // URLSearchParams 가 "topic:dead" 를 "topic%3Adead" 로 인코딩하므로 되돌려서 본다.
        if (decodeURIComponent(String(url)).includes("topic:dead")) throw new Error("ECONNRESET");
        return fakeRes(200, REAL_BODY, {});
      },
      sleep: async () => {},
      now: () => 0,
      token: "",
    },
    ["dead", "agent-skills"],
    1
  );
  assert.equal(result.repos.length, 3, "살아 있는 topic 의 결과는 그대로 살린다");
  assert.equal(result.pagesOk, 1);
  assert.equal(result.pagesTried, 2);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /ECONNRESET/);
});

test("최종 0건이면 던진다 — 빈 스냅샷이 '수집됨'으로 읽히면 그 주 재시도가 봉인된다", async () => {
  await assert.rejects(
    () =>
      collectSkillRepos(
        {
          fetchFn: async () => fakeRes(500, {}, {}),
          sleep: async () => {},
          now: () => 0,
          token: "",
        },
        ["agent-skills"],
        1
      ),
    /0건/
  );
});

test("GITHUB_TOKEN 이 있으면 Authorization 헤더를 붙이고, 없으면 붙이지 않는다", async () => {
  const seen: Array<Record<string, string>> = [];
  const grab = async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push(init?.headers ?? {});
    return fakeRes(200, REAL_BODY, {});
  };

  await collectSkillRepos(
    { fetchFn: grab as unknown as typeof fetch, sleep: async () => {}, now: () => 0, token: "ghp_x" },
    ["agent-skills"],
    1
  );
  assert.equal(seen[0].Authorization, "Bearer ghp_x");

  await collectSkillRepos(
    { fetchFn: grab as unknown as typeof fetch, sleep: async () => {}, now: () => 0, token: "" },
    ["agent-skills"],
    1
  );
  assert.equal(seen[1].Authorization, undefined, "무인증도 정상 경로다");
});
