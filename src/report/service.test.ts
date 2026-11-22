// 통합 보고서 실행기(price 쪽) — 가짜 수집기·모의 발송기로 검증한다(모델 호출·실제 발송 없음).
//
// ⚠️ DB_PATH·DAILY_NEWS_DIR·DAILY_REPORT_COLLECTOR 를 임시 경로로 돌린 뒤 동적 import 한다.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DailyReportJson } from "../../shared/report.ts";
import type { NewsSnapshot, YoutubeSnapshot } from "../../shared/types.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "report-service-"));
const DATA = path.join(TMP, "data");
const OUT = path.join(TMP, "daily-news");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(OUT, "collector"), { recursive: true });
process.env.DB_PATH = path.join(DATA, "price.db");
process.env.DAILY_NEWS_DIR = OUT;
process.env.DAILY_REPORT_COLLECTOR = path.join(OUT, "collector", "daily-report.mjs");
fs.writeFileSync(process.env.DAILY_REPORT_COLLECTOR, "// 가짜 — 테스트는 runCollector 를 주입한다\n");

const svc = await import("./service.ts");
const news = await import("../news/news.ts");
const yt = await import("../youtube/youtube.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

beforeEach(() => {
  svc.__resetReportServiceForTest();
  for (const f of ["daily-report-attempt.json", "daily-report-delivery.json"]) fs.rmSync(path.join(DATA, f), { force: true });
  fs.rmSync(path.join(OUT, "runs"), { recursive: true, force: true });
  fs.rmSync(path.join(OUT, "latest.json"), { force: true });
  fs.rmSync(path.join(OUT, ".run.lock"), { force: true });
});

let seq = 0;
function runId(): string {
  seq += 1;
  return `20261123T0${String(seq).padStart(5, "0")}Z-ab${String(seq % 100).padStart(2, "0")}`;
}

function report(id: string, over: Partial<DailyReportJson> = {}): DailyReportJson {
  return {
    version: 1,
    runId: id,
    trigger: "price:schedule",
    preview: false,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ok: true,
    successCount: 3,
    modelCount: 3,
    models: [
      { key: "claude", label: "Claude Opus 5.5", model: "claude-opus-5-5", actualModels: [], outcome: "success", reason: "", newsCount: 1, youtubeCount: 1, toolCalls: 1 },
    ],
    editor: { label: null, model: null, ok: true, note: "" },
    highlights: ["요약"],
    counts: { before: 2, afterMerge: 2, alreadyReported: 0, reported: 2, seedsOnly: 0 },
    coverage: { lastSuccessAt: null, freshDays: 2, gap: null, geekNews: { ok: true, count: 0, since: "", until: "", error: null } },
    news: [{ key: "ai", label: "AI", items: [{ kind: "news", categoryKey: "ai", categoryLabel: "AI", title: "새 기사", summary: "s", source: "src", url: "https://a.example/1", date: "2026-11-23", foundBy: ["Opus 5.5"], secondary: [], conflict: "", update: false }] }],
    youtube: [],
    seedsOnly: [],
    sourceFailures: [],
    ...over,
  };
}

function tabNews(title: string, n = 1): NewsSnapshot {
  return {
    date: "2026-11-23",
    updatedAt: new Date().toISOString(),
    source: "llm",
    notes: null,
    categories: [
      {
        key: "ai",
        label: "AI",
        emoji: "🤖",
        color: "#000",
        items: Array.from({ length: n }, (_, i) => ({ title: `${title}${i}`, source: "s", date: "2026-11-23", summary: "s", link: `https://a.example/${i}`, related: [], foundBy: ["Opus 5.5", "Gemini 4 Neon"] })),
      },
    ],
  };
}

function tabYoutube(n = 1): YoutubeSnapshot {
  return {
    date: "2026-11-23",
    updatedAt: new Date().toISOString(),
    source: "llm",
    freshDays: 2,
    notes: null,
    categories: [
      {
        key: "tools",
        label: "도구",
        emoji: "🛠️",
        color: "#000",
        items: Array.from({ length: n }, (_, i) => ({ title: `영상${i}`, channel: "c", date: "2026-11-23", summary: "s", url: `https://www.youtube.com/watch?v=abcdefghij${i}`, videoId: `abcdefghij${i}`, thumbnail: null })),
      },
    ],
  };
}

/** 수집기가 남기는 실행 결과를 흉내 낸다. */
function writeRun(id: string, r: DailyReportJson, tabs?: { news: NewsSnapshot; youtube: YoutubeSnapshot }): void {
  const dir = path.join(OUT, "runs", id);
  fs.mkdirSync(path.join(dir, "tabs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(r));
  if (tabs) {
    fs.writeFileSync(path.join(dir, "tabs", "news.json"), JSON.stringify(tabs.news));
    fs.writeFileSync(path.join(dir, "tabs", "youtube.json"), JSON.stringify(tabs.youtube));
  }
  fs.writeFileSync(path.join(OUT, "latest.json"), JSON.stringify({ runId: id, ok: r.ok, finishedAt: new Date().toISOString() }));
}

function deps(opts: {
  collector: (args: string[]) => Promise<{ code: number | null; stdout?: string; timedOut?: boolean }>;
  sleep?: () => Promise<void>;
}) {
  const delivered: DailyReportJson[] = [];
  const argsSeen: string[][] = [];
  return {
    delivered,
    argsSeen,
    deps: {
      now: () => new Date(),
      runCollector: async (args: string[]) => {
        argsSeen.push(args);
        const r = await opts.collector(args);
        return { code: r.code, stdout: r.stdout ?? "", stderrTail: "", timedOut: r.timedOut ?? false, spawnError: null };
      },
      sleep: opts.sleep ?? (async () => {}),
      deliver: async (r: DailyReportJson) => {
        delivered.push(r);
        return { sent: { email: new Date().toISOString() }, skipped: {}, errors: [] };
      },
    },
  };
}

test("성공: 통합 결과로 뉴스·유튜브 탭을 갱신하고(실행 중엔 '수집 중'), 보고서를 한 번 보내고, 시도를 기록한다", async () => {
  const id = runId();
  let collectingDuring = false;
  const d = deps({
    collector: async () => {
      collectingDuring = news.isNewsCollecting() && yt.isYoutubeCollecting();
      writeRun(id, report(id), { news: tabNews("통합"), youtube: tabYoutube(2) });
      return { code: 0, stdout: `${JSON.stringify({ ok: true, runId: id })}\n` };
    },
  });
  const a = await svc.runDailyReportJob("schedule", d.deps);
  assert.equal(a?.ok, true);
  assert.equal(a?.runId, id);
  assert.equal(collectingDuring, true, "실행 중에는 두 탭이 '수집 중'");
  assert.equal(news.isNewsCollecting() || yt.isYoutubeCollecting(), false, "끝나면 해제");
  assert.equal(news.getNewsSnapshot()?.categories[0].items[0].title, "통합0");
  assert.deepEqual(news.getNewsSnapshot()?.categories[0].items[0].foundBy, ["Opus 5.5", "Gemini 4 Neon"]);
  assert.equal(news.getNewsLastAttempt()?.ok, true);
  assert.equal(yt.getYoutubeSnapshot()?.categories[0].items.length, 2);
  assert.equal(yt.getYoutubeLastAttempt()?.ok, true);
  assert.equal(d.delivered.length, 1);
  assert.deepEqual(d.argsSeen[0], ["--source-data", DATA, "--output", OUT, "--trigger", "price:schedule"]);
  assert.equal(svc.getReportLastAttempt()?.runId, id);
  // 발송 기록 → 목록에 보낸 채널이 보인다
  const row = svc.listReportRuns().find((r) => r.runId === id);
  assert.ok(row?.delivered.email);
  // catch-up 판정: 이 시도가 끝난 뒤의 슬롯은 아직 커버가 아니다
  assert.equal(svc.reportCoveredAt(new Date(Date.now() - 60_000)), true);
  assert.equal(svc.reportCoveredAt(new Date(Date.now() + 60_000)), false);
});

test("세 모델 모두 건너뜀: 탭은 그대로(직전 유지), 실패 시도만 기록, 연속 실패는 첫 회만 알린다", async () => {
  // 먼저 정상 1회로 탭을 채운다.
  const okId = runId();
  await svc.runDailyReportJob(
    "schedule",
    deps({
      collector: async () => {
        writeRun(okId, report(okId), { news: tabNews("직전"), youtube: tabYoutube(1) });
        return { code: 0, stdout: JSON.stringify({ runId: okId }) };
      },
    }).deps
  );
  const failed = (id: string) =>
    deps({
      collector: async () => {
        writeRun(id, report(id, { ok: false, successCount: 0, news: [], highlights: [] }));
        return { code: 2, stdout: JSON.stringify({ ok: false, runId: id }) };
      },
    });
  const f1 = failed(runId());
  const a1 = await svc.runDailyReportJob("schedule", f1.deps);
  assert.equal(a1?.ok, false);
  assert.equal(news.getNewsSnapshot()?.categories[0].items[0].title, "직전0", "실패면 기존 스냅샷 유지");
  assert.equal(news.getNewsLastAttempt()?.ok, false);
  assert.equal(yt.getYoutubeLastAttempt()?.ok, false);
  assert.equal(f1.delivered.length, 1, "첫 실패는 알린다");
  const f2 = failed(runId());
  await svc.runDailyReportJob("catchup", f2.deps);
  assert.equal(f2.delivered.length, 0, "연속 실패는 다시 알리지 않는다");
  assert.equal(svc.reportCoveredAt(new Date(Date.now() - 3_600_000)), false, "실패 실행은 커버가 아니다");
});

test("새 항목이 없는 보고서는 자동 발송하지 않는다(탭은 그대로 갱신)", async () => {
  const id = runId();
  const d = deps({
    collector: async () => {
      writeRun(id, report(id, { news: [], highlights: [], counts: { before: 3, afterMerge: 3, alreadyReported: 3, reported: 0, seedsOnly: 0 } }), {
        news: tabNews("전체", 3),
        youtube: tabYoutube(1),
      });
      return { code: 0, stdout: JSON.stringify({ runId: id }) };
    },
  });
  const a = await svc.runDailyReportJob("schedule", d.deps);
  assert.equal(a?.ok, true);
  assert.equal(d.delivered.length, 0);
  assert.equal(news.getNewsSnapshot()?.categories[0].items.length, 3, "탭은 증분이 아니라 통합 결과 전체");
});

test("다른 실행(Orca 자동화 등)이 잠금을 쥐고 있으면 끝날 때까지 기다렸다가 그 결과를 이어받는다", async () => {
  const other = runId();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, ".run.lock"), "99999");
  let slept = 0;
  const d = deps({
    collector: async () => ({ code: 3, stdout: JSON.stringify({ ok: false, error: "다른 보고서 실행이 진행 중입니다." }) }),
    sleep: async () => {
      slept += 1;
      // 다른 실행이 끝났다: 결과를 남기고 잠금을 푼다.
      writeRun(other, report(other), { news: tabNews("이어받음"), youtube: tabYoutube(1) });
      fs.rmSync(path.join(OUT, ".run.lock"), { force: true });
    },
  });
  const a = await svc.runDailyReportJob("schedule", d.deps);
  assert.ok(slept >= 1);
  assert.equal(a?.ok, true);
  assert.equal(a?.adopted, true);
  assert.equal(a?.runId, other);
  assert.equal(news.getNewsSnapshot()?.categories[0].items[0].title, "이어받음0");
  assert.equal(d.delivered.length, 1);
  // 같은 실행을 또 이어받지 않는다(이미 처리·발송).
  fs.writeFileSync(path.join(OUT, ".run.lock"), "99999");
  const d2 = deps({
    collector: async () => ({ code: 3 }),
    sleep: async () => fs.rmSync(path.join(OUT, ".run.lock"), { force: true }),
  });
  const a2 = await svc.runDailyReportJob("catchup", d2.deps);
  assert.equal(a2?.ok, false);
  assert.equal(d2.delivered.length, 0);
});

test("수집기 오류·시간 초과·결과 없음은 실패 시도로 남고 throw 하지 않는다", async () => {
  const crash = await svc.runDailyReportJob("manual", deps({ collector: async () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: "price 데이터 폴더를 찾지 못했습니다" }) }) }).deps);
  assert.equal(crash?.ok, false);
  assert.match(crash?.error ?? "", /종료 코드 1.*데이터 폴더/);
  const slow = await svc.runDailyReportJob("manual", deps({ collector: async () => ({ code: null, timedOut: true }) }).deps);
  assert.match(slow?.error ?? "", /분 안에 끝나지 않아/);
});

test("동시에 두 번 부르면 두 번째는 아무것도 하지 않는다(null)", async () => {
  const id = runId();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const d = deps({
    collector: async () => {
      await gate;
      writeRun(id, report(id), { news: tabNews("x"), youtube: tabYoutube(1) });
      return { code: 0, stdout: JSON.stringify({ runId: id }) };
    },
  });
  const first = svc.runDailyReportJob("schedule", d.deps);
  assert.equal(svc.isReportRunning(), true);
  assert.equal(await svc.runDailyReportJob("manual", d.deps), null);
  release();
  assert.equal((await first)?.ok, true);
});

test("자식 환경: .env 비밀값(메일·네이버·API 키)은 넘기지 않고 기본 변수만, PATH 에 Homebrew 를 보탠다", () => {
  const env = svc.collectorEnv({
    PATH: "/usr/bin:/bin",
    HOME: "/Users/x",
    USER: "x",
    LANG: "ko_KR.UTF-8",
    TMPDIR: "/tmp/x",
    GMAIL_ADDRESS: "a@b.c",
    GOOGLE_CLIENT_SECRET: "s",
    ANTHROPIC_API_KEY: "k",
    NAVER_CLIENT_SECRET: "n",
    IMESSAGE_TO: "+82",
    DB_PATH: "/x/price.db",
  });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH", "TMPDIR", "USER"]);
  assert.match(env.PATH ?? "", /^\/usr\/bin:\/bin:\/opt\/homebrew\/bin/);
});

test("화면 '보내기': 고른 채널만 보내고 발송 기록을 남긴다, 잘못된 실행 ID 는 거부", async () => {
  const id = runId();
  writeRun(id, report(id));
  const calls: string[][] = [];
  const r = await svc.sendReportRun(id, ["imessage"], async (_r, only) => {
    calls.push(only);
    return { sent: { imessage: "2026-11-23T00:00:00.000Z" }, skipped: {}, errors: [] };
  });
  assert.deepEqual(calls, [["imessage"]]);
  assert.ok(r?.sent.imessage);
  assert.equal(svc.getReportRun(id)?.delivered.imessage, "2026-11-23T00:00:00.000Z");
  assert.equal(await svc.sendReportRun("../../etc", ["email"]), null);
  assert.equal(svc.getReportRun("../x"), null);
});

test("기록이 아예 없으면(배포 직후) 봇 홈의 마지막 성공 실행으로 커버를 판정한다", () => {
  assert.equal(svc.reportCoveredAt(new Date(Date.now() - 60_000)), false, "latest.json 도 없으면 커버 아님");
  fs.writeFileSync(path.join(OUT, "latest.json"), JSON.stringify({ runId: runId(), ok: true, finishedAt: new Date().toISOString() }));
  assert.equal(svc.reportCoveredAt(new Date(Date.now() - 60_000)), true);
});

test("실제 자식 프로세스 경로: 가짜 수집기 스크립트를 띄워 인자·환경(비밀값 제외)을 넘기고 결과를 읽는다", async () => {
  const id = runId();
  const probe = path.join(TMP, "probe.json");
  fs.writeFileSync(
    process.env.DAILY_REPORT_COLLECTOR!,
    `import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const out = args[args.indexOf("--output") + 1];
fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ args, envKeys: Object.keys(process.env), cwd: process.cwd() }));
const dir = path.join(out, "runs", ${JSON.stringify(id)});
fs.mkdirSync(path.join(dir, "tabs"), { recursive: true });
fs.writeFileSync(path.join(dir, "report.json"), ${JSON.stringify(JSON.stringify(report(id, { news: [], highlights: [] })))});
fs.writeFileSync(path.join(dir, "tabs", "news.json"), ${JSON.stringify(JSON.stringify(tabNews("실프로세스")))});
fs.writeFileSync(path.join(dir, "tabs", "youtube.json"), ${JSON.stringify(JSON.stringify(tabYoutube(1)))});
process.stderr.write("로그는 stderr\\n");
process.stdout.write(JSON.stringify({ ok: true, runId: ${JSON.stringify(id)} }) + "\\n");
`
  );
  process.env.GMAIL_ADDRESS = "secret@example.com";
  process.env.NAVER_CLIENT_SECRET = "naver-secret";
  try {
    const a = await svc.runDailyReportJob("manual"); // 실제 spawn(REAL_DEPS). 새 항목 0건이라 발송도 없다.
    assert.equal(a?.ok, true, a?.error ?? "");
    assert.equal(news.getNewsSnapshot()?.categories[0].items[0].title, "실프로세스0");
    const p = JSON.parse(fs.readFileSync(probe, "utf8")) as { args: string[]; envKeys: string[]; cwd: string };
    assert.deepEqual(p.args, ["--source-data", DATA, "--output", OUT, "--trigger", "price:manual"]);
    assert.equal(p.envKeys.includes("GMAIL_ADDRESS"), false);
    assert.equal(p.envKeys.includes("NAVER_CLIENT_SECRET"), false);
    assert.equal(p.envKeys.includes("DB_PATH"), false);
    assert.ok(p.envKeys.includes("PATH") && p.envKeys.includes("HOME"));
    assert.equal(p.cwd, "/");
  } finally {
    delete process.env.GMAIL_ADDRESS;
    delete process.env.NAVER_CLIENT_SECRET;
  }
});
