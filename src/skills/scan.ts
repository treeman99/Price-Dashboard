import { createHash } from "node:crypto";
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
 *
 * ── 신호 정의를 바꾸면 캐시가 저절로 무효화된다 ─────────────────────────────
 * 스캔 캐시(skill_scans)의 키는 `pushed_at` **과 `SCAN_SIGNATURE_VERSION`** 이다. 예전에는
 * pushed_at 만 봐서, 신호를 고쳐도 그 저장소가 다시 푸시될 때까지 옛 판정이 그대로 나왔다
 * (= 이 파일을 고치는 일 자체가 반영되지 않았다). 지금은 신호표가 바뀌면 버전 문자열이 바뀌고
 * 캐시가 통째로 미스가 되므로, 손으로 `DELETE FROM skill_scans;` 를 칠 일이 없다.
 *
 * ── 쿼터: GITHUB_TOKEN 을 넣으면 이 절 전체가 사라진다 ──────────────────────
 * 트리 호출은 core 버킷을 쓰고 **무인증은 60회/시간**이다. 노출 후보가 byStars TOP 50 ∪
 * byGrowth TOP 50 이라 첫 회차부터 창에 닿는다(실측 57/60). 그래서 스캔 시작 전에
 * `GET /rate_limit`(이 호출 자체는 쿼터를 쓰지 않는다) 으로 잔량을 보고 **예산 안에서만**
 * 새로 조회하고, 못 본 저장소는 `unknown` 으로 둔 채 회차를 정상 종료한다.
 *   ★ 예산이 모자라다고 `local` 로 떨어뜨리지 않는다. "모른다"와 "로컬"은 다른 말이다.
 * `.env` 에 **GITHUB_TOKEN 을 넣으면 한도가 5000회/시간**이 되어 예산 절삭이 사실상 발동하지
 * 않는다(default_branch 를 쓰는 지금 첫 회차 비용이 50회이므로 1% 남짓이다).
 */

// ── 신호 ────────────────────────────────────────────────

/**
 * 원격 서비스와 통신하는 것이 **존재 이유**인 CLI 목록.
 *
 * ★ 위음성(false negative)을 막으려고 넣었다. googleworkspace/cli 의 `gws` 처럼 외부 서비스
 *   CLI 를 감싸기만 하는 스킬은 SKILL.md 본문에 curl·fetch·URL 이 한 줄도 없다. 아래 NETWORK_SIGNALS
 *   만으로는 신호 0건 → `local` 로 단정되고, 사용자는 🔒 로컬 을 믿은 채 원격 서비스를 치는 스킬을
 *   돌린다. 이 기능에서 가장 나쁜 오류라 여기에 별도 갈래를 둔다.
 *   (실측: 이 목록을 넣기 전 googleworkspace/cli 는 `local-sampled` 였고, 넣은 뒤 40/40 건에서
 *    `gws` 호출이 잡혀 `external` 로 바뀌었다 — 2026-09-02 실제 저장소 재스캔.)
 *
 * ⚠️ **런타임 목적이 원격 통신인 것만 넣는다.** npm/pip/brew install, docker pull, git clone,
 *    apt-get 은 네트워크를 쓰지만 **설치·빌드 단계**일 뿐 스킬이 하는 일이 아니다. 그것까지
 *    잡으면 거의 모든 스킬이 외부로 물들어 태그가 정보를 잃는다.
 */
export const EXTERNAL_CLIS = [
  "gh",
  "gws",
  "aws",
  "gcloud",
  "az",
  "kubectl",
  "heroku",
  "vercel",
  "netlify",
  "supabase",
  "stripe",
  "firebase",
  "doctl",
  "flyctl",
  "railway",
  "wrangler",
  "twilio",
  "sentry-cli",
  "openai",
  "hf",
] as const;

/**
 * CLI 이름 뒤에 오는 토큰이 이것들이면 **호출이 아니라 산문**으로 본다.
 *
 * "gh is the GitHub CLI" 같은 영어 설명문은 줄머리 + 소문자 단어라 명령 호출과 형태가 같다.
 * 흔한 기능어만 잘라 내면 그 겹침이 거의 사라진다(한국어 조사는 `[a-z]` 에 안 걸려 애초에 무해).
 */
const CLI_PROSE_WORDS = [
  "is", "are", "was", "were", "be", "can", "could", "will", "would", "should", "must", "may",
  "and", "or", "but", "to", "the", "a", "an", "for", "with", "from", "in", "on", "at", "by", "of",
  "has", "have", "had", "does", "do", "did", "not", "no", "also", "then", "so", "such", "that",
  "this", "it", "its", "you", "we", "which", "when", "if", "only", "just",
  "use", "uses", "used", "using", "provide", "provides", "require", "requires", "support",
  "supports", "allow", "allows", "lets", "need", "needs", "work", "works", "means", "stands",
  "refers", "command", "commands", "cli", "tool", "tools",
].join("|");

/**
 * `<cli> <서브커맨드>` **명령 호출 형태**만 잡는 정규식을 만든다.
 *
 * 시작점은 셋뿐이다 — 줄머리(들여쓰기·`$`/`>` 프롬프트 허용), 백틱(인라인 코드·코드펜스),
 * 파이프/`&&`/`;` 뒤(한 줄에 이어 붙인 명령). 그 다음에 `npx`/`bunx`/`uvx` 러너가 와도 된다.
 * 뒤에는 소문자로 시작하는 서브커맨드가 **반드시** 있어야 한다.
 *
 * 이 형태 제약이 전부다:
 *   "`gh pr create`" / "gws mail list" → 잡힌다.
 *   "gh 를 쓰면 좋다" / "npm install wrangler" / "pip install openai" → 안 잡힌다.
 *     (install 뒤의 이름은 줄머리도 백틱 뒤도 아니고, 뒤따르는 서브커맨드도 없다.)
 */
function cliCallRe(cli: string): RegExp {
  const start = "(?:^[ \\t]*(?:[$>][ \\t]+)?|`[ \\t]*|(?:&&|\\|\\||;|\\|)[ \\t]*)";
  const runner = "(?:(?:npx|bunx|uvx)[ \\t]+)?";
  const sub = `[ \\t]+(?!(?:${CLI_PROSE_WORDS})\\b)[a-z][a-z0-9:_-]*`;
  return new RegExp(start + runner + cli + sub, "m");
}

/**
 * 호스트 자리에 이 표식이 있으면 신호로 세지 않는 **가짜 호스트** lookahead.
 *
 * `https://api.example.com/products` 는 Next.js 패턴을 가르치는 **예제 코드**이지 이 스킬이
 * 부르는 곳이 아니다(실측 위양성 2건: wshobson/agents 의 nextjs-app-router-patterns,
 * github/awesome-copilot 의 openapi-to-application-code). example.com/.org/.net 은 RFC 2606
 * 예약 도메인이라 애초에 아무도 서비스하지 않고, 루프백과 `your-domain` 류는 자리표시자다.
 *
 * `://` 바로 뒤에 붙여 쓴다. `[a-z0-9.-]*` 가 호스트 안만 훑고(`/` 를 못 넘는다) 표식을 찾으면
 * 매치를 취소하므로, `https://api.your-domain.com` 처럼 표식이 호스트 **중간**에 있어도 걸러진다.
 */
const NOT_PLACEHOLDER_HOST =
  "(?![a-z0-9.-]*(?:example\\.(?:com|org|net)|your[-_]?(?:domain|site|host|server|api|company)|" +
  "my[-_]?domain|localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0)\\b)";

/**
 * `/mcp` 로 끝나지만 **읽을 문서**이지 붙을 서버가 아닌 호스트 lookahead.
 *
 * `https://docs.claude.com/en/docs/mcp` 같은 안내 링크까지 원격 엔드포인트로 세면, 이 파일이
 * 처음부터 지켜 온 "산문 속 맨 URL 은 신호가 아니다"를 스스로 깬다.
 */
const NOT_MCP_DOC_HOST =
  "(?!(?:[a-z0-9-]+\\.)*(?:github\\.com|gitlab\\.com|modelcontextprotocol\\.io|npmjs\\.com|" +
  "anthropic\\.com|claude\\.com|readthedocs\\.io)\\b)(?!docs?\\.)";

/**
 * `curl … | sh` 설치 관용구. **신호가 아니다.**
 *
 * 이 파일은 npm/pip/brew install·docker pull·apt-get 을 "설치·빌드 단계일 뿐 스킬이 하는 일이
 * 아니다"라며 이미 빼고 있는데, `curl -sSL https://…/install.sh | bash` 는 정확히 그 규약의
 * 셸 판본이다(실측 위양성: github/awesome-copilot 의 skills/aspire). 빼지 않으면 자기 규약과
 * 어긋난다.
 */
const SHELL_INSTALL_PIPE = /\|\s*(?:sudo\s+)?(?:ba|z|k|fi)?sh\b/;

/**
 * 런타임 네트워크 신호. 질문은 하나다 — **"이 스킬이 돌 때 네트워크로 나가는가."**
 *
 * ⚠️ **문서에 링크가 있다고 외부 접근이 아니다.** 산문 속 맨 URL(참고 문서 링크, 저장소
 *    주소, 배지 이미지)은 신호가 아니다. 그래서 `https?://` 를 통째로 잡지 않고, 호출 형태
 *    (curl -X / fetch("http…") / requests.get)와 api·graph 호스트만 좁게 잡는다.
 *    실측 분리: claude-api → WebFetch·WebSearch·curl 검출(정답) / brand-guidelines·docx·
 *    algorithmic-art → 신호 없음(정답).
 *
 * ⚠️ **반대쪽 오류(위음성)를 막는 갈래가 둘 있다.**
 *    1) EXTERNAL_CLIS — 외부 서비스 CLI 를 감싸기만 하는 스킬은 본문에 URL 도 HTTP 호출도 없다.
 *    2) MCP 계열 3종 — 원격 MCP 스킬은 **호출을 MCP 클라이언트가 대신하므로** 본문에 HTTP
 *       호출문이 아예 없다. `mcp__`/`mcpServers` 만 보던 시절 ComposioHQ/awesome-claude-skills
 *       (★74,204, SKILL.md 864개)의 표본 40건이 전부 신호 0건 → 🔒 로컬 로 표시됐다.
 *       실제 본문은 frontmatter `requires: mcp: [rube]` 와 `https://rube.app/mcp` 였다.
 *
 * ★ MCP 신호를 셋으로 나눈 이유는 **근거를 화면에 남기기 위해서**다. 원격 URL 은 확정이지만
 *   frontmatter 선언만으로는 로컬 stdio 서버(`command: node ./server.js`)일 수도 있다.
 *   이름을 나눠 두면 사용자가 툴팁에서 "무엇을 보고 그렇게 판정했는지"를 그대로 읽는다.
 */
export interface NetworkSignal {
  name: string;
  re: RegExp;
  /** "frontmatter" 면 파일 머리의 YAML 블록만 본다(산문에 적힌 같은 낱말과 섞이지 않게). */
  scope?: "frontmatter";
  /** 이 패턴에도 걸리는 줄은 신호로 세지 않는다(줄 단위로 판정한다 — 설치 안내 배제용). */
  skipLine?: RegExp;
}

export const NETWORK_SIGNALS: ReadonlyArray<NetworkSignal> = [
  // 에이전트 도구 이름. frontmatter 의 allowed-tools 에 적힌 것도 신호다 — "이 스킬은 웹을
  // 쓸 수 있다"는 선언 자체가 우리가 답하려는 질문의 답이다.
  { name: "WebFetch", re: /\bWebFetch\b/ },
  { name: "WebSearch", re: /\bWebSearch\b/ },
  // 셸 호출. `curl` 단어만으로는 산문("curl 로도 됩니다")과 구분이 안 되므로 옵션이 붙은
  // 실제 호출 형태만 잡는다. 줄머리·공백·코드펜스 백틱 뒤가 시작점이다.
  // 설치 관용구(`| sh`)가 붙은 줄은 뺀다 — 같은 파일에 진짜 호출이 따로 있으면 그 줄이 잡는다.
  { name: "curl", re: /(^|[\s`])curl\s+-/, skipLine: SHELL_INSTALL_PIPE },
  { name: "wget", re: /(^|[\s`])wget\s/, skipLine: SHELL_INSTALL_PIPE },
  // 코드 안의 HTTP 호출. 예제 도메인은 뺀다 — 교육용 코드조각은 런타임 행위가 아니다.
  { name: "fetch()", re: new RegExp(`\\bfetch\\(\\s*[\`'"]https?://${NOT_PLACEHOLDER_HOST}`) },
  { name: "requests", re: /\brequests\.(get|post|put)\b/ },
  { name: "httpx", re: /\bhttpx\.(get|post|Client)/ },
  { name: "axios", re: /\baxios\b/ },
  { name: "urllib", re: /\burllib\.request\b/ },
  // api·graph 호스트. 문서에 적혀 있어도 "이 스킬이 부르는 곳"일 확률이 압도적이다.
  // 단 예약 예시 도메인(api.example.com)은 그 확률이 0 이다.
  {
    name: "api호스트",
    re: new RegExp(`https?://${NOT_PLACEHOLDER_HOST}[a-z0-9.-]*(api|graph)\\.[a-z0-9.-]+`, "i"),
  },
  // ── MCP 3종 ──
  // 1) 도구 이름(mcp__x__y)·설정 키(mcpServers). 기존 신호 그대로다.
  { name: "MCP", re: /mcp__|mcpServers/ },
  // 2) frontmatter 선언. `requires:` 아래의 `mcp: [rube]` 가 실물이다. 산문에 "MCP" 라고 적은
  //    것과 섞이지 않게 **머리 YAML 블록으로 범위를 좁힌다**(MCP 를 설명만 하는 스킬은 많다).
  //    로컬 stdio 서버 선언일 수도 있어 확정하지 않고, 이름으로 근거를 남긴다.
  {
    name: "MCP(선언)",
    scope: "frontmatter",
    re: /^[ \t-]*(?:mcp[-_]?servers?|mcp)[ \t]*:|^[ \t]*requires[ \t]*:.*\bmcp\b/im,
  },
  // 3) 원격 MCP 엔드포인트 URL. 여기까지 오면 **원격 확정**이다 — 로컬 stdio 서버는 URL 이 없다.
  {
    name: "MCP(원격)",
    re: new RegExp(
      `(?:https?|wss?)://${NOT_PLACEHOLDER_HOST}${NOT_MCP_DOC_HOST}[^\\s"'\`<>)\\]}]*/mcp\\b`,
      "i"
    ),
  },
  // 외부 서비스 CLI 호출. 위 EXTERNAL_CLIS 에서 자동 생성해 붙인다(신호 이름은 `외부CLI(gh)`).
  ...EXTERNAL_CLIS.map((cli) => ({ name: `외부CLI(${cli})`, re: cliCallRe(cli) })),
];

/**
 * 파일 머리의 YAML frontmatter 본문(구분선 제외). 없으면 빈 문자열.
 * 정규식으로 흉내 내지 않고 잘라 두는 이유는 하나다 — `mcp:` 를 찾을 때 산문 본문까지 훑으면
 * "MCP: Model Context Protocol …" 같은 설명 줄이 선언으로 둔갑한다.
 */
export function frontMatter(text: string): string {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? m[1] : "";
}

/** 신호 1건이 이 본문에 있는가. skipLine 이 있으면 줄 단위로 본다. */
function hasSignal(sig: NetworkSignal, text: string, fm: string): boolean {
  const target = sig.scope === "frontmatter" ? fm : text;
  if (!target) return false;
  if (!sig.skipLine) return sig.re.test(target);
  // 설치 안내 줄만 빼고 나머지 줄에서 다시 찾는다 — 한 파일에 설치 안내와 진짜 호출이 함께
  // 있으면 신호는 그대로 남아야 한다(빼는 것은 '그 줄'이지 '그 신호'가 아니다).
  for (const line of target.split("\n")) {
    if (sig.re.test(line) && !sig.skipLine.test(line)) return true;
  }
  return false;
}

/** SKILL.md 본문 1건에서 발견된 신호 이름들(중복 없음, NETWORK_SIGNALS 순서 유지). */
export function detectSignals(text: string): string[] {
  const fm = frontMatter(text);
  const out: string[] = [];
  for (const s of NETWORK_SIGNALS) {
    if (hasSignal(s, text, fm)) out.push(s.name);
  }
  return out;
}

/**
 * 신호 정의 버전. **캐시 행에 함께 저장하고, 다르면 캐시를 버리고 다시 스캔한다.**
 *
 * 예전 캐시 키는 `pushed_at` 뿐이었다. 그래서 이 파일의 신호를 고쳐도 그 저장소가 다시 푸시될
 * 때까지 옛 판정이 그대로 나왔다 — 즉 **신호를 고치는 일 자체가 라이브에 반영되지 않았다.**
 *
 * 수동 번호와 신호표 해시를 함께 쓴다. 번호는 "이번에 무엇을 왜 바꿨나"를 사람이 읽는 자리이고,
 * 해시는 그 번호를 **올리는 걸 잊어도** 캐시가 저절로 무효화되게 하는 안전망이다(정확히 그
 * 망각이 이번 회귀의 원인이었다).
 *
 *   1: 최초 정의 (WebFetch·curl·api호스트·MCP(mcp__|mcpServers)·외부CLI)
 *   2: MCP 선언형·원격 URL 추가, curl 설치 관용구·예시 도메인 위양성 제거 (2026-09-02)
 */
export const SCAN_SIGNATURE_REVISION = 2;

/** `v2-<신호표 sha256 앞 8자>`. skill_scans.sig_version 에 그대로 들어간다. */
export const SCAN_SIGNATURE_VERSION = `v${SCAN_SIGNATURE_REVISION}-${createHash("sha256")
  .update(
    NETWORK_SIGNALS.map(
      (s) => `${s.name} ${s.re.source} ${s.re.flags} ${s.scope ?? ""} ${s.skipLine?.source ?? ""}`
    ).join("\n")
  )
  .digest("hex")
  .slice(0, 8)}`;

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
  /**
   * 기본 브랜치를 **모를 때만** 쓰는 후보 목록. 아래 defaultBranch 가 값을 주면 쓰이지 않는다.
   */
  branches: readonly string[];
  /**
   * 저장소의 실제 기본 브랜치. 모르면 null.
   *
   * ★ GitHub 검색 응답에 `default_branch` 가 이미 들어 있다(github.ts 가 곁으로 실어 준다).
   *   그런데 예전에는 그걸 안 쓰고 main → master 를 찍어 봤다. 그 결과 상위 50 중 3건
   *   (code-yeongyu/oh-my-openagent=dev, titanwings/distilly=dot-skill,
   *    yusufkaraaslan/Skill_Seekers=development)이 **기본 브랜치가 아닌 낡은 브랜치의 파일로**
   *   판정되고, 펼침 목록 링크도 그 낡은 브랜치를 가리켰다. 조회는 성공하니 아무도 몰랐다.
   *   덤으로 트리 호출도 저장소당 1회로 고정된다(실측 57회 → 50회).
   */
  defaultBranch: (repo: SkillRepo) => string | null;
  /** 스캔 전에 core 잔량을 확인할지. 테스트는 끈다(네트워크를 한 번 더 두드리지 않게). */
  checkQuota: boolean;
  /** 잔량에서 남겨 둘 여유분. 다른 경로가 core 를 쓸 때를 위한 몫이다. */
  quotaReserve: number;
}

export const SCAN_TIMEOUT_MS = 10_000;
export const SCAN_REPO_CONCURRENCY = 5;
export const SCAN_FILE_CONCURRENCY = 8;
/**
 * 기본 브랜치를 **모를 때만** 쓰는 후보. main → master 순.
 * 수집 경로가 default_branch 를 실어 주므로 정상 회차에서는 거의 쓰이지 않는다(폴백이다).
 */
export const SCAN_BRANCHES = ["main", "master"] as const;

/** core 잔량에서 남겨 두는 여유분. 경계에서 아슬아슬하게 긁지 않기 위한 몫이다. */
export const SCAN_QUOTA_RESERVE = 3;

/** GitHub 잔량 조회. **이 호출 자체는 쿼터를 쓰지 않는다**(공식 문서 명시). */
export const GITHUB_RATE_LIMIT_URL = "https://api.github.com/rate_limit";

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
    defaultBranch: () => null,
    checkQuota: true,
    quotaReserve: SCAN_QUOTA_RESERVE,
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
 * **기본 브랜치를 알면 그것 하나만 본다**(deps.defaultBranch). 모를 때만 main → master 를
 * 순서대로 찍어 본다. 404 는 "그 브랜치가 없다"는 뜻이라 다음 후보로 넘어가고, 403/429
 * (레이트리밋)는 브랜치를 바꿔 봐야 소용없으므로 즉시 접는다 — 무인증 60회/시간에서 한
 * 저장소가 쿼터를 두 번 태우면 안 된다.
 */
async function fetchTree(repo: SkillRepo, deps: ScanDeps): Promise<TreeResult> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "daily-price-dashboard/skills",
    ...(deps.token ? { Authorization: `Bearer ${deps.token}` } : {}),
  };
  let lastReason: string | null = null;
  // 기본 브랜치를 알면 후보를 흔들지 않는다 — 낡은 main 이 남아 있어도 그쪽을 읽지 않는다.
  const known = deps.defaultBranch(repo);
  const candidates = known ? [known] : deps.branches;

  for (const branch of candidates) {
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
  /**
   * 남은 core 예산이 모자라 **아예 두드리지 않은** 저장소 수(전부 unknown).
   * ★ skipped 와 나눠 센다 — "맞고 접었다"와 "애초에 안 갔다"는 다음 회차 판단이 다르다.
   */
  budgetSkipped: number;
  /** 스캔 시작 시점의 core 잔량. 확인하지 못했으면 null. */
  coreRemaining: number | null;
  ms: number;
}

/** `GET /rate_limit` 응답에서 core 버킷만 뽑는다. 못 읽으면 null(예산 절삭을 하지 않는다). */
async function fetchCoreRemaining(deps: ScanDeps): Promise<number | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "daily-price-dashboard/skills",
    ...(deps.token ? { Authorization: `Bearer ${deps.token}` } : {}),
  };
  const got = await getText(GITHUB_RATE_LIMIT_URL, headers, deps);
  if (!got || got.status !== 200) return null;
  try {
    const body = JSON.parse(got.text) as {
      resources?: { core?: { remaining?: unknown } };
    };
    const n = Number(body?.resources?.core?.remaining);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * 노출 후보를 스캔한다.
 *
 * @param repos     스캔 대상(= byStars TOP 50 ∪ byGrowth TOP 50, 링크 사망 검증 통과분)
 * @param cacheHit  repo → 재사용 가능한 캐시(없으면 null). pushed_at 이 같을 때만 준다.
 *
 * ★ 레이트리밋을 만나면 **남은 저장소를 즉시 포기한다**(kind="unknown"). 무인증 60회/시간
 *   창이 리셋되기를 기다리면 주간 회차가 한 시간을 붙잡는다. 태그 하나 때문에 그럴 수 없다.
 *
 * ★★ 그보다 먼저, **시작 전에 남은 예산을 보고 그 안에서만 새로 조회한다.** 리밋을 맞고 접는
 *    것과 애초에 안 가는 것은 결과가 같아 보이지만 다르다 — 맞고 접으면 그 회차의 남은 core 가
 *    0 이 되어 같은 시간 창의 다른 경로까지 함께 막힌다. 예산 밖 저장소는 `unknown` 으로 두고
 *    회차는 정상 종료한다.
 *    ⚠️ 예산이 모자란 것은 "신호가 없다"가 아니다. 절대 `local` 로 떨어뜨리지 않는다.
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

  // ── 예산 산정 ──
  // 트리 호출 비용은 기본 브랜치를 알면 1회, 모르면 후보 수(main→master = 최대 2회)다.
  // 목록은 이미 랭킹 순이라 앞에서부터 채우면 **상위 저장소가 먼저 판정된다**.
  const cost = (repo: SkillRepo) => (deps.defaultBranch(repo) ? 1 : deps.branches.length);
  const coreRemaining = deps.checkQuota && pending.length > 0 ? await fetchCoreRemaining(deps) : null;
  let runnable = pending;
  let deferred: SkillRepo[] = [];
  if (coreRemaining !== null) {
    const budget = Math.max(0, coreRemaining - deps.quotaReserve);
    let spent = 0;
    let cut = pending.length;
    for (let i = 0; i < pending.length; i++) {
      const next = spent + cost(pending[i]);
      if (next > budget) {
        cut = i;
        break;
      }
      spent = next;
    }
    runnable = pending.slice(0, cut);
    deferred = pending.slice(cut);
  }

  log.info(
    `스킬 네트워크 스캔 시작 — 대상 ${repos.length}건 (캐시 재사용 ${cached}건, 신규 조회 ${runnable.length}건, ` +
      `${deps.token ? "인증 5000회/시간" : "무인증 60회/시간"}, core 잔량 ${coreRemaining ?? "?"})` +
      (deferred.length ? ` · 예산 부족으로 ${deferred.length}건은 판정 보류` : "")
  );
  if (deferred.length) {
    log.warn(
      `스킬 네트워크 스캔 — core 잔량 ${coreRemaining}/여유분 ${deps.quotaReserve} 안에서만 조회한다 → ` +
        `${deferred.length}건은 '판정 불가'로 남긴다(다음 회차에 다시 본다. '로컬'로 단정하지 않는다)`
    );
  }
  for (const repo of deferred) scans.set(repo.id, unknownScan(repo));

  await mapPool(runnable, deps.repoConcurrency, async (repo) => {
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
      `조회 ${fetched}건 / 캐시 ${cached}건 / 생략 ${skipped}건` +
      (deferred.length ? ` / 예산 보류 ${deferred.length}건` : "") +
      ` · ${formatKindCounts(scans)}`
  );
  return {
    scans,
    cached,
    fetched,
    skipped,
    budgetSkipped: deferred.length,
    coreRemaining,
    ms,
  };
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
