/**
 * 세 모델 통합 보고서 — price 서버 쪽 실행기(수집기 번들에는 들어가지 않는다).
 *
 * price 스케줄러가 '보고서' 일정(기본 09:00·17:00)마다 Orca IT News 봇 홈에 배포된 수집기
 * (`~/.orca/bots/it-news/daily-news/collector/daily-report.mjs`)를 자식 프로세스로 실행하고, 결과 파일을 읽어
 *   1) 뉴스·유튜브 탭 스냅샷을 통합 결과로 갱신하고(기존 보호 규칙 그대로 — 결과가 비면 직전 유지),
 *   2) 켜 둔 채널로 보고서를 메일·문자로 보낸다(같은 실행은 한 번만).
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
import { applyNewsReportSnapshot, markNewsCollecting, recordNewsReportFailure } from "../news/news.ts";
import { applyYoutubeReportSnapshot, markYoutubeCollecting, recordYoutubeReportFailure } from "../youtube/youtube.ts";
import { deliverReport, reportChannels, type DeliveryResult, type ReportChannel } from "./deliver.ts";
import type {
  DailyReportAttempt,
  DailyReportJson,
  DailyReportListResponse,
  DailyReportModelOutcome,
  DailyReportRunSummary,
} from "../../shared/report.ts";
import type { NewsSnapshot, YoutubeSnapshot } from "../../shared/types.ts";

export type ReportTrigger = "schedule" | "catchup" | "manual";

const DATA_DIR = path.dirname(config.dbPath);
/** price 가 마지막으로 돌린 보고서 실행의 결과(catch-up·백오프·화면 판정용). 새 파일 — 기존 상태 파일과 무관. */
const ATTEMPT_PATH = path.join(DATA_DIR, "daily-report-attempt.json");
/** 실행별 발송 기록(같은 실행을 두 번 보내지 않는다). */
const DELIVERY_PATH = path.join(DATA_DIR, "daily-report-delivery.json");
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
  const tag = `report:${trigger}`;
  const finishedAt = () => deps.now().toISOString();
  if (!report) {
    const error = "보고서 결과(report.json)를 찾지 못했습니다 — 수집기 배포 버전을 확인하세요.";
    recordNewsReportFailure(startedAt, tag, error);
    recordYoutubeReportFailure(startedAt, tag, error);
    return { at: startedAt, finishedAt: finishedAt(), trigger, ok: false, runId, adopted, error };
  }

  if (report.ok) {
    const news = readJson<NewsSnapshot>(path.join(runDir, "tabs", "news.json"));
    const yt = readJson<YoutubeSnapshot>(path.join(runDir, "tabs", "youtube.json"));
    if (news) applyNewsReportSnapshot(news, startedAt, tag);
    else recordNewsReportFailure(startedAt, tag, "통합 결과에 뉴스 탭 파일이 없습니다");
    if (yt) applyYoutubeReportSnapshot(yt, startedAt, tag);
    else recordYoutubeReportFailure(startedAt, tag, "통합 결과에 유튜브 탭 파일이 없습니다");
  } else {
    const why = `세 모델이 모두 건너뛰어 통합 결과가 없습니다(${report.models.map((m) => `${m.label}: ${m.outcome}`).join(", ")})`;
    recordNewsReportFailure(startedAt, tag, why);
    recordYoutubeReportFailure(startedAt, tag, why);
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
  markNewsCollecting(true);
  markYoutubeCollecting(true);
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
    markNewsCollecting(false);
    markYoutubeCollecting(false);
    running = null;
  }
  recordAttempt(attempt);
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
  };
}

/** 실행 1건 상세. report.json 이 없는 옛 실행은 report.md 원문만. */
export function getReportRun(
  runId: string
): { report: DailyReportJson | null; markdown: string | null; delivered: Partial<Record<ReportChannel, string>> } | null {
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
  return { report, markdown, delivered: readDelivery()[runId] ?? {} };
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
