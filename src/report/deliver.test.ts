// 보고서 메일·문자 발송 — 모의 발송기로만 검증한다(실제 메일·문자를 보내지 않는다).
//
// ⚠️ DB_PATH 를 임시 디렉터리로 돌린 뒤 동적 import 한다(탭 설정·OAuth 저장소가 실제 data/ 를 읽지 않게).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DailyReportJson } from "../../shared/report.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "report-deliver-"));
process.env.DB_PATH = path.join(TMP, "price.db");

const { config } = await import("../config.ts");
const { __setStorePathForTest } = await import("../notify/google-auth.ts");
const { saveTabSettings } = await import("../settings/tab-settings.ts");
const deliver = await import("./deliver.ts");

after(() => {
  deliver.__setReportSendersForTest(null);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const mails: { subject: string; html: string }[] = [];
const texts: string[] = [];
let mailResult = true;
deliver.__setReportSendersForTest({
  mail: async (o) => {
    mails.push(o);
    return mailResult;
  },
  imessage: async (t) => {
    texts.push(t);
  },
});

function connected(): void {
  const file = path.join(TMP, "google-oauth.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      refreshToken: "rt",
      accessToken: "at",
      expiresAt: Date.now() + 3600_000,
      email: "me@example.com",
      needsReauth: false,
      lastError: null,
      lastSuccessAt: new Date().toISOString(),
    })
  );
  __setStorePathForTest(file);
  Object.assign(config.notify, {
    email: true,
    gmailAddress: "me@example.com",
    googleClientId: "cid",
    googleClientSecret: "secret",
    imessage: true,
    imessageTo: "+820000000000",
  });
}

beforeEach(() => {
  mails.length = 0;
  texts.length = 0;
  mailResult = true;
  connected();
  saveTabSettings({ report: { notifyEmail: false, notifyImessage: false } });
});

export function sampleReport(over: Partial<DailyReportJson> = {}): DailyReportJson {
  return {
    version: 1,
    runId: "20261123T000000Z-abcd",
    trigger: "price:schedule",
    preview: false,
    startedAt: "2026-11-23T00:00:00.000Z",
    finishedAt: "2026-11-23T00:30:00.000Z",
    ok: true,
    successCount: 2,
    modelCount: 3,
    models: [
      { key: "claude", label: "Claude Opus 5.5", model: "claude-opus-5-5", actualModels: ["claude-opus-5-5"], outcome: "success", reason: "", newsCount: 10, youtubeCount: 8, toolCalls: 40 },
      { key: "gpt", label: "GPT-6.1 Sol", model: "gpt-6.1-sol", actualModels: [], outcome: "skipped-limit", reason: "You've hit your usage limit", newsCount: 0, youtubeCount: 0, toolCalls: 0 },
      { key: "gemini", label: "Gemini 4 Neon", model: "gemini-4-neon-xhigh", actualModels: ["gemini-4-neon-xhigh"], outcome: "success", reason: "", newsCount: 9, youtubeCount: 7, toolCalls: 80 },
    ],
    editor: { label: "Claude Opus 5.5", model: "claude-opus-5-5", ok: true, note: "" },
    highlights: ["앤트로픽이 새 모델을 공개했다.", "<script>요약</script>"],
    counts: { before: 34, afterMerge: 20, alreadyReported: 5, reported: 15, seedsOnly: 1 },
    coverage: {
      lastSuccessAt: "2026-11-22T08:00:00.000Z",
      freshDays: 2,
      gap: null,
      geekNews: { ok: true, count: 12, since: "", until: "", error: null },
    },
    news: [
      {
        key: "ai",
        label: "🤖 AI",
        items: [
          {
            kind: "news",
            categoryKey: "ai",
            categoryLabel: "🤖 AI",
            title: "앤트로픽 새 모델",
            summary: "요약 <b>굵게</b>",
            source: "Anthropic",
            url: "https://anthropic.com/news/x",
            date: "2026-11-23",
            foundBy: ["Opus 5.5", "Gemini 4 Neon"],
            secondary: [{ label: "TechSite", link: "https://techsite.com/a" }],
            conflict: "날짜 표기 차이",
            update: false,
          },
        ],
      },
    ],
    youtube: [],
    seedsOnly: [{ title: "추천 업로드", channel: "채널", date: "2026-11-23", url: "https://www.youtube.com/watch?v=abcdefghijk", categoryLabel: "🛠️ 도구" }],
    sourceFailures: [],
    ...over,
  };
}

test("탭 스위치가 꺼져 있으면(기본값) 자격이 갖춰져도 아무것도 보내지 않는다", async () => {
  const ch = deliver.reportChannels();
  assert.equal(ch.email.enabled, false);
  assert.equal(ch.email.ready, true);
  const r = await deliver.deliverReport(sampleReport());
  assert.deepEqual(r.sent, {});
  assert.equal(mails.length + texts.length, 0);
});

test("메일만 켜면 메일만, 둘 다 켜면 둘 다 — 모의 발송기로 한 번씩", async () => {
  saveTabSettings({ report: { notifyEmail: true } });
  let r = await deliver.deliverReport(sampleReport());
  assert.ok(r.sent.email);
  assert.equal(r.sent.imessage, undefined);
  assert.equal(mails.length, 1);
  assert.equal(texts.length, 0);

  saveTabSettings({ report: { notifyImessage: true } });
  r = await deliver.deliverReport(sampleReport());
  assert.ok(r.sent.email && r.sent.imessage);
  assert.equal(mails.length, 2);
  assert.equal(texts.length, 1);
});

test(".env 전역 스위치·계정 연결이 없으면 켜 둬도 건너뛰고 사유를 남긴다", async () => {
  saveTabSettings({ report: { notifyEmail: true, notifyImessage: true } });
  config.notify.email = false;
  config.notify.imessageTo = "";
  const r = await deliver.deliverReport(sampleReport());
  assert.deepEqual(r.sent, {});
  assert.match(r.skipped.email ?? "", /NOTIFY_EMAIL/);
  assert.match(r.skipped.imessage ?? "", /IMESSAGE_TO/);
  assert.equal(mails.length + texts.length, 0);
});

test("화면의 '보내기'(only)는 탭 스위치와 무관하게 고른 채널만 보낸다", async () => {
  const r = await deliver.deliverReport(sampleReport(), { only: ["imessage"] });
  assert.ok(r.sent.imessage);
  assert.equal(r.sent.email, undefined);
  assert.equal(r.skipped.email, "이번 발송 대상 아님", "고르지 않은 채널을 '스위치 꺼짐'으로 오해하게 적지 않는다");
  assert.equal(texts.length, 1);
  assert.equal(mails.length, 0);
});

test("발송 실패는 throw 하지 않고 errors 로 돌려준다", async () => {
  saveTabSettings({ report: { notifyEmail: true } });
  mailResult = false;
  const r = await deliver.deliverReport(sampleReport());
  assert.equal(r.sent.email, undefined);
  assert.equal(r.errors.length, 1);
});

test("메일 본문: 핵심 요약·모델별 상태·항목(찾은 모델·보조 출처·근거 차이)·추천 업로드, 외부 텍스트는 이스케이프", () => {
  const html = deliver.buildReportEmailHtml(sampleReport());
  assert.match(html, /IT 뉴스·유튜브 통합 보고서/);
  assert.match(html, /핵심 요약/);
  assert.match(html, /앤트로픽이 새 모델을 공개했다/);
  assert.match(html, /모델별 상태/);
  assert.match(html, /한도로 건너뜀/);
  assert.match(html, /gemini-4-neon-xhigh/);
  assert.match(html, /찾은 모델 Opus 5\.5, Gemini 4 Neon/);
  assert.match(html, /보조 출처/);
  assert.match(html, /근거 차이: 날짜 표기 차이/);
  assert.match(html, /추천 채널 신규 업로드/);
  assert.match(html, /부분 결과: 3개 모델 중 2개 성공/);
  assert.doesNotMatch(html, /<script>|<b>굵게<\/b>/, "요약·하이라이트의 태그는 글자로 나와야 한다");
  assert.match(deliver.reportSubject(sampleReport()), /IT 보고서 .* 뉴스 1 · 영상 0 — 3개 중 2개 모델/);
});

test("문자 본문: 핵심 요약 + 모델별 상태 + 대시보드 링크, 짧게", () => {
  const t = deliver.buildReportSmsText(sampleReport(), "http://localhost:7777/#report");
  assert.match(t, /^🗞️ IT 보고서 .* — 뉴스 1·영상 0/);
  assert.match(t, /• 앤트로픽이 새 모델을 공개했다\./);
  assert.match(t, /모델: Opus 5\.5 ✓ · GPT-6\.1 Sol 한도 · Neon ✓/);
  assert.match(t, /http:\/\/localhost:7777\/#report$/);
  const fail = deliver.buildReportSmsText(sampleReport({ ok: false, successCount: 0, highlights: [] }), "x");
  assert.match(fail, /세 모델이 모두 건너뛰어/);
});
