import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.ts";
import { __setStorePathForTest } from "./google-auth.ts";
import {
  __setAlertStorePathForTest,
  __setIMessageSenderForTest,
  buildRawMessage,
  isMailConfigured,
  sendMail,
} from "./mailer.ts";

/**
 * 네트워크 없는 스텁 테스트. Gmail API 호출은 globalThis.fetch 를 갈아끼워 가로채고,
 * OAuth 상태는 임시 디렉터리에 유효한 토큰을 직접 심어 만든다.
 *
 * ⚠️ iMessage 발송기는 **파일 전체에서 반드시 스텁으로 고정한다**. 개발 머신 .env 에는 실제
 * 수신 번호가 들어 있어, 재인증 경고 경로가 살아 있으면 테스트를 돌릴 때마다 진짜 문자가 간다.
 */

const ADDRESS = "tester@gmail.com";

/** 스텁으로 가로챈 경고 문자. connectedStore() 가 케이스마다 비운다. */
let alerts: string[] = [];

/** 현재 스텁이 취할 동작. 발송 실패를 흉내 낼 때만 바꾼다. */
let alertShouldFail = false;

__setIMessageSenderForTest(async (text: string) => {
  if (alertShouldFail) throw new Error("osascript -1743 (Not authorized)");
  alerts.push(text);
});

/** 마지막 경고 시각 파일 경로(케이스마다 새로 잡힌다). */
let alertPath = "";

/** OAuth 저장소를 임시 디렉터리로 돌리고 '연결됨 + 토큰 유효' 상태를 심는다. */
function connectedStore(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailer-"));
  const file = path.join(dir, "google-oauth.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      refreshToken: "rt-1",
      accessToken: "at-1",
      expiresAt: Date.now() + 3600_000,
      email: ADDRESS,
      needsReauth: false,
      lastError: null,
      lastSuccessAt: new Date().toISOString(),
    }),
    "utf8"
  );
  __setStorePathForTest(file);

  // 경고 이력도 케이스마다 초기화 — 억제 타이머가 케이스 사이로 새면 안 된다.
  alertPath = path.join(dir, "mail-alert.json");
  __setAlertStorePathForTest(alertPath);
  alerts = [];
  alertShouldFail = false;

  config.notify.email = true;
  config.notify.gmailAddress = ADDRESS;
  config.notify.googleClientId = "test-client-id";
  config.notify.googleClientSecret = "test-client-secret";
  config.notify.imessage = true;
  config.notify.imessageTo = "+821000000000";
}

/** 재로그인이 필요한(invalid_grant 이후) 토큰 상태를 심는다. */
function needsReauthStore(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailer-"));
  const file = path.join(dir, "google-oauth.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      refreshToken: "rt-1",
      accessToken: "",
      expiresAt: 0,
      email: ADDRESS,
      needsReauth: true,
      lastError: "토큰 갱신 실패 — invalid_grant",
      lastSuccessAt: null,
    }),
    "utf8"
  );
  __setStorePathForTest(file);
}

/**
 * Gmail send 응답 큐로 fetch 를 대체한다.
 * 토큰 갱신(urlencoded)과 메일 발송(JSON) 두 종류가 같은 fetch 를 타므로 본문을 둘 다 받는다.
 */
function stubFetch(responses: Array<{ ok: boolean; status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; auth: string; payload: Record<string, string> }> = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = String(init?.body ?? "");
    let payload: Record<string, string>;
    try {
      payload = JSON.parse(body) as Record<string, string>;
    } catch {
      payload = Object.fromEntries(new URLSearchParams(body));
    }
    calls.push({ url: String(url), auth: headers.authorization ?? "", payload });
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    };
  }) as unknown as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

/** base64url 알파벳만 쓰는가(+ / = 가 없어야 한다). */
function isBase64Url(s: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(s);
}

// ── MIME 빌드 ──

test("buildRawMessage: base64url 로 인코딩된 RFC822 원문을 만든다", async () => {
  connectedStore();
  const raw = await buildRawMessage({ subject: "테스트 제목", html: "<p>본문</p>" });

  assert.ok(isBase64Url(raw), "base64url 알파벳만 있어야 한다(+ / = 금지)");

  const mime = Buffer.from(raw, "base64url").toString("utf8");
  assert.ok(/^From: /m.test(mime));
  assert.ok(mime.includes(ADDRESS), "from/to 는 GMAIL_ADDRESS(자기 자신)");
  assert.ok(/^To: /m.test(mime));
  assert.ok(/^Subject: /m.test(mime));
  assert.ok(mime.includes("text/html"));
});

test("buildRawMessage: 한글 제목은 MIME 인코딩되어 원문이 ASCII 로 유지된다", async () => {
  connectedStore();
  const raw = await buildRawMessage({ subject: "📰 뉴스 다이제스트", html: "<p>본문</p>" });
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  const subject = /^Subject: (.*)$/m.exec(mime)?.[1] ?? "";
  // RFC 2047 encoded-word (=?UTF-8?B?...?=) 여야 한다 — 날것의 한글이 헤더에 남으면 안 된다.
  assert.match(subject, /=\?UTF-8\?/i);
});

test("buildRawMessage: CID 인라인 첨부가 multipart/related 로 들어간다", async () => {
  connectedStore();
  const raw = await buildRawMessage({
    subject: "증시 브리핑",
    html: `<img src="cid:chart-kr-005930">`,
    attachments: [
      { filename: "chart_kr_005930.png", content: PNG, cid: "chart-kr-005930", contentType: "image/png" },
    ],
  });

  assert.ok(isBase64Url(raw));
  const mime = Buffer.from(raw, "base64url").toString("utf8");

  // 인라인 이미지는 본문과 같은 related 컨테이너 안에 있어야 메일 클라이언트가 렌더한다.
  assert.ok(mime.includes("multipart/related"), "multipart/related 컨테이너 필요");
  assert.ok(mime.includes("Content-ID: <chart-kr-005930>"), "Content-ID 헤더 필요");
  assert.ok(mime.includes("chart_kr_005930.png"));
  assert.ok(mime.includes("image/png"));
  assert.ok(/Content-Disposition: inline/i.test(mime), "CID 첨부는 inline 이어야 한다");
  // PNG 본문이 base64 로 실려 있어야 한다.
  assert.ok(mime.includes(PNG.toString("base64").slice(0, 16)));
});

test("buildRawMessage: 첨부 여러 개가 모두 실린다", async () => {
  connectedStore();
  const raw = await buildRawMessage({
    subject: "증시 브리핑",
    html: `<img src="cid:c1"><img src="cid:c2">`,
    attachments: [
      { filename: "a.png", content: PNG, cid: "c1", contentType: "image/png" },
      { filename: "b.png", content: PNG, cid: "c2", contentType: "image/png" },
    ],
  });
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  assert.ok(mime.includes("Content-ID: <c1>"));
  assert.ok(mime.includes("Content-ID: <c2>"));
});

// ── 설정 판정 ──

test("isMailConfigured: NOTIFY_EMAIL / 주소 / OAuth 클라이언트가 모두 있어야 true", () => {
  connectedStore();
  assert.equal(isMailConfigured(), true);

  config.notify.email = false;
  assert.equal(isMailConfigured(), false);
  config.notify.email = true;

  config.notify.gmailAddress = "";
  assert.equal(isMailConfigured(), false);
  config.notify.gmailAddress = ADDRESS;

  config.notify.googleClientId = "";
  assert.equal(isMailConfigured(), false);
  config.notify.googleClientId = "test-client-id";
});

// ── 발송 ──

test("sendMail: Gmail API 에 {raw} 를 POST 하고 true", async () => {
  connectedStore();
  const f = stubFetch([{ ok: true, body: { id: "18f0" } }]);
  try {
    const ok = await sendMail({
      subject: "증시 브리핑",
      html: `<img src="cid:chart">`,
      attachments: [{ filename: "c.png", content: PNG, cid: "chart", contentType: "image/png" }],
    });
    assert.equal(ok, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    assert.equal(f.calls[0].auth, "Bearer at-1");

    const raw = f.calls[0].payload.raw;
    assert.ok(isBase64Url(raw), "요청 본문의 raw 는 base64url");
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    assert.ok(mime.includes("Content-ID: <chart>"));
  } finally {
    f.restore();
  }
});

test("sendMail: 영구 실패(4xx)는 throw 하지 않고 false", async () => {
  connectedStore();
  const f = stubFetch([{ ok: false, status: 403, body: { error: { message: "Forbidden" } } }]);
  try {
    assert.equal(await sendMail({ subject: "s", html: "<p>h</p>" }), false);
    // 403 은 재시도 대상이 아니다 — 한 번만 친다.
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test("sendMail: 401 이면 토큰 캐시를 버리고 한 번 더 시도한다", async () => {
  connectedStore();
  const f = stubFetch([
    { ok: false, status: 401, body: { error: { message: "Invalid Credentials" } } },
    // 캐시를 버렸으니 두 번째 호출은 토큰 갱신이고, 그 다음이 재발송이다.
    { ok: true, body: { access_token: "at-2", expires_in: 3599 } },
    { ok: true, body: { id: "18f1" } },
  ]);
  try {
    const ok = await sendMail({ subject: "s", html: "<p>h</p>" });
    assert.equal(ok, true);
    // send(401) → token refresh → send(200)
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[1].url, "https://oauth2.googleapis.com/token");
    assert.equal(f.calls[1].payload.grant_type, "refresh_token");
    assert.equal(f.calls[2].auth, "Bearer at-2");
  } finally {
    f.restore();
  }
});

test("sendMail: 5xx 는 재시도 후 false", async () => {
  connectedStore();
  const f = stubFetch([{ ok: false, status: 503, body: { error: { message: "Backend Error" } } }]);
  try {
    assert.equal(await sendMail({ subject: "s", html: "<p>h</p>" }), false);
    assert.equal(f.calls.length, 3);
  } finally {
    f.restore();
  }
});

test("sendMail: 재로그인이 필요하면 throw 없이 false", async () => {
  connectedStore();
  needsReauthStore();

  const f = stubFetch([{ ok: true, body: { id: "x" } }]);
  try {
    assert.equal(await sendMail({ subject: "s", html: "<p>h</p>" }), false);
    // 재로그인 전에는 발송을 시도조차 하지 않는다.
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

test("sendMail: NOTIFY_EMAIL 이 꺼져 있으면 조용히 false", async () => {
  connectedStore();
  config.notify.email = false;
  const f = stubFetch([{ ok: true, body: {} }]);
  try {
    assert.equal(await sendMail({ subject: "s", html: "<p>h</p>" }), false);
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
    config.notify.email = true;
  }
});

// ── 재인증 경고(iMessage) ──────────────────────────────────────
//
// 이번 사고의 본질은 "메일이 죽었는데 아무도 몰랐다"였다. 메일이 죽은 상태에서는 메일로 알릴 수
// 없으므로, 살아 있는 채널(iMessage)로 밀어 올리는 이 경로가 사고 재발을 막는 유일한 장치다.

test("재인증 필요: 살아 있는 채널(iMessage)로 경고가 나간다", async () => {
  connectedStore();
  needsReauthStore();

  const f = stubFetch([{ ok: true, body: {} }]);
  try {
    assert.equal(await sendMail({ subject: "뉴스", html: "<p>h</p>" }), false);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /메일 발송 실패/);
    assert.match(alerts[0], /Google 재로그인/);
    assert.ok(alerts[0].includes(`http://localhost:${config.port}`), "대시보드 주소를 알려준다");
  } finally {
    f.restore();
  }
});

test("중복 억제: 6시간 안에 여러 번 실패해도 문자는 한 통", async () => {
  connectedStore();
  needsReauthStore();

  const f = stubFetch([{ ok: true, body: {} }]);
  try {
    // 하루에 도는 알림 네 종이 연달아 실패하는 상황.
    for (const subject of ["뉴스", "유튜브", "이벤트", "증시"]) {
      assert.equal(await sendMail({ subject, html: "<p>h</p>" }), false);
    }
    assert.equal(alerts.length, 1, "매 실패마다 문자가 오면 스팸이 되어 읽히지 않는다");
  } finally {
    f.restore();
  }
});

test("중복 억제: 6시간이 지나면 다시 한 통 보낸다", async () => {
  connectedStore();
  needsReauthStore();

  const f = stubFetch([{ ok: true, body: {} }]);
  try {
    assert.equal(await sendMail({ subject: "뉴스", html: "<p>h</p>" }), false);
    assert.equal(alerts.length, 1);

    // 마지막 경고를 7시간 전으로 돌린다(시계 조작 대신 저장값을 옮긴다).
    fs.writeFileSync(
      alertPath,
      JSON.stringify({ lastReauthAlertAt: Date.now() - 7 * 60 * 60 * 1000 }),
      "utf8"
    );
    __setAlertStorePathForTest(alertPath); // 메모리 캐시를 파일값으로 되돌린다.

    assert.equal(await sendMail({ subject: "증시", html: "<p>h</p>" }), false);
    assert.equal(alerts.length, 2, "6시간이 지났으면 다시 알려야 한다");
  } finally {
    f.restore();
  }
});

test("발송이 다시 성공하면 억제 타이머가 풀린다", async () => {
  connectedStore();
  needsReauthStore();

  const fail = stubFetch([{ ok: true, body: {} }]);
  try {
    assert.equal(await sendMail({ subject: "뉴스", html: "<p>h</p>" }), false);
    assert.equal(alerts.length, 1);
  } finally {
    fail.restore();
  }

  // 사용자가 대시보드에서 다시 연결 → 발송 성공.
  connectedStore();
  __setAlertStorePathForTest(alertPath); // 성공 케이스도 같은 경고 이력을 본다.
  const ok = stubFetch([{ ok: true, body: { id: "18f0" } }]);
  try {
    assert.equal(await sendMail({ subject: "뉴스", html: "<p>h</p>" }), true);
  } finally {
    ok.restore();
  }

  // 다음 사고 때는 6시간을 기다리지 않고 즉시 알려야 한다.
  needsReauthStore();
  const again = stubFetch([{ ok: true, body: {} }]);
  try {
    assert.equal(await sendMail({ subject: "증시", html: "<p>h</p>" }), false);
    assert.equal(alerts.length, 1, "리셋 뒤 첫 실패는 즉시 경고");
  } finally {
    again.restore();
  }
});

test("iMessage 발송이 실패해도 sendMail 은 throw 하지 않고, 다음 실패에 다시 시도한다", async () => {
  connectedStore();
  needsReauthStore();
  alertShouldFail = true;

  const f = stubFetch([{ ok: true, body: {} }]);
  try {
    assert.equal(await sendMail({ subject: "뉴스", html: "<p>h</p>" }), false);
    assert.equal(alerts.length, 0);

    // 문자가 실제로 나가지 못했으므로 억제 타이머를 켜면 안 된다 — 켜면 6시간 동안 침묵한다.
    assert.equal(fs.existsSync(alertPath), false, "실패한 경고는 이력으로 남기지 않는다");

    alertShouldFail = false;
    assert.equal(await sendMail({ subject: "증시", html: "<p>h</p>" }), false);
    assert.equal(alerts.length, 1, "복구되면 곧바로 경고가 나가야 한다");
  } finally {
    f.restore();
  }
});

test("iMessage 미설정이면 경고를 건너뛴다(발송 결과는 그대로 false)", async () => {
  connectedStore();
  needsReauthStore();
  config.notify.imessage = false;

  const f = stubFetch([{ ok: true, body: {} }]);
  try {
    assert.equal(await sendMail({ subject: "뉴스", html: "<p>h</p>" }), false);
    assert.equal(alerts.length, 0);
  } finally {
    f.restore();
    config.notify.imessage = true;
  }
});

test("일시적 실패(5xx)는 재인증 경고를 보내지 않는다", async () => {
  connectedStore();
  const f = stubFetch([{ ok: false, status: 503, body: { error: { message: "Backend Error" } } }]);
  try {
    assert.equal(await sendMail({ subject: "뉴스", html: "<p>h</p>" }), false);
    assert.equal(alerts.length, 0, "자격증명 문제가 아닌 실패로 문자를 보내면 늑대소년이 된다");
  } finally {
    f.restore();
  }
});

test.after(() => {
  __setStorePathForTest(null);
  __setAlertStorePathForTest(null);
  __setIMessageSenderForTest(null);
});
