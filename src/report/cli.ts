/**
 * 일일 뉴스·유튜브 통합 보고서 — 단일 명령 진입점.
 *
 *   node daily-report.mjs [--source-data <price/data>] [--output <daily-news>] [--preview]
 *                         [--models claude,gpt,gemini] [--gemini-model <id>] [--retry-delay <초>]
 *                         [--trigger <price:schedule|price:catchup|price:manual|cli>]
 *
 * 하는 일(한 번에 끝난다): 잠금 → 실행별 고유 디렉터리 → price 상태 파일 사본(원본은 읽기만) →
 * 공용 원자료 수집 → 세 모델 독립 취합(동시) → 통합 → 보고서·중간 결과·체크포인트 저장.
 * stdout 에는 결과 JSON 한 줄만 쓴다(로그는 stderr 와 실행 디렉터리의 run.log).
 *
 * 종료 코드: 0 = 성공 모델 1개 이상(보고서 생성) · 2 = 세 모델 모두 건너뜀(실패 보고서만) ·
 *            3 = 다른 실행이 진행 중 · 1 = 예기치 않은 오류.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** price 상태 중 보고서가 읽는 파일(스킵·설정의 원본). 원본은 절대 쓰지 않고 실행별로 복사한다. */
export const STATE_FILES = [
  "news-categories.json",
  "youtube-categories.json",
  "youtube-blocklist.json",
  "youtube-dismissed.json",
  "youtube-watched.json",
  "youtube-reclass.json",
  "youtube-channels.json",
  "tab-settings.json",
];

/** price 운영 체크아웃의 data 폴더(launchd 서비스가 쓰는 원본). 다르면 --source-data 또는 PRICE_DATA_DIR. */
export const DEFAULT_SOURCE_DATA = path.join(os.homedir(), "Workspace", "price", "data");
export const DEFAULT_OUTPUT = path.join(os.homedir(), ".orca", "bots", "it-news", "daily-news");

interface CliArgs {
  sourceData: string;
  output: string;
  preview: boolean;
  models: string[];
  geminiModel: string | null;
  retryDelaySec: number;
  trigger: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    sourceData: process.env.PRICE_DATA_DIR?.trim() || DEFAULT_SOURCE_DATA,
    output: process.env.DAILY_NEWS_DIR?.trim() || DEFAULT_OUTPUT,
    preview: false,
    models: ["claude", "gpt", "gemini"],
    geminiModel: process.env.DAILY_REPORT_GEMINI_MODEL?.trim() || null,
    retryDelaySec: 45,
    trigger: "cli",
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} 값이 없습니다`);
      return x;
    };
    if (k === "--source-data") a.sourceData = v();
    else if (k === "--output") a.output = v();
    else if (k === "--preview") a.preview = true;
    else if (k === "--models") a.models = v().split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--gemini-model") a.geminiModel = v();
    else if (k === "--retry-delay") a.retryDelaySec = Math.max(0, Number(v()) || 0);
    else if (k === "--trigger") a.trigger = v().replace(/[^A-Za-z0-9:._-]/g, "").slice(0, 40) || "cli";
    else if (k === "--help" || k === "-h") {
      process.stdout.write(
        "사용법: daily-report [--source-data DIR] [--output DIR] [--preview] [--models claude,gpt,gemini] [--gemini-model ID] [--retry-delay 초] [--trigger 이름]\n"
      );
      process.exit(0);
    } else throw new Error(`알 수 없는 옵션: ${k}`);
  }
  a.sourceData = path.resolve(a.sourceData);
  a.output = path.resolve(a.output);
  return a;
}

export function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

export function hashState(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of STATE_FILES) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) out[f] = sha256File(p);
  }
  return out;
}

/**
 * price 상태 파일을 실행별 사본 폴더로 복사하고 원본 해시를 돌려준다. 원본은 읽기만 한다.
 * 이후 수집기(채널 캐시 갱신 등)가 쓰는 곳은 사본뿐이다.
 */
export function snapshotState(sourceDir: string, stateDir: string): Record<string, string> {
  fs.mkdirSync(stateDir, { recursive: true });
  const before = hashState(sourceDir);
  for (const f of STATE_FILES) {
    const src = path.join(sourceDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stateDir, f));
  }
  return before;
}

/** 실행 잠금. 죽은 프로세스가 남긴 잠금은 걷어 낸다. 획득 실패면 null. */
export function acquireLock(file: string): (() => void) | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) fs.unlinkSync(file);
        } catch {
          /* 이미 없음 */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(fs.readFileSync(file, "utf8").trim());
      let alive = false;
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      if (alive) return null;
      fs.unlinkSync(file);
    }
  }
  return null;
}

/** 실행 ID: UTC 시각 + 난수(같은 초에 두 번 돌아도 경로가 겹치지 않는다). */
export function newRunId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${ts}-${crypto.randomBytes(2).toString("hex")}`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(args.sourceData, "news-categories.json")) && !fs.existsSync(path.join(args.sourceData, "youtube-categories.json"))) {
    throw new Error(`price 데이터 폴더를 찾지 못했습니다: ${args.sourceData}`);
  }
  const release = acquireLock(path.join(args.output, ".run.lock"));
  if (!release) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "다른 보고서 실행이 진행 중입니다." })}\n`);
    return 3;
  }
  try {
    const runId = newRunId();
    const runDir = path.join(args.output, args.preview ? "previews" : "runs", runId);
    const stateDir = path.join(runDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });

    // 로그: stderr + 실행 디렉터리 run.log. stdout 은 결과 JSON 전용이다.
    const logStream = fs.createWriteStream(path.join(runDir, "run.log"), { flags: "a" });
    const tee =
      (orig: (...a: unknown[]) => void) =>
      (...a: unknown[]) => {
        orig(...a);
        logStream.write(`${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`);
      };
    const errOut = console.error.bind(console);
    console.log = tee(errOut);
    console.info = tee(errOut);
    console.warn = tee(console.warn.bind(console));
    console.error = tee(errOut);

    // 상태 사본: 원본은 읽기만 한다. 해시를 실행 전·후로 남겨 원본 불변을 증명한다.
    const before = snapshotState(args.sourceData, stateDir);
    process.env.DB_PATH = path.join(stateDir, "price.db");
    // dotenv 가 엉뚱한 .env 를 읽지 않도록 비밀값이 없는 실행 디렉터리에서 모듈을 불러온다.
    process.chdir(runDir);

    const { runDailyReport } = await import("./pipeline.ts");
    const { defaultDeps } = await import("./defaults.ts");
    const { REPORT_MODELS } = await import("./models.ts");
    const models = REPORT_MODELS.filter((m) => args.models.includes(m.key)).map((m) =>
      m.key === "gemini" && args.geminiModel ? { ...m, model: args.geminiModel } : m
    );
    if (!models.length) throw new Error("실행할 모델이 없습니다(--models 확인).");

    const result = await runDailyReport(defaultDeps, {
      runId,
      runDir,
      outputDir: args.output,
      preview: args.preview,
      models,
      retryDelayMs: args.retryDelaySec * 1000,
      sourceHashes: { before, after: () => hashState(args.sourceData) },
      trigger: args.trigger,
    });
    const after = hashState(args.sourceData);
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    if (!unchanged) console.error("⚠️ 실행 중 price 원본 상태 파일이 바뀌었습니다(사용자 조작 가능). summary.json 의 sourceHashes 확인.");
    process.stdout.write(
      `${JSON.stringify({
        ok: result.ok,
        runId: result.runId,
        report: result.reportPath,
        reportJson: result.reportJsonPath,
        tabs: result.tabs,
        trigger: args.trigger,
        preview: result.preview,
        successCount: result.successCount,
        models: result.models.map((m) => ({ key: m.spec.key, model: m.spec.model, actual: m.actualModels, outcome: m.outcome, reason: m.reason.slice(0, 300) })),
        editor: result.editor.spec?.model ?? null,
        counts: result.counts,
        checkpointAdvanced: result.checkpointAdvanced,
        sourceStateUnchanged: unchanged,
      })}\n`
    );
    await new Promise<void>((r) => logStream.end(r));
    return result.ok ? 0 : 2;
  } finally {
    release();
  }
}

const isMain = (() => {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`daily-report 오류: ${(e as Error).stack ?? e}\n`);
      process.stdout.write(`${JSON.stringify({ ok: false, error: (e as Error).message })}\n`);
      process.exit(1);
    }
  );
}
