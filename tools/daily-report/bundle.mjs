#!/usr/bin/env node
/**
 * 일일 뉴스·유튜브 통합 보고서 수집기를 **저장소 밖 운영 경로**에 배포한다.
 *
 *   node tools/daily-report/bundle.mjs [--out <디렉터리>]
 *   (기본 출력: ~/.orca/bots/it-news/daily-news/collector)
 *
 * 왜: Orca 자동화가 임시 워크트리(또는 저장소 체크아웃)에 의존하지 않도록 src/report/cli.ts 를
 * 단일 ESM 파일로 묶는다. Claude Agent SDK 는 플랫폼별 실행 바이너리를 자기 위치 기준으로 찾으므로
 * 묶지 않고 node_modules 째로 옆에 둔다(APFS 복제 `cp -c` — 같은 볼륨이면 디스크를 거의 쓰지 않는다).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(repo, "package.json"));
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = path.resolve(
  outIdx >= 0 ? args[outIdx + 1] : path.join(os.homedir(), ".orca", "bots", "it-news", "daily-news", "collector")
);

const esbuild = require("esbuild");
fs.mkdirSync(out, { recursive: true });
const tmp = path.join(out, `daily-report.mjs.tmp-${process.pid}`);
await esbuild.build({
  entryPoints: [path.join(repo, "src", "report", "cli.ts")],
  outfile: tmp,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/claude-agent-sdk-*"],
  // 번들 안의 CommonJS 의존성(dotenv 등)이 require 를 쓸 수 있게 한다.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
fs.renameSync(tmp, path.join(out, "daily-report.mjs"));

// Agent SDK + 이 플랫폼의 실행 바이너리 패키지를 옆에 둔다.
// (SDK 는 exports 에 package.json 을 열어 두지 않아 require.resolve 대신 node_modules 경로를 직접 찾는다.)
const findPkg = (name) => {
  for (const dir of require.resolve.paths(name) ?? []) {
    const p = path.join(dir, name);
    if (fs.existsSync(path.join(p, "package.json"))) return p;
  }
  return null;
};
const sdkPkg = findPkg("@anthropic-ai/claude-agent-sdk");
if (!sdkPkg) throw new Error("@anthropic-ai/claude-agent-sdk 를 찾지 못했습니다(npm install 확인).");
const sdkVersion = JSON.parse(fs.readFileSync(path.join(sdkPkg, "package.json"), "utf8")).version;
const platformPkgName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const nm = path.join(out, "node_modules", "@anthropic-ai");
fs.rmSync(path.join(out, "node_modules"), { recursive: true, force: true });
fs.mkdirSync(nm, { recursive: true });
const copy = (src, dst) => execFileSync("cp", ["-cR", src, dst]);
copy(sdkPkg, path.join(nm, "claude-agent-sdk"));
const platformDir = findPkg(platformPkgName);
if (platformDir) copy(platformDir, path.join(nm, path.basename(platformDir)));

let commit = "unknown";
try {
  commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  /* git 없음 */
}
const dirty = (() => {
  try {
    return execFileSync("git", ["-C", repo, "status", "--porcelain", "--", "src", "shared"], { encoding: "utf8" }).trim().length > 0;
  } catch {
    return null;
  }
})();
fs.writeFileSync(
  path.join(out, "BUILD.json"),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      sourceRepo: repo,
      commit,
      sourceDirty: dirty,
      agentSdk: sdkVersion,
      platformPackage: platformDir ? platformPkgName : null,
      node: process.version,
    },
    null,
    2
  )
);
console.log(JSON.stringify({ out, bundle: path.join(out, "daily-report.mjs"), commit, sdk: sdkVersion, platform: !!platformDir }));
