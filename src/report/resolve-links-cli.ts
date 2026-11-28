/**
 * 지난 실행 보고서의 검색 경유 주소(Gemini vertexaisearch 등)를 원래 기사 주소로 풀어 실행 폴더에
 * `link-resolutions.json` 을 쓴다. report.json(원본 기록)은 읽기만 하고 고치지 않는다 — price 가 화면·메일에서 덧씌운다.
 *
 *   npm run daily:report:resolve-links -- [--output <daily-news>] [--run <runId>] [--dry-run]
 *
 * 경유 주소 자체에만 HEAD(안 되면 GET) 요청을 보내 302 Location 을 읽는다(기사 사이트에는 요청하지 않음).
 * 만료 등으로 풀지 못한 주소는 그대로 두고 사유만 기록한다. 이미 풀린 주소는 다시 요청하지 않으므로 여러 번 돌려도 된다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DailyReportJson } from "../../shared/report.ts";
import { collectReportRedirects, resolveRunLinks } from "./link-resolutions.ts";

const RUN_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;

function parse(argv: string[]): { output: string; run: string | null; dryRun: boolean } {
  const a = {
    output: process.env.DAILY_NEWS_DIR?.trim() || path.join(os.homedir(), ".orca", "bots", "it-news", "daily-news"),
    run: null as string | null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--output") a.output = argv[++i];
    else if (k === "--run") a.run = argv[++i];
    else if (k === "--dry-run") a.dryRun = true;
    else throw new Error(`알 수 없는 인자: ${k}`);
  }
  if (a.run && !RUN_ID_RE.test(a.run)) throw new Error(`실행 ID 형식이 아님: ${a.run}`);
  return a;
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  const runsDir = path.join(args.output, "runs");
  const ids = (args.run ? [args.run] : fs.readdirSync(runsDir).filter((x) => RUN_ID_RE.test(x)).sort()).filter((id) =>
    fs.existsSync(path.join(runsDir, id, "report.json"))
  );
  const rows: Record<string, unknown>[] = [];
  for (const id of ids) {
    const dir = path.join(runsDir, id);
    if (args.dryRun) {
      const report = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")) as DailyReportJson;
      rows.push({ runId: id, redirects: collectReportRedirects(report).length });
      continue;
    }
    const r = await resolveRunLinks(dir);
    rows.push({ runId: id, ...r });
    console.error(
      `[resolve-links] ${id}: 경유 주소 ${r.total}건 — 원래 주소 ${r.resolved}건, 그대로 ${r.unresolved}건${r.wrote ? "" : " (기록 안 함)"}`
    );
  }
  console.log(JSON.stringify({ ok: true, dryRun: args.dryRun, runs: rows }));
}

main().catch((e) => {
  console.error(`[resolve-links] 실패: ${(e as Error).message}`);
  process.exit(1);
});
