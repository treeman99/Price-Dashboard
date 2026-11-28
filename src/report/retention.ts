/**
 * 보고서 실행 기록 보관 — 봇 홈의 `runs/<runId>/`(운영 실행)·`previews/<runId>/`(시험 실행)를 완료 시각 기준
 * N일(기본 7일, 대시보드 `report.retentionDays`)이 지나면 지운다. 2026-11-28 사용자 결정
 * "1주일 기준으로 저장하면 될 것 같아. 그 이상 지난 뉴스를 볼 것 같진 않아."
 *
 * 누가·언제: 수집기(cli.ts)가 **실행이 끝날 때마다, 실행 잠금을 쥔 채로** 정리한다 — 별도 스케줄러가 없고,
 * 잠금 덕분에 그 순간 다른 수집기 실행이 진행 중일 수 없다. 운영 실행은 runs/·previews/ 둘 다, `--preview`
 * 실행은 previews/ 만 정리한다(시험 실행은 운영 기록을 건드리지 않는다).
 *
 * 지우지 않는 것(runs/):
 *  - 지금 끝난 실행(진행 중이던 실행), 가장 최근 실행(최신)
 *  - latest.json 의 runId·lastSuccessRunId, state/checkpoint.json 의 lastSuccessRunId, 가장 최근 성공 실행
 *    (직전 성공 — 7일이 지나도 남겨 증분 기준을 잃지 않는다)
 *  - 완료 기록(summary.json·report.json)이 없는 실행 중 최근 활동이 보관 기간 안인 것(진행 중일 수 있음)
 *  - 실행 ID 모양이 아닌 항목·심볼릭 링크(손으로 둔 파일은 건드리지 않는다)
 * state/·collector/·latest.json 등 runs/·previews/ 밖은 이 모듈이 보지도 않는다.
 *
 * latest.json·checkpoint.json 이 있는데 읽히지 않으면 보호 대상을 알 수 없으므로 runs/ 정리를 건너뛴다(안전 쪽).
 */
import fs from "node:fs";
import path from "node:path";

/** 기본 보관 기간(일). 대시보드 '통합 보고서' 설정의 `report.retentionDays` 가 우선한다. */
export const DEFAULT_RETENTION_DAYS = 7;

const DAY_MS = 86_400_000;
const RUN_ID_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{4}$/;

export type RetentionArea = "runs" | "previews";

/** 실행 폴더 1개의 보관 판정 재료. */
export interface RunMeta {
  runId: string;
  /** 실행 ID 의 시작 시각(ISO). */
  startedAt: string;
  /** 완료 시각(summary.json → report.json 의 finishedAt). 없으면 끝나지 않았거나 중단된 실행. */
  finishedAt: string | null;
  /** 성공 모델이 1개 이상이었나(완료 기록이 없으면 null). */
  ok: boolean | null;
  /** 완료 기록이 없을 때 쓰는 마지막 활동 시각(폴더 바로 아래 파일들의 최신 수정 시각, ISO). */
  lastActivityAt: string | null;
  /** 폴더 크기(바이트, 측정했을 때만). */
  bytes?: number;
}

export interface RetentionDecision extends RunMeta {
  /** 판정 기준 시각(완료 시각, 없으면 마지막 활동 시각·시작 시각 중 늦은 쪽). */
  basisAt: string;
  /** 남기는 이유(지우는 항목은 빈 배열). */
  reasons: string[];
}

export interface RetentionPlan {
  area: RetentionArea;
  days: number;
  now: string;
  /** 이 시각보다 **이전에** 끝난 실행을 지운다(정확히 N×24시간 된 실행은 남김). */
  cutoff: string;
  remove: RetentionDecision[];
  keep: RetentionDecision[];
  /** 정리를 건너뛴 이유(보호 대상을 확인하지 못함 등). 있으면 remove 는 비어 있다. */
  skipped: string | null;
}

export function isRunId(id: string): boolean {
  return RUN_ID_RE.test(id);
}

/** 실행 ID(UTC 시각) → Date. 형식이 아니면 null. */
export function runIdStart(runId: string): Date | null {
  const m = RUN_ID_RE.exec(runId);
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** 보관 기간(일) 정규화: 정수 1 이상, 이상한 값이면 기본값. */
export function normalizeRetentionDays(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.trunc(v) : DEFAULT_RETENTION_DAYS;
}

function validIso(v: unknown): string | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null;
}

function readJsonFile(file: string): { exists: boolean; value: Record<string, unknown> | null } {
  if (!fs.existsSync(file)) return { exists: false, value: null };
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return { exists: true, value: v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null };
  } catch {
    return { exists: true, value: null };
  }
}

function dirBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let names: fs.Dirent[] = [];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n.name);
      try {
        if (n.isDirectory()) walk(p);
        else total += fs.lstatSync(p).size;
      } catch {
        /* 사라진 파일 */
      }
    }
  };
  walk(dir);
  return total;
}

/** 실행 폴더에서 판정 재료를 읽는다(읽기만). */
export function readRunMeta(runDir: string, runId: string, measure = false): RunMeta {
  const startedAt = runIdStart(runId)?.toISOString() ?? new Date(0).toISOString();
  let finishedAt: string | null = null;
  let ok: boolean | null = null;
  // summary.json 은 실행의 마지막 기록(pipeline.ts) — 있으면 완료된 실행이다. 예전 실행·도중 중단 대비로 report.json 도 본다.
  const summary = readJsonFile(path.join(runDir, "summary.json"));
  for (const value of [summary.value, readJsonFile(path.join(runDir, "report.json")).value]) {
    const fin = validIso(value?.finishedAt);
    if (fin) {
      finishedAt = fin;
      ok = typeof value?.ok === "boolean" ? value.ok : null;
      break;
    }
  }
  // 2026-11-22 첫 배포본의 summary.json 에는 finishedAt 이 없다 — 마지막에 쓰는 파일이므로 그 수정 시각을 완료 시각으로 본다.
  if (!finishedAt && summary.value) {
    try {
      finishedAt = new Date(fs.statSync(path.join(runDir, "summary.json")).mtimeMs).toISOString();
      ok = typeof summary.value.ok === "boolean" ? summary.value.ok : null;
    } catch {
      /* 사라진 파일 */
    }
  }
  let lastActivityAt: string | null = null;
  if (!finishedAt) {
    let latest = 0;
    try {
      for (const n of fs.readdirSync(runDir)) {
        try {
          latest = Math.max(latest, fs.lstatSync(path.join(runDir, n)).mtimeMs);
        } catch {
          /* 사라진 파일 */
        }
      }
      latest = Math.max(latest, fs.lstatSync(runDir).mtimeMs);
    } catch {
      /* 폴더 없음 */
    }
    lastActivityAt = latest > 0 ? new Date(latest).toISOString() : null;
  }
  return { runId, startedAt, finishedAt, ok, lastActivityAt, ...(measure ? { bytes: dirBytes(runDir) } : {}) };
}

export interface PlanInput {
  area: RetentionArea;
  entries: RunMeta[];
  now: Date;
  days: number;
  /** 반드시 남길 실행 ID → 이유(지금 실행·latest.json·체크포인트 등). */
  protect?: Map<string, string>;
  /** 가장 최근 실행·가장 최근 성공 실행을 남긴다(runs/). previews/ 는 false. */
  keepNewestAndLastSuccess?: boolean;
}

/**
 * 보관 판정(순수 함수). 완료 시각이 cutoff(now - days×24h)보다 **이전**이면 지운다 — 경계(정확히 N일)는 남긴다.
 * 완료 기록이 없는 실행은 시작 시각·마지막 활동 시각이 **모두** cutoff 이전일 때만 지운다(진행 중일 수 있으므로).
 */
export function planRetention(input: PlanInput): RetentionPlan {
  const days = normalizeRetentionDays(input.days);
  const cutoffMs = input.now.getTime() - days * DAY_MS;
  const protect = new Map(input.protect ?? []);
  const sorted = [...input.entries].sort((a, b) => a.runId.localeCompare(b.runId));
  if (input.keepNewestAndLastSuccess && sorted.length) {
    const newest = sorted[sorted.length - 1].runId;
    protect.set(newest, protect.has(newest) ? `${protect.get(newest)}, 최신 실행` : "최신 실행");
    const lastOk = [...sorted].reverse().find((e) => e.ok === true);
    if (lastOk) protect.set(lastOk.runId, protect.has(lastOk.runId) ? `${protect.get(lastOk.runId)}, 직전 성공 실행` : "직전 성공 실행");
  }
  const remove: RetentionDecision[] = [];
  const keep: RetentionDecision[] = [];
  for (const e of sorted) {
    const basisMs = e.finishedAt
      ? Date.parse(e.finishedAt)
      : Math.max(Date.parse(e.startedAt), e.lastActivityAt ? Date.parse(e.lastActivityAt) : 0);
    const basisAt = new Date(basisMs).toISOString();
    const reasons: string[] = [];
    const p = protect.get(e.runId);
    if (p) reasons.push(p);
    if (basisMs >= cutoffMs) reasons.push(e.finishedAt ? "보관 기간 안" : "완료 기록 없음 — 최근 활동이 보관 기간 안(진행 중일 수 있음)");
    (reasons.length ? keep : remove).push({ ...e, basisAt, reasons });
  }
  return {
    area: input.area,
    days,
    now: input.now.toISOString(),
    cutoff: new Date(cutoffMs).toISOString(),
    remove,
    keep,
    skipped: null,
  };
}

/** 영역 폴더의 실행 목록(실행 ID 모양의 실제 폴더만 — 심볼릭 링크·파일은 제외). */
function listRunDirs(dir: string): string[] {
  let names: fs.Dirent[] = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names.filter((n) => n.isDirectory() && !n.isSymbolicLink() && isRunId(n.name)).map((n) => n.name);
}

export interface PlanOptions {
  now: Date;
  days: number;
  /** 지금 이 프로세스가 만든 실행(진행 중으로 취급해 항상 남긴다). */
  currentRunId?: string | null;
  /** 폴더 크기를 잰다(미리보기 보고용). */
  measure?: boolean;
}

/**
 * 봇 홈(outputDir)의 한 영역에 대한 보관 계획(읽기만 — 지우지 않는다).
 * runs/ 는 latest.json·checkpoint.json 이 가리키는 실행과 최신·직전 성공 실행을 보호한다.
 */
export function planAreaRetention(outputDir: string, area: RetentionArea, opts: PlanOptions): RetentionPlan {
  const dir = path.join(outputDir, area);
  const protect = new Map<string, string>();
  const add = (id: unknown, why: string) => {
    if (typeof id !== "string" || !isRunId(id)) return;
    protect.set(id, protect.has(id) ? `${protect.get(id)}, ${why}` : why);
  };
  if (opts.currentRunId) add(opts.currentRunId, "지금 실행(진행 중)");
  let skipped: string | null = null;
  if (area === "runs") {
    const latest = readJsonFile(path.join(outputDir, "latest.json"));
    const checkpoint = readJsonFile(path.join(outputDir, "state", "checkpoint.json"));
    if (latest.exists && !latest.value) skipped = "latest.json 을 읽지 못해 보호할 실행을 확인할 수 없음";
    else if (checkpoint.exists && !checkpoint.value) skipped = "state/checkpoint.json 을 읽지 못해 보호할 실행을 확인할 수 없음";
    add(latest.value?.runId, "latest.json 최신 실행");
    add(latest.value?.lastSuccessRunId, "latest.json 직전 성공 실행");
    add(checkpoint.value?.lastSuccessRunId, "체크포인트 직전 성공 실행(증분 기준)");
  }
  const entries = listRunDirs(dir).map((id) => readRunMeta(path.join(dir, id), id, !!opts.measure));
  const plan = planRetention({
    area,
    entries,
    now: opts.now,
    days: opts.days,
    protect,
    keepNewestAndLastSuccess: area === "runs",
  });
  if (skipped) return { ...plan, keep: [...plan.keep, ...plan.remove.map((d) => ({ ...d, reasons: [`정리 건너뜀: ${skipped}`] }))], remove: [], skipped };
  return plan;
}

export interface RetentionResult {
  area: RetentionArea;
  days: number;
  cutoff: string;
  removed: string[];
  kept: number;
  failed: { runId: string; error: string }[];
  skipped: string | null;
}

/**
 * 계획대로 지운다. 지우기 직전에 각 폴더를 다시 판정해(그새 완료 기록이 생겼거나 보호 대상이 됐으면) 건너뛴다.
 * 실패는 모아서 돌려주고 던지지 않는다 — 정리 실패가 보고서 실행을 실패로 만들면 안 된다.
 */
export function applyRetention(outputDir: string, plan: RetentionPlan, log: (msg: string) => void = () => {}): RetentionResult {
  const dir = path.join(outputDir, plan.area);
  const removed: string[] = [];
  const failed: { runId: string; error: string }[] = [];
  let keptOnRecheck = 0;
  const cutoffMs = Date.parse(plan.cutoff);
  for (const d of plan.remove) {
    const p = path.join(dir, d.runId);
    try {
      const st = fs.lstatSync(p);
      if (!st.isDirectory() || st.isSymbolicLink()) {
        keptOnRecheck++;
        continue;
      }
      const fresh = readRunMeta(p, d.runId);
      const basis = fresh.finishedAt
        ? Date.parse(fresh.finishedAt)
        : Math.max(Date.parse(fresh.startedAt), fresh.lastActivityAt ? Date.parse(fresh.lastActivityAt) : 0);
      if (basis >= cutoffMs) {
        keptOnRecheck++;
        continue;
      }
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(d.runId);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // 그새 이미 없어짐
      failed.push({ runId: d.runId, error: (e as Error).message });
    }
  }
  if (removed.length) log(`보고서 기록 정리(${plan.area}, ${plan.days}일 보관): ${removed.length}개 삭제 — ${removed.join(", ")}`);
  for (const f of failed) log(`⚠️ 보고서 기록 정리 실패(${plan.area}/${f.runId}): ${f.error}`);
  if (plan.skipped) log(`⚠️ 보고서 기록 정리 건너뜀(${plan.area}): ${plan.skipped}`);
  return {
    area: plan.area,
    days: plan.days,
    cutoff: plan.cutoff,
    removed,
    kept: plan.keep.length + keptOnRecheck + failed.length,
    failed,
    skipped: plan.skipped,
  };
}

/**
 * 실행이 끝날 때 부르는 정리 진입점. 운영 실행은 runs/·previews/, 시험 실행(preview)은 previews/ 만.
 * 호출부는 실행 잠금을 쥔 상태여야 한다(cli.ts main).
 */
export function pruneReportHistory(
  outputDir: string,
  opts: { now: Date; days: number; currentRunId: string | null; preview: boolean; log?: (msg: string) => void }
): RetentionResult[] {
  const areas: RetentionArea[] = opts.preview ? ["previews"] : ["runs", "previews"];
  return areas.map((area) =>
    applyRetention(outputDir, planAreaRetention(outputDir, area, { now: opts.now, days: opts.days, currentRunId: opts.currentRunId }), opts.log)
  );
}
