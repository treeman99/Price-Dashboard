// 보고서 기록 보관(price 쪽) — 수집기가 지운 실행을 화면·API·발송 기록이 안전하게 다루는지 검증한다.
//
// ⚠️ DB_PATH·DAILY_NEWS_DIR·DAILY_REPORT_COLLECTOR 를 임시 경로로 돌린 뒤 동적 import 한다(운영 data 불변, 실제 발송 없음).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DailyReportJson } from "../../shared/report.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "report-service-retention-"));
const DATA = path.join(TMP, "data");
const OUT = path.join(TMP, "daily-news");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(OUT, "collector"), { recursive: true });
process.env.DB_PATH = path.join(DATA, "price.db");
process.env.DAILY_NEWS_DIR = OUT;
process.env.DAILY_REPORT_COLLECTOR = path.join(OUT, "collector", "daily-report.mjs");
fs.writeFileSync(process.env.DAILY_REPORT_COLLECTOR, "// 가짜 — 테스트는 runCollector 를 주입한다\n");

const svc = await import("./service.ts");
const settings = await import("../settings/tab-settings.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const DELIVERY = path.join(DATA, "daily-report-delivery.json");
const MOVES = path.join(DATA, "report-moves.json");
const DAY = 86_400_000;

beforeEach(() => {
  svc.__resetReportServiceForTest();
  for (const f of ["daily-report-attempt.json", "daily-report-delivery.json", "report-moves.json", "tab-settings.json"]) {
    fs.rmSync(path.join(DATA, f), { force: true });
  }
  fs.rmSync(path.join(OUT, "runs"), { recursive: true, force: true });
  fs.rmSync(path.join(OUT, "latest.json"), { force: true });
});

function idAt(ms: number, tag: string): string {
  return `${new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${tag}`;
}

function report(id: string): DailyReportJson {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId: id,
    trigger: "price:schedule",
    preview: false,
    startedAt: now,
    finishedAt: now,
    ok: true,
    successCount: 1,
    modelCount: 1,
    models: [{ key: "claude", label: "Claude Opus 5.5", model: "claude-opus-5-5", actualModels: [], outcome: "success", reason: "", newsCount: 1, youtubeCount: 0, toolCalls: 1 }],
    editor: { label: null, model: null, ok: true, note: "" },
    highlights: [],
    counts: { before: 1, afterMerge: 1, alreadyReported: 0, reported: 1, seedsOnly: 0 },
    coverage: { lastSuccessAt: null, freshHours: 24, gap: null, geekNews: { ok: true, count: 0, since: "", until: "", error: null } },
    news: [],
    youtube: [],
    seedsOnly: [],
    sourceFailures: [],
  } as unknown as DailyReportJson;
}

function writeRun(id: string): void {
  const dir = path.join(OUT, "runs", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report(id)));
}

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;

test("발송·이동 기록: 실행 폴더가 정리됐고 보관 기간보다 오래된 실행만 지운다", () => {
  const now = Date.now();
  const kept = idAt(now - 10 * DAY, "aa01"); // 폴더가 남아 있음(직전 성공 등) → 남김
  const gone = idAt(now - 10 * DAY, "aa02"); // 폴더 없음 + 오래됨 → 지움
  const goneRecent = idAt(now - 2 * DAY, "aa03"); // 폴더 없음 + 기간 안 → 남김
  const latestGone = idAt(now - 11 * DAY, "aa04"); // latest.json 이 가리킴 → 남김
  writeRun(kept);
  fs.writeFileSync(path.join(OUT, "latest.json"), JSON.stringify({ runId: latestGone, ok: true }));
  const ledger = {
    [kept]: { email: "2026-11-18T00:30:00Z" },
    [gone]: { email: "2026-11-18T00:31:00Z", imessage: "2026-11-18T00:31:05Z" },
    [goneRecent]: { email: "2026-11-26T00:30:00Z" },
    [latestGone]: { email: "2026-11-17T00:30:00Z" },
    "not-a-run-id": { email: "x" },
  };
  fs.writeFileSync(DELIVERY, JSON.stringify(ledger));
  fs.writeFileSync(MOVES, JSON.stringify({ [gone]: { k: { kind: "news", toKey: "ai", at: "x" } }, [kept]: { k: { kind: "news", toKey: "ai", at: "x" } } }));

  const res = svc.pruneReportLedgers(new Date(now));
  assert.deepEqual(res, { delivery: [gone], moves: [gone] });
  assert.deepEqual(Object.keys(readJson(DELIVERY)).sort(), [kept, goneRecent, latestGone, "not-a-run-id"].sort());
  assert.deepEqual(Object.keys(readJson(MOVES)), [kept]);
  // 다시 돌려도 더 지울 것이 없다(파일도 다시 쓰지 않음).
  assert.deepEqual(svc.pruneReportLedgers(new Date(now)), { delivery: [], moves: [] });
});

test("발송 기록 정리는 대시보드 보관 기간(report.retentionDays)을 따르고, runs/ 를 못 읽으면 아무것도 지우지 않는다", () => {
  const now = Date.now();
  const gone = idAt(now - 4 * DAY, "bb01");
  fs.writeFileSync(DELIVERY, JSON.stringify({ [gone]: { email: "x" } }));
  // runs/ 자체가 없음 → 봇 홈 경로 문제일 수 있으니 지우지 않는다.
  assert.deepEqual(svc.pruneReportLedgers(new Date(now)).delivery, []);
  fs.mkdirSync(path.join(OUT, "runs"), { recursive: true });
  assert.deepEqual(svc.pruneReportLedgers(new Date(now)).delivery, [], "기본 7일 — 4일 전 실행은 남김");
  settings.saveTabSettings({ report: { retentionDays: 3 } });
  assert.deepEqual(svc.pruneReportLedgers(new Date(now)).delivery, [gone], "3일로 줄이면 지움");
});

test("보관 기간 설정: 기본 7일, 1~90일 정수만 저장, 목록 응답에 실린다", () => {
  assert.equal(settings.getTabSettings().report.retentionDays, 7);
  assert.equal(svc.getReportOverview().retentionDays, 7);
  assert.deepEqual(settings.getTabSettingsResponse().numberRules["report.retentionDays"], { min: 1, max: 90, unit: "일" });
  for (const bad of [0, 91, 2.5, "7"]) {
    assert.throws(() => settings.saveTabSettings({ report: { retentionDays: bad as number } }), /보고서 기록 보관 기간: 1~90일/);
  }
  settings.saveTabSettings({ report: { retentionDays: 14 } });
  assert.equal(svc.getReportOverview().retentionDays, 14);
  // 기본값과 같으면 저장분에서 빠진다(sparse) — 다른 보고서 설정은 그대로.
  settings.saveTabSettings({ report: { retentionDays: 7, notifyEmail: true } });
  assert.deepEqual(readJson(path.join(DATA, "tab-settings.json")).report, { notifyEmail: true });
});

test("정리된 실행: 목록에서 빠지고 상세·보내기·이동은 오류 없이 '없음'으로 응답한다", async () => {
  const now = Date.now();
  const live = idAt(now - 3600_000, "cc01");
  const gone = idAt(now - 9 * DAY, "cc02");
  const half = idAt(now - 9 * DAY, "cc03"); // 정리 도중(파일이 이미 빠진 폴더)
  writeRun(live);
  writeRun(gone);
  fs.mkdirSync(path.join(OUT, "runs", half, "models"), { recursive: true });
  assert.deepEqual(svc.listReportRuns().map((r) => r.runId), [live, gone]);
  fs.rmSync(path.join(OUT, "runs", gone), { recursive: true });
  assert.deepEqual(svc.listReportRuns().map((r) => r.runId), [live], "지운 실행·빈 폴더는 목록에 없다");
  assert.equal(svc.getReportRun(gone), null);
  assert.equal(svc.getReportRun(half), null, "report.json·report.md 가 모두 없으면 없는 실행으로 본다");
  assert.ok(svc.getReportRun(live)?.report);
  let sent = 0;
  assert.equal(await svc.sendReportRun(gone, ["email"], async () => ({ sent: { email: String(++sent) }, skipped: {}, errors: [] })), null);
  assert.equal(sent, 0, "지운 실행은 보내지 않는다");
  assert.throws(() => svc.moveReportEntry(gone, "k", "ai"), /report\.json/);
});

test("실행이 끝나면(price 경유) 수집기가 지운 실행의 발송 기록도 정리한다 — 이번 실행의 발송은 한 번만", async () => {
  const now = Date.now();
  const old = idAt(now - 9 * DAY, "dd01");
  const fresh = idAt(now - 1000, "dd02");
  writeRun(old);
  fs.writeFileSync(DELIVERY, JSON.stringify({ [old]: { email: "2026-11-19T00:30:00Z" } }));
  // 새 항목이 있는 보고서여야 자동 발송된다.
  const withItem = report(fresh);
  withItem.news = [
    {
      key: "ai",
      label: "AI",
      items: [{ key: "u", kind: "news", categoryKey: "ai", categoryLabel: "AI", title: "t", summary: "s", source: "x", url: "https://a.example/1", date: "2026-11-28", foundBy: [], secondary: [], conflict: "", update: false }],
    },
  ] as DailyReportJson["news"];
  const delivered: string[] = [];
  const deps = {
    now: () => new Date(),
    runCollector: async () => {
      // 수집기 흉내: 새 실행을 남기고, 보관 기간이 지난 실행 폴더를 정리한다.
      const dir = path.join(OUT, "runs", fresh);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(withItem));
      fs.writeFileSync(path.join(OUT, "latest.json"), JSON.stringify({ runId: fresh, ok: true, finishedAt: new Date().toISOString() }));
      fs.rmSync(path.join(OUT, "runs", old), { recursive: true });
      return { code: 0, stdout: `${JSON.stringify({ ok: true, runId: fresh })}\n`, stderrTail: "", timedOut: false, spawnError: null };
    },
    sleep: async () => {},
    deliver: async (r: DailyReportJson) => {
      delivered.push(r.runId);
      return { sent: { email: new Date().toISOString() }, skipped: {}, errors: [] };
    },
  };
  const a = await svc.runDailyReportJob("schedule", deps);
  assert.equal(a?.ok, true);
  assert.deepEqual(delivered, [fresh]);
  const ledger = readJson(DELIVERY);
  assert.deepEqual(Object.keys(ledger), [fresh], "지운 실행의 기록은 빠지고 이번 실행 기록만 남는다");
  // 같은 실행을 다시 처리하는 일은 없다(발송 기록 유지).
  assert.ok((ledger[fresh] as { email?: string }).email);
});
