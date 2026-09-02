import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachAccess,
  decideAccessKind,
  detectSignals,
  frontMatter,
  pickSkillPaths,
  sampleEvenly,
  scanRepo,
  scanRepos,
  SCAN_SIGNATURE_VERSION,
  unitName,
} from "./scan.ts";
import type { SkillRankEntry, SkillRepo } from "../../shared/skills.ts";

/**
 * 네트워크 접근 스캐너 회귀 테스트.
 *
 * ★ 이 파일이 지키는 것은 **비대칭 판정** 하나다.
 *   신호를 찾으면 확정(표본이어도 참), 못 찾은 것은 없다는 증거가 아니다.
 *   그래서 "표본 0건이 local 로 승격되지 않는다"가 이 파일의 제1 테스트다 —
 *   6,632개 중 40개만 보고 "로컬 전용"이라 적으면 사용자가 그 태그를 믿고
 *   외부로 나가는 스킬을 돌린다. 태그는 사실처럼 읽히므로 틀릴 권리가 없다.
 */

// ── ★★ 비대칭 판정 (이 파일의 핵심) ──

test("표본 검사에서 신호 0건은 local 이 아니라 local-sampled 다", () => {
  // 864개 중 40개만 보고 신호가 없었다 — "없다"고 말할 근거가 되지 않는다.
  assert.equal(
    decideAccessKind({ treeOk: true, total: 864, checked: 40, network: 0 }),
    "local-sampled"
  );
  // 한 개만 덜 봐도 마찬가지다. 경계에서 슬그머니 승격되면 안 된다.
  assert.equal(decideAccessKind({ treeOk: true, total: 41, checked: 40, network: 0 }), "local-sampled");
});

test("전수 검사에서 신호 0건이어야만 local 로 단정한다", () => {
  assert.equal(decideAccessKind({ treeOk: true, total: 13, checked: 13, network: 0 }), "local");
  assert.equal(decideAccessKind({ treeOk: true, total: 1, checked: 1, network: 0 }), "local");
});

test("신호를 찾으면 표본이어도 확정이다 — 전부면 external, 일부면 partial", () => {
  // 20개만 봤지만 그중 20개 전부에서 나왔다. "찾았다"는 사실은 표본이어도 참이다.
  assert.equal(decideAccessKind({ treeOk: true, total: 900, checked: 20, network: 20 }), "external");
  assert.equal(decideAccessKind({ treeOk: true, total: 900, checked: 20, network: 2 }), "partial");
  assert.equal(decideAccessKind({ treeOk: true, total: 20, checked: 20, network: 1 }), "partial");
});

test("SKILL.md 0개는 no-skill, 트리 조회 실패는 unknown 이다(둘을 섞지 않는다)", () => {
  // 트리를 봤는데 SKILL.md 가 없다 = awesome 목록·도구 저장소.
  assert.equal(decideAccessKind({ treeOk: true, total: 0, checked: 0, network: 0 }), "no-skill");
  // 트리를 못 봤다 = 아무것도 모른다. total 0 이 'SKILL.md 가 없다'는 뜻이 아니다.
  assert.equal(decideAccessKind({ treeOk: false, total: 0, checked: 0, network: 0 }), "unknown");
});

test("SKILL.md 는 있는데 한 건도 못 읽었으면 unknown 이다 — 로컬로 접지 않는다", () => {
  assert.equal(decideAccessKind({ treeOk: true, total: 12, checked: 0, network: 0 }), "unknown");
});

// ── 신호 검출 ──

test("에이전트 도구·셸 호출·HTTP 라이브러리를 검출한다", () => {
  assert.deepEqual(detectSignals("Use the WebFetch tool to read the page."), ["WebFetch"]);
  assert.deepEqual(detectSignals("allowed-tools: WebSearch, Read"), ["WebSearch"]);
  assert.ok(detectSignals("```bash\ncurl -s https://example.com\n```").includes("curl"));
  assert.ok(detectSignals("run `wget https://a.b/c`").includes("wget"));
  assert.ok(detectSignals('const r = await fetch("https://x.dev/v1")').includes("fetch()"));
  assert.ok(detectSignals("requests.get(url, timeout=5)").includes("requests"));
  assert.ok(detectSignals("httpx.Client(base_url=BASE)").includes("httpx"));
  assert.ok(detectSignals("import axios from 'axios'").includes("axios"));
  assert.ok(detectSignals("urllib.request.urlopen(u)").includes("urllib"));
  assert.ok(detectSignals("POST https://api.github.com/graphql").includes("api호스트"));
  assert.ok(detectSignals("mcp__playwright__browser_click").includes("MCP"));
  assert.ok(detectSignals('"mcpServers": {}').includes("MCP"));
});

test("★ 산문 속 참고 링크는 신호가 아니다 — 문서에 URL 이 있다고 외부 접근이 아니다", () => {
  const doc = [
    "# Brand Guidelines",
    "",
    "자세한 내용은 https://github.com/anthropics/skills 와",
    "https://docs.example.com/brand 를 참고하세요.",
    "![badge](https://img.shields.io/badge/x-y-blue)",
    "이 스킬은 로컬 파일만 편집합니다.",
  ].join("\n");
  assert.deepEqual(detectSignals(doc), [], "맨 URL 만으로 external 이 되면 태그가 거짓말이 된다");
});

test("산문 속 도구 이름 언급도 그대로 신호로 본다(과탐이 아니라 보수적 판정이다)", () => {
  // '못 찾은 것'만 조심하면 된다. 찾은 쪽으로 기우는 오차는 태그를 거짓말로 만들지 않는다.
  assert.deepEqual(detectSignals("이 스킬은 WebFetch 를 쓰지 않습니다."), ["WebFetch"]);
});

test("curl 은 옵션이 붙은 실제 호출 형태만 잡는다", () => {
  assert.deepEqual(detectSignals("curl 로도 같은 일을 할 수 있습니다."), []);
  assert.ok(detectSignals("curl -X POST /x").includes("curl"));
});

// ── ★ 외부 서비스 CLI (위음성 보완) ──

test("★ 외부 서비스 CLI 호출을 신호로 잡는다 — 본문에 URL 이 없어도 원격으로 나간다", () => {
  // googleworkspace/cli 의 gws 가 실제 사례다. SKILL.md 에 curl·fetch·URL 이 한 줄도 없어
  // 기존 신호로는 0건 → 'local' 로 단정됐다. 🔒 로컬 을 믿고 원격 서비스를 치게 되는 오류다.
  assert.deepEqual(detectSignals("gws mail list --max 10"), ["외부CLI(gws)"]);
  assert.deepEqual(detectSignals("```bash\ngh pr create --fill\n```"), ["외부CLI(gh)"]);
  assert.deepEqual(detectSignals("실행: `gh pr create` 하면 된다"), ["외부CLI(gh)"]);
  // 줄머리 변형 — 들여쓰기·셸 프롬프트·파이프라인 뒤·npx 러너.
  assert.ok(detectSignals("    kubectl get pods").includes("외부CLI(kubectl)"));
  assert.ok(detectSignals("$ gcloud auth login").includes("외부CLI(gcloud)"));
  assert.ok(detectSignals("cd app && flyctl deploy").includes("외부CLI(flyctl)"));
  assert.ok(detectSignals("npx wrangler deploy").includes("외부CLI(wrangler)"));
  assert.ok(detectSignals("- `stripe listen --forward-to localhost`").includes("외부CLI(stripe)"));
  assert.ok(detectSignals("sentry-cli releases new v1").includes("외부CLI(sentry-cli)"));
});

test("★ 설치·빌드 단계 명령은 신호가 아니다 — 스킬의 런타임 목적이 아니다", () => {
  // 이걸 잡으면 거의 모든 스킬이 '외부'로 물들어 태그가 정보를 잃는다.
  assert.deepEqual(detectSignals("npm install foo"), []);
  assert.deepEqual(detectSignals("pip install bar"), []);
  assert.deepEqual(detectSignals("brew install gh"), [], "설치 대상으로 적힌 CLI 이름도 호출이 아니다");
  assert.deepEqual(detectSignals("docker pull node:20"), []);
  assert.deepEqual(detectSignals("apt-get install -y jq"), []);
  assert.deepEqual(detectSignals("npm install -g @cloudflare/wrangler"), []);
});

test("★ 산문 속 CLI 언급은 신호가 아니다 — 명령 호출 형태여야 한다", () => {
  assert.deepEqual(detectSignals("gh 는 GitHub CLI 다"), []);
  assert.deepEqual(detectSignals("gh 를 쓰면 좋다"), []);
  assert.deepEqual(detectSignals("gh is the GitHub CLI."), [], "영어 설명문도 줄머리+소문자라 형태가 겹친다");
  assert.deepEqual(detectSignals("aws provides many services."), []);
  // 서브커맨드가 아예 없으면 호출로 보지 않는다.
  assert.deepEqual(detectSignals("vercel"), []);
  assert.deepEqual(detectSignals("`kubectl`"), []);
});

test("외부CLI 신호도 다른 신호와 동급으로 판정에 들어간다", () => {
  // 신호 이름만 다를 뿐, decideAccessKind 입장에서는 '신호가 나온 파일'일 뿐이다.
  const withCli = detectSignals("gws mail list");
  const withFetch = detectSignals("WebFetch 로 읽는다");
  assert.equal(withCli.length > 0, true);
  assert.equal(withFetch.length > 0, true);
  // 한 파일에서 여러 CLI 가 나오면 전부 남긴다(어떤 서비스였는지가 툴팁에 그대로 보인다).
  assert.deepEqual(detectSignals("gh pr list\naws s3 ls"), ["외부CLI(gh)", "외부CLI(aws)"]);
});

test("★ 기존 신호 없는 문서는 CLI 신호 추가 후에도 여전히 신호 0건이다(회귀)", () => {
  const doc = [
    "# Brand Guidelines",
    "",
    "회사 색상과 로고 사용 규칙을 로컬 문서에 적용합니다.",
    "설치: npm install -D prettier",
    "참고: https://example.com/brand",
  ].join("\n");
  assert.deepEqual(detectSignals(doc), [], "새 신호가 기존 local 판정을 흔들면 안 된다");
});

// ── ★ MCP 선언형 (위음성 — 이 기능이 막으려던 바로 그 오류) ──

/**
 * ComposioHQ/awesome-claude-skills(★74,204, SKILL.md 864개)의 실물 본문이다.
 * `mcp__`·`mcpServers` 만 보던 시절 이 파일은 신호 0건 → 🔒 로컬 로 표시됐다.
 * 원격 SaaS 로 나가는 것이 **존재 이유**인 스킬이므로 이 기능에서 가장 나쁜 오류다.
 */
const COMPOSIO_SKILL = [
  "---",
  "name: affinda-automation",
  'description: "Automate Affinda tasks via Rube MCP (Composio)."',
  "requires:",
  "  mcp: [rube]",
  "---",
  "",
  "**Get Rube MCP**: Add `https://rube.app/mcp` as an MCP server in your client configuration.",
  "",
  "Call `RUBE_SEARCH_TOOLS` first to get current tool schemas.",
].join("\n");

test("★ frontmatter 의 mcp 선언과 원격 /mcp 엔드포인트를 잡는다 (Composio 위음성)", () => {
  const signals = detectSignals(COMPOSIO_SKILL);
  assert.ok(signals.includes("MCP(선언)"), "requires: 아래의 mcp 키가 선언이다");
  assert.ok(signals.includes("MCP(원격)"), "https://rube.app/mcp 는 원격 엔드포인트다");
  // frontmatter 선언만 있고 URL 이 없어도 신호는 남아야 한다.
  assert.deepEqual(detectSignals("---\nrequires:\n  mcp: [rube]\n---\n로컬 파일만 만진다."), [
    "MCP(선언)",
  ]);
  // 반대로 URL 만 있어도 잡힌다(frontmatter 가 아예 없는 파일이 실제로 있다).
  assert.deepEqual(detectSignals("Add https://rube.app/mcp as an MCP server."), ["MCP(원격)"]);
});

test("기존 mcp__ / mcpServers 신호는 그대로 남는다(이름 'MCP')", () => {
  assert.deepEqual(detectSignals("mcp__playwright__browser_click"), ["MCP"]);
  assert.deepEqual(detectSignals('"mcpServers": {}'), ["MCP"]);
});

test("★ 산문 속 MCP 언급은 선언이 아니다 — frontmatter 로 범위를 좁힌다", () => {
  // 본문에 "MCP:" 로 시작하는 설명 줄이 있어도 선언으로 세지 않는다.
  assert.deepEqual(detectSignals("## MCP\nMCP: Model Context Protocol 을 설명한다."), []);
  assert.deepEqual(detectSignals("about the MCP protocol in general"), []);
  assert.deepEqual(detectSignals("npm install @modelcontextprotocol/inspector"), []);
  // 이름에 mcp 가 든 스킬(mcp-builder)도 선언이 아니다 — 키가 name 이지 mcp 가 아니다.
  assert.deepEqual(detectSignals("---\nname: mcp-builder\n---\n로컬에서 서버를 만든다."), []);
});

test("★ 로컬 stdio MCP 서버는 원격 신호로 몰지 않는다", () => {
  // command/args 로 로컬 프로세스를 띄우는 형태에는 URL 이 없다 → MCP(원격) 이 붙으면 안 된다.
  const stdio = ['{ "command": "node", "args": ["./server.js"] }', "npx -y @scope/my-mcp-server"].join(
    "\n"
  );
  assert.ok(!detectSignals(stdio).includes("MCP(원격)"));
  // 루프백으로 붙는 MCP 서버도 원격이 아니다.
  assert.ok(!detectSignals("http://localhost:3000/mcp").includes("MCP(원격)"));
  assert.ok(!detectSignals("http://127.0.0.1:8080/mcp").includes("MCP(원격)"));
});

test("★ MCP 문서 링크는 엔드포인트가 아니다 — 산문 속 맨 URL 규칙 그대로다", () => {
  assert.deepEqual(detectSignals("자세한 내용은 https://docs.claude.com/en/docs/mcp 참고"), []);
  assert.deepEqual(detectSignals("https://modelcontextprotocol.io/mcp 를 읽어라"), []);
  assert.deepEqual(detectSignals("https://github.com/anthropics/mcp 저장소"), []);
});

// ── ★ 위양성 2종 (실측 파일 기준) ──

test("★ `curl … | sh` 설치 안내는 신호가 아니다 — npm/pip install 을 빼는 규약의 셸 판본이다", () => {
  // 실측: github/awesome-copilot 의 skills/aspire/SKILL.md
  assert.deepEqual(detectSignals("curl -sSL https://aspire.dev/install.sh | bash"), []);
  assert.deepEqual(detectSignals("curl -fsSL https://get.x.dev | sh"), []);
  assert.deepEqual(detectSignals("wget -qO- https://get.x.dev/install | sudo bash"), []);
  // ⚠️ 같은 파일에 진짜 호출이 따로 있으면 신호는 그대로 남는다(빼는 것은 '그 줄'이다).
  const mixed = ["curl -sSL https://aspire.dev/install.sh | bash", "curl -X POST /v1/items"].join("\n");
  assert.ok(detectSignals(mixed).includes("curl"));
});

test("★ 예약 예시 도메인은 api 호스트가 아니다 — 아무도 그 주소를 서비스하지 않는다", () => {
  // 실측 2건: wshobson/agents 의 nextjs-app-router-patterns, github/awesome-copilot 의 openapi-…
  assert.deepEqual(detectSignals("const res = await fetch('https://api.example.com/products', {"), []);
  assert.deepEqual(detectSignals("- A URL to the spec (e.g., `https://api.example.com/openapi.json`)"), []);
  assert.deepEqual(detectSignals("https://api.your-domain.com/v1 로 바꿔 쓰세요"), []);
  assert.deepEqual(detectSignals("http://localhost:3000/api/health"), []);
  // 진짜 api 호스트는 그대로 잡힌다(위양성 제거가 위음성을 만들면 안 된다).
  assert.ok(detectSignals("POST https://api.github.com/graphql").includes("api호스트"));
  assert.ok(detectSignals('fetch("https://api.openai.com/v1")').includes("fetch()"));
});

test("frontMatter 는 머리 YAML 블록만 돌려준다(없으면 빈 문자열)", () => {
  assert.equal(frontMatter("---\nname: a\nmcp: [x]\n---\n본문"), "name: a\nmcp: [x]");
  assert.equal(frontMatter("본문만 있는 파일"), "");
  // 닫는 구분선이 없으면 frontmatter 가 아니다 — 본문을 통째로 훑지 않는다.
  assert.equal(frontMatter("---\nname: a\n본문"), "");
});

// ── ★ 신호 정의 버전 (캐시 무효화) ──

test("★ 신호 정의 버전은 결정적이고 개정 번호를 담는다", () => {
  assert.match(SCAN_SIGNATURE_VERSION, /^v2-[0-9a-f]{8}$/);
  // 같은 프로세스에서 두 번 읽어도 같다(캐시 키라 흔들리면 매주 전수 재스캔이 된다).
  assert.equal(SCAN_SIGNATURE_VERSION, SCAN_SIGNATURE_VERSION);
});

// ── 트리 → 경로·이름·표본 ──

test("트리에서 SKILL.md blob 만 사전순으로 고른다(대소문자 무시, 디렉터리 제외)", () => {
  const paths = pickSkillPaths({
    tree: [
      { path: "skills/zeta/SKILL.md", type: "blob" },
      { path: "skills/alpha/SKILL.md", type: "blob" },
      { path: "skills/alpha", type: "tree" },
      { path: "README.md", type: "blob" },
      { path: "docs/SKILL.md.bak", type: "blob" },
      { path: "legacy/skill.md", type: "blob" },
    ],
  });
  assert.deepEqual(paths, ["legacy/skill.md", "skills/alpha/SKILL.md", "skills/zeta/SKILL.md"]);
});

test("이름은 SKILL.md 가 든 디렉터리명, 루트면 저장소 이름이다", () => {
  assert.equal(unitName("skills/claude-api/SKILL.md", "skills"), "claude-api");
  assert.equal(unitName("SKILL.md", "ponytail"), "ponytail");
});

test("표본은 앞에서 자르지 않고 고르게 뽑는다 — 한 디렉터리만 보면 표본이 무의미하다", () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  const sample = sampleEvenly(items, 4);
  assert.deepEqual(sample, [0, 25, 50, 75]);
  // cap 이상이면 전부 그대로(전수 검사가 성립해야 local 로 단정할 수 있다).
  assert.deepEqual(sampleEvenly([1, 2, 3], 40), [1, 2, 3]);
});

test("같은 입력이면 같은 표본이다(결정적) — 캐시·재현성이 여기에 걸려 있다", () => {
  const items = Array.from({ length: 500 }, (_, i) => `f${i}`);
  assert.deepEqual(sampleEvenly(items, 40), sampleEvenly(items, 40));
});

// ── scanRepo (가짜 네트워크) ──

function repo(over: Partial<SkillRepo> = {}): SkillRepo {
  return {
    id: 1,
    fullName: "acme/skills",
    owner: "acme",
    name: "skills",
    url: "https://github.com/acme/skills",
    description: null,
    summary: null,
    stars: 100,
    forks: 0,
    watchers: 0,
    openIssues: 0,
    language: null,
    license: null,
    topics: [],
    createdAt: "",
    pushedAt: "2026-09-01T00:00:00Z",
    archived: false,
    ...over,
  };
}

/** 트리 1건 + 파일 본문 맵을 흉내 내는 fetch. 브랜치는 main 만 존재한다고 본다. */
function fakeNet(files: Record<string, string>, opts: { branch?: string; truncated?: boolean } = {}) {
  const branch = opts.branch ?? "main";
  const calls: string[] = [];
  const fetchFn = async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/git/trees/")) {
      if (!url.includes(`/git/trees/${branch}?`)) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          truncated: opts.truncated === true,
          tree: Object.keys(files).map((p) => ({ path: p, type: "blob" })),
        }),
        { status: 200 }
      );
    }
    const path = url.split(`/${branch}/`)[1] ?? "";
    const body = files[decodeURIComponent(path)];
    if (body === undefined) return new Response("Not Found", { status: 404 });
    return new Response(body, { status: 200 });
  };
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

const fast = {
  sleep: async () => {},
  token: "",
  timeoutMs: 50,
  repoConcurrency: 2,
  fileConcurrency: 2,
  // 테스트는 잔량 조회를 하지 않는다(가짜 fetch 를 한 번 더 두드리지 않게).
  checkQuota: false,
};

test("전부 신호가 있으면 external, 링크만 있는 문서는 신호로 세지 않는다", async () => {
  const net = fakeNet({
    "skills/a/SKILL.md": "Use WebFetch to load the page.",
    "skills/b/SKILL.md": "```bash\ncurl -s https://api.x.dev/v1\n```",
  });
  const r = await scanRepo(repo(), { ...fast, ...net });
  assert.equal(r.access.kind, "external");
  assert.equal(r.access.total, 2);
  assert.equal(r.access.checked, 2);
  assert.equal(r.access.network, 2);
  assert.deepEqual(r.units.map((u) => u.name), ["a", "b"]);
  assert.equal(r.units[0].url, "https://github.com/acme/skills/blob/main/skills/a/SKILL.md");
});

test("일부만 신호가 있으면 partial 이다", async () => {
  const net = fakeNet({
    "skills/a/SKILL.md": "WebSearch 로 찾는다",
    "skills/b/SKILL.md": "로컬 파일만 만진다. 참고: https://example.com/doc",
  });
  const r = await scanRepo(repo(), { ...fast, ...net });
  assert.equal(r.access.kind, "partial");
  assert.equal(r.access.network, 1);
  assert.deepEqual(r.units[1].signals, [], "산문 링크는 신호가 아니다");
});

test("전수 검사에서 신호 0건이면 local 이다", async () => {
  const net = fakeNet({ "a/SKILL.md": "로컬만", "b/SKILL.md": "역시 로컬" });
  const r = await scanRepo(repo(), { ...fast, ...net });
  assert.equal(r.access.kind, "local");
  assert.equal(r.access.checked, r.access.total);
});

test("★ cap 으로 잘린 표본에서 신호가 0건이면 local 이 아니라 local-sampled 다", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 50; i++) files[`s${String(i).padStart(3, "0")}/SKILL.md`] = "로컬만 만진다";
  const net = fakeNet(files);
  const r = await scanRepo(repo(), { ...fast, ...net, cap: 5 });
  assert.equal(r.access.kind, "local-sampled");
  assert.equal(r.access.total, 50);
  assert.equal(r.access.checked, 5);
  assert.equal(r.units.length, 5, "units 는 표본만 담는다");
});

test("트리가 잘렸으면(truncated) 전수로 단정하지 않는다", async () => {
  const net = fakeNet({ "a/SKILL.md": "로컬만" }, { truncated: true });
  const r = await scanRepo(repo(), { ...fast, ...net });
  assert.equal(r.access.kind, "local-sampled", "본 목록이 전부가 아니므로 local 단정은 거짓말이다");
});

test("SKILL.md 가 하나도 없으면 no-skill 이다(awesome 목록 저장소)", async () => {
  const net = fakeNet({});
  const r = await scanRepo(repo(), { ...fast, ...net });
  assert.equal(r.access.kind, "no-skill");
  assert.deepEqual(r.units, []);
});

test("기본 브랜치를 모르면 main → master 순으로 시도한다(폴백)", async () => {
  const net = fakeNet({ "a/SKILL.md": "WebFetch" }, { branch: "master" });
  const r = await scanRepo(repo(), { ...fast, ...net });
  assert.equal(r.branch, "master");
  assert.equal(r.access.kind, "external");
  assert.ok(net.calls.some((u) => u.includes("/git/trees/main?")), "main 을 먼저 시도한다");
});

test("★ 기본 브랜치를 알면 그것만 본다 — 낡은 main 이 남아 있어도 읽지 않는다", async () => {
  // 실측 사례: code-yeongyu/oh-my-openagent 의 기본 브랜치는 dev 인데 낡은 master 가 남아 있어
  // 조회는 성공했고, 그래서 **다른 파일로 판정한 것을 아무도 몰랐다.**
  const net = fakeNet({ "a/SKILL.md": "WebFetch" }, { branch: "dev" });
  const r = await scanRepo(repo(), { ...fast, ...net, defaultBranch: () => "dev" });
  assert.equal(r.branch, "dev");
  assert.equal(r.access.kind, "external");
  const trees = net.calls.filter((u) => u.includes("/git/trees/"));
  assert.equal(trees.length, 1, "트리 호출은 저장소당 1회로 준다(쿼터도 함께 아낀다)");
  assert.ok(trees[0].includes("/git/trees/dev?"));
  assert.ok(r.units[0].url.includes("/blob/dev/"), "펼침 링크도 기본 브랜치를 가리켜야 한다");
});

test("트리 조회가 전부 실패하면 unknown 이다 — '로컬'이 아니다", async () => {
  const r = await scanRepo(repo(), {
    ...fast,
    fetchFn: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
  });
  assert.equal(r.access.kind, "unknown");
  assert.equal(r.access.total, 0);
});

test("파일을 하나도 못 읽으면 unknown 이다 — 신호 0건으로 세지 않는다", async () => {
  const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("/git/trees/main?")) {
      return new Response(JSON.stringify({ tree: [{ path: "a/SKILL.md", type: "blob" }] }), {
        status: 200,
      });
    }
    return new Response("nope", { status: 503 }); // raw 만 죽었다
  }) as unknown as typeof fetch;
  const r = await scanRepo(repo(), { ...fast, fetchFn });
  assert.equal(r.access.kind, "unknown");
  assert.equal(r.access.total, 1);
  assert.equal(r.access.checked, 0);
});

test("레이트리밋(403)은 브랜치를 바꿔 재시도하지 않는다 — 쿼터를 두 번 태우지 않는다", async () => {
  const calls: string[] = [];
  const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return new Response("rate limited", { status: 403 });
  }) as unknown as typeof fetch;
  const r = await scanRepo(repo(), { ...fast, fetchFn });
  assert.equal(r.rateLimited, true);
  assert.equal(r.access.kind, "unknown");
  assert.equal(calls.length, 1, "master 로 다시 시도하지 않는다");
});

// ── scanRepos (캐시·레이트리밋·집계) ──

test("캐시가 맞으면 트리를 조회하지 않는다(유일한 core 쿼터 소비 지점을 아낀다)", async () => {
  const net = fakeNet({ "a/SKILL.md": "WebFetch" });
  const cachedAccess = { kind: "local" as const, total: 3, checked: 3, network: 0, signals: [] };
  const s = await scanRepos(
    [repo({ id: 1 }), repo({ id: 2, fullName: "acme/other" })],
    (r) =>
      r.id === 1
        ? { repoId: 1, fullName: r.fullName, branch: null, access: cachedAccess, units: [] }
        : null,
    { ...fast, ...net }
  );
  assert.equal(s.cached, 1);
  assert.equal(s.fetched, 1);
  assert.equal(s.scans.get(1)!.access.kind, "local");
  assert.equal(net.calls.filter((u) => u.includes("/git/trees/")).length, 1, "캐시 적중분은 호출하지 않는다");
});

test("레이트리밋에 걸리면 남은 저장소는 unknown 으로 두고 즉시 접는다", async () => {
  let trees = 0;
  const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes("/git/trees/")) {
      trees += 1;
      return new Response("rate limited", { status: 403 });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const repos = Array.from({ length: 6 }, (_, i) => repo({ id: i + 1, fullName: `acme/r${i}` }));
  const s = await scanRepos(repos, () => null, { ...fast, fetchFn, repoConcurrency: 1 });
  assert.equal(s.skipped, 6);
  assert.equal(s.fetched, 0);
  assert.equal(trees, 1, "한 번 막히면 나머지는 두드리지 않는다(창 리셋을 기다리지 않는다)");
  for (const scan of s.scans.values()) assert.equal(scan.access.kind, "unknown");
});

// ── ★ 쿼터 예산 (모자라면 '모른다'로 두고 회차는 완주한다) ──

/** /rate_limit 에 core 잔량을 실어 주는 가짜 네트워크. 트리·raw 는 files 로 응답한다. */
function fakeNetWithQuota(files: Record<string, string>, remaining: number) {
  const base = fakeNet(files);
  const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("/rate_limit")) {
      base.calls.push(url);
      return new Response(JSON.stringify({ resources: { core: { remaining } } }), { status: 200 });
    }
    return base.fetchFn(input);
  }) as unknown as typeof fetch;
  return { fetchFn, calls: base.calls };
}

test("★ core 예산이 모자라면 남은 저장소는 unknown 이다 — 절대 local 이 아니다", async () => {
  const net = fakeNetWithQuota({ "a/SKILL.md": "로컬만 만진다" }, 5);
  const repos = Array.from({ length: 6 }, (_, i) => repo({ id: i + 1, fullName: `acme/r${i}` }));
  const s = await scanRepos(repos, () => null, {
    ...fast,
    ...net,
    checkQuota: true,
    quotaReserve: 3, // 잔량 5 - 여유 3 = 예산 2건
    defaultBranch: () => "main", // 저장소당 1회
    repoConcurrency: 1,
  });
  assert.equal(s.fetched, 2, "예산만큼만 새로 조회한다");
  assert.equal(s.budgetSkipped, 4);
  assert.equal(s.coreRemaining, 5);
  assert.equal(net.calls.filter((u) => u.includes("/git/trees/")).length, 2);
  // ★ 예산 부족은 "신호가 없다"가 아니다. 안 본 저장소가 로컬로 굳으면 태그가 거짓말이 된다.
  for (const id of [3, 4, 5, 6]) assert.equal(s.scans.get(id)!.access.kind, "unknown");
  // 예산 안의 것은 정상 판정된다(전수 검사라 local 로 단정해도 참이다).
  assert.equal(s.scans.get(1)!.access.kind, "local");
});

test("잔량을 못 읽으면 예산 절삭을 하지 않는다(기존 403 접기가 안전망이다)", async () => {
  const net = fakeNet({ "a/SKILL.md": "로컬만" }); // /rate_limit 은 404 로 떨어진다
  const repos = Array.from({ length: 3 }, (_, i) => repo({ id: i + 1, fullName: `acme/r${i}` }));
  const s = await scanRepos(repos, () => null, { ...fast, ...net, checkQuota: true });
  assert.equal(s.budgetSkipped, 0);
  assert.equal(s.coreRemaining, null);
  assert.equal(s.fetched, 3);
});

test("캐시로 다 채워지면 잔량 조회조차 하지 않는다", async () => {
  const net = fakeNetWithQuota({ "a/SKILL.md": "로컬만" }, 1);
  const cachedAccess = { kind: "local" as const, total: 1, checked: 1, network: 0, signals: [] };
  const s = await scanRepos(
    [repo({ id: 1 })],
    (r) => ({ repoId: r.id, fullName: r.fullName, branch: null, access: cachedAccess, units: [] }),
    { ...fast, ...net, checkQuota: true }
  );
  assert.equal(s.cached, 1);
  assert.equal(s.coreRemaining, null);
  assert.equal(net.calls.length, 0, "새로 볼 것이 없으면 네트워크를 아예 안 두드린다");
});

// ── attachAccess ──

test("스캔 결과가 있는 항목에만 access/units 를 붙인다(원본은 변형하지 않는다)", () => {
  const a = repo({ id: 1 });
  const b = repo({ id: 2, fullName: "acme/b" });
  const entries: SkillRankEntry[] = [
    { rank: 1, repo: a, prevRank: null, starsGained: null },
    { rank: 2, repo: b, prevRank: null, starsGained: null },
  ];
  const out = attachAccess(
    entries,
    new Map([
      [
        1,
        {
          repoId: 1,
          fullName: "acme/skills",
          branch: "main",
          access: { kind: "external" as const, total: 2, checked: 2, network: 2, signals: ["WebFetch"] },
          units: [{ name: "a", path: "a/SKILL.md", url: "u", signals: ["WebFetch"] }],
        },
      ],
    ])
  );
  assert.equal(out[0].repo.access!.kind, "external");
  assert.equal(out[0].repo.units!.length, 1);
  // 스캔이 없으면 access 를 아예 넣지 않는다 — 화면은 없으면 칩을 그리지 않는다.
  assert.equal(out[1].repo.access, undefined);
  assert.equal(a.access, undefined, "원본 SkillRepo 는 그대로다");
});
