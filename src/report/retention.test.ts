// 보고서 실행 기록 보관(retention.ts) — 임시 봇 홈으로 판정·삭제를 검증한다(운영 폴더는 건드리지 않음).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RETENTION_DAYS,
  applyRetention,
  normalizeRetentionDays,
  planAreaRetention,
  planRetention,
  pruneReportHistory,
  readRunMeta,
  runIdStart,
  type RunMeta,
} from "./retention.ts";
import { parseArgs } from "./cli.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "report-retention-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = new Date("2026-11-28T09:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** 실행 ID(시작 시각) — 끝 4자리는 구분용. */
function idAt(ms: number, tag: string): string {
  return `${iso(ms).replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${tag}`;
}

function meta(runId: string, finishedAt: string | null, ok: boolean | null, lastActivityAt: string | null = null): RunMeta {
  return { runId, startedAt: runIdStart(runId)!.toISOString(), finishedAt, ok, lastActivityAt };
}

// ── 순수 판정 ────────────────────────────────────────────────────────────────

test("경계: 완료 시각이 정확히 7일 전이면 남기고, 그보다 1ms 이전이면 지운다", () => {
  const cutoff = NOW.getTime() - 7 * DAY;
  const exact = idAt(cutoff - 30 * 60_000, "aa01");
  const older = idAt(cutoff - 30 * 60_000 - 1000, "aa02");
  const newest = idAt(NOW.getTime() - 3600_000, "aa03");
  const plan = planRetention({
    area: "runs",
    now: NOW,
    days: 7,
    entries: [meta(exact, iso(cutoff), true), meta(older, iso(cutoff - 1), true), meta(newest, iso(NOW.getTime() - 60_000), true)],
    keepNewestAndLastSuccess: true,
  });
  assert.equal(plan.cutoff, iso(cutoff));
  assert.deepEqual(plan.remove.map((d) => d.runId), [older]);
  assert.deepEqual(plan.keep.map((d) => d.runId).sort(), [exact, newest].sort());
  assert.ok(plan.keep.find((d) => d.runId === exact)!.reasons.includes("보관 기간 안"));
});

test("판정은 시작이 아니라 완료 시각 기준: 7일 넘게 전에 시작했어도 7일 안에 끝났으면 남긴다", () => {
  const cutoff = NOW.getTime() - 7 * DAY;
  const id = idAt(cutoff - 2 * 3600_000, "bb01"); // 7일 2시간 전에 시작
  const plan = planRetention({ area: "previews", now: NOW, days: 7, entries: [meta(id, iso(cutoff + 1000), true)] });
  assert.equal(plan.remove.length, 0);
});

test("최신 실행과 직전 성공 실행은 7일이 지나도 남긴다(최신이 실패여도 직전 성공은 따로 보호)", () => {
  const oldOk = idAt(NOW.getTime() - 20 * DAY, "cc01");
  const olderOk = idAt(NOW.getTime() - 21 * DAY, "cc02");
  const newestFail = idAt(NOW.getTime() - 10 * DAY, "cc03");
  const plan = planRetention({
    area: "runs",
    now: NOW,
    days: 7,
    entries: [
      meta(olderOk, iso(NOW.getTime() - 21 * DAY), true),
      meta(oldOk, iso(NOW.getTime() - 20 * DAY), true),
      meta(newestFail, iso(NOW.getTime() - 10 * DAY), false),
    ],
    keepNewestAndLastSuccess: true,
  });
  assert.deepEqual(plan.remove.map((d) => d.runId), [olderOk]);
  assert.deepEqual(plan.keep.find((d) => d.runId === newestFail)!.reasons, ["최신 실행"]);
  assert.deepEqual(plan.keep.find((d) => d.runId === oldOk)!.reasons, ["직전 성공 실행"]);
});

test("보호 목록(latest.json·체크포인트·지금 실행)은 기간과 무관하게 남긴다", () => {
  const p1 = idAt(NOW.getTime() - 30 * DAY, "dd01");
  const p2 = idAt(NOW.getTime() - 29 * DAY, "dd02");
  const plan = planRetention({
    area: "previews",
    now: NOW,
    days: 7,
    entries: [meta(p1, iso(NOW.getTime() - 30 * DAY), true), meta(p2, iso(NOW.getTime() - 29 * DAY), true)],
    protect: new Map([[p1, "지금 실행(진행 중)"]]),
  });
  assert.deepEqual(plan.remove.map((d) => d.runId), [p2]);
  assert.deepEqual(plan.keep[0].reasons, ["지금 실행(진행 중)"]);
});

test("완료 기록이 없는 실행: 최근 활동이 보관 기간 안이면 남기고(진행 중일 수 있음), 시작·활동 모두 오래됐으면 지운다", () => {
  const live = idAt(NOW.getTime() - 9 * DAY, "ee01");
  const dead = idAt(NOW.getTime() - 9 * DAY, "ee02");
  const plan = planRetention({
    area: "previews",
    now: NOW,
    days: 7,
    entries: [meta(live, null, null, iso(NOW.getTime() - 60_000)), meta(dead, null, null, iso(NOW.getTime() - 8 * DAY))],
  });
  assert.deepEqual(plan.remove.map((d) => d.runId), [dead]);
  assert.match(plan.keep[0].reasons[0], /진행 중일 수 있음/);
});

test("보관 기간 정규화: 1 이상 정수만, 아니면 기본 7일", () => {
  assert.equal(DEFAULT_RETENTION_DAYS, 7);
  assert.equal(normalizeRetentionDays(3), 3);
  assert.equal(normalizeRetentionDays(2.9), 2);
  for (const bad of [0, -1, Number.NaN, "7", null, undefined]) assert.equal(normalizeRetentionDays(bad), 7);
  // 기간이 바뀌면 cutoff 도 바뀐다.
  const id = idAt(NOW.getTime() - 4 * DAY, "ff01");
  const newer = idAt(NOW.getTime() - 3600_000, "ff02");
  const entries = [meta(id, iso(NOW.getTime() - 4 * DAY), true), meta(newer, iso(NOW.getTime() - 60_000), true)];
  assert.equal(planRetention({ area: "previews", now: NOW, days: 3, entries }).remove.length, 1);
  assert.equal(planRetention({ area: "previews", now: NOW, days: 7, entries }).remove.length, 0);
});

// ── 실제 폴더 ────────────────────────────────────────────────────────────────

let homeSeq = 0;
function newHome(): string {
  const home = path.join(TMP, `home-${++homeSeq}`);
  fs.mkdirSync(path.join(home, "runs"), { recursive: true });
  fs.mkdirSync(path.join(home, "previews"), { recursive: true });
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  fs.mkdirSync(path.join(home, "collector"), { recursive: true });
  fs.writeFileSync(path.join(home, "collector", "daily-report.mjs"), "// 수집기\n");
  return home;
}

/** 완료된 실행(summary.json + report.json). */
function writeDone(home: string, area: "runs" | "previews", runId: string, finishedMs: number, ok = true): void {
  const dir = path.join(home, area, runId);
  fs.mkdirSync(path.join(dir, "models", "claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, "report.md"), "# 보고서\n");
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ runId, ok, finishedAt: iso(finishedMs - 1000) }));
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ runId, ok, finishedAt: iso(finishedMs) }));
  fs.writeFileSync(path.join(dir, "models", "claude", "trace.json"), "{}");
}

/** 완료 기록이 없는 실행(진행 중이거나 중단) — 파일·폴더 수정 시각을 activityMs 로 맞춘다. */
function writeIncomplete(home: string, area: "runs" | "previews", runId: string, activityMs: number): void {
  const dir = path.join(home, area, runId);
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.writeFileSync(path.join(dir, "run.log"), "수집 중…\n");
  const t = new Date(activityMs);
  for (const p of [path.join(dir, "run.log"), path.join(dir, "state"), dir]) fs.utimesSync(p, t, t);
}

test("runs/: 7일 지난 실행만 지우고 최신·latest.json·체크포인트 직전 성공·진행 중 실행과 runs/ 밖은 그대로 둔다", () => {
  const home = newHome();
  const now = Date.now();
  const r = {
    old1: idAt(now - 10 * DAY, "a001"), // 지움
    old2: idAt(now - 8 * DAY, "a002"), // 지움
    ckpt: idAt(now - 12 * DAY, "a003"), // 체크포인트 lastSuccessRunId → 남김
    recent: idAt(now - 2 * DAY, "a004"), // 기간 안 → 남김
    crashed: idAt(now - 9 * DAY, "a005"), // 완료 기록 없음 + 오래됨 → 지움
    live: idAt(now - 9 * DAY, "a006"), // 완료 기록 없음 + 최근 활동 → 남김
    latest: idAt(now - 3600_000, "a007"), // 최신·latest.json → 남김
  };
  writeDone(home, "runs", r.old1, now - 10 * DAY);
  writeDone(home, "runs", r.old2, now - 8 * DAY, false);
  writeDone(home, "runs", r.ckpt, now - 12 * DAY);
  writeDone(home, "runs", r.recent, now - 2 * DAY);
  writeIncomplete(home, "runs", r.crashed, now - 9 * DAY);
  writeIncomplete(home, "runs", r.live, now - 60_000);
  writeDone(home, "runs", r.latest, now - 60_000, false);
  fs.writeFileSync(path.join(home, "latest.json"), JSON.stringify({ runId: r.latest, ok: false, lastSuccessRunId: r.ckpt }));
  fs.writeFileSync(
    path.join(home, "state", "checkpoint.json"),
    JSON.stringify({ version: 1, lastSuccessAt: iso(now - 12 * DAY), lastSuccessRunId: r.ckpt, sources: {}, seen: { "url:x": iso(now - 13 * DAY) } })
  );
  // 손으로 둔 항목: 실행 ID 모양이 아닌 폴더·파일, 실행 ID 이름의 심볼릭 링크(가리키는 곳은 오래된 실행 폴더 모양).
  fs.mkdirSync(path.join(home, "runs", "notes"));
  fs.writeFileSync(path.join(home, "runs", "README.txt"), "메모");
  const outside = path.join(TMP, `outside-${homeSeq}`);
  writeDone(path.dirname(outside), path.basename(outside) as "runs", idAt(now - 30 * DAY, "zz01"), now - 30 * DAY);
  const linkName = idAt(now - 30 * DAY, "a008");
  fs.symlinkSync(path.join(outside, idAt(now - 30 * DAY, "zz01")), path.join(home, "runs", linkName));
  const ckptBefore = fs.readFileSync(path.join(home, "state", "checkpoint.json"), "utf8");
  const latestBefore = fs.readFileSync(path.join(home, "latest.json"), "utf8");

  const plan = planAreaRetention(home, "runs", { now: new Date(now), days: 7, currentRunId: r.latest });
  assert.deepEqual(plan.remove.map((d) => d.runId).sort(), [r.old1, r.old2, r.crashed].sort());
  const reasons = Object.fromEntries(plan.keep.map((d) => [d.runId, d.reasons.join(" / ")]));
  assert.match(reasons[r.ckpt], /체크포인트 직전 성공 실행/);
  assert.match(reasons[r.ckpt], /latest\.json 직전 성공 실행/);
  assert.match(reasons[r.latest], /지금 실행\(진행 중\)/);
  assert.match(reasons[r.latest], /최신 실행/);
  assert.match(reasons[r.live], /진행 중일 수 있음/);
  assert.match(reasons[r.recent], /보관 기간 안/);

  const res = applyRetention(home, plan);
  assert.deepEqual(res.removed.sort(), [r.old1, r.old2, r.crashed].sort());
  assert.equal(res.failed.length, 0);
  const left = fs.readdirSync(path.join(home, "runs")).sort();
  assert.deepEqual(left, [r.ckpt, r.recent, r.live, r.latest, linkName, "README.txt", "notes"].sort());
  assert.ok(fs.existsSync(path.join(outside, idAt(now - 30 * DAY, "zz01"), "summary.json")), "링크가 가리키는 곳은 그대로");
  assert.equal(fs.readFileSync(path.join(home, "state", "checkpoint.json"), "utf8"), ckptBefore, "체크포인트 불변");
  assert.equal(fs.readFileSync(path.join(home, "latest.json"), "utf8"), latestBefore, "latest.json 불변");
  assert.ok(fs.existsSync(path.join(home, "collector", "daily-report.mjs")), "collector/ 불변");
});

test("previews/: 운영 실행은 runs/·previews/ 둘 다, 시험 실행은 previews/ 만 정리한다", () => {
  const home = newHome();
  const now = Date.now();
  const runOld = idAt(now - 9 * DAY, "b001");
  const runNew = idAt(now - 3600_000, "b002");
  const pvOld = idAt(now - 9 * DAY, "b003");
  const pvNew = idAt(now - 2 * DAY, "b004");
  const pvCur = idAt(now - 9 * DAY, "b005"); // 시험 실행 '지금 실행'(인위적으로 오래된 ID)
  writeDone(home, "runs", runOld, now - 9 * DAY);
  writeDone(home, "runs", runNew, now - 60_000);
  writeDone(home, "previews", pvOld, now - 9 * DAY);
  writeDone(home, "previews", pvNew, now - 2 * DAY);
  writeDone(home, "previews", pvCur, now - 8 * DAY);
  fs.writeFileSync(path.join(home, "latest.json"), JSON.stringify({ runId: runNew, ok: true, lastSuccessRunId: runNew }));

  const logs: string[] = [];
  const preview = pruneReportHistory(home, { now: new Date(now), days: 7, currentRunId: pvCur, preview: true, log: (m) => logs.push(m) });
  assert.deepEqual(preview.map((r) => r.area), ["previews"]);
  assert.deepEqual(preview[0].removed, [pvOld]);
  assert.ok(fs.existsSync(path.join(home, "runs", runOld)), "시험 실행은 운영 기록(runs/)을 건드리지 않는다");
  assert.ok(fs.existsSync(path.join(home, "previews", pvCur)), "지금 실행은 남긴다");
  assert.match(logs.join("\n"), /보고서 기록 정리\(previews, 7일 보관\): 1개 삭제/);

  const prod = pruneReportHistory(home, { now: new Date(now), days: 7, currentRunId: runNew, preview: false });
  assert.deepEqual(prod.map((r) => [r.area, r.removed]), [
    ["runs", [runOld]],
    ["previews", [pvCur]],
  ]);
  assert.deepEqual(fs.readdirSync(path.join(home, "previews")), [pvNew]);
  assert.deepEqual(fs.readdirSync(path.join(home, "runs")), [runNew]);
});

test("latest.json·checkpoint.json 이 깨졌으면 runs/ 정리를 건너뛴다(previews/ 는 정리)", () => {
  for (const broken of ["latest.json", path.join("state", "checkpoint.json")]) {
    const home = newHome();
    const now = Date.now();
    const old = idAt(now - 9 * DAY, "c001");
    const cur = idAt(now - 60_000, "c002");
    const pv = idAt(now - 9 * DAY, "c003");
    writeDone(home, "runs", old, now - 9 * DAY);
    writeDone(home, "runs", cur, now - 30_000);
    writeDone(home, "previews", pv, now - 9 * DAY);
    fs.writeFileSync(path.join(home, "latest.json"), JSON.stringify({ runId: cur, ok: true }));
    fs.writeFileSync(path.join(home, broken), "{ 깨진 JSON");
    const logs: string[] = [];
    const res = pruneReportHistory(home, { now: new Date(now), days: 7, currentRunId: cur, preview: false, log: (m) => logs.push(m) });
    assert.equal(res[0].removed.length, 0, broken);
    assert.match(res[0].skipped ?? "", /읽지 못해/);
    assert.ok(fs.existsSync(path.join(home, "runs", old)), broken);
    assert.deepEqual(res[1].removed, [pv]);
    assert.match(logs.join("\n"), /정리 건너뜀\(runs\)/);
  }
});

test("지우기 직전 재판정: 계획 뒤에 완료 기록이 새로 생겨 기간 안이 되면 지우지 않는다", () => {
  const home = newHome();
  const now = Date.now();
  const id = idAt(now - 9 * DAY, "d001");
  const newest = idAt(now - 60_000, "d002");
  writeIncomplete(home, "previews", id, now - 9 * DAY);
  writeDone(home, "previews", newest, now - 30_000);
  const plan = planAreaRetention(home, "previews", { now: new Date(now), days: 7 });
  assert.deepEqual(plan.remove.map((d) => d.runId), [id]);
  fs.writeFileSync(path.join(home, "previews", id, "summary.json"), JSON.stringify({ ok: true, finishedAt: new Date(now).toISOString() }));
  const res = applyRetention(home, plan);
  assert.deepEqual(res.removed, []);
  assert.ok(fs.existsSync(path.join(home, "previews", id)));
});

test("readRunMeta: summary.json 우선, 없으면 report.json, 둘 다 없으면 마지막 활동 시각 + 크기 측정", () => {
  const home = newHome();
  const now = Date.now();
  const a = idAt(now - DAY, "e001");
  writeDone(home, "runs", a, now - DAY);
  const m = readRunMeta(path.join(home, "runs", a), a, true);
  assert.equal(m.finishedAt, iso(now - DAY));
  assert.equal(m.ok, true);
  assert.ok((m.bytes ?? 0) > 0);
  fs.rmSync(path.join(home, "runs", a, "summary.json"));
  assert.equal(readRunMeta(path.join(home, "runs", a), a).finishedAt, iso(now - DAY - 1000));
  // 첫 배포본(2026-11-22) 형식: summary.json 에 finishedAt 이 없음 → summary.json 수정 시각을 완료 시각으로.
  const legacy = idAt(now - 9 * DAY, "e003");
  const ldir = path.join(home, "runs", legacy);
  fs.mkdirSync(ldir, { recursive: true });
  fs.writeFileSync(path.join(ldir, "summary.json"), JSON.stringify({ runId: legacy, ok: true }));
  fs.writeFileSync(path.join(ldir, "report.md"), "# 옛 보고서\n");
  fs.utimesSync(path.join(ldir, "summary.json"), new Date(now - 9 * DAY + 600_000), new Date(now - 9 * DAY + 600_000));
  const ml = readRunMeta(ldir, legacy);
  assert.equal(ml.finishedAt, iso(now - 9 * DAY + 600_000));
  assert.equal(ml.ok, true);
  const b = idAt(now - 5 * DAY, "e002");
  writeIncomplete(home, "runs", b, now - 4 * DAY);
  const mb = readRunMeta(path.join(home, "runs", b), b);
  assert.equal(mb.finishedAt, null);
  assert.equal(Math.round(Date.parse(mb.lastActivityAt!) / 1000), Math.round((now - 4 * DAY) / 1000));
});

// ── CLI ──────────────────────────────────────────────────────────────────────

test("CLI 인자: --retention-plan·--retention-days", () => {
  const a = parseArgs(["--retention-plan", "--retention-days", "3", "--output", TMP]);
  assert.equal(a.retentionPlan, true);
  assert.equal(a.retentionDays, 3);
  assert.equal(parseArgs([]).retentionDays, null);
  assert.throws(() => parseArgs(["--retention-days", "0"]), /1 이상의 정수/);
});

test("CLI --retention-plan: 지울/남길 실행을 계산만 하고 아무것도 지우지 않는다(보관 기간은 price 설정에서 읽음)", () => {
  const home = newHome();
  const data = path.join(TMP, `data-${homeSeq}`);
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "tab-settings.json"), JSON.stringify({ report: { retentionDays: 3 } }));
  const now = Date.now();
  const old = idAt(now - 4 * DAY, "f001");
  const cur = idAt(now - 60_000, "f002");
  writeDone(home, "runs", old, now - 4 * DAY);
  writeDone(home, "runs", cur, now - 30_000);
  fs.writeFileSync(path.join(home, "latest.json"), JSON.stringify({ runId: cur, ok: true, lastSuccessRunId: cur }));
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const r = spawnSync(process.execPath, ["--import", "tsx", path.join(repo, "src", "report", "cli.ts"), "--retention-plan", "--output", home, "--source-data", data], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, DB_PATH: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { days: number; plans: { area: string; remove: { runId: string; bytes: number }[]; keep: { runId: string }[] }[] };
  assert.equal(out.days, 3, "data/tab-settings.json 의 report.retentionDays");
  const runs = out.plans.find((p) => p.area === "runs")!;
  assert.deepEqual(runs.remove.map((d) => d.runId), [old]);
  assert.ok(runs.remove[0].bytes > 0);
  assert.deepEqual(runs.keep.map((d) => d.runId), [cur]);
  assert.ok(fs.existsSync(path.join(home, "runs", old)), "미리 보기는 지우지 않는다");
});
