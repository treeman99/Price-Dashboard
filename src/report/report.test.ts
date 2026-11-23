/**
 * 일일 뉴스·유튜브 통합 보고서 — 통합 규칙·모델 건너뜀·증분·보존 회귀 테스트.
 *
 * ★ 실제 모델·네트워크·price data 를 쓰지 않는다. 파이프라인은 가짜 deps 로 돌리고, 한도 응답은
 *   각 CLI 의 **실제 오류 문구**(Codex·agy·Claude)를 그대로 모의한다.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NewsSnapshot, YoutubeSnapshot } from "../../shared/types.ts";
import { UsageLimitError } from "../util/codex-query.ts";
import {
  AGY_TOOL_BUDGET_MAX,
  AntigravityError,
  buildAgyPrompt,
  buildAgySettings,
  isAntigravityLimitText,
  parseAgyStream,
} from "../util/antigravity-query.ts";
import {
  applyEditorGroups,
  canonicalUrl,
  deterministicMerge,
  exactGroups,
  splitIncremental,
  updateSeen,
  type ReportItem,
} from "./merge.ts";
import { classifyFailure, REPORT_MODELS, type ModelSpec } from "./models.ts";
import { checkpointPath, readCheckpoint, runDailyReport, type PipelineDeps, type RawData } from "./pipeline.ts";
import { acquireLock, hashState, newRunId, snapshotState, STATE_FILES } from "./cli.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daily-report-test-"));
/** 고정 실행 시각(로컬) — 조사 구간(실행 시점 기준 최근 24시간)이 날짜에 따라 흔들리지 않게. 구간: 11/21 21:00 ~ 11/22 21:00. */
const FIXED_NOW = new Date(2026, 10, 22, 21, 0, 0);
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const [CLAUDE, GPT, GEMINI] = REPORT_MODELS;

// 실제 오류 문구(2026-11-22 실측·바이너리 근거)
const CODEX_LIMIT =
  "Codex 비정상 종료(code=1, signal=-) — You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 9:00 PM.";
const AGY_UNSUPPORTED =
  "Antigravity 실패(status=ERROR, code=1) — This client is no longer supported for Gemini Code Assist for individuals.";
const AGY_QUOTA = "Antigravity 실패(status=ERROR, code=1) — You have exhausted your quota on this model.";
const CLAUDE_LIMIT = "You've hit your Opus limit · resets 3pm (Asia/Seoul)";

function item(p: Partial<ReportItem> & Pick<ReportItem, "id" | "model" | "title">): ReportItem {
  return {
    kind: "news",
    categoryKey: "ai",
    categoryLabel: "🤖 AI",
    summary: `${p.title} 요약`,
    source: "매체",
    url: null,
    date: "2026-11-22",
    related: [],
    ...p,
  };
}

// ── URL 정규화·고유 키 ──

test("canonicalUrl: 추적 파라미터·www·끝 슬래시·조각 제거, YouTube·GeekNews 고유 ID 로 접는다", () => {
  assert.equal(
    canonicalUrl("http://www.example.com/a/b/?utm_source=x&id=3&fbclid=1#top"),
    "https://example.com/a/b?id=3"
  );
  assert.equal(canonicalUrl("https://youtu.be/abcdefghijk?t=30"), "https://www.youtube.com/watch?v=abcdefghijk");
  assert.equal(canonicalUrl("https://m.youtube.com/watch?v=abcdefghijk&list=x"), "https://www.youtube.com/watch?v=abcdefghijk");
  assert.equal(
    canonicalUrl("https://news.hada.io/topic?id=37609&utm_source=geeknews&utm_medium=rss"),
    "https://news.hada.io/topic?id=37609"
  );
  assert.equal(canonicalUrl("javascript:alert(1)"), null);
  assert.equal(canonicalUrl("not a url"), null);
});

test("정확 키 통합: 같은 기사(추적 파라미터만 다름)·같은 영상 ID·보조 링크 일치는 한 그룹, 뉴스와 영상은 섞지 않는다", () => {
  const items = [
    item({ id: "claude:news:0", model: "claude", title: "A 발표", url: "https://example.com/a?utm_source=x" }),
    item({ id: "gemini:news:0", model: "gemini", title: "A 공식 발표", url: "https://www.example.com/a/" }),
    item({ id: "gpt:news:0", model: "gpt", title: "A 보도", url: "https://other.com/a", related: [{ label: "원문", link: "https://example.com/a" }] }),
    item({ id: "claude:youtube:0", model: "claude", kind: "youtube", title: "영상", url: "https://youtu.be/abcdefghijk" }),
    item({ id: "gemini:youtube:0", model: "gemini", kind: "youtube", title: "영상2", url: "https://www.youtube.com/watch?v=abcdefghijk" }),
    item({ id: "gemini:news:1", model: "gemini", title: "B 단독", url: "https://example.com/b" }),
  ];
  const groups = exactGroups(items).map((g) => g.sort());
  assert.deepEqual(
    groups.sort((a, b) => a[0].localeCompare(b[0])),
    [["claude:news:0", "gemini:news:0", "gpt:news:0"], ["claude:youtube:0", "gemini:youtube:0"], ["gemini:news:1"]].sort((a, b) =>
      a[0].localeCompare(b[0])
    )
  );
  const merged = deterministicMerge(items);
  const a = merged.find((g) => g.members.length === 3)!;
  assert.deepEqual(a.models, ["claude", "gemini", "gpt"]);
  assert.ok(a.secondary.some((s) => s.link.includes("other.com")), "대표가 아닌 출처는 보조 출처로 남는다");
});

// ── 편집기(의미 통합) 검증 ──

const semanticItems = [
  // 같은 사건을 서로 다른 매체 링크로 보고(정확 키는 다르다) → 편집기만 묶을 수 있다.
  item({ id: "claude:news:0", model: "claude", title: "앤트로픽, Claude 새 모델 공개", url: "https://anthropic.com/news/x", source: "Anthropic" }),
  item({ id: "gemini:news:0", model: "gemini", title: "Anthropic launches new Claude model", url: "https://techsite.com/claude-new", source: "TechSite", date: "2026-11-21" }),
  // 한 모델만 찾은 유의미한 사건
  item({ id: "gemini:news:1", model: "gemini", title: "양자 오류정정 신기록", url: "https://quantum.example/qec", categoryKey: "quantum" }),
];

test("편집기 의미 통합: 같은 사건은 대표 1개 + 보조 출처, 날짜 차이는 근거 차이로 표시, 한 모델 단독 사건은 보존", () => {
  const groups = applyEditorGroups(semanticItems, [
    { ids: ["claude:news:0", "gemini:news:0"], representative: "claude:news:0", reason: "같은 모델 발표", conflict: "" },
    { ids: ["gemini:news:1"], representative: "gemini:news:1" },
  ]);
  assert.equal(groups.length, 2);
  const ev = groups[0];
  assert.equal(ev.rep.id, "claude:news:0", "편집기가 고른 원출처가 대표");
  assert.deepEqual(ev.models, ["claude", "gemini"]);
  assert.equal(ev.secondary[0].link, "https://techsite.com/claude-new");
  assert.match(ev.conflict, /날짜 표기가 다름/);
  assert.equal(groups[1].rep.id, "gemini:news:1");
  assert.deepEqual(groups[1].models, ["gemini"]);
});

test("편집기가 한 모델 단독 항목을 빠뜨리거나·지어낸 id·뉴스/영상 혼합·같은 링크 분리를 하면 편집 결과를 거부한다", () => {
  assert.throws(
    () => applyEditorGroups(semanticItems, [{ ids: ["claude:news:0", "gemini:news:0"], representative: "claude:news:0" }]),
    /누락/
  );
  assert.throws(
    () => applyEditorGroups(semanticItems, [{ ids: ["claude:news:0", "gemini:news:0", "gemini:news:1", "x:news:9"], representative: "x:news:9" }]),
    /모르는 id/
  );
  const withVideo = [...semanticItems, item({ id: "claude:youtube:0", model: "claude", kind: "youtube", title: "v", url: "https://youtu.be/abcdefghijk" })];
  assert.throws(
    () =>
      applyEditorGroups(withVideo, [
        { ids: ["claude:news:0", "claude:youtube:0"], representative: "claude:news:0" },
        { ids: ["gemini:news:0"], representative: "gemini:news:0" },
        { ids: ["gemini:news:1"], representative: "gemini:news:1" },
      ]),
    /혼합/
  );
  const sameLink = [
    item({ id: "claude:news:0", model: "claude", title: "a", url: "https://e.com/x" }),
    item({ id: "gemini:news:0", model: "gemini", title: "b", url: "https://e.com/x?utm_source=1" }),
  ];
  assert.throws(
    () =>
      applyEditorGroups(sameLink, [
        { ids: ["claude:news:0"], representative: "claude:news:0" },
        { ids: ["gemini:news:0"], representative: "gemini:news:0" },
      ]),
    /분리/
  );
});

test("증분: 모든 키가 이미 보고된 그룹은 제외, 일부만 보고됐으면 '새 출처' 업데이트로 유지, seen 은 보존 기간을 지킨다", () => {
  const groups = deterministicMerge([
    item({ id: "a", model: "claude", title: "old", url: "https://e.com/old" }),
    item({ id: "b", model: "claude", title: "upd", url: "https://e.com/upd", related: [{ label: "r", link: "https://e.com/old2" }] }),
    item({ id: "c", model: "claude", title: "new", url: "https://e.com/new" }),
  ]);
  const seen = { "url:https://e.com/old": "2026-11-22T00:00:00Z", "url:https://e.com/old2": "2026-11-22T00:00:00Z" };
  const { fresh, alreadyReported } = splitIncremental(groups, seen);
  assert.deepEqual(alreadyReported.map((g) => g.rep.id), ["a"]);
  assert.deepEqual(fresh.map((g) => [g.rep.id, !!g.update]), [["b", true], ["c", false]]);
  const next = updateSeen({ "url:https://e.com/ancient": "2026-10-01T00:00:00Z", ...seen }, fresh, "2026-11-22T08:00:00Z", 14);
  assert.equal("url:https://e.com/ancient" in next, false, "14일 지난 키는 걷어 낸다");
  assert.ok("url:https://e.com/new" in next);
});

// ── 한도 판별(실제 문구) ──

test("classifyFailure: 각 CLI 의 실제 한도 문구는 limit, 지원 종료·인증 등은 error", () => {
  assert.equal(classifyFailure(GPT, new UsageLimitError(CODEX_LIMIT)), "limit");
  assert.equal(classifyFailure(GPT, new Error(CODEX_LIMIT)), "limit", "메시지 문구로도 판별");
  assert.equal(classifyFailure(GPT, new Error("Codex 최종 응답이 없습니다.")), "error");
  assert.equal(classifyFailure(GEMINI, new AntigravityError(AGY_QUOTA, isAntigravityLimitText(AGY_QUOTA))), "limit");
  assert.equal(classifyFailure(GEMINI, new AntigravityError(AGY_UNSUPPORTED, isAntigravityLimitText(AGY_UNSUPPORTED))), "error");
  assert.equal(classifyFailure(CLAUDE, new Error(CLAUDE_LIMIT)), "limit");
  assert.equal(classifyFailure(CLAUDE, new Error("Failed to authenticate: OAuth session expired")), "error");
});

test("agy 실행 설정: 명령·파일 쓰기·브라우저·다운로드·MCP 는 deny, stream-json 에서 실제 모델·도구 근거를 읽는다", () => {
  const s = buildAgySettings(true) as { permissions: { allow: string[]; deny: string[] } };
  assert.deepEqual(s.permissions.allow, ["read_url(*)"]);
  for (const d of ["command(*)", "write_file(*)", "execute_url(*)", "download_url(*)", "mcp(*)"]) assert.ok(s.permissions.deny.includes(d));
  const stream = [
    JSON.stringify({ event: "init", init: { model: "gemini-4-argon-high" } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "tool", state: "DONE", tool_name: "search_web", tool_info: { parameters: { query: "q" } } } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "tool", state: "ERROR", tool_name: "run_command", tool_info: { parameters: { CommandLine: "ls" } } } }),
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "{\"ok\":1}" } }),
  ].join("\n");
  const p = parseAgyStream(stream);
  assert.equal(p.initModel, "gemini-4-argon-high");
  assert.equal(p.status, "SUCCESS");
  assert.deepEqual(p.tools.map((t) => t.name), ["search_web", "run_command (거부/실패)"]);
});

// ── 파이프라인(가짜 deps) ──

function newsSnap(items: { title: string; link: string; source?: string; date?: string; publishedAt?: string | null }[]): NewsSnapshot {
  return {
    date: "2026-11-22",
    updatedAt: new Date().toISOString(),
    source: "llm",
    notes: null,
    categories: [
      {
        key: "ai",
        label: "AI",
        emoji: "🤖",
        color: "#000",
        items: items.map((i) => ({
          title: i.title,
          source: i.source ?? "매체",
          date: i.date ?? "2026-11-22",
          publishedAt: i.publishedAt ?? null,
          summary: `${i.title} 요약`,
          link: i.link,
          related: [],
        })),
      },
    ],
  };
}

function ytSnap(videos: { title: string; id: string }[]): YoutubeSnapshot {
  return {
    date: "2026-11-22",
    updatedAt: new Date().toISOString(),
    source: "llm",
    freshHours: 24,
    notes: null,
    categories: [
      {
        key: "tools",
        label: "도구",
        emoji: "🛠️",
        color: "#000",
        items: videos.map((v) => ({
          title: v.title,
          originalTitle: null,
          channel: "채널",
          channelHandle: null,
          date: "2026-11-22",
          summary: `${v.title} 요약`,
          url: `https://www.youtube.com/watch?v=${v.id}`,
          videoId: v.id,
          thumbnail: null,
          views: null,
          duration: null,
        })),
      },
    ],
  };
}

interface FakeOpts {
  fail?: Partial<Record<ModelSpec["key"], () => Error>>;
  editorFail?: Partial<Record<ModelSpec["key"], () => Error>>;
  geekNewsOk?: boolean;
  newsBy?: Partial<Record<ModelSpec["key"], { title: string; link: string; source?: string; date?: string; publishedAt?: string | null }[]>>;
  editorGroups?: (ids: string[]) => unknown;
}

function fakeDeps(o: FakeOpts = {}) {
  const calls: Record<string, number> = {};
  const editorCalls: string[] = [];
  const bump = (k: string) => (calls[k] = (calls[k] ?? 0) + 1);
  const defaultNews: Record<ModelSpec["key"], { title: string; link: string; source?: string; date?: string; publishedAt?: string | null }[]> = {
    // 같은 사건(앤트로픽 발표)을 서로 다른 링크로, 그리고 Gemini 단독 사건 하나
    claude: [{ title: "앤트로픽 새 모델", link: "https://anthropic.com/news/x", source: "Anthropic" }],
    gpt: [{ title: "Anthropic new model", link: "https://anthropic.com/news/x?utm_source=feed", source: "Anthropic" }],
    gemini: [
      // 어제 날짜지만 발행 시각이 구간(11/21 21:00~) 안이라 들어온다 — 날짜 차이는 근거 차이로 표시된다.
      { title: "Claude 신모델 보도", link: "https://techsite.com/claude", source: "TechSite", date: "2026-11-21", publishedAt: "2026-11-21T23:30:00+09:00" },
      { title: "양자 신기록(단독)", link: "https://quantum.example/qec" },
    ],
  };
  const deps: PipelineDeps = {
    now: () => new Date(FIXED_NOW),
    categories: () => ({ news: [{ key: "ai", label: "🤖 AI" }], youtube: [{ key: "tools", label: "🛠️ 도구" }], freshHours: 24 }),
    collectRaw: async ({ now }): Promise<RawData> => ({
      geekNews: { ok: o.geekNewsOk !== false, entries: [], error: o.geekNewsOk === false ? "HTTP 503" : null, since: now.toISOString(), until: now.toISOString() },
      seeds: new Map([["tools", [{ videoId: "seedonly111", title: "추천 채널 업로드", channel: "추천", date: "2026-11-22", categoryKey: "tools", description: null }]]]),
      sources: [
        { id: "geeknews", label: "GeekNews", ok: o.geekNewsOk !== false, count: 0, since: now.toISOString(), until: now.toISOString(), ...(o.geekNewsOk === false ? { error: "HTTP 503" } : {}) },
        { id: "youtube:추천", label: "추천", ok: true, count: 1, since: now.toISOString(), until: now.toISOString() },
      ],
    }),
    collectNews: async (spec) => {
      bump(`${spec.key}:news`);
      const f = o.fail?.[spec.key];
      if (f) throw f();
      return newsSnap((o.newsBy ?? defaultNews)[spec.key] ?? defaultNews[spec.key]);
    },
    collectYoutube: async (spec) => {
      bump(`${spec.key}:youtube`);
      const f = o.fail?.[spec.key];
      if (f) throw f();
      return ytSnap([{ title: "공통 영상", id: "abcdefghijk" }]);
    },
    runEditor: async (spec, prompt) => {
      editorCalls.push(spec.key);
      const f = o.editorFail?.[spec.key];
      if (f) throw f();
      const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
      if (o.editorGroups) return JSON.stringify(o.editorGroups(ids));
      // 기본 편집: 정확 키 묶음은 그대로 두고 'Claude 신모델 보도'(gemini:news:0)를 앤트로픽 사건과 의미 통합
      const news = ids.filter((i) => i.includes(":news:"));
      const yt = ids.filter((i) => i.includes(":youtube:"));
      const anth = news.filter((i) => !i.endsWith("gemini:news:1"));
      const groups = [
        ...(anth.length ? [{ ids: anth, representative: anth[0], reason: "같은 발표", conflict: "" }] : []),
        ...news.filter((i) => i.endsWith("gemini:news:1")).map((i) => ({ ids: [i], representative: i })),
        ...(yt.length ? [{ ids: yt, representative: yt[0] }] : []),
      ];
      return JSON.stringify({ groups, highlights: ["앤트로픽이 새 모델을 공개했다.", "양자 오류정정 신기록이 나왔다."] });
    },
    trace: (_sink, fn) => fn(),
    log: () => {},
  };
  return { deps, calls, editorCalls };
}

let runSeq = 0;
async function run(outputDir: string, d: PipelineDeps, preview = false) {
  const runId = `t${++runSeq}`;
  return runDailyReport(d, {
    runId,
    runDir: path.join(outputDir, preview ? "previews" : "runs", runId),
    outputDir,
    preview,
    models: REPORT_MODELS,
    retryDelayMs: 0,
  });
}

test("세 모델 모두 성공: 같은 사건은 하나로(세 모델 표기), 단독 사건 보존, 편집은 Opus, 체크포인트 진행", async () => {
  const out = path.join(tmpRoot, "all-ok");
  const { deps, editorCalls } = fakeDeps();
  const r = await run(out, deps);
  assert.equal(r.ok, true);
  assert.equal(r.successCount, 3);
  assert.deepEqual(editorCalls, ["claude"]);
  assert.equal(r.editor.spec?.key, "claude");
  // 뉴스 4건(claude1+gpt1+gemini2) + 영상 3건 → 앤트로픽 사건 1 + 양자 1 + 영상 1
  assert.equal(r.counts.before, 7);
  assert.equal(r.counts.afterMerge, 3);
  const md = fs.readFileSync(r.reportPath, "utf8");
  assert.match(md, /3개 모델 모두 독립 취합 성공/);
  assert.match(md, /찾은 모델: Opus 5\.5, Gemini 4 Neon, GPT-6\.1 Sol/);
  assert.match(md, /양자 신기록\(단독\)[\s\S]*찾은 모델: Gemini 4 Neon/);
  assert.match(md, /근거 차이: 모델별 날짜 표기가 다름/);
  assert.match(md, /편집 모델: Claude Opus 5\.5 \(`claude-opus-5-5`\)/);
  assert.match(md, /추천 채널 신규 업로드/);
  assert.match(md, /영상 본문은 시청하지 않음/);
  const cp = readCheckpoint(out);
  assert.equal(cp.lastSuccessRunId, r.runId);
  assert.ok(Object.keys(cp.seen).length > 0);
  const merge = JSON.parse(fs.readFileSync(path.join(r.runDir, "merge.json"), "utf8"));
  assert.equal(merge.counts.afterMerge, 3);
  for (const m of ["claude", "gpt", "gemini"]) {
    assert.ok(fs.existsSync(path.join(r.runDir, "models", m, "news.json")), `${m} 중간 결과 보관`);
    assert.ok(fs.existsSync(path.join(r.runDir, "models", m, "status.json")));
  }

  // 탭 스냅샷(tabs/)은 2026-11-23 뉴스·유튜브 탭을 없애며 걷어 냈다.
  assert.equal(fs.existsSync(path.join(r.runDir, "tabs")), false);

  // 구조화 보고서(report.json): 화면·메일용
  const rj = JSON.parse(fs.readFileSync(r.reportJsonPath, "utf8"));
  assert.equal(rj.version, 1);
  assert.equal(rj.trigger, "cli");
  assert.equal(rj.ok, true);
  assert.equal(rj.successCount, 3);
  assert.deepEqual(rj.highlights, ["앤트로픽이 새 모델을 공개했다.", "양자 오류정정 신기록이 나왔다."]);
  assert.equal(rj.models.find((m: { key: string }) => m.key === "gemini").model, "gemini-4-neon-xhigh");
  assert.equal(rj.news[0].items.length, 2);
  assert.equal(rj.news[0].items[0].title, "앤트로픽 새 모델", "대표는 원출처(Opus 원본)");
  assert.equal(rj.news[0].items[0].key, "https://anthropic.com/news/x", "항목 키 = 정규화 URL");
  assert.deepEqual(rj.news[0].items[0].foundBy, ["Opus 5.5", "Gemini 4 Neon", "GPT-6.1 Sol"]);
  assert.equal(rj.youtube[0].items.length, 1);
  assert.equal(rj.youtube[0].items[0].key, "yt:abcdefghijk");
  assert.equal(rj.youtube[0].items[0].videoId, "abcdefghijk");
  assert.equal(rj.seedsOnly.length, 1);
  assert.equal(rj.editor.model, "claude-opus-5-5");
});

test("한 모델 한도: 짧은 1회 재시도 후 '한도로 건너뜀', 나머지로 보고서·체크포인트 진행, 사유 원문 표시", async () => {
  const out = path.join(tmpRoot, "gpt-limit");
  const { deps, calls } = fakeDeps({ fail: { gpt: () => new UsageLimitError(CODEX_LIMIT) } });
  const r = await run(out, deps);
  assert.equal(calls["gpt:news"], 2, "한도면 딱 한 번 더 시도");
  assert.equal(calls["gpt:youtube"], 2);
  assert.equal(r.ok, true);
  assert.equal(r.successCount, 2);
  const gpt = r.models.find((m) => m.spec.key === "gpt")!;
  assert.equal(gpt.outcome, "skipped-limit");
  const md = fs.readFileSync(r.reportPath, "utf8");
  assert.match(md, /부분 결과/);
  assert.match(md, /\| GPT-6\.1 Sol \| `gpt-6\.1-sol` → - \| 한도로 건너뜀 \| .*hit your usage limit/);
  assert.doesNotMatch(md, /찾은 모델: [^\n]*GPT/, "건너뛴 모델을 찾은 모델로 적지 않는다");
  assert.equal(r.checkpointAdvanced, true);
});

test("한도 외 오류: 재시도 없이 '오류로 건너뜀(조치 필요)'으로 구분 표시", async () => {
  const out = path.join(tmpRoot, "gemini-error");
  const { deps, calls } = fakeDeps({ fail: { gemini: () => new AntigravityError(AGY_UNSUPPORTED, false) } });
  const r = await run(out, deps);
  assert.equal(calls["gemini:news"], 1, "한도 외 오류는 재시도하지 않는다");
  assert.equal(r.models.find((m) => m.spec.key === "gemini")!.outcome, "skipped-error");
  const md = fs.readFileSync(r.reportPath, "utf8");
  assert.match(md, /오류로 건너뜀\(조치 필요\)/);
  assert.match(md, /\*\*조치 필요\*\*: Gemini 4 Neon — .*no longer supported/);
  assert.equal(r.ok, true);
});

test("세 모델 모두 건너뜀: 실패 보고서만 내고 체크포인트·seen 을 진행하지 않는다", async () => {
  const out = path.join(tmpRoot, "all-skip");
  // 먼저 성공 1회로 기준점을 만든다.
  const ok = await run(out, fakeDeps().deps);
  const before = fs.readFileSync(checkpointPath(out), "utf8");
  const { deps } = fakeDeps({
    fail: {
      claude: () => new Error(CLAUDE_LIMIT),
      gpt: () => new UsageLimitError(CODEX_LIMIT),
      gemini: () => new AntigravityError(AGY_QUOTA, true),
    },
  });
  const r = await run(out, deps);
  assert.equal(r.ok, false);
  assert.equal(r.successCount, 0);
  assert.equal(r.checkpointAdvanced, false);
  const failJson = JSON.parse(fs.readFileSync(r.reportJsonPath, "utf8"));
  assert.equal(failJson.ok, false);
  assert.deepEqual(failJson.news, []);
  assert.deepEqual(failJson.highlights, []);
  assert.equal(fs.readFileSync(checkpointPath(out), "utf8"), before, "기준 시점·seen 그대로");
  const md = fs.readFileSync(r.reportPath, "utf8");
  assert.match(md, /통합 실패/);
  assert.equal((md.match(/한도로 건너뜀/g) ?? []).length >= 3, true);
  const latest = JSON.parse(fs.readFileSync(path.join(out, "latest.json"), "utf8"));
  assert.equal(latest.ok, false);
  assert.equal(latest.lastSuccessRunId, ok.runId);
  // 실행별 보고서는 고유 경로에 남고 이전 보고서 내용은 바뀌지 않는다.
  assert.notEqual(r.reportPath, ok.reportPath);
  assert.match(fs.readFileSync(ok.reportPath, "utf8"), /3개 모델 모두 독립 취합 성공/);
});

test("편집 우선순위: Opus 가 건너뛰면 GPT, Opus 편집 실패 시 다음 성공 모델이 편집", async () => {
  const a = await run(path.join(tmpRoot, "editor-a"), fakeDeps({ fail: { claude: () => new Error(CLAUDE_LIMIT) } }).deps);
  assert.equal(a.editor.spec?.key, "gpt");
  const b = fakeDeps({ editorFail: { claude: () => new Error("Failed to authenticate") } });
  const r = await run(path.join(tmpRoot, "editor-b"), b.deps);
  assert.deepEqual(b.editorCalls, ["claude", "gpt"]);
  assert.equal(r.editor.spec?.key, "gpt");
  assert.match(fs.readFileSync(r.reportPath, "utf8"), /편집 실패 시도: `claude-opus-5-5`/);
});

test("편집기가 단독 항목을 빠뜨리면 그 편집을 버리고 결정론적 통합으로도 단독 항목을 보존한다", async () => {
  const { deps } = fakeDeps({
    editorGroups: (ids) => ({ groups: [{ ids: ids.filter((i) => !i.endsWith("gemini:news:1")), representative: ids[0] }], highlights: [] }),
  });
  const r = await run(path.join(tmpRoot, "editor-drop"), deps);
  assert.equal(r.editor.ok, false);
  const md = fs.readFileSync(r.reportPath, "utf8");
  assert.match(md, /양자 신기록\(단독\)/);
  assert.match(md, /결정론적 통합/);
});

test("원자료 출처 실패: 그 출처의 기준 시점은 진행하지 않고 성공한 출처만 진행", async () => {
  const out = path.join(tmpRoot, "source-fail");
  const r = await run(out, fakeDeps({ geekNewsOk: false }).deps);
  assert.equal(r.ok, true);
  const cp = readCheckpoint(out);
  assert.equal(cp.sources.geeknews, undefined, "실패한 GeekNews 는 기록하지 않는다");
  assert.ok(cp.sources["youtube:추천"]?.okAt);
  assert.match(fs.readFileSync(r.reportPath, "utf8"), /GeekNews 공식 피드: 수집 실패 — HTTP 503/);
});

test("증분: 두 번째 실행은 이미 보고한 항목을 제외하고 새 항목만, 미리보기는 체크포인트·포인터를 건드리지 않는다", async () => {
  const out = path.join(tmpRoot, "incremental");
  await run(out, fakeDeps().deps);
  const cp1 = fs.readFileSync(checkpointPath(out), "utf8");
  const latest1 = fs.readFileSync(path.join(out, "latest.json"), "utf8");

  const pv = await run(out, fakeDeps().deps, true);
  assert.equal(pv.checkpointAdvanced, false);
  assert.equal(fs.readFileSync(checkpointPath(out), "utf8"), cp1);
  assert.equal(fs.readFileSync(path.join(out, "latest.json"), "utf8"), latest1);
  assert.match(fs.readFileSync(pv.reportPath, "utf8"), /미리보기/);

  const newsBy = {
    claude: [
      { title: "앤트로픽 새 모델", link: "https://anthropic.com/news/x", source: "Anthropic" },
      { title: "새 소식", link: "https://e.com/fresh" },
    ],
    gpt: [{ title: "Anthropic new model", link: "https://anthropic.com/news/x", source: "Anthropic" }],
    gemini: [{ title: "양자 신기록(단독)", link: "https://quantum.example/qec" }],
  };
  // 편집기: 같은 링크(앤트로픽) 둘과 영상은 묶고 나머지는 단독 그룹
  const editorGroups = (ids: string[]) => {
    const anth: string[] = ids.filter((i) => i === "claude:news:0" || i === "gpt:news:0");
    const yt = ids.filter((i) => i.includes(":youtube:"));
    const rest = ids.filter((i) => !anth.includes(i) && !yt.includes(i));
    return {
      groups: [
        { ids: anth, representative: "claude:news:0" },
        { ids: yt, representative: yt[0] },
        ...rest.map((i) => ({ ids: [i], representative: i })),
      ],
      highlights: [],
    };
  };
  const r2 = await run(out, fakeDeps({ newsBy, editorGroups }).deps);
  assert.equal(r2.counts.reported, 1, "새 소식 1건만");
  assert.ok(r2.counts.alreadyReported >= 3);
  const md = fs.readFileSync(r2.reportPath, "utf8");
  assert.match(md, /새 소식/);
  assert.doesNotMatch(md, /양자 신기록/);
});

// ── CLI 보조: 상태 보존·잠금·실행 ID ──

test("상태 사본: 원본 price data 는 읽기만 하고, 사본을 고쳐도 원본 해시는 그대로다", () => {
  const src = path.join(tmpRoot, "price-data");
  const dst = path.join(tmpRoot, "state-copy");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "youtube-dismissed.json"), JSON.stringify([{ videoId: "dismissed001" }]));
  fs.writeFileSync(path.join(src, "youtube-watched.json"), JSON.stringify([]));
  fs.writeFileSync(path.join(src, "news-categories.json"), JSON.stringify([{ key: "ai" }]));
  const before = snapshotState(src, dst);
  assert.deepEqual(Object.keys(before).sort(), ["news-categories.json", "youtube-dismissed.json", "youtube-watched.json"]);
  fs.writeFileSync(path.join(dst, "youtube-dismissed.json"), "[]"); // 수집기가 사본을 바꿔도
  assert.deepEqual(hashState(src), before, "원본은 그대로");
  assert.ok(STATE_FILES.includes("youtube-blocklist.json") && STATE_FILES.includes("tab-settings.json"));
});

test("실행 잠금과 실행 ID: 동시 실행은 막고(살아 있는 pid), 죽은 pid 잠금은 걷어 내며, 실행 ID 는 겹치지 않는다", () => {
  const lock = path.join(tmpRoot, "lock", ".run.lock");
  const release = acquireLock(lock)!;
  assert.ok(release);
  assert.equal(acquireLock(lock), null, "같은 프로세스가 잡고 있으면 실패");
  release();
  fs.writeFileSync(lock, "999999"); // 존재하지 않는 pid
  const again = acquireLock(lock);
  assert.ok(again, "죽은 잠금은 걷어 낸다");
  again!();
  // 같은 초에 여러 번 만들어도 겹치지 않아야 한다. 난수가 4자리(16비트)라 50개면 우연히 겹칠 확률이 약 2%였다
  // (2026-11-23 실제로 한 번 실패) — 실행은 잠금으로 하나씩만 돌므로 같은 초 5개로 충분하다(우연 실패 약 0.02%).
  const ids = new Set(Array.from({ length: 5 }, () => newRunId(new Date("2026-11-22T00:00:00Z"))));
  assert.equal(ids.size, 5);
  assert.match([...ids][0], /^20261122T000000Z-[0-9a-f]{4}$/);
});

test("agy 프롬프트: Claude 의 maxTurns 대신 도구 호출 예산(상한 80)과 시간 제한을 명시한다", () => {
  const yt = buildAgyPrompt("작업", { maxTurns: 120, tools: ["WebSearch"] }, true, 20 * 60_000);
  assert.match(yt, new RegExp(`최대 ${AGY_TOOL_BUDGET_MAX}회까지만`));
  assert.match(yt, /약 20분 안에/);
  const news = buildAgyPrompt("작업", { maxTurns: 40 }, true);
  assert.match(news, /최대 40회까지만/);
  const noWeb = buildAgyPrompt("작업", { maxTurns: 1 }, false);
  assert.doesNotMatch(noWeb, /도구 호출\(검색·열람\)/);
});

// ── 사용자 규칙(2026-11-23): 통합 단계의 취합 제외·카테고리 이동 ──

test("취합 제외: 모델이 가져온 제외 사이트 기사·차단 채널·제외 영상은 통합 단계에서 다시 걸러진다", async () => {
  const out = path.join(tmpRoot, "user-exclude");
  const { deps } = fakeDeps();
  let editorPrompt = "";
  const runEditor = deps.runEditor;
  const r = await run(out, {
    ...deps,
    runEditor: async (spec, prompt) => {
      editorPrompt = prompt;
      return runEditor(spec, prompt);
    },
    exclusions: () => ({
      newsUrl: (u) => !!u && u.includes("quantum.example"),
      youtubeChannel: () => false,
      youtubeVideo: (id) => id === "abcdefghijk",
    }),
  });
  const rj = JSON.parse(fs.readFileSync(r.reportJsonPath, "utf8"));
  const titles = rj.news.flatMap((s: { items: { title: string }[] }) => s.items.map((i) => i.title));
  assert.equal(titles.includes("양자 신기록(단독)"), false, "제외 사이트 기사는 보고서에 없다");
  assert.equal(rj.youtube.length, 0, "제외 영상은 세 모델이 모두 가져와도 빠진다");
  assert.equal(rj.counts.excludedByUser, 4, "Gemini 의 제외 사이트 기사 1 + 세 모델의 제외 영상 3");
  assert.doesNotMatch(editorPrompt, /quantum\.example/, "편집기에도 넘기지 않는다");
  assert.match(fs.readFileSync(r.reportPath, "utf8"), /사용자 취합 제외 4건 제외/);
});

test("카테고리 이동 학습: 사용자 기록이 통합 단계에 적용되고 편집기 교정보다 우선하며, 편집기 프롬프트에 교정 기록이 들어간다", async () => {
  const out = path.join(tmpRoot, "user-moves");
  let editorPrompt = "";
  const { deps } = fakeDeps({
    editorGroups: (ids) => {
      const news = ids.filter((i) => i.includes(":news:"));
      const yt = ids.filter((i) => i.includes(":youtube:"));
      const quantum = news.filter((i) => i.endsWith("gemini:news:1"));
      const anth = news.filter((i) => !i.endsWith("gemini:news:1"));
      return {
        groups: [
          { ids: anth, representative: anth[0], category: "sci" }, // 사용자 기록 없음 → 편집기 교정 적용
          { ids: quantum, representative: quantum[0], category: "ai" }, // 사용자 기록(sci)과 충돌 → 사용자 기록 우선
          { ids: yt, representative: yt[0], category: "없는키" }, // 모르는 key → 무시
        ],
        highlights: [],
      };
    },
  });
  const runEditor = deps.runEditor;
  const r = await run(out, {
    ...deps,
    categories: () => ({
      news: [
        { key: "ai", label: "🤖 AI" },
        { key: "sci", label: "⚛️ 과학" },
      ],
      youtube: [{ key: "tools", label: "🛠️ 도구" }],
      freshHours: 24,
    }),
    runEditor: async (spec, prompt) => {
      editorPrompt = prompt;
      return runEditor(spec, prompt);
    },
    categoryMoves: () => ({
      news: [{ title: "  양자 신기록(단독) ", channel: "매체", toKey: "sci" }],
      youtube: [{ title: "공통 영상", channel: "채널", toKey: "없는카테고리" }],
    }),
  });
  assert.match(editorPrompt, /교정 기록/);
  assert.match(editorPrompt, /뉴스 "  양자 신기록\(단독\) " \(매체\) → ⚛️ 과학 \(key=sci\)/);
  assert.doesNotMatch(editorPrompt, /없는카테고리/, "지금 없는 카테고리로의 기록은 쓰지 않는다");
  const rj = JSON.parse(fs.readFileSync(r.reportJsonPath, "utf8"));
  const where = (title: string) =>
    rj.news.find((s: { items: { title: string }[] }) => s.items.some((i) => i.title === title))?.key;
  assert.equal(where("양자 신기록(단독)"), "sci", "사용자 기록(제목·출처 정규화 일치) 적용, 편집기의 'ai' 교정은 무시");
  assert.equal(where("앤트로픽 새 모델"), "sci", "사용자 기록이 없는 그룹은 편집기 교정 적용");
  assert.equal(rj.youtube[0].key, "tools", "모르는 key 의 편집기 교정은 무시");
});

// ── 조사 기간(2026-11-23): 실행 시점 기준 최근 24시간, 시각 단위 ──

test("조사 구간: 통합 단계가 시각으로 다시 판정하고(날짜만이면 오늘만·시각 미확인 표시), 보고서에 정확한 구간을 적는다", async () => {
  const out = path.join(tmpRoot, "window");
  const { deps } = fakeDeps({
    // 편집기는 항목을 묶지 않는다(이 테스트는 구간 판정만 본다).
    editorGroups: (ids) => ({ groups: ids.map((id) => ({ ids: [id], representative: id })), highlights: [] }),
    newsBy: {
      claude: [
        { title: "구간 안(시각)", link: "https://a.example/in", publishedAt: "2026-11-22T10:00:00+09:00" },
        { title: "구간 밖(어제 20시)", link: "https://a.example/old", date: "2026-11-21", publishedAt: "2026-11-21T20:00:00+09:00" },
      ],
      gpt: [
        { title: "날짜만 오늘", link: "https://b.example/today", date: "2026-11-22" },
        { title: "날짜만 어제", link: "https://b.example/yday", date: "2026-11-21" },
      ],
      gemini: [{ title: "미래 시각", link: "https://c.example/future", date: "2026-11-23", publishedAt: "2026-11-23T08:00:00+09:00" }],
    },
  });
  const r = await run(out, deps);
  const rj = JSON.parse(fs.readFileSync(r.reportJsonPath, "utf8"));
  const titles = rj.news.flatMap((s: { items: { title: string }[] }) => s.items.map((i) => i.title));
  assert.deepEqual(titles.sort(), ["구간 안(시각)", "날짜만 오늘"].sort());
  assert.equal(rj.counts.outOfWindow, 3, "어제 20시·날짜만 어제·미래 시각");
  const today = rj.news[0].items.find((i: { title: string }) => i.title === "날짜만 오늘");
  assert.equal(today.timeApprox, true);
  const timed = rj.news[0].items.find((i: { title: string }) => i.title === "구간 안(시각)");
  assert.equal(timed.publishedAt, "2026-11-22T10:00:00+09:00");
  assert.equal(timed.timeApprox, undefined);
  assert.equal(rj.coverage.freshHours, 24);
  assert.equal(rj.coverage.windows.news.from, "2026-11-21T21:00:00+09:00");
  assert.equal(rj.coverage.windows.news.to, "2026-11-22T21:00:00+09:00");
  const md = fs.readFileSync(r.reportPath, "utf8");
  assert.match(md, /뉴스: \*\*11\/21 21:00 ~ 11\/22 21:00 KST\*\* \(실행 시점 기준 최근 24시간, \*\*발행 시각 단위\*\*로 판정\)/);
  assert.match(md, /유튜브: \*\*11\/21 21:00 ~ 11\/22 21:00 KST\*\* \(실행 시점 기준 최근 24시간, \*\*업로드 시각 단위\*\*/);
  assert.match(md, /조사 구간 밖 3건 제외/);
  assert.match(md, /발행 11\/22 10:00/);
  assert.match(md, /발행 11\/22\(시각 미확인\)/);
});

test("조사 구간: 세 모델에 같은 구간(뉴스 24시간·유튜브 freshHours)을 넘긴다", async () => {
  const out = path.join(tmpRoot, "window-pass");
  const seen: string[] = [];
  const { deps } = fakeDeps();
  const r = await run(out, {
    ...deps,
    categories: () => ({ news: [{ key: "ai", label: "🤖 AI" }], youtube: [{ key: "tools", label: "🛠️ 도구" }], freshHours: 12 }),
    collectNews: async (spec, raw, w) => {
      seen.push(`news:${w.news.hours}:${w.news.start.toISOString()}`);
      return deps.collectNews(spec, raw, w);
    },
    collectYoutube: async (spec, raw, w) => {
      seen.push(`yt:${w.youtube.hours}:${w.youtube.start.toISOString()}`);
      return deps.collectYoutube(spec, raw, w);
    },
  });
  assert.equal(new Set(seen.filter((x) => x.startsWith("news"))).size, 1, "세 모델이 같은 뉴스 구간");
  assert.ok(seen.includes(`news:24:${new Date(FIXED_NOW.getTime() - 24 * 3_600_000).toISOString()}`));
  assert.ok(seen.includes(`yt:12:${new Date(FIXED_NOW.getTime() - 12 * 3_600_000).toISOString()}`));
  // 유튜브 12시간 구간: 날짜만 있는 오늘 영상(0시 시작)은 구간 시작(09:00) 이전이라 보수적으로 빠진다.
  const rj = JSON.parse(fs.readFileSync(r.reportJsonPath, "utf8"));
  assert.equal(rj.youtube.length, 0);
  assert.equal(rj.coverage.windows.youtube.hours, 12);
});
