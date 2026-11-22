// 통합 보고서 실행기(price 쪽) — 가짜 수집기·모의 발송기로 검증한다(모델 호출·실제 발송 없음).
//
// ⚠️ DB_PATH·DAILY_NEWS_DIR·DAILY_REPORT_COLLECTOR 를 임시 경로로 돌린 뒤 동적 import 한다.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DailyReportJson } from "../../shared/report.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "report-service-"));
const DATA = path.join(TMP, "data");
const OUT = path.join(TMP, "daily-news");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(OUT, "collector"), { recursive: true });
process.env.DB_PATH = path.join(DATA, "price.db");
process.env.DAILY_NEWS_DIR = OUT;
process.env.DAILY_REPORT_COLLECTOR = path.join(OUT, "collector", "daily-report.mjs");
fs.writeFileSync(process.env.DAILY_REPORT_COLLECTOR, "// 가짜 — 테스트는 runCollector 를 주입한다\n");
fs.writeFileSync(
  path.join(DATA, "news-categories.json"),
  JSON.stringify([
    { key: "ai", label: "AI", emoji: "🤖", color: "#000" },
    { key: "sci", label: "과학", emoji: "⚛️", color: "#111" },
  ])
);
fs.writeFileSync(
  path.join(DATA, "youtube-categories.json"),
  JSON.stringify([
    { key: "tools", label: "도구", emoji: "🛠️", color: "#000", region: "global", recommendedChannels: ["추천채널"] },
    { key: "review", label: "리뷰", emoji: "📱", color: "#111", region: "kr" },
  ])
);

const svc = await import("./service.ts");
const blocklist = await import("../youtube/blocklist.ts");
const dismissed = await import("../youtube/dismissed.ts");
const watched = await import("../youtube/watched.ts");
const excluded = await import("../news/excluded.ts");
const ytReclass = await import("../youtube/reclass.ts");
const newsReclass = await import("../news/reclass.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

beforeEach(() => {
  svc.__resetReportServiceForTest();
  for (const f of ["daily-report-attempt.json", "daily-report-delivery.json", "report-moves.json"]) fs.rmSync(path.join(DATA, f), { force: true });
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
    news: [
      {
        key: "ai",
        label: "🤖 AI",
        items: [
          { key: "https://a.example/1", kind: "news", categoryKey: "ai", categoryLabel: "🤖 AI", title: "양자 기사", summary: "s", source: "과학일보", url: "https://a.example/1", date: "2026-11-23", foundBy: ["Opus 5.5"], secondary: [], conflict: "", update: false },
          { kind: "news", categoryKey: "ai", categoryLabel: "🤖 AI", title: "옛 형식 기사(키 없음)", summary: "s", source: "스팸뉴스", url: "https://www.spam.example/x?utm_source=a", date: "2026-11-23", foundBy: ["Opus 5.5"], secondary: [], conflict: "", update: false },
        ],
      },
    ],
    youtube: [
      {
        key: "tools",
        label: "🛠️ 도구",
        items: [
          { key: "yt:abcdefghij1", videoId: "abcdefghij1", channelHandle: null, kind: "youtube", categoryKey: "tools", categoryLabel: "🛠️ 도구", title: "영상1", summary: "s", source: "추천채널", url: "https://www.youtube.com/watch?v=abcdefghij1", date: "2026-11-23", foundBy: ["Opus 5.5"], secondary: [], conflict: "", update: false },
          { kind: "youtube", categoryKey: "tools", categoryLabel: "🛠️ 도구", title: "영상2", summary: "s", source: "차단채널", url: "https://www.youtube.com/watch?v=abcdefghij2", date: "2026-11-23", foundBy: ["Opus 5.5"], secondary: [], conflict: "", update: false },
        ],
      },
    ],
    seedsOnly: [],
    sourceFailures: [],
    ...over,
  };
}

/** 수집기가 남기는 실행 결과를 흉내 낸다. */
function writeRun(id: string, r: DailyReportJson): void {
  const dir = path.join(OUT, "runs", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(r));
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

test("성공: 보고서를 한 번 보내고 시도를 기록한다(뉴스·유튜브 탭 스냅샷은 더 쓰지 않는다)", async () => {
  const id = runId();
  const d = deps({
    collector: async () => {
      writeRun(id, report(id));
      return { code: 0, stdout: `${JSON.stringify({ ok: true, runId: id })}\n` };
    },
  });
  const a = await svc.runDailyReportJob("schedule", d.deps);
  assert.equal(a?.ok, true);
  assert.equal(a?.runId, id);
  assert.equal(d.delivered.length, 1);
  assert.deepEqual(d.argsSeen[0], ["--source-data", DATA, "--output", OUT, "--trigger", "price:schedule"]);
  assert.equal(svc.getReportLastAttempt()?.runId, id);
  assert.equal(fs.existsSync(path.join(DATA, "news-latest.json")), false, "탭 스냅샷 파일을 만들지 않는다");
  assert.equal(fs.existsSync(path.join(DATA, "youtube-latest.json")), false);
  const row = svc.listReportRuns().find((r) => r.runId === id);
  assert.ok(row?.delivered.email);
  assert.equal(svc.reportCoveredAt(new Date(Date.now() - 60_000)), true);
  assert.equal(svc.reportCoveredAt(new Date(Date.now() + 60_000)), false);
});

test("세 모델 모두 건너뜀: 실패 시도 기록, 연속 실패는 첫 회만 알린다", async () => {
  const failed = (id: string) =>
    deps({
      collector: async () => {
        writeRun(id, report(id, { ok: false, successCount: 0, news: [], youtube: [], highlights: [] }));
        return { code: 2, stdout: JSON.stringify({ ok: false, runId: id }) };
      },
    });
  const f1 = failed(runId());
  assert.equal((await svc.runDailyReportJob("schedule", f1.deps))?.ok, false);
  assert.equal(f1.delivered.length, 1, "첫 실패는 알린다");
  const f2 = failed(runId());
  await svc.runDailyReportJob("catchup", f2.deps);
  assert.equal(f2.delivered.length, 0, "연속 실패는 다시 알리지 않는다");
  assert.equal(svc.reportCoveredAt(new Date(Date.now() - 3_600_000)), false, "실패 실행은 커버가 아니다");
});

test("새 항목이 없는 보고서는 자동 발송하지 않는다", async () => {
  const id = runId();
  const d = deps({
    collector: async () => {
      writeRun(id, report(id, { news: [], youtube: [], highlights: [] }));
      return { code: 0, stdout: JSON.stringify({ runId: id }) };
    },
  });
  assert.equal((await svc.runDailyReportJob("schedule", d.deps))?.ok, true);
  assert.equal(d.delivered.length, 0);
});

test("다른 실행(Orca 자동화 등)이 잠금을 쥐고 있으면 끝날 때까지 기다렸다가 그 결과를 이어받는다(같은 실행은 두 번 안 받음)", async () => {
  const other = runId();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, ".run.lock"), "99999");
  let slept = 0;
  const d = deps({
    collector: async () => ({ code: 3, stdout: JSON.stringify({ ok: false, error: "다른 보고서 실행이 진행 중입니다." }) }),
    sleep: async () => {
      slept += 1;
      writeRun(other, report(other));
      fs.rmSync(path.join(OUT, ".run.lock"), { force: true });
    },
  });
  const a = await svc.runDailyReportJob("schedule", d.deps);
  assert.ok(slept >= 1);
  assert.equal(a?.adopted, true);
  assert.equal(a?.runId, other);
  assert.equal(d.delivered.length, 1);
  fs.writeFileSync(path.join(OUT, ".run.lock"), "99999");
  const d2 = deps({ collector: async () => ({ code: 3 }), sleep: async () => fs.rmSync(path.join(OUT, ".run.lock"), { force: true }) });
  const a2 = await svc.runDailyReportJob("catchup", d2.deps);
  assert.equal(a2?.ok, false);
  assert.equal(d2.delivered.length, 0);
});

test("수집기 오류·시간 초과는 실패 시도로 남고 throw 하지 않는다", async () => {
  const crash = await svc.runDailyReportJob("manual", deps({ collector: async () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: "price 데이터 폴더를 찾지 못했습니다" }) }) }).deps);
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
      writeRun(id, report(id));
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

test("보고서 보기: 항목 키(옛 형식은 같은 규칙으로 생성)와 사용자 상태(본영상·제외 영상·차단 채널·추천 채널·제외 사이트)를 얹는다", () => {
  const id = runId();
  writeRun(id, report(id));
  watched.markWatched({ videoId: "abcdefghij1", title: "영상1", channel: "추천채널" });
  blocklist.addBlock({ channel: "차단채널", handle: null, categoryKey: "tools" });
  excluded.addExcludedDomain({ url: "https://spam.example/" });
  const v = svc.getReportRun(id)!.report!;
  const [n1, n2] = v.news[0].items;
  assert.equal(n1.key, "https://a.example/1");
  assert.equal(n2.key, "https://spam.example/x", "옛 형식 항목은 정규화 URL 로 키를 만든다(추적 파라미터·www 제거)");
  assert.equal(n1.state.excluded, false);
  assert.equal(n2.state.excluded, true, "제외 사이트 기사 → 화면이 숨긴다");
  const [y1, y2] = v.youtube[0].items;
  assert.equal(y1.state.watched, true);
  assert.equal(y1.state.recommended, true, "이 카테고리의 추천 채널");
  assert.equal(y2.key, "yt:abcdefghij2");
  assert.equal(y2.videoId, "abcdefghij2");
  assert.equal(y2.state.blocked, true, "이 카테고리에서 차단한 채널");
  dismissed.addDismiss({ videoId: "abcdefghij1", title: "영상1", channel: "추천채널" });
  assert.equal(svc.getReportRun(id)!.report!.youtube[0].items[0].state.dismissed, true);
  // 원본 report.json 은 그대로다
  assert.equal(JSON.parse(fs.readFileSync(path.join(OUT, "runs", id, "report.json"), "utf8")).news[0].items[1].key, undefined);
});

test("카테고리 이동: 화면에 바로 반영(오버레이)되고, 학습 기록(뉴스 news-reclass·유튜브 youtube-reclass)이 다음 프롬프트 규칙이 된다", () => {
  const id = runId();
  writeRun(id, report(id));
  const v1 = svc.moveReportEntry(id, "https://a.example/1", "sci", new Date("2026-11-23T01:00:00Z"));
  assert.deepEqual(v1.news.map((s) => s.key), ["ai", "sci"]);
  const moved = v1.news.find((s) => s.key === "sci")!.items[0];
  assert.equal(moved.title, "양자 기사");
  assert.equal(moved.movedFrom, "ai");
  assert.equal(moved.categoryLabel, "⚛️ 과학");
  assert.match(newsReclass.buildNewsReclassSection([
    { key: "ai", label: "AI", emoji: "🤖", color: "#000" },
    { key: "sci", label: "과학", emoji: "⚛️", color: "#111" },
  ] as never), /"양자 기사" \(과학일보\) 같은 기사 → 'AI'가 아니라 '과학'에 넣어라/);

  const v2 = svc.moveReportEntry(id, "yt:abcdefghij1", "review");
  assert.deepEqual(v2.youtube.map((s) => s.key), ["tools", "review"]);
  assert.match(ytReclass.buildReclassSection([
    { key: "tools", label: "도구", emoji: "🛠️", color: "#000", region: "global" },
    { key: "review", label: "리뷰", emoji: "📱", color: "#111", region: "kr" },
  ] as never), /"영상1" \(추천채널\) 같은 영상 → '도구'가 아니라 '리뷰'에 넣어라/);

  // 다시 읽어도(새로고침) 이동이 남는다
  assert.equal(svc.getReportRun(id)!.report!.news.find((s) => s.key === "sci")!.items.length, 1);
  assert.throws(() => svc.moveReportEntry(id, "https://a.example/1", "없는키"), /카테고리를 찾지 못했습니다/);
  assert.throws(() => svc.moveReportEntry(id, "없는항목", "sci"), /항목을 이 보고서에서 찾지 못했습니다/);
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
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "report.json"), ${JSON.stringify(JSON.stringify(report(id, { news: [], youtube: [], highlights: [] })))});
process.stderr.write("로그는 stderr\\n");
process.stdout.write(JSON.stringify({ ok: true, runId: ${JSON.stringify(id)} }) + "\\n");
`
  );
  process.env.GMAIL_ADDRESS = "secret@example.com";
  process.env.NAVER_CLIENT_SECRET = "naver-secret";
  try {
    const a = await svc.runDailyReportJob("manual"); // 실제 spawn(REAL_DEPS). 새 항목 0건이라 발송도 없다.
    assert.equal(a?.ok, true, a?.error ?? "");
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
