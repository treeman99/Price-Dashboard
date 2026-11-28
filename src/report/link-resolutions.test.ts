// 경유 주소 처리의 통합 단계·지난 실행 기록(2026-11-28): URL 중복 통합·증분·사이트 제외가 원래 주소로 돌고,
// 지난 실행은 report.json 을 고치지 않고 link-resolutions.json 으로 덧씌우는지. 모델·네트워크는 가짜다.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NewsSnapshot } from "../../shared/types.ts";
import type { DailyReportJson } from "../../shared/report.ts";
import { canonicalUrl, deterministicMerge, itemKeys, splitIncremental, type ReportItem } from "./merge.ts";
import {
  applyLinkResolutions,
  collectReportRedirects,
  expandSeenWithResolutions,
  LINK_RESOLUTIONS_FILE,
  readLinkResolutionMaps,
  readLinkResolutions,
  resolveRunLinks,
} from "./link-resolutions.ts";
import { REPORT_MODELS } from "./models.ts";
import { runDailyReport, type PipelineDeps } from "./pipeline.ts";
import { buildReportEmailHtml } from "./deliver.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "link-resolutions-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const V = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/";

function item(p: Partial<ReportItem> & Pick<ReportItem, "id" | "model" | "title">): ReportItem {
  return { kind: "news", categoryKey: "ai", categoryLabel: "🤖 AI", summary: "s", source: "매체", url: null, date: "2026-11-28", related: [], ...p };
}

test("통합: 경유 주소는 키가 되지 않고, 풀린 원래 주소로 다른 모델의 같은 기사와 묶이며 대표는 원래 주소 쪽", () => {
  const items = [
    item({ id: "claude:news:0", model: "claude", title: "OpenAI 맞소송", url: "https://www.cnn.com/2026/11/27/tech/openai-apple" }),
    // Gemini 결과가 수집 단계에서 원래 주소로 풀린 경우 → 같은 키
    item({ id: "gemini:news:0", model: "gemini", title: "오픈AI 맞소송", url: "https://cnn.com/2026/11/27/tech/openai-apple/" }),
    // 못 푼 경유 주소 두 개(검색마다 토큰이 다르다) — 같은 기사라도 키로 묶지 않는다
    item({ id: "gemini:news:1", model: "gemini", title: "푸두", url: `${V}TOKEN_A`, sourceDomain: "prnewswire.com" }),
    item({ id: "gemini:news:2", model: "gemini", title: "푸두2", url: `${V}TOKEN_B`, related: [{ label: "BNN", link: `${V}TOKEN_C`, domain: "bnnbloomberg.ca" }] }),
  ];
  assert.deepEqual(itemKeys(items[2]), [], "경유 주소는 키가 아니다");
  const groups = deterministicMerge(items);
  assert.equal(groups.length, 3);
  const cnn = groups.find((g) => g.members.length === 2)!;
  assert.deepEqual(cnn.models, ["claude", "gemini"]);
  // 경유 주소 대표 + 다른 모델의 원래 주소 → 원래 주소를 대표로
  const mixed = deterministicMerge([
    item({ id: "gemini:news:0", model: "gemini", title: "x", url: `${V}T1`, related: [{ label: "원문", link: "https://www.reuters.com/x" }] }),
    item({ id: "claude:news:0", model: "claude", title: "x", url: "https://www.reuters.com/x" }),
  ]);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].rep.url, "https://www.reuters.com/x");
  assert.deepEqual(mixed[0].secondary, [{ label: "매체", link: `${V}T1` }]);
  // 못 푼 보조 출처는 도메인 힌트를 달고 간다
  const g2 = groups.find((g) => g.rep.id === "gemini:news:2")!;
  assert.deepEqual(g2.secondary, [{ label: "BNN", link: `${V}TOKEN_C`, domain: "bnnbloomberg.ca" }]);
});

test("증분: 매번 새로 생기는 경유 주소 토큰 때문에 이미 보고한 기사가 '새 출처' 업데이트로 다시 올라오지 않는다", () => {
  const seen = { "url:https://reuters.com/x": "2026-11-28T00:00:00.000Z" };
  const [g] = deterministicMerge([
    item({ id: "gemini:news:0", model: "gemini", title: "x", url: "https://www.reuters.com/x", related: [{ label: "새 토큰", link: `${V}FRESH` }] }),
  ]);
  const { fresh, alreadyReported } = splitIncremental([g], seen);
  assert.equal(alreadyReported.length, 1);
  assert.equal(fresh.length, 0);
});

test("지난 실행 경유 주소 키 → 풀이 기록의 원래 주소 키도 본 것으로(체크포인트는 그대로)", () => {
  const wrapper = `${V}OLD`;
  const seen = { [`url:${canonicalUrl(wrapper)}`]: "2026-11-27T08:00:00.000Z", "url:https://a.example/z": "2026-11-27T08:00:00.000Z" };
  const map = new Map([
    [wrapper, "https://news.hada.io/topic?id=37957&utm_source=x"],
    [`${V}NEVERSEEN`, "https://b.example/y"],
  ]);
  const out = expandSeenWithResolutions(seen, map);
  assert.equal(out["url:https://news.hada.io/topic?id=37957"], "2026-11-27T08:00:00.000Z");
  assert.equal(out["gn:37957"], "2026-11-27T08:00:00.000Z");
  assert.equal(out["url:https://b.example/y"], undefined, "보고한 적 없는 경유 주소는 더하지 않는다");
  assert.equal(Object.keys(seen).length, 2, "입력은 고치지 않는다");
});

function reportWith(items: DailyReportJson["news"][number]["items"]): DailyReportJson {
  return {
    version: 1,
    runId: "20261127T000000Z-6362",
    trigger: "price:schedule",
    preview: false,
    startedAt: "2026-11-27T00:00:00.000Z",
    finishedAt: "2026-11-27T00:15:00.000Z",
    ok: true,
    successCount: 3,
    modelCount: 3,
    models: [],
    editor: { label: null, model: null, ok: true, note: "" },
    highlights: [],
    counts: { before: 1, afterMerge: 1, alreadyReported: 0, reported: 1, seedsOnly: 0 },
    coverage: { lastSuccessAt: null, gap: null, geekNews: { ok: true, count: 0, since: "", until: "", error: null } },
    news: [{ key: "ai", label: "🤖 AI", items }],
    youtube: [],
    seedsOnly: [],
    sourceFailures: [],
  };
}

const entry = (over: Partial<DailyReportJson["news"][number]["items"][number]>) => ({
  kind: "news" as const,
  categoryKey: "ai",
  categoryLabel: "🤖 AI",
  title: "기사",
  summary: "s",
  source: "PR Newswire",
  url: null,
  date: "2026-11-27",
  foundBy: ["Gemini 4 Neon"],
  secondary: [],
  conflict: "",
  update: false,
  ...over,
});

test("지난 실행: 경유 주소를 풀어 link-resolutions.json 에만 쓰고 report.json 은 그대로, 덧씌우면 원래 주소·키 유지", async () => {
  const runDir = path.join(tmp, "out", "runs", "20261127T000000Z-6362");
  fs.mkdirSync(runDir, { recursive: true });
  const r = reportWith([
    entry({ key: canonicalUrl(`${V}PUDU`)!, url: `${V}PUDU`, secondary: [{ label: "BNN", link: `${V}GONE` }, { label: "원문", link: "https://a.example/1" }] }),
  ]);
  const reportPath = path.join(runDir, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(r, null, 2));
  const hash = () => crypto.createHash("sha256").update(fs.readFileSync(reportPath)).digest("hex");
  const before = hash();
  assert.deepEqual(collectReportRedirects(r).sort(), [`${V}GONE`, `${V}PUDU`]);

  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls++;
    return String(input).endsWith("PUDU")
      ? new Response(null, { status: 302, headers: { location: "https://www.prnewswire.com/apac/pudu.html" } })
      : new Response("Not Found", { status: 404 });
  };
  const s1 = await resolveRunLinks(runDir, { fetchImpl, now: new Date("2026-11-28T08:30:00Z") });
  assert.deepEqual(s1, { total: 2, resolved: 1, unresolved: 1, requested: 2, wrote: true });
  assert.equal(hash(), before, "report.json 은 바이트 하나 안 바뀐다");
  const file = readLinkResolutions(runDir)!;
  assert.deepEqual(file.resolved, { [`${V}PUDU`]: "https://www.prnewswire.com/apac/pudu.html" });
  assert.ok(file.unresolved[`${V}GONE`]);

  // 다시 돌리면 이미 푼 주소는 요청하지 않고 못 푼 것만 다시 시도
  calls = 0;
  const s2 = await resolveRunLinks(runDir, { fetchImpl });
  assert.equal(s2.requested, 1);
  assert.ok(calls >= 1 && calls <= 2, "못 푼 1건만(HEAD+GET)");

  const view = applyLinkResolutions(r, readLinkResolutions(runDir));
  const e = view.news[0].items[0];
  assert.equal(e.url, "https://www.prnewswire.com/apac/pudu.html");
  assert.equal(e.key, canonicalUrl(`${V}PUDU`), "항목 키는 그대로(카테고리 이동 기록이 키에 묶여 있다)");
  assert.deepEqual(e.secondary.map((x) => x.link), [`${V}GONE`, "https://a.example/1"], "못 푼 것은 그대로");
  assert.equal(applyLinkResolutions(r, null), r);

  const map = readLinkResolutionMaps(path.join(tmp, "out"), new Date("2026-11-28T09:00:00Z"));
  assert.equal(map.get(`${V}PUDU`), "https://www.prnewswire.com/apac/pudu.html");
  assert.equal(readLinkResolutionMaps(path.join(tmp, "out"), new Date("2026-12-31T00:00:00Z")).size, 0, "오래된 실행은 안 본다");
});

test("메일: 기사마다 원래 사이트 도메인, 못 푼 경유 주소는 '원래 주소 확인 불가'(아는 도메인 함께)", () => {
  const html = buildReportEmailHtml(
    reportWith([
      entry({ title: "풀린 기사", url: "https://www.prnewswire.com/apac/pudu.html" }),
      entry({ title: "못 푼 기사", url: `${V}X`, sourceDomain: "bnnbloomberg.ca", secondary: [{ label: "CNN", link: `${V}Y` }] }),
    ])
  );
  assert.match(html, /prnewswire\.com/);
  assert.match(html, /bnnbloomberg\.ca · 원래 주소 확인 불가/);
  assert.match(html, /CNN<\/a> \(원래 주소 확인 불가\)/);
});

test("파이프라인: 지난 실행에 경유 주소로 보고된 기사는 원래 주소로 다시 와도 새 항목이 아니고, 못 푼 주소는 힌트 도메인으로 제외", async () => {
  const out = path.join(tmp, "pipe");
  const wrapper = `${V}REPORTED_BEFORE`;
  fs.mkdirSync(path.join(out, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(out, "state", "checkpoint.json"),
    JSON.stringify({ version: 1, lastSuccessAt: "2026-11-28T00:15:00.000Z", lastSuccessRunId: "x", sources: {}, seen: { [`url:${canonicalUrl(wrapper)}`]: "2026-11-28T00:15:00.000Z" } })
  );
  const prevRun = path.join(out, "runs", "20261128T000000Z-8ae7");
  fs.mkdirSync(prevRun, { recursive: true });
  fs.writeFileSync(
    path.join(prevRun, LINK_RESOLUTIONS_FILE),
    JSON.stringify({ version: 1, runId: "20261128T000000Z-8ae7", updatedAt: "", resolved: { [wrapper]: "https://www.prnewswire.com/apac/pudu.html" }, unresolved: {} })
  );
  const now = new Date("2026-11-28T08:00:00Z");
  const at = "2026-11-28T15:00:00+09:00";
  const snap = (items: NewsSnapshot["categories"][number]["items"]): NewsSnapshot => ({
    date: "2026-11-28",
    updatedAt: now.toISOString(),
    source: "llm",
    categories: [{ key: "ai", label: "AI", emoji: "🤖", color: "#000", items }],
    notes: null,
  });
  const news: Record<string, NewsSnapshot> = {
    claude: snap([{ title: "푸두 300% 성장", source: "PR Newswire", date: "2026-11-28", publishedAt: at, summary: "s", link: "https://www.prnewswire.com/apac/pudu.html", related: [] }]),
    gpt: snap([{ title: "새 기사", source: "Reuters", date: "2026-11-28", publishedAt: at, summary: "s", link: "https://www.reuters.com/new", related: [] }]),
    gemini: snap([
      { title: "새 기사(Gemini)", source: "Reuters", date: "2026-11-28", publishedAt: at, summary: "s", link: "https://reuters.com/new/", related: [] },
      { title: "스팸 사이트 기사", source: "스팸", date: "2026-11-28", publishedAt: at, summary: "s", link: `${V}SPAM`, sourceDomain: "spam.example", related: [] },
      { title: "못 푼 기사", source: "어딘가", date: "2026-11-28", publishedAt: at, summary: "s", link: `${V}NOHINT`, sourceDomain: "somewhere.example", related: [] },
    ]),
  };
  const deps: PipelineDeps = {
    now: () => new Date(now),
    categories: () => ({ news: [{ key: "ai", label: "🤖 AI" }], youtube: [], freshHours: 24 }),
    collectRaw: async () => ({ geekNews: { ok: true, entries: [], error: null, since: "", until: "" }, seeds: new Map(), sources: [] }),
    collectNews: async (spec) => news[spec.key],
    collectYoutube: async () => ({ date: "2026-11-28", updatedAt: now.toISOString(), source: "llm", categories: [], notes: null }) as never,
    runEditor: async () => {
      throw new Error("편집기 없음 — 결정론적 통합");
    },
    exclusions: () => ({
      newsUrl: (url, hint) => /spam\.example/.test(String(url)) || hint === "spam.example",
      youtubeChannel: () => false,
      youtubeVideo: () => false,
    }),
    trace: (_s, fn) => fn(),
    log: () => {},
  };
  const res = await runDailyReport(deps, {
    runId: "20261128T080000Z-1111",
    runDir: path.join(out, "runs", "20261128T080000Z-1111"),
    outputDir: out,
    preview: false,
    models: REPORT_MODELS,
    retryDelayMs: 0,
  });
  assert.equal(res.counts.excludedByUser, 1);
  assert.equal(res.counts.alreadyReported, 1, "경유 주소로 이미 보고한 푸두 기사");
  const rj = JSON.parse(fs.readFileSync(res.reportJsonPath, "utf8")) as DailyReportJson;
  const items = rj.news.flatMap((s) => s.items);
  assert.deepEqual(items.map((i) => i.title).sort(), ["못 푼 기사", "새 기사"].sort());
  const fresh = items.find((i) => i.title === "새 기사")!;
  assert.deepEqual(fresh.foundBy.sort(), ["GPT-6.1 Sol", "Gemini 4 Neon"].sort(), "원래 주소로 두 모델이 묶인다");
  const unresolved = items.find((i) => i.title === "못 푼 기사")!;
  assert.equal(unresolved.sourceDomain, "somewhere.example", "report.json 에 힌트 도메인이 남는다");
  // 체크포인트 파일에는 판정용 확장 키를 쓰지 않는다(이번에 보고한 키만 더해진다)
  const cp = JSON.parse(fs.readFileSync(path.join(out, "state", "checkpoint.json"), "utf8"));
  assert.equal(cp.seen["url:https://prnewswire.com/apac/pudu.html"], undefined);
});
