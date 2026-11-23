/**
 * 메일·문자 발송 범위 회귀 방지.
 *
 *  - 세 모델 통합 보고서: 메일·문자(2026-11-22 재도입, src/report/deliver.ts).
 *  - 증시 브리핑·팝업/전시·스킬 랭킹: **메일만**(2026-11-23 PR #2 이전 일정·형식으로 복구, 문자는 보내지 않는다).
 *  - 펄스·가동 중단·뉴스·유튜브 탭 메일: 보내지 않는다.
 * 실제 메시지를 보내는 테스트는 하지 않고, 발송 수단을 쓰는 코드가 **허용된 파일에만** 있는지를 소스 수준에서 고정한다.
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
  const NODEMAILER = /from ["']nodemailer/;
  const allowed: Record<string, RegExp[]> = {
    "src/notify/imessage.ts": [OSA],
    // MIME 조립(CID 인라인 첨부)만 nodemailer 를 빌리고, 전송은 Gmail REST.
    "src/notify/mailer.ts": [GMAIL, NODEMAILER],
  };
  const hits: string[] = [];
  for (const f of SOURCES) {
    const text = fs.readFileSync(f, "utf8");
    for (const re of [OSA, GMAIL, NODEMAILER]) {
      if (re.test(text) && !(allowed[rel(f)] ?? []).some((a) => a.source === re.source)) hits.push(`${rel(f)} ~ ${re}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("문자를 보내는 곳은 보고서 발송 모듈과 발송기 내부뿐이다(증시·팝업/전시·스킬은 문자 없음)", () => {
  const callers = new Set(["src/report/deliver.ts", "src/notify/mailer.ts", "src/notify/imessage.ts"]);
  const hits: string[] = [];
  for (const f of SOURCES) {
    if (callers.has(rel(f))) continue;
    const text = fs.readFileSync(f, "utf8");
    if (/sendIMessage\(|sendStockIMessage|sendEventsIMessage|sendSkillsIMessage|sendPulseIMessage|sendPulseDigest|deliverReport\(/.test(text)) {
      // 보고서 실행기(service.ts)는 deliverReport 를 기본 의존성으로만 묶는다.
      if (rel(f) === "src/report/service.ts" && !/sendIMessage|sendMail\(/.test(text)) continue;
      hits.push(rel(f));
    }
  }
  assert.deepEqual(hits, []);
});

test("메일을 보내는 곳: 보고서 발송 모듈 + 증시·팝업/전시·스킬 랭킹 메일 모듈(+발송기 내부)", () => {
  const callers = new Set([
    "src/report/deliver.ts",
    "src/notify/mailer.ts",
    "src/notify/stock-email.ts",
    "src/notify/events-email.ts",
    "src/notify/skills-email.ts",
  ]);
  const hits = SOURCES.filter((f) => /sendMail\(/.test(fs.readFileSync(f, "utf8")) && !callers.has(rel(f))).map(rel);
  assert.deepEqual(hits, []);
  // 세 탭 메일 모듈은 탭 게이트(tab-notify.ts: 메일만, 문자는 항상 false)로 판정한다.
  for (const m of ["stock", "events", "skills"]) {
    assert.match(read(`src/notify/${m}-email.ts`), /from "\.\/tab-notify\.ts"/, m);
  }
  assert.match(read("src/notify/tab-notify.ts"), /if \(channel !== "email"\) return false;/);
});

test("notify 모듈을 import 하는 곳: 보고서 발송·Google 연결 라우트·메일 복구한 세 탭 수집기뿐", () => {
  const allowed = new Set([
    "src/report/deliver.ts",
    "src/api/routes.ts",
    "src/stock/stock.ts",
    "src/events/events.ts",
    "src/skills/skills.ts",
  ]);
  const hits = SOURCES.filter((f) => /from ["'][./]*notify\//.test(fs.readFileSync(f, "utf8")) && !allowed.has(rel(f))).map(rel);
  assert.deepEqual(hits, []);
  // 뉴스·유튜브 탭 메일·펄스 문자·가동 중단 문자 모듈은 되살리지 않았다.
  for (const gone of [
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

test("설정: 보고서 스위치(기본 꺼짐) + 세 탭 '메일로 받기'(기본 켜짐), 탭별 문자 스위치는 없다", () => {
  assert.doesNotMatch(read("shared/types.ts"), /NotifyChannel|NotifyTabId/);
  const ts = read("src/settings/tab-settings.ts");
  assert.match(ts, /report: \{ notifyEmail: false, notifyImessage: false \}/);
  assert.match(ts, /stock: \{ historyRetentionDays: config\.historyRetentionDays, notifyEmail: true \}/);
  assert.match(ts, /skills: \{ notifyEmail: true \}/);
  const web = read("web/src/lib/tabConfig.ts");
  assert.doesNotMatch(web, /CHANNEL_LABEL|notify:/);
  for (const p of ["stock.notifyEmail", "events.notifyEmail", "skills.notifyEmail"]) assert.ok(web.includes(`path: "${p}"`), p);
  assert.equal((web.match(/notifyImessage/g) ?? []).length, 1, "문자 스위치는 보고서 탭 하나뿐");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; dependencies?: Record<string, string> };
  assert.equal(pkg.scripts["mail:preview"], undefined);
  assert.ok(pkg.dependencies?.nodemailer, "증시 차트 CID 인라인 첨부용 MIME 조립");
  assert.ok(pkg.dependencies?.["@napi-rs/canvas"], "증시 메일 차트 PNG 렌더");
});

test("정기 작업: 증시·팝업/전시·스킬 랭킹 정시·보충 실행은 메일 대상(notify: true)", () => {
  const s = read("src/scheduler/scheduler.ts");
  assert.match(s, /refreshEvents\(\{ trigger, notify: true \}\)/);
  assert.match(s, /refreshStock\(\{ market, trigger, slot, notify: true \}\)/);
  assert.match(s, /refreshSkills\(\{ trigger, notify: true \}\)/);
});
