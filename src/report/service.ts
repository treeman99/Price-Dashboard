/**
 * 세 모델 통합 보고서 — price 서버 쪽 실행기(수집기 번들에는 들어가지 않는다).
 *
 * price 스케줄러가 '보고서' 일정(기본 09:00·17:00)마다 Orca IT News 봇 홈에 배포된 수집기
 * (`~/.orca/bots/it-news/daily-news/collector/daily-report.mjs`)를 자식 프로세스로 실행하고, 결과 파일을 읽어
 * 켜 둔 채널로 보고서를 메일·문자로 보낸다(같은 실행은 한 번만). 2026-11-23 부터 뉴스·유튜브 탭은 없고
 * '보고서' 탭이 유일한 화면이다 — 탭 스냅샷 반영은 하지 않는다. 화면용으로는 실행별 report.json 위에
 * 사용자 동작(카테고리 이동 오버레이, 본영상·제외·차단 상태)을 얹어 돌려준다.
 *
 * 왜 price 가 직접 실행하나(Orca 자동화·웹훅 대신): 중간에 LLM 단계가 없어 결정적이고, Orca 앱이 꺼져 있어도
 * 돌며, 결과를 price 가 바로 읽는다. 비밀값도 필요 없다 — 자식 프로세스에는 실행에 필요한 기본 환경 변수만 넘기고
 * `.env` 에서 읽은 값(메일·네이버 키 등)은 넘기지 않는다.
 *
 * 다른 실행(예: 아직 켜져 있는 Orca 자동화)이 수집기 잠금을 쥐고 있으면(종료 코드 3) 그 실행이 끝나길 기다렸다가
 * 그 결과를 이어받는다 — 같은 시각에 30분짜리 수집을 두 번 돌리지 않는다.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { deliverReport, reportChannels, type DeliveryResult, type ReportChannel } from "./deliver.ts";
import { reportEntryKey } from "./output.ts";
import { loadCategories as loadNewsCategories } from "../news/categories.ts";
import { loadCategories as loadYoutubeCategories } from "../youtube/categories.ts";
import { buildDomainMatcher } from "../news/excluded.ts";
import { addNewsReclass } from "../news/reclass.ts";
import { addReclass } from "../youtube/reclass.ts";
import { buildBlockMatcher } from "../youtube/blocklist.ts";
import { buildDismissMatcher } from "../youtube/dismissed.ts";
import { activeWatched } from "../youtube/watched.ts";
import { isRecommendedChannel } from "../../shared/youtube.ts";
import type {
  DailyReportAttempt,
  DailyReportEntryView,
  DailyReportJson,
  DailyReportListResponse,
  DailyReportModelOutcome,
  DailyReportRunSummary,
  DailyReportRunView,
  DailyReportSection,
} from "../../shared/report.ts";
import { getTabSettings } from "../settings/tab-settings.ts";

export type ReportTrigger = "schedule" | "catchup" | "manual";

const DATA_DIR = path.dirname(config.dbPath);
/** price 가 마지막으로 돌린 보고서 실행의 결과(catch-up·백오프·화면 판정용). 새 파일 — 기존 상태 파일과 무관. */
const ATTEMPT_PATH = path.join(DATA_DIR, "daily-report-attempt.json");
/** 실행별 발송 기록(같은 실행을 두 번 보내지 않는다). */
const DELIVERY_PATH = path.join(DATA_DIR, "daily-report-delivery.json");
/** 보고서 화면의 카테고리 이동 오버레이(실행별·항목별). 학습 기록(*-reclass.json)과 별도로 화면 반영용. */
const MOVES_PATH = path.join(DATA_DIR, "report-moves.json");
const DELIVERY_KEEP = 200;
/** 잠금 해제를 확인하는 간격(다른 실행 결과를 이어받을 때). */
const LOCK_POLL_MS = 20_000;
/** 실행 ID 형식(수집기 newRunId). 경로 조립 전에 반드시 확인한다. */
const RUN_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;

export interface CollectorRun {
  code: number | null;
  stdout: string;
  stderrTail: string;
  timedOut: boolean;
  spawnError: string | null;
}

export interface ReportServiceDeps {
  now(): Date;
  /** 수집기 실행. args 는 수집기 인자(노드·진입 파일 제외). */
  runCollector(args: string[], timeoutMs: number): Promise<CollectorRun>;
  sleep(ms: number): Promise<void>;
  deliver(r: DailyReportJson): Promise<DeliveryResult>;
}

function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (e) {
    log.warn(`보고서 파일 읽기 실패(${path.basename(file)}): ${(e as Error).message}`);
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function runsDir(): string {
  return path.join(config.dailyReport.dir, "runs");
}

export function isValidRunId(id: unknown): id is string {
  return typeof id === "string" && RUN_ID_RE.test(id);
}

// ── 수집기 실행 ──────────────────────────────────────────────────────────────

/**
 * 자식 프로세스 환경: 실행에 필요한 기본 변수만 넘긴다(허용 목록). price 는 dotenv 로 `.env` 를 process.env 에
 * 올려 두므로 통째로 넘기면 메일 OAuth·네이버 키·ANTHROPIC_API_KEY 까지 수집기로 새어 나간다.
 * PATH 에는 Homebrew 경로를 보탠다 — launchd 서비스의 PATH 가 짧아도 codex 를 찾게.
 */
export function collectorEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allow = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "__CF_USER_TEXT_ENCODING"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of allow) if (src[k]) env[k] = src[k];
  env.HOME ??= os.homedir();
  env.LANG ??= "ko_KR.UTF-8";
  const base = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  env.PATH = [...new Set([...(src.PATH ?? "").split(":").filter(Boolean), ...base])].join(":");
  return env;
}

/** 실제 실행기. 프로세스 그룹으로 띄워, 시간 초과 시 수집기가 띄운 모델 CLI 까지 함께 끝낸다. */
function spawnCollector(args: string[], timeoutMs: number): Promise<CollectorRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (r: CollectorRun) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [config.dailyReport.collector, ...args], {
        cwd: "/",
        env: collectorEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (e) {
      done({ code: null, stdout: "", stderrTail: "", timedOut: false, spawnError: (e as Error).message });
      return;
    }
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        /* 이미 끝남 */
      }
    };
    child.stdout?.on("data", (d: Buffer) => {
      stdout = (stdout + d.toString("utf8")).slice(-200_000);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-8_000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      log.warn(`통합 보고서 수집기 시간 초과(${Math.round(timeoutMs / 60_000)}분) → 종료`);
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 15_000).unref();
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderrTail: stderr, timedOut, spawnError: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderrTail: stderr, timedOut, spawnError: null });
    });
  });
}

const REAL_DEPS: ReportServiceDeps = {
  now: () => new Date(),
  runCollector: spawnCollector,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  deliver: (r) => deliverReport(r),
};

/** stdout 의 마지막 JSON 줄(수집기 결과). */
function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const l of lines) {
    const t = l.trim();
    if (!t.startsWith("{")) continue;
    try {
      return JSON.parse(t) as Record<string, unknown>;
    } catch {
      /* 다음 줄 */
    }
  }
  return null;
}

// ── 시도 기록·발송 기록 ──────────────────────────────────────────────────────

let attemptMemo: DailyReportAttempt | null | undefined;

export function getReportLastAttempt(): DailyReportAttempt | null {
  if (attemptMemo === undefined) attemptMemo = readJson<DailyReportAttempt>(ATTEMPT_PATH);
  return attemptMemo ?? null;
}

function recordAttempt(a: DailyReportAttempt): void {
  attemptMemo = a;
  try {
    writeJsonAtomic(ATTEMPT_PATH, a);
  } catch (e) {
    log.warn(`보고서 시도 기록 저장 실패: ${(e as Error).message}`);
  }
}

type DeliveryLedger = Record<string, Partial<Record<ReportChannel, string>>>;

function readDelivery(): DeliveryLedger {
  return readJson<DeliveryLedger>(DELIVERY_PATH) ?? {};
}

function noteDelivered(runId: string, sent: Partial<Record<ReportChannel, string>>): void {
  if (!Object.keys(sent).length) return;
  const all = readDelivery();
  all[runId] = { ...all[runId], ...sent };
  const keep = Object.keys(all).sort().slice(-DELIVERY_KEEP);
  try {
    writeJsonAtomic(DELIVERY_PATH, Object.fromEntries(keep.map((k) => [k, all[k]])));
  } catch (e) {
    log.warn(`보고서 발송 기록 저장 실패: ${(e as Error).message}`);
  }
}

/**
 * 보관 기간이 지나 봇 홈에서 정리된 실행(runs/<runId>/ 가 없어진 실행)의 발송 기록·카테고리 이동 오버레이를 지운다
 * (2026-11-28, 기본 7일). 실행 폴더 자체는 수집기가 정리한다(retention.ts) — 여기서는 price 쪽 기록만 맞춘다.
 *
 * 남기는 것: 실행 폴더가 아직 있는 실행(최신·직전 성공 실행 포함), latest.json·마지막 시도가 가리키는 실행, 보관 기간
 * 안에 시작한 실행, 실행 ID 모양이 아닌 키. 발송 중복 방지는 '이번에 끝난(또는 이어받은) 실행'의 기록만 보므로
 * (finishRun) 폴더가 없어진 옛 실행의 기록을 지워도 같은 보고서가 다시 나가지 않는다 — 그 실행은 report.json 이 없어
 * 발송 자체가 불가능하다. runs/ 를 읽지 못하면(봇 홈 경로 문제 등) 아무것도 지우지 않는다.
 */
export function pruneReportLedgers(now = new Date()): { delivery: string[]; moves: string[] } {
  const out = { delivery: [] as string[], moves: [] as string[] };
  let existing: Set<string>;
  try {
    existing = new Set(fs.readdirSync(runsDir()).filter(isValidRunId));
  } catch {
    return out;
  }
  const days = getTabSettings().report.retentionDays;
  const cutoff = now.getTime() - days * 86_400_000;
  const latest = readJson<{ runId?: string; lastSuccessRunId?: string }>(path.join(config.dailyReport.dir, "latest.json"));
  const protect = new Set([latest?.runId, latest?.lastSuccessRunId, getReportLastAttempt()?.runId].filter(isValidRunId));
  const stale = (id: string) => {
    if (!isValidRunId(id) || existing.has(id) || protect.has(id)) return false;
    const t = Date.parse(runIdTime(id));
    return Number.isFinite(t) && t < cutoff;
  };
  const prune = <T,>(file: string, ledger: Record<string, T>, removed: string[]) => {
    const drop = Object.keys(ledger).filter(stale);
    if (!drop.length) return;
    for (const id of drop) delete ledger[id];
    try {
      writeJsonAtomic(file, ledger);
      removed.push(...drop);
    } catch (e) {
      log.warn(`보고서 기록 정리 실패(${path.basename(file)}): ${(e as Error).message}`);
    }
  };
  prune(DELIVERY_PATH, readDelivery(), out.delivery);
  prune(MOVES_PATH, readMoves(), out.moves);
  if (out.delivery.length || out.moves.length) {
    log.info(
      `보고서 기록 정리(${days}일 보관, 실행 폴더가 정리된 실행): 발송 기록 ${out.delivery.length}건 · 카테고리 이동 ${out.moves.length}건`
    );
  }
  return out;
}

// ── 실행 ────────────────────────────────────────────────────────────────────

let running: { trigger: ReportTrigger; startedAt: string } | null = null;

export function isReportRunning(): boolean {
  return running !== null;
}

/**
 * 이 실행 결과를 자동으로 보낼까. 빈 보고서(새 항목 0건)는 보내지 않는다 — 하루 두 번 '새 항목 없음'만 오면
 * 사람은 곧 읽지 않게 된다. 실패 보고서는 연속 실패의 첫 회만 보낸다(백오프 재시도마다 실패 메일이 쌓이지 않게).
 */
export function shouldAutoDeliver(r: DailyReportJson, prev: DailyReportAttempt | null): boolean {
  if (!r.ok) return prev?.ok !== false;
  const items = r.news.reduce((a, s) => a + s.items.length, 0) + r.youtube.reduce((a, s) => a + s.items.length, 0);
  return items + r.seedsOnly.length > 0 || r.models.some((m) => m.outcome === "skipped-error");
}

/**
 * 다른 실행이 잠금을 쥐고 있을 때: 끝날 때까지 기다렸다가, **우리가 시작한 뒤 끝난** 실행이면 그 실행 ID.
 * 오래된 실행이나 이미 처리한 실행은 이어받지 않는다(같은 보고서를 두 번 반영·발송하지 않게).
 */
async function waitAndAdopt(startedAt: string, timeoutMs: number, deps: ReportServiceDeps): Promise<string | null> {
  const lock = path.join(config.dailyReport.dir, ".run.lock");
  const deadline = deps.now().getTime() + timeoutMs;
  log.info("통합 보고서: 다른 실행(Orca 자동화 등)이 진행 중 — 끝나면 그 결과를 이어받습니다");
  while (fs.existsSync(lock) && deps.now().getTime() < deadline) await deps.sleep(LOCK_POLL_MS);
  if (fs.existsSync(lock)) return null;
  const latest = readJson<{ runId?: string; finishedAt?: string }>(path.join(config.dailyReport.dir, "latest.json"));
  if (!isValidRunId(latest?.runId) || !latest?.finishedAt) return null;
  if (Date.parse(latest.finishedAt) < Date.parse(startedAt)) return null;
  if (getReportLastAttempt()?.runId === latest.runId) return null;
  return latest.runId;
}

/** 수집기가 남긴 실행 결과를 탭·발송에 반영한다. */
async function finishRun(
  runId: string,
  trigger: ReportTrigger,
  startedAt: string,
  adopted: boolean,
  deps: ReportServiceDeps
): Promise<DailyReportAttempt> {
  const runDir = path.join(runsDir(), runId);
  const report = readJson<DailyReportJson>(path.join(runDir, "report.json"));
  const finishedAt = () => deps.now().toISOString();
  if (!report) {
    const error = "보고서 결과(report.json)를 찾지 못했습니다 — 수집기 배포 버전을 확인하세요.";
    return { at: startedAt, finishedAt: finishedAt(), trigger, ok: false, runId, adopted, error };
  }

  // 발송 — 같은 실행은 한 번만(이어받은 실행 포함).
  if (!readDelivery()[runId]) {
    if (shouldAutoDeliver(report, getReportLastAttempt())) {
      const d = await deps.deliver(report);
      noteDelivered(runId, d.sent);
    } else {
      log.info(`통합 보고서 발송 생략 [${runId}] — ${report.ok ? "새 항목 없음" : "연속 실패(첫 회만 알림)"}`);
    }
  }

  return {
    at: startedAt,
    finishedAt: finishedAt(),
    trigger,
    ok: report.ok,
    runId,
    adopted,
    error: report.ok ? null : "세 모델이 모두 건너뛰었습니다(보고서 탭에서 모델별 사유 확인)",
  };
}

async function execute(trigger: ReportTrigger, startedAt: string, deps: ReportServiceDeps): Promise<DailyReportAttempt> {
  const fail = (error: string, runId: string | null = null): DailyReportAttempt => ({
    at: startedAt,
    finishedAt: deps.now().toISOString(),
    trigger,
    ok: false,
    runId,
    adopted: false,
    error,
  });
  if (!fs.existsSync(config.dailyReport.collector)) {
    return fail(`수집기가 없습니다(${config.dailyReport.collector}) — 저장소에서 npm run daily:report:bundle 로 배포하세요.`);
  }
  const timeoutMs = config.dailyReport.timeoutMin * 60_000;
  const args = ["--source-data", DATA_DIR, "--output", config.dailyReport.dir, "--trigger", `price:${trigger}`];
  log.info(`통합 보고서 수집기 실행 [${trigger}] — 세 모델 동시 취합(30분 안팎)`);
  const res = await deps.runCollector(args, timeoutMs);
  const json = lastJsonLine(res.stdout);
  const runId = isValidRunId(json?.runId) ? json.runId : null;

  if (res.code === 3) {
    const other = await waitAndAdopt(startedAt, timeoutMs, deps);
    if (!other) return fail("다른 보고서 실행이 진행 중이었고, 끝난 뒤 이어받을 새 결과를 찾지 못했습니다.");
    log.info(`통합 보고서: 다른 실행 결과를 이어받음 (${other})`);
    return finishRun(other, trigger, startedAt, true, deps);
  }
  if (res.spawnError) return fail(`수집기 실행 실패: ${res.spawnError}`);
  if (res.timedOut) return fail(`수집기가 ${config.dailyReport.timeoutMin}분 안에 끝나지 않아 중단했습니다.`, runId);
  if (!runId) {
    const tail = res.stderrTail.trim().split("\n").slice(-1)[0] ?? "";
    return fail(`수집기 오류(종료 코드 ${res.code}): ${String(json?.error ?? tail).slice(0, 300)}`);
  }
  return finishRun(runId, trigger, startedAt, false, deps);
}

/**
 * 통합 보고서 1회. 이미 실행 중이면 null(아무것도 하지 않는다). **throw 하지 않는다** — 실패도 시도 기록으로 남긴다.
 * 스케줄러·수동 라우트는 전역 LLM 슬롯 안에서 이 함수를 부른다(세 모델이 동시에 도는 무거운 작업이다).
 */
export async function runDailyReportJob(
  trigger: ReportTrigger,
  deps: ReportServiceDeps = REAL_DEPS
): Promise<DailyReportAttempt | null> {
  if (running) {
    log.warn(`통합 보고서 실행 중 → ${trigger} 중복 방지`);
    return null;
  }
  const startedAt = deps.now().toISOString();
  running = { trigger, startedAt };
  let attempt: DailyReportAttempt;
  try {
    attempt = await execute(trigger, startedAt, deps);
  } catch (e) {
    attempt = {
      at: startedAt,
      finishedAt: deps.now().toISOString(),
      trigger,
      ok: false,
      runId: null,
      adopted: false,
      error: `보고서 처리 예외: ${(e as Error).message}`,
    };
  } finally {
    running = null;
  }
  recordAttempt(attempt);
  // 수집기가 방금 보관 기간이 지난 실행 폴더를 정리했을 수 있다 — price 쪽 기록도 맞춘다(실패해도 실행 결과와 무관).
  try {
    pruneReportLedgers(deps.now());
  } catch (e) {
    log.warn(`보고서 기록 정리 실패: ${(e as Error).message}`);
  }
  if (attempt.ok) log.info(`통합 보고서 완료 [${trigger}] ${attempt.runId}${attempt.adopted ? " (이어받음)" : ""}`);
  else log.warn(`통합 보고서 실패 [${trigger}]: ${attempt.error}`);
  return attempt;
}

/**
 * 예정 시각(scheduled)이 정상 결과로 커버됐는가(catch-up·누락 집계 공용 술어).
 * 마지막 시도가 성공했고 그 시도가 예정 시각 이후에 끝났으면 커버. 시도 기록이 아예 없으면(배포 직후)
 * 봇 홈의 마지막 실행으로 판정한다 — 배포하자마자 30분짜리 보충이 도는 것을 막기 위한 첫 회 대체 경로다.
 */
export function reportCoveredAt(scheduled: Date): boolean {
  const a = getReportLastAttempt();
  if (a) return a.ok && Date.parse(a.finishedAt) >= scheduled.getTime();
  const latest = readJson<{ ok?: boolean; finishedAt?: string }>(path.join(config.dailyReport.dir, "latest.json"));
  return !!latest?.ok && !!latest.finishedAt && Date.parse(latest.finishedAt) >= scheduled.getTime();
}

// ── 화면용 조회 ──────────────────────────────────────────────────────────────

interface LegacySummary {
  runId: string;
  ok: boolean;
  successCount: number;
  models: { spec: { key: string; label: string }; outcome: DailyReportModelOutcome }[];
  counts: DailyReportRunSummary["counts"];
  trigger?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** 실행 ID(UTC 시각) → ISO. */
function runIdTime(runId: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(runId);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : "";
}

function summaryOf(runId: string, delivery: DeliveryLedger): DailyReportRunSummary | null {
  const dir = path.join(runsDir(), runId);
  const r = readJson<DailyReportJson>(path.join(dir, "report.json"));
  const delivered = delivery[runId] ?? {};
  if (r) {
    return {
      runId,
      trigger: r.trigger,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      ok: r.ok,
      successCount: r.successCount,
      modelCount: r.modelCount,
      models: r.models.map((m) => ({ key: m.key, label: m.label, outcome: m.outcome })),
      counts: r.counts,
      highlights: r.highlights.slice(0, 3),
      delivered,
    };
  }
  // report.json 이 생기기 전(2026-11-22 이전 배포본) 실행은 summary.json 으로 목록만 보여 준다.
  const s = readJson<LegacySummary>(path.join(dir, "summary.json"));
  if (!s) return null;
  return {
    runId,
    trigger: s.trigger ?? "cli",
    startedAt: s.startedAt ?? runIdTime(runId),
    finishedAt: s.finishedAt ?? runIdTime(runId),
    ok: s.ok,
    successCount: s.successCount,
    modelCount: s.models.length,
    models: s.models.map((m) => ({ key: m.spec.key, label: m.spec.label, outcome: m.outcome })),
    counts: s.counts,
    highlights: [],
    delivered,
  };
}

export function listReportRuns(limit = 40): DailyReportRunSummary[] {
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(runsDir()).filter(isValidRunId).sort().reverse();
  } catch {
    return [];
  }
  const delivery = readDelivery();
  const out: DailyReportRunSummary[] = [];
  for (const id of ids) {
    if (out.length >= limit) break;
    const s = summaryOf(id, delivery);
    if (s) out.push(s);
  }
  return out;
}

export function getReportOverview(limit = 40): DailyReportListResponse {
  const build = readJson<{ commit?: string; builtAt?: string }>(path.join(path.dirname(config.dailyReport.collector), "BUILD.json"));
  return {
    runs: listReportRuns(limit),
    running: running ? { trigger: running.trigger, startedAt: running.startedAt } : null,
    lastAttempt: getReportLastAttempt(),
    channels: reportChannels(),
    collector: {
      available: fs.existsSync(config.dailyReport.collector),
      commit: build?.commit ?? null,
      builtAt: build?.builtAt ?? null,
    },
    retentionDays: getTabSettings().report.retentionDays,
  };
}

type MovesLedger = Record<string, Record<string, { kind: "news" | "youtube"; toKey: string; at: string }>>;

function readMoves(): MovesLedger {
  return readJson<MovesLedger>(MOVES_PATH) ?? {};
}

/** 종류별 카테고리 key → 표시 라벨(이모지 포함, 보고서 표기와 같은 형식) + 원래 이름. */
function categoryDefs(kind: "news" | "youtube"): Map<string, { label: string; name: string }> {
  const defs = kind === "news" ? loadNewsCategories() : loadYoutubeCategories();
  return new Map(defs.map((d) => [d.key, { label: `${d.emoji} ${d.label}`.trim(), name: d.label }]));
}

/** 항목 키(예전 실행은 같은 규칙으로 만든다). */
function keyOf(e: DailyReportJson["news"][number]["items"][number]): string {
  return e.key ?? reportEntryKey(e.kind, e.url, e.title, e.videoId);
}

/**
 * 화면용 실행 보기: report.json 위에 ① 사용자 카테고리 이동 오버레이 ② 항목 상태(본영상·제외 영상·차단 채널·
 * 추천 채널·뉴스 제외 사이트)를 얹는다. 보고서 파일 자체는 고치지 않는다(봇 홈 산출물은 불변).
 */
export function buildRunView(report: DailyReportJson, moves: MovesLedger[string] = {}): DailyReportRunView {
  const watched = new Set(activeWatched().map((w) => w.videoId));
  const isDismissed = buildDismissMatcher();
  const isBlocked = buildBlockMatcher();
  const isExcluded = buildDomainMatcher();
  const ytDefs = loadYoutubeCategories();
  const recommendedOf = new Map(ytDefs.map((d) => [d.key, d.recommendedChannels ?? []]));
  const view = (kind: "news" | "youtube", sections: DailyReportSection[]) => {
    const defs = categoryDefs(kind);
    const order = [...defs.keys()];
    const out = new Map<string, { key: string; label: string; items: DailyReportEntryView[] }>();
    const ensure = (key: string, label: string) => {
      if (!out.has(key)) out.set(key, { key, label: defs.get(key)?.label ?? label, items: [] });
      return out.get(key)!;
    };
    for (const s of sections) ensure(s.key, s.label);
    for (const s of sections) {
      for (const e of s.items) {
        const key = keyOf(e);
        const mv = moves[key];
        const to = mv && mv.kind === kind && defs.has(mv.toKey) ? mv.toKey : null;
        const catKey = to ?? s.key;
        const videoId = kind === "youtube" ? (e.videoId ?? (key.startsWith("yt:") ? key.slice(3) : null)) : null;
        const state: DailyReportEntryView["state"] =
          kind === "youtube"
            ? {
                watched: !!videoId && watched.has(videoId),
                dismissed: isDismissed(videoId),
                blocked: isBlocked(e.source, e.channelHandle ?? null, catKey),
                recommended: isRecommendedChannel(recommendedOf.get(catKey) ?? [], e.source, e.channelHandle ?? null),
              }
            : { excluded: isExcluded(e.url) };
        ensure(catKey, catKey).items.push({
          ...e,
          key,
          videoId,
          categoryKey: catKey,
          categoryLabel: defs.get(catKey)?.label ?? e.categoryLabel,
          movedFrom: to && to !== s.key ? s.key : undefined,
          state,
        });
      }
    }
    // 정의 순서대로, 빈 칸은 뺀다(옮겨서 비게 된 카테고리 포함).
    return [...out.values()]
      .filter((x) => x.items.length)
      .sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99));
  };
  return { ...report, news: view("news", report.news), youtube: view("youtube", report.youtube) };
}

/** 실행 1건 상세. report.json 이 없는 옛 실행은 report.md 원문만. */
export function getReportRun(
  runId: string
): { report: DailyReportRunView | null; markdown: string | null; delivered: Partial<Record<ReportChannel, string>> } | null {
  if (!isValidRunId(runId)) return null;
  const dir = path.join(runsDir(), runId);
  if (!fs.existsSync(dir)) return null;
  const report = readJson<DailyReportJson>(path.join(dir, "report.json"));
  let markdown: string | null = null;
  if (!report) {
    try {
      markdown = fs.readFileSync(path.join(dir, "report.md"), "utf8");
    } catch {
      markdown = null;
    }
  }
  // 둘 다 없으면 보여 줄 것이 없는 실행이다(보관 기간 정리 도중이거나 깨진 폴더) — 없는 실행과 같이 다룬다(404).
  if (!report && markdown === null) return null;
  return { report: report ? buildRunView(report, readMoves()[runId]) : null, markdown, delivered: readDelivery()[runId] ?? {} };
}

/**
 * 보고서 항목을 다른 카테고리로 옮긴다: ① 화면 오버레이(이 실행의 이 항목) ② 학습 기록 — 유튜브는 기존
 * youtube-reclass.json, 뉴스는 news-reclass.json(제목+출처) — 다음 실행의 세 모델 프롬프트·편집 단계·통합 단계가 참고한다.
 * 잘못된 실행·항목·카테고리면 사유 문자열을 던진다.
 */
export function moveReportEntry(runId: string, key: string, toKey: string, now = new Date()): DailyReportRunView {
  if (!isValidRunId(runId)) throw new Error("실행 ID 형식이 올바르지 않습니다.");
  const report = readJson<DailyReportJson>(path.join(runsDir(), runId, "report.json"));
  if (!report) throw new Error("이 실행에는 구조화 보고서(report.json)가 없습니다.");
  const ledger = readMoves();
  const current = buildRunView(report, ledger[runId]);
  const all = [...current.news, ...current.youtube].flatMap((s) => s.items);
  const entry = all.find((e) => e.key === key);
  if (!entry) throw new Error("옮길 항목을 이 보고서에서 찾지 못했습니다.");
  const defs = categoryDefs(entry.kind);
  const to = defs.get(toKey);
  if (!to) throw new Error("옮길 카테고리를 찾지 못했습니다.");
  if (toKey === entry.categoryKey) return current;
  const from = defs.get(entry.categoryKey);
  const record = {
    title: entry.title,
    channel: entry.source,
    fromKey: entry.categoryKey,
    fromLabel: from?.name ?? entry.categoryKey,
    toKey,
    toLabel: to.name,
    movedAt: now.toISOString(),
  };
  if (entry.kind === "youtube") addReclass(record);
  else addNewsReclass(record);
  ledger[runId] = { ...ledger[runId], [key]: { kind: entry.kind, toKey, at: now.toISOString() } };
  // 오래된 실행의 오버레이는 최근 200개 실행만 남긴다.
  const keep = Object.keys(ledger).sort().slice(-DELIVERY_KEEP);
  writeJsonAtomic(MOVES_PATH, Object.fromEntries(keep.map((k) => [k, ledger[k]])));
  log.info(`보고서 항목 이동 [${runId}] ${entry.kind} "${entry.title.slice(0, 60)}" ${record.fromLabel} → ${record.toLabel}`);
  return buildRunView(report, ledger[runId]);
}

/**
 * 사용자가 화면에서 누른 '보내기' — 탭 스위치와 무관하게 고른 채널로 그 실행의 보고서를 보낸다(자격은 필요).
 * 시험 발송도 이 경로다.
 */
export async function sendReportRun(
  runId: string,
  channels: ReportChannel[],
  deliver: (r: DailyReportJson, only: ReportChannel[]) => Promise<DeliveryResult> = (r, only) => deliverReport(r, { only })
): Promise<DeliveryResult | null> {
  if (!isValidRunId(runId)) return null;
  const report = readJson<DailyReportJson>(path.join(runsDir(), runId, "report.json"));
  if (!report) return null;
  const d = await deliver(report, channels);
  noteDelivered(runId, d.sent);
  return d;
}

/** 테스트 전용 — 메모리 캐시 초기화. */
export function __resetReportServiceForTest(): void {
  attemptMemo = undefined;
  running = null;
}
