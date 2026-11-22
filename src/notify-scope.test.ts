/**
 * 메일·문자 발송 범위 회귀 방지 — **세 모델 통합 보고서 전용**(2026-11-22 사용자 결정).
 *
 * 2026-11-22 오전에 메일·문자 발송을 모두 걷어 냈다가, 같은 날 보고서만 메일·문자로 받기로 되살렸다.
 * 증시·팝업/전시·스킬·펄스·가동 중단 알림은 다시 보내지 않는다. 실제 메시지를 보내는 테스트는 하지 않고,
 * 발송 수단을 쓰는 코드가 **허용된 파일에만** 있는지를 소스 수준에서 고정한다.
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
const rel = (f: string) => path.relative(ROOT, f);
const read = (r: string) => fs.readFileSync(path.join(ROOT, r), "utf8");

test("발송 수단(osascript 실행·Gmail send API 주소)은 발송기 두 파일에만 있다", () => {
  // 주석 언급이 아니라 **코드에서 쓰는 문자열**을 본다.
  const OSA = /["']osascript["']/;
  const GMAIL = /["']https:\/\/gmail\.googleapis\.com/;
  const allowed: Record<string, RegExp> = {
    "src/notify/imessage.ts": OSA,
    "src/notify/mailer.ts": GMAIL,
  };
  const hits: string[] = [];
  for (const f of SOURCES) {
    const text = fs.readFileSync(f, "utf8");
    for (const re of [OSA, GMAIL, /from ["']nodemailer/]) {
      if (re.test(text) && allowed[rel(f)]?.source !== re.source) hits.push(`${rel(f)} ~ ${re}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("발송 함수를 부르는 곳은 보고서 발송 모듈과 발송기 내부뿐이다(다른 탭 알림 없음)", () => {
  const callers = new Set(["src/report/deliver.ts", "src/notify/mailer.ts", "src/notify/imessage.ts"]);
  const hits: string[] = [];
  for (const f of SOURCES) {
    if (callers.has(rel(f))) continue;
    const text = fs.readFileSync(f, "utf8");
    if (/sendIMessage|sendMail\(|sendPulseIMessage|sendPulseDigest|deliverReport\(/.test(text)) {
      // 보고서 실행기(service.ts)는 deliverReport 를 기본 의존성으로만 묶는다.
      if (rel(f) === "src/report/service.ts" && !/sendIMessage|sendMail\(/.test(text)) continue;
      hits.push(rel(f));
    }
  }
  assert.deepEqual(hits, []);
});

test("notify 모듈을 import 하는 곳: 보고서 발송·Google 연결 라우트·발송기 자신뿐", () => {
  const allowed = new Set(["src/report/deliver.ts", "src/api/routes.ts", "src/notify/mailer.ts", "src/notify/email-kit.ts"]);
  const hits = SOURCES.filter((f) => /from ["'][./]*notify\//.test(fs.readFileSync(f, "utf8")) && !allowed.has(rel(f))).map(rel);
  assert.deepEqual(hits, []);
  // 예전 탭별 메일(증시·팝업/전시·스킬·뉴스·유튜브)·펄스 문자·가동 중단 문자 모듈은 되살리지 않았다.
  for (const gone of [
    "src/notify/stock-email.ts",
    "src/notify/events-email.ts",
    "src/notify/skills-email.ts",
    "src/notify/news-email.ts",
    "src/notify/youtube-email.ts",
    "src/notify/pulse-imessage.ts",
    "src/uptime/notify.ts",
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, gone)), false, `${gone} 는 없어야 한다`);
  }
});

test("수집기 번들 쪽 코드는 발송·price 실행기를 import 하지 않는다(봇 홈 수집기는 발송하지 않는다)", () => {
  for (const f of ["cli.ts", "pipeline.ts", "defaults.ts", "merge.ts", "models.ts", "render.ts", "output.ts"]) {
    const text = read(`src/report/${f}`);
    assert.doesNotMatch(text, /from ["']\.\/(deliver|service)\.ts["']|from ["'][./]*notify\//, f);
  }
});

test("API: 문자 테스트 라우트·펄스 알림 필드는 없고, 보고서·Google 연결 라우트는 있다", () => {
  const routes = read("src/api/routes.ts");
  assert.doesNotMatch(routes, /api\.(get|post)\("\/notify\//);
  assert.doesNotMatch(routes, /notifyEnabled/);
  assert.match(routes, /api\.get\("\/google\/status"/);
  assert.match(routes, /api\.post\("\/report\/runs\/:runId\/send"/);
});

test("정기 작업: 펄스 묶음 발송 cron 은 없고, 뉴스·유튜브는 통합 보고서 일정 하나로 돈다", () => {
  const s = read("src/scheduler/scheduler.ts");
  assert.doesNotMatch(s, /dp-stock-pulse-flush|flushPulseQueue/);
  assert.match(s, /scheduleGroup\("report", s\.report,/);
  assert.match(s, /\{ label: "통합 보고서", run: checkReportCatchup \}/);
  assert.doesNotMatch(s, /scheduleGroup\("news"|scheduleGroup\("youtube"/);
});

test("설정: 탭별 알림 채널 스키마는 없고 보고서 스위치만 있다(기본 꺼짐)", () => {
  assert.doesNotMatch(read("shared/types.ts"), /NotifyChannel|NotifyTabId/);
  assert.match(read("src/settings/tab-settings.ts"), /report: \{ notifyEmail: false, notifyImessage: false \}/);
  assert.doesNotMatch(read("web/src/lib/tabConfig.ts"), /CHANNEL_LABEL|notify:/);
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; dependencies?: Record<string, string> };
  assert.equal(pkg.scripts["mail:preview"], undefined);
  assert.equal(pkg.dependencies?.nodemailer, undefined, "보고서 메일은 HTML 한 파트라 MIME 을 직접 만든다");
});
