/**
 * 메일·문자 발송 기능 제거(2026-11-22) 회귀 방지.
 *
 * 실제 메시지를 보내는 테스트는 하지 않는다. 대신 **발송 경로가 코드에 다시 생기지 않았는지**와
 * 뉴스·유튜브 정기 수집(열람 데이터의 원천)이 남아 있는지를 소스 수준에서 고정한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const SOURCES = ["src", "shared", "web/src"].flatMap((d) => walk(path.join(ROOT, d)));
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("발송 모듈과 진입점이 없다(src/notify, uptime/notify, MailAuthBanner)", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "src/notify")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "src/uptime/notify.ts")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "web/src/components/MailAuthBanner.tsx")), false);
});

test("어떤 운영 소스도 메일·문자 발송 수단을 쓰지 않는다(osascript·Gmail send API·nodemailer·notify 모듈)", () => {
  const banned = [
    /osascript/,
    /gmail\.googleapis\.com/,
    /from ["']nodemailer/,
    /from ["'][./]*notify\//,
    /from ["']\.\/notify\.ts["']/,
    /sendIMessage|sendMail\(|sendPulseIMessage|sendPulseDigest/,
  ];
  const hits: string[] = [];
  for (const f of SOURCES) {
    const text = fs.readFileSync(f, "utf8");
    for (const re of banned) if (re.test(text)) hits.push(`${path.relative(ROOT, f)} ~ ${re}`);
  }
  assert.deepEqual(hits, []);
});

test("API 에 메일 계정 연결·문자 테스트 라우트가 없다", () => {
  const routes = read("src/api/routes.ts");
  assert.doesNotMatch(routes, /api\.(get|post)\("\/google\//);
  assert.doesNotMatch(routes, /api\.(get|post)\("\/notify\//);
  assert.doesNotMatch(routes, /notifyEnabled/);
});

test("정기 작업: 펄스 야간 묶음 발송 cron 은 없고, 뉴스·유튜브 정기 수집과 누락 보충은 남아 있다(열람 데이터 원천)", () => {
  const s = read("src/scheduler/scheduler.ts");
  assert.doesNotMatch(s, /dp-stock-pulse-flush|flushPulseQueue/);
  assert.match(s, /scheduleGroup\("news", s\.news,/);
  assert.match(s, /scheduleGroup\("youtube", s\.youtube,/);
  assert.match(s, /\{ label: "뉴스", run: checkNewsCatchup \}/);
  assert.match(s, /\{ label: "유튜브", run: checkYoutubeCatchup \}/);
});

test("설정: 알림 채널 스키마·화면 스위치·환경 변수 안내가 없다", () => {
  assert.doesNotMatch(read("shared/types.ts"), /NotifyChannel|NotifyTabId/);
  assert.doesNotMatch(
    read("src/config.ts"),
    /process\.env\.(NOTIFY_EMAIL|NOTIFY_IMESSAGE|IMESSAGE_TO|GMAIL_ADDRESS|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET)\b/
  );
  assert.doesNotMatch(read("web/src/lib/tabConfig.ts"), /CHANNEL_LABEL|notify:/);
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["mail:preview"], undefined);
});
