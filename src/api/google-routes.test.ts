/**
 * `/api/google/*` (메일 발송용 Google 계정 연결) 라우트 회귀 테스트.
 *
 * 검증 대상:
 * 1. `GET /google/status` — 200 + 화면(MailAuthBanner.parseStatus)이 받아들이는 형태.
 * 2. `GET /google/auth-url` — 미설정이면 400, 설정돼 있으면 state 와 요청 Host 에서 유도한
 *    redirect_uri 가 박힌 동의 화면 주소.
 * 3. `GET /google/callback` — state 불일치·재사용·code 누락은 전부 `?google=error` 로 302,
 *    정상 흐름은 `?google=ok` 로 302 하며 **동의 때 쓴 redirect_uri 그대로** 교환한다.
 * 4. `POST /google/disconnect` — 200 이후 미연결. **GET 은 열려 있지 않다**(부수효과 있는 동작).
 *
 * ★ 네트워크로 실제 Google 을 부르지 않는다. 토큰 엔드포인트는 `globalThis.fetch` 를 갈아끼워
 *   막고(google-auth.test.ts 와 같은 수법), 이 파일이 서버로 보내는 요청은 가로채기 전에
 *   붙잡아 둔 원본 fetch(`httpFetch`)로 보낸다 — 안 그러면 테스트 자신의 요청이 스텁에 먹힌다.
 *
 * ★ 실제 `data/` 를 건드리지 않는다. `config` 는 import 시점에 `DB_PATH` 를 읽으므로 라우트를
 *   불러오기 **전에** 임시 경로로 갈아끼우고(`src/uptime/store.test.ts:9` 관례), 토큰 파일도
 *   `__setStorePathForTest` 로 임시 디렉터리에 둔다.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "google-routes-test-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");

const { api } = await import("./routes.ts");
const { config } = await import("../config.ts");
const { __setStorePathForTest, getGoogleAuthStatus } = await import("../notify/google-auth.ts");

// ── 테스트 서버 ──

const app = express();
app.use(express.json());
app.use("/api", api);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

/** 서버로 가는 요청 전용. 아래에서 globalThis.fetch 를 갈아끼우므로 원본을 붙잡아 둔다. */
const httpFetch = globalThis.fetch.bind(globalThis);

/** 302 를 따라가지 않는다 — 이 테스트가 확인하려는 것이 바로 그 Location 이다. */
function req(pathname: string, init?: RequestInit) {
  return httpFetch(`${base}${pathname}`, { redirect: "manual", ...init });
}

after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 공용 준비물 ──

/** .env 가 채워진 상태(= configured). 토큰 파일은 매번 새 임시 경로로 돌린다. */
function configured(): void {
  config.notify.googleClientId = "test-client-id";
  config.notify.googleClientSecret = "test-client-secret";
  __setStorePathForTest(path.join(fs.mkdtempSync(path.join(tmpDir, "store-")), "google-oauth.json"));
}

/** 토큰 엔드포인트 스텁. 반환값으로 실제 교환 인자(redirect_uri·code)를 확인한다. */
function stubTokenEndpoint(res: { ok: boolean; body: unknown }) {
  const calls: URLSearchParams[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(new URLSearchParams(String(init?.body ?? "")));
    return {
      ok: res.ok,
      status: res.ok ? 200 : 400,
      json: async () => res.body,
      text: async () => JSON.stringify(res.body),
    };
  }) as unknown as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

/** 서명 없는 가짜 id_token. google-auth 는 서명을 검증하지 않는다(표시용 email 만 꺼낸다). */
function fakeIdToken(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.sig`;
}

/** 동의 화면 주소를 받아 그 안의 state 를 꺼낸다(= 서버가 기억하고 있는 대기표). */
async function issueState(): Promise<{ state: string; redirectUri: string }> {
  const res = await req("/api/google/auth-url");
  assert.equal(res.status, 200);
  const { url } = (await res.json()) as { url: string };
  const q = new URL(url).searchParams;
  return { state: q.get("state") ?? "", redirectUri: q.get("redirect_uri") ?? "" };
}

/** 302 의 목적지에서 `google` / `reason` 표식을 꺼낸다. */
function redirectMarks(res: Response): { google: string | null; reason: string | null } {
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("location") ?? "", base);
  return { google: loc.searchParams.get("google"), reason: loc.searchParams.get("reason") };
}

/** 콘솔을 가로채 이 블록에서 실제로 찍힌 로그를 모은다(비밀값 유출 확인용). */
async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const lines: string[] = [];
  const sink =
    (...args: unknown[]) => void lines.push(args.map((a) => String(a)).join(" "));
  console.log = sink;
  console.warn = sink;
  console.error = sink;
  try {
    await fn();
  } finally {
    Object.assign(console, originals);
  }
  return lines.join("\n");
}

// ── GET /api/google/status ──

test("status: 200 + 화면이 받아들이는 형태로 내려간다 (토큰은 절대 실리지 않는다)", async () => {
  configured();
  const res = await req("/api/google/status");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);

  const body = (await res.json()) as Record<string, unknown>;
  // MailAuthBanner.parseStatus 가 요구하는 3개 불리언 — 하나라도 빠지면 화면이 상태를 통째로 버린다.
  assert.equal(typeof body.configured, "boolean");
  assert.equal(typeof body.connected, "boolean");
  assert.equal(typeof body.needsReauth, "boolean");
  assert.deepEqual(
    Object.keys(body).sort(),
    ["configured", "connected", "email", "grantedScope", "lastError", "lastSuccessAt", "needsReauth"]
  );
  // 미연결 상태에서 시작한다(임시 저장소라 토큰 파일이 없다).
  assert.equal(body.configured, true);
  assert.equal(body.connected, false);
});

// ── GET /api/google/auth-url ──

test("auth-url: 클라이언트 미설정이면 400 + 사유", async () => {
  config.notify.googleClientId = "";
  config.notify.googleClientSecret = "";
  const res = await req("/api/google/auth-url");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /GOOGLE_CLIENT_ID/);
});

test("auth-url: state 와 요청 Host 에서 유도한 redirect_uri 가 박힌 동의 화면 주소", async () => {
  configured();
  const res = await req("/api/google/auth-url");
  assert.equal(res.status, 200);

  const { url } = (await res.json()) as { url: string };
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, "https://accounts.google.com/o/oauth2/v2/auth");

  const q = parsed.searchParams;
  assert.equal(q.get("client_id"), "test-client-id");
  // ★ 포트는 요청 Host(=테스트 서버의 임의 포트)에서 오고, 스킴·호스트이름은 localhost 로 고정.
  //   127.0.0.1 로 접속해도 Google Console 에 등록된 형태 그대로 나가야 한다.
  assert.equal(q.get("redirect_uri"), `http://localhost:${port}/api/google/callback`);
  // refresh token 을 반드시 받기 위한 조합(google-auth.ts buildAuthUrl 주석).
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("prompt"), "consent");
  assert.match(q.get("scope") ?? "", /gmail\.send/);
  // state 는 추측할 수 없어야 한다 — 16바이트 난수의 hex.
  assert.match(q.get("state") ?? "", /^[0-9a-f]{32}$/);

  // 호출할 때마다 다른 대기표가 나온다.
  const again = await issueState();
  assert.notEqual(again.state, q.get("state"));
});

// ── GET /api/google/callback ──

test("callback: state 가 없거나 다르면 교환하지 않고 error 리다이렉트", async () => {
  configured();
  const stub = stubTokenEndpoint({ ok: true, body: {} });
  try {
    const noState = await req("/api/google/callback?code=abc");
    assert.deepEqual(redirectMarks(noState), { google: "error", reason: "state_mismatch" });

    const wrongState = await req("/api/google/callback?code=abc&state=deadbeef");
    assert.deepEqual(redirectMarks(wrongState), { google: "error", reason: "state_mismatch" });
  } finally {
    stub.restore();
  }
  // 토큰 엔드포인트는 한 번도 불리지 않아야 한다 — 대조 전에 code 를 쓰면 방어가 무의미하다.
  assert.equal(stub.calls.length, 0);
});

test("callback: 정상 state 라도 1회용 — 같은 표를 다시 쓰면 state_mismatch", async () => {
  configured();
  const { state } = await issueState();

  // 첫 사용: Google 이 거절한 경우에도 대기표는 소비된다.
  const first = await req(`/api/google/callback?state=${state}&error=access_denied`);
  assert.deepEqual(redirectMarks(first), { google: "error", reason: "access_denied" });

  const replay = await req(`/api/google/callback?state=${state}&code=abc`);
  assert.deepEqual(redirectMarks(replay), { google: "error", reason: "state_mismatch" });
});

test("callback: 모르는 error 값은 그대로 흘리지 않고 auth_failed 로 접는다", async () => {
  configured();
  const { state } = await issueState();
  const res = await req(`/api/google/callback?state=${state}&error=%3Cscript%3E`);
  assert.deepEqual(redirectMarks(res), { google: "error", reason: "auth_failed" });
});

test("callback: code 가 없으면 missing_code", async () => {
  configured();
  const { state } = await issueState();
  const res = await req(`/api/google/callback?state=${state}`);
  assert.deepEqual(redirectMarks(res), { google: "error", reason: "missing_code" });
});

test("callback: 성공하면 동의 때 쓴 redirect_uri 그대로 교환하고 ?google=ok 로 돌려보낸다", async () => {
  configured();
  const { state, redirectUri } = await issueState();
  const stub = stubTokenEndpoint({
    ok: true,
    body: {
      access_token: "at-1",
      refresh_token: "rt-1", scope: "openid email https://www.googleapis.com/auth/gmail.send",
      expires_in: 3600,
      id_token: fakeIdToken({ email: "me@example.com" }),
    },
  });
  try {
    const res = await req(`/api/google/callback?state=${state}&code=auth-code-1`);
    assert.deepEqual(redirectMarks(res), { google: "ok", reason: null });
  } finally {
    stub.restore();
  }

  assert.equal(stub.calls.length, 1);
  // ★ 동의 요청과 **한 글자도 다르면** Google 이 거절한다. 콜백의 Host 로 다시 계산하지 않는다.
  assert.equal(stub.calls[0].get("redirect_uri"), redirectUri);
  assert.equal(stub.calls[0].get("code"), "auth-code-1");
  assert.equal(stub.calls[0].get("grant_type"), "authorization_code");

  const status = (await (await req("/api/google/status")).json()) as Record<string, unknown>;
  assert.equal(status.connected, true);
  assert.equal(status.email, "me@example.com");
});

test("callback: 교환 실패는 사유 코드만 싣고, code·비밀값은 로그에 남기지 않는다", async () => {
  configured();
  const { state } = await issueState();
  const stub = stubTokenEndpoint({
    ok: false,
    body: { error: "invalid_grant", error_description: "Bad Request" },
  });
  let marks: { google: string | null; reason: string | null } = { google: null, reason: null };
  const logged = await captureLogs(async () => {
    const res = await req(`/api/google/callback?state=${state}&code=super-secret-code`);
    marks = redirectMarks(res);
  });
  stub.restore();

  // 화면(MailAuthBanner.reasonText)이 문장으로 풀어 주는 코드다.
  assert.deepEqual(marks, { google: "error", reason: "invalid_grant" });
  assert.ok(logged.includes("invalid_grant"), `사유가 로그에 남아야 한다: ${logged}`);
  assert.ok(!logged.includes("super-secret-code"), `code 가 로그에 새어 나갔다: ${logged}`);
  assert.ok(!logged.includes("test-client-secret"), `client_secret 이 로그에 새어 나갔다: ${logged}`);
  // 실패해도 미연결 상태는 화면이 읽을 수 있는 형태로 남는다.
  assert.equal(getGoogleAuthStatus().connected, false);
});

// ── 연결 해제 ──

test("disconnect: GET 은 열려 있지 않다 (부수효과 있는 동작을 GET 에 두지 않는다)", async () => {
  const res = await req("/api/google/disconnect");
  assert.ok([404, 405].includes(res.status), `GET 이 ${res.status} 로 처리됐다`);
});

test("disconnect: POST 는 200 + 이후 미연결", async () => {
  configured();
  // 먼저 연결된 상태를 만든다.
  const { state } = await issueState();
  const stub = stubTokenEndpoint({
    ok: true,
    body: { access_token: "at-2", refresh_token: "rt-2", scope: "openid email https://www.googleapis.com/auth/gmail.send", expires_in: 3600 },
  });
  try {
    await req(`/api/google/callback?state=${state}&code=auth-code-2`);
  } finally {
    stub.restore();
  }
  assert.equal(getGoogleAuthStatus().connected, true);

  const res = await req("/api/google/disconnect", { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const status = (await (await req("/api/google/status")).json()) as Record<string, unknown>;
  assert.equal(status.connected, false);
});

test("disconnect: 해제 시점에 떠 있던 대기표도 함께 버린다", async () => {
  configured();
  const { state } = await issueState();
  await req("/api/google/disconnect", { method: "POST" });

  // 뒤늦게 돌아온 콜백이 방금 누른 '해제' 를 되살리면 안 된다.
  const late = await req(`/api/google/callback?state=${state}&code=late-code`);
  assert.deepEqual(redirectMarks(late), { google: "error", reason: "state_mismatch" });
  assert.equal(getGoogleAuthStatus().connected, false);
});
