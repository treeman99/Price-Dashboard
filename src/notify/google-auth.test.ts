import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.ts";
import {
  GOOGLE_SCOPES,
  GoogleAuthError,
  __setStorePathForTest,
  buildAuthUrl,
  disconnect,
  emailFromIdToken,
  exchangeCode,
  getAccessToken,
  getGoogleAuthStatus,
  invalidateAccessToken,
  isAccessTokenUsable,
} from "./google-auth.ts";

/**
 * 실제 Google 자격증명 없이 도는 스텁 테스트. 네트워크는 globalThis.fetch 를 갈아끼워 막고,
 * 토큰 파일은 임시 디렉터리로 돌린다(진짜 data/google-oauth.json 을 건드리면 안 된다).
 */

/** 테스트마다 새 임시 저장소 + 클라이언트 설정을 세운다. */
function freshStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goauth-"));
  __setStorePathForTest(path.join(dir, "google-oauth.json"));
  config.notify.googleClientId = "test-client-id";
  config.notify.googleClientSecret = "test-client-secret";
  return path.join(dir, "google-oauth.json");
}

/** fetch 를 고정 응답 큐로 대체한다. 반환값으로 실제 호출 인자를 확인할 수 있다. */
function stubFetch(responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? "")) });
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  }) as unknown as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

/** 서명 없는 가짜 id_token(payload 만 base64url). 모듈은 서명을 검증하지 않는다. */
function fakeIdToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

// ── 토큰 만료 판정 ──

test("isAccessTokenUsable: 토큰이 없으면 사용 불가", () => {
  assert.equal(isAccessTokenUsable({ accessToken: "", expiresAt: Date.now() + 3600_000 }), false);
});

test("isAccessTokenUsable: 만료가 지났으면 사용 불가", () => {
  const now = 1_000_000;
  assert.equal(isAccessTokenUsable({ accessToken: "t", expiresAt: now - 1 }, now), false);
});

test("isAccessTokenUsable: 60초 여유 안쪽이면 사용 불가(왕복 중 만료 방지)", () => {
  const now = 1_000_000;
  // 59초 남음 → 여유(60초)보다 짧으므로 미리 갱신해야 한다.
  assert.equal(isAccessTokenUsable({ accessToken: "t", expiresAt: now + 59_000 }, now), false);
  // 61초 남음 → 아직 쓴다.
  assert.equal(isAccessTokenUsable({ accessToken: "t", expiresAt: now + 61_000 }, now), true);
});

// ── 동의 URL ──

test("buildAuthUrl: offline+consent+state 를 담고, restricted scope 는 절대 넣지 않는다", () => {
  freshStore();
  const url = new URL(buildAuthUrl("http://localhost:7777/api/google/callback", "st4te"));
  const q = url.searchParams;
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("prompt"), "consent");
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("state"), "st4te");
  assert.equal(q.get("client_id"), "test-client-id");
  assert.equal(q.get("redirect_uri"), "http://localhost:7777/api/google/callback");

  const scopes = (q.get("scope") ?? "").split(" ");
  assert.ok(scopes.includes("https://www.googleapis.com/auth/gmail.send"));
  // CASA Tier2 유료 감사 대상이라 절대 요청하면 안 되는 scope.
  assert.ok(!scopes.includes("https://mail.google.com/"));
  assert.deepEqual(scopes, GOOGLE_SCOPES);
});

test("buildAuthUrl: client 미설정이면 GoogleAuthError", () => {
  freshStore();
  config.notify.googleClientId = "";
  assert.throws(() => buildAuthUrl("http://localhost/cb", "s"), GoogleAuthError);
  config.notify.googleClientId = "test-client-id";
});

// ── id_token 파싱 ──

test("emailFromIdToken: email claim 을 꺼낸다", () => {
  assert.equal(emailFromIdToken(fakeIdToken({ email: "me@gmail.com" })), "me@gmail.com");
});

test("emailFromIdToken: 형식이 깨졌으면 null (throw 하지 않음)", () => {
  assert.equal(emailFromIdToken("not-a-jwt"), null);
  assert.equal(emailFromIdToken(""), null);
  assert.equal(emailFromIdToken(fakeIdToken({ sub: "123" })), null);
});

// ── 코드 교환 ──

test("exchangeCode: 토큰 저장 + 상태 연결됨 + 파일 권한 0600", async () => {
  const file = freshStore();
  const f = stubFetch([
    {
      ok: true,
      body: {
        access_token: "at-1",
        refresh_token: "rt-1", scope: "openid email https://www.googleapis.com/auth/gmail.send",
        expires_in: 3599,
        id_token: fakeIdToken({ email: "me@gmail.com" }),
      },
    },
  ]);
  try {
    await exchangeCode("code-1", "http://localhost:7777/cb");

    const sent = f.calls[0];
    assert.equal(sent.url, "https://oauth2.googleapis.com/token");
    assert.equal(sent.body.get("grant_type"), "authorization_code");
    assert.equal(sent.body.get("code"), "code-1");

    const st = getGoogleAuthStatus();
    assert.equal(st.configured, true);
    assert.equal(st.connected, true);
    assert.equal(st.needsReauth, false);
    assert.equal(st.email, "me@gmail.com");
    assert.equal(st.lastError, null);
    assert.ok(st.lastSuccessAt && !Number.isNaN(Date.parse(st.lastSuccessAt)));

    // 이 파일 한 장이 곧 발송 권한이므로 소유자 전용이어야 한다.
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    f.restore();
  }
});

test("exchangeCode: refresh_token 이 없으면 needsReauth 로 못 박고 실패", async () => {
  freshStore();
  const f = stubFetch([{ ok: true, body: { access_token: "at-1", expires_in: 3599 } }]);
  try {
    await assert.rejects(
      () => exchangeCode("code-1", "http://localhost/cb"),
      (e: unknown) => e instanceof GoogleAuthError && e.needsReauth
    );
    const st = getGoogleAuthStatus();
    assert.equal(st.connected, false);
    assert.equal(st.needsReauth, true);
    assert.ok(st.lastError);
  } finally {
    f.restore();
  }
});

test("exchangeCode: 교환 실패(invalid_grant)는 needsReauth 로 전달", async () => {
  freshStore();
  const f = stubFetch([
    { ok: false, status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } },
  ]);
  try {
    await assert.rejects(
      () => exchangeCode("stale-code", "http://localhost/cb"),
      (e: unknown) => e instanceof GoogleAuthError && e.needsReauth
    );
  } finally {
    f.restore();
  }
});

// ── access token 발급/갱신 ──

test("getAccessToken: 미연결이면 재로그인 필요 오류 (네트워크 호출 없음)", async () => {
  freshStore();
  const f = stubFetch([{ ok: true, body: {} }]);
  try {
    await assert.rejects(
      () => getAccessToken(),
      (e: unknown) => e instanceof GoogleAuthError && e.needsReauth
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

test("getAccessToken: 유효한 캐시가 있으면 갱신하지 않는다", async () => {
  freshStore();
  const setup = stubFetch([
    { ok: true, body: { access_token: "at-1", refresh_token: "rt-1", scope: "openid email https://www.googleapis.com/auth/gmail.send", expires_in: 3599 } },
  ]);
  await exchangeCode("c", "http://localhost/cb");
  setup.restore();

  const f = stubFetch([{ ok: true, body: { access_token: "at-2", expires_in: 3599 } }]);
  try {
    assert.equal(await getAccessToken(), "at-1");
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

test("getAccessToken: 만료됐으면 refresh_token 으로 갱신한다", async () => {
  freshStore();
  const setup = stubFetch([
    // expires_in 0 → 이미 만료된 것으로 저장된다.
    { ok: true, body: { access_token: "at-1", refresh_token: "rt-1", scope: "openid email https://www.googleapis.com/auth/gmail.send", expires_in: 0 } },
  ]);
  await exchangeCode("c", "http://localhost/cb");
  setup.restore();

  const f = stubFetch([{ ok: true, body: { access_token: "at-2", expires_in: 3599 } }]);
  try {
    assert.equal(await getAccessToken(), "at-2");
    assert.equal(f.calls[0].body.get("grant_type"), "refresh_token");
    assert.equal(f.calls[0].body.get("refresh_token"), "rt-1");
    // 두 번째 호출은 캐시 적중 — 네트워크 왕복이 늘지 않아야 한다.
    assert.equal(await getAccessToken(), "at-2");
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test("getAccessToken: 동시 호출은 갱신 한 번으로 접힌다", async () => {
  freshStore();
  const setup = stubFetch([
    { ok: true, body: { access_token: "at-1", refresh_token: "rt-1", scope: "openid email https://www.googleapis.com/auth/gmail.send", expires_in: 0 } },
  ]);
  await exchangeCode("c", "http://localhost/cb");
  setup.restore();

  const f = stubFetch([{ ok: true, body: { access_token: "at-2", expires_in: 3599 } }]);
  try {
    const [a, b, c] = await Promise.all([getAccessToken(), getAccessToken(), getAccessToken()]);
    assert.deepEqual([a, b, c], ["at-2", "at-2", "at-2"]);
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test("getAccessToken: invalid_grant → needsReauth 전이 (이후 호출은 네트워크 없이 즉시 실패)", async () => {
  freshStore();
  const setup = stubFetch([
    { ok: true, body: { access_token: "at-1", refresh_token: "rt-1", scope: "openid email https://www.googleapis.com/auth/gmail.send", expires_in: 0 } },
  ]);
  await exchangeCode("c", "http://localhost/cb");
  setup.restore();
  assert.equal(getGoogleAuthStatus().connected, true);

  const f = stubFetch([
    {
      ok: false,
      status: 400,
      body: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
    },
  ]);
  try {
    await assert.rejects(
      () => getAccessToken(),
      (e: unknown) => e instanceof GoogleAuthError && e.needsReauth
    );

    const st = getGoogleAuthStatus();
    assert.equal(st.needsReauth, true);
    assert.equal(st.connected, false);
    assert.ok(st.lastError?.includes("invalid_grant"));

    // 죽은 refresh token 은 재시도해도 살아나지 않는다 — 다시 호출해도 fetch 는 늘지 않는다.
    await assert.rejects(
      () => getAccessToken(),
      (e: unknown) => e instanceof GoogleAuthError && e.needsReauth
    );
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test("getAccessToken: 일시적 실패는 needsReauth 로 승격하지 않는다", async () => {
  freshStore();
  const setup = stubFetch([
    { ok: true, body: { access_token: "at-1", refresh_token: "rt-1", scope: "openid email https://www.googleapis.com/auth/gmail.send", expires_in: 0 } },
  ]);
  await exchangeCode("c", "http://localhost/cb");
  setup.restore();

  const f = stubFetch([{ ok: false, status: 503, body: { error: "backend_error" } }]);
  try {
    await assert.rejects(
      () => getAccessToken(),
      (e: unknown) => e instanceof GoogleAuthError && !e.needsReauth
    );
    const st = getGoogleAuthStatus();
    assert.equal(st.needsReauth, false);
    // refresh token 은 살아 있으므로 여전히 '연결됨'이다.
    assert.equal(st.connected, true);
    assert.ok(st.lastError?.includes("backend_error"));
  } finally {
    f.restore();
  }
});

test("getAccessToken: 갱신이 새 refresh_token 을 주면 갈아끼운다", async () => {
  freshStore();
  const setup = stubFetch([
    { ok: true, body: { access_token: "at-1", refresh_token: "rt-1", scope: "openid email https://www.googleapis.com/auth/gmail.send", expires_in: 0 } },
  ]);
  await exchangeCode("c", "http://localhost/cb");
  setup.restore();

  const f = stubFetch([
    { ok: true, body: { access_token: "at-2", refresh_token: "rt-2", expires_in: 0 } },
    { ok: true, body: { access_token: "at-3", expires_in: 3599 } },
  ]);
  try {
    await getAccessToken();
    await getAccessToken();
    assert.equal(f.calls[1].body.get("refresh_token"), "rt-2");
  } finally {
    f.restore();
  }
});

// ── 캐시 무효화 / 연결 해제 ──

test("invalidateAccessToken: access token 만 버리고 연결은 유지한다", async () => {
  freshStore();
  const setup = stubFetch([
    { ok: true, body: { access_token: "at-1", refresh_token: "rt-1", scope: "openid email https://www.googleapis.com/auth/gmail.send", expires_in: 3599 } },
  ]);
  await exchangeCode("c", "http://localhost/cb");
  setup.restore();

  invalidateAccessToken();
  assert.equal(getGoogleAuthStatus().connected, true);

  const f = stubFetch([{ ok: true, body: { access_token: "at-2", expires_in: 3599 } }]);
  try {
    // 캐시를 버렸으니 갱신을 타야 한다.
    assert.equal(await getAccessToken(), "at-2");
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test("disconnect: 파일과 상태를 모두 비운다", async () => {
  const file = freshStore();
  const setup = stubFetch([
    {
      ok: true,
      body: {
        access_token: "at-1",
        refresh_token: "rt-1", scope: "openid email https://www.googleapis.com/auth/gmail.send",
        expires_in: 3599,
        id_token: fakeIdToken({ email: "me@gmail.com" }),
      },
    },
  ]);
  await exchangeCode("c", "http://localhost/cb");
  setup.restore();
  assert.equal(fs.existsSync(file), true);

  disconnect();
  assert.equal(fs.existsSync(file), false);
  const st = getGoogleAuthStatus();
  assert.equal(st.connected, false);
  assert.equal(st.email, null);
  assert.equal(st.needsReauth, false);
  assert.equal(st.lastSuccessAt, null);
});

// ── 상태 직렬화 ──

test("getGoogleAuthStatus: 토큰을 절대 노출하지 않는다(그대로 API 응답이 된다)", async () => {
  freshStore();
  const setup = stubFetch([
    {
      ok: true,
      body: {
        access_token: "SECRET-at",
        refresh_token: "SECRET-rt",
        expires_in: 3599,
        scope: "openid email https://www.googleapis.com/auth/gmail.send",
        id_token: fakeIdToken({ email: "me@gmail.com" }),
      },
    },
  ]);
  await exchangeCode("c", "http://localhost/cb");
  setup.restore();

  const st = getGoogleAuthStatus();
  assert.deepEqual(Object.keys(st).sort(), [
    "configured",
    "connected",
    "email",
    "grantedScope",
    "lastError",
    "lastSuccessAt",
    "needsReauth",
  ]);
  const json = JSON.stringify(st);
  assert.ok(!json.includes("SECRET-at"));
  assert.ok(!json.includes("SECRET-rt"));
});

test("getGoogleAuthStatus: 저장 파일이 깨져 있어도 미연결로 접는다", () => {
  const file = freshStore();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json", "utf8");
  __setStorePathForTest(file); // 캐시 비우고 다시 읽게 한다

  const st = getGoogleAuthStatus();
  assert.equal(st.connected, false);
  assert.equal(st.needsReauth, false);
});

test("getGoogleAuthStatus: client 미설정이면 configured=false", () => {
  freshStore();
  config.notify.googleClientId = "";
  config.notify.googleClientSecret = "";
  assert.equal(getGoogleAuthStatus().configured, false);
  config.notify.googleClientId = "test-client-id";
  config.notify.googleClientSecret = "test-client-secret";
});

// ── 부여 scope 검증 ──
//
// 2026-08-08 실제 사고: 동의 화면에서 '나를 대신하여 이메일 전송'이 미체크인 채로 [계속]을
// 누르자 refresh token 은 정상 발급됐고 화면은 "연결됨"을 보여줬는데, 정작 발송은 전부
// 403 insufficient scopes 로 죽었다. 로그인 성공을 발송 가능으로 착각하지 않도록 못 박는다.

test("exchangeCode: gmail.send 가 빠진 동의는 연결로 치지 않는다", async () => {
  freshStore();
  const f = stubFetch([
    {
      ok: true,
      body: {
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3599,
        scope: "openid email", // 사용자가 발송 권한 체크를 빠뜨린 경우
      },
    },
  ]);
  try {
    await assert.rejects(() => exchangeCode("c", "http://localhost/cb"), /발송 권한/);
  } finally {
    f.restore();
  }

  const st = getGoogleAuthStatus();
  assert.equal(st.connected, false, "권한 없는 연결을 connected 로 보고하면 안 된다");
  assert.equal(st.needsReauth, true, "재로그인을 요구해야 한다");
  assert.match(String(st.lastError), /이메일 전송/);
});

test("getGoogleAuthStatus: 발송 scope 없는 저장 상태는 재로그인 대상이다", () => {
  const file = freshStore();
  fs.writeFileSync(
    file,
    JSON.stringify({
      refreshToken: "rt-1",
      accessToken: "at-1",
      expiresAt: Date.now() + 3_600_000,
      email: "me@gmail.com",
      needsReauth: false,
      lastError: null,
      lastSuccessAt: new Date().toISOString(),
      grantedScope: "openid email",
    })
  );
  __setStorePathForTest(file);

  const st = getGoogleAuthStatus();
  assert.equal(st.connected, false);
  assert.equal(st.needsReauth, true);
});

test("getGoogleAuthStatus: grantedScope 미기록(구버전 파일)은 연결로 인정한다", () => {
  const file = freshStore();
  fs.writeFileSync(
    file,
    JSON.stringify({
      refreshToken: "rt-1",
      accessToken: "at-1",
      expiresAt: Date.now() + 3_600_000,
      email: "me@gmail.com",
      needsReauth: false,
      lastError: null,
      lastSuccessAt: new Date().toISOString(),
    })
  );
  __setStorePathForTest(file);

  // 판정 근거가 없을 뿐이라 막지 않는다 — 실제 발송이 403 이면 그때 needsReauth 로 넘어간다.
  const st = getGoogleAuthStatus();
  assert.equal(st.connected, true);
  assert.equal(st.needsReauth, false);
  assert.equal(st.grantedScope, null);
});

test.after(() => {
  // 다른 테스트 파일이 진짜 data/ 를 보게 되돌린다.
  __setStorePathForTest(null);
});
