/**
 * Google OAuth2 (설치형 앱 / loopback redirect) 토큰 관리.
 *
 * ## 왜 OAuth 인가
 * 원래는 Gmail 앱 비밀번호 + SMTP 였다. 2026-08-05 계정 비밀번호를 바꾸자 앱 비밀번호가
 * **조용히** 폐기됐고, 69건의 메일이 3일간 실패했는데 log.warn 한 줄로 삼켜져 아무도 몰랐다.
 * refresh token 은 비밀번호 변경으로 죽지 않고, 죽을 때는 `invalid_grant` 로 명시적으로
 * 알려준다 — 그 신호를 상태로 남겨(needsReauth) 화면에서 회수할 수 있게 하는 것이 이 모듈의 목적이다.
 *
 * ## scope 를 gmail.send 하나로 고정하는 이유
 * `https://mail.google.com/` 은 Google 의 **restricted scope** 라 CASA Tier2 유료 보안감사
 * 대상이 된다(개인 대시보드에 감사 비용을 물릴 수는 없다). 반면
 * `.../auth/gmail.send` 는 sensitive scope 로 감사 없이 쓸 수 있다.
 * `openid` · `email` 은 non-sensitive 라 붙여도 검증 부담이 없어, **연결된 계정 주소를 알아내려고**
 * 함께 요청한다 — gmail.send 만으로는 `users/me/profile` 도 userinfo 도 부를 수 없다.
 *
 * ## 의존성
 * 신규 npm 패키지 없이 node 내장 fetch 만 쓴다(googleapis 등 미설치).
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * 요청 scope. **gmail.send 외의 Gmail scope 를 추가하지 말 것** — 위 주석 참고.
 * openid/email 은 계정 주소 확인 전용이며 non-sensitive 다.
 */
export const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export const GOOGLE_SCOPES = ["openid", "email", SEND_SCOPE];

/**
 * access token 만료 안전 여유(ms). 만료 직전 토큰으로 발송을 시작하면 네트워크 왕복 도중
 * 만료돼 401 을 맞는다 — 60초를 미리 깎아 그 창을 없앤다.
 */
const EXPIRY_SKEW_MS = 60_000;

/** 토큰 저장 위치. data/ 는 gitignore 대상이고, 파일 권한은 0600 으로 고정한다. */
const DEFAULT_STORE_PATH = path.join(path.dirname(config.dbPath), "google-oauth.json");

let storePath = DEFAULT_STORE_PATH;

/** 재로그인이 필요한지까지 함께 전달하는 인증 오류. */
export class GoogleAuthError extends Error {
  readonly needsReauth: boolean;

  constructor(message: string, needsReauth = false) {
    super(message);
    this.name = "GoogleAuthError";
    this.needsReauth = needsReauth;
  }
}

/** 화면·API 가 "지금 메일을 보낼 수 있는 상태인가"를 판단하는 데 필요한 최소 정보. */
export type GoogleAuthStatus = {
  /** GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 이 설정돼 있는가. */
  configured: boolean;
  /** refresh token 을 보유하고 있고 마지막 갱신이 성공했는가. */
  connected: boolean;
  /** 연결된 계정 주소(id_token 의 email claim, 없으면 GMAIL_ADDRESS). */
  email: string | null;
  /** invalid_grant 등으로 재로그인이 필요한가. */
  needsReauth: boolean;
  /** 마지막 실패 사유(사람이 읽는 문장). 비밀값은 절대 담기지 않는다. */
  lastError: string | null;
  /** 마지막으로 토큰 발급/갱신에 성공한 시각(ISO). */
  lastSuccessAt: string | null;
  /** 동의 화면에서 실제로 부여받은 scope(공백 구분). 미연결이면 null. */
  grantedScope: string | null;
};

/** data/google-oauth.json 의 스키마. */
interface TokenState {
  refreshToken: string;
  /** 캐시된 access token. 만료 후에도 남아 있을 수 있으므로 expiresAt 과 함께 판단한다. */
  accessToken: string;
  /** access token 만료 시각(epoch ms). */
  expiresAt: number;
  email: string | null;
  needsReauth: boolean;
  lastError: string | null;
  lastSuccessAt: string | null;
  /**
   * 토큰 응답이 알려준, **실제로 부여받은** scope. 요청한 scope 와 다를 수 있다 —
   * 동의 화면에서 민감 권한은 개별 체크박스로 나오고 기본이 미체크라, 사용자가 그냥 [계속]을
   * 누르면 로그인은 성공하고 gmail.send 만 빠진다(2026-08-08 실제 발생: 화면은 "연결됨"인데
   * 발송은 403 insufficient scopes). 그래서 부여분을 저장해 두고 발송 전에 대조한다.
   */
  grantedScope: string | null;
}

const EMPTY_STATE: TokenState = {
  refreshToken: "",
  accessToken: "",
  expiresAt: 0,
  email: null,
  needsReauth: false,
  lastError: null,
  lastSuccessAt: null,
  grantedScope: null,
};

/**
 * 메모리 캐시. 매 발송마다 파일을 읽지 않기 위한 것이고, 프로세스가 죽으면 파일에서 복구된다.
 * null 이면 "아직 안 읽음" — 파일이 없어서 비어 있는 상태와 구분한다.
 */
let cached: TokenState | null = null;

/** 동시 refresh 중복 방지. 여러 메일이 한꺼번에 나갈 때 토큰 교환을 한 번으로 접는다. */
let refreshInFlight: Promise<string> | null = null;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 저장 파일 로드. 없거나 깨졌으면 빈 상태(= 미연결)로 접는다 — 여기서 throw 하면 기동이 막힌다. */
function readState(): TokenState {
  if (cached) return cached;
  try {
    if (fs.existsSync(storePath)) {
      const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, unknown>;
      cached = {
        refreshToken: str(raw.refreshToken),
        accessToken: str(raw.accessToken),
        expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : 0,
        email: typeof raw.email === "string" && raw.email ? raw.email : null,
        needsReauth: raw.needsReauth === true,
        lastError: typeof raw.lastError === "string" && raw.lastError ? raw.lastError : null,
        lastSuccessAt:
          typeof raw.lastSuccessAt === "string" && raw.lastSuccessAt ? raw.lastSuccessAt : null,
        grantedScope:
          typeof raw.grantedScope === "string" && raw.grantedScope ? raw.grantedScope : null,
      };
      return cached;
    }
  } catch (e) {
    // 메시지에 파일 내용은 실리지 않는다(JSON.parse 는 위치만 알려준다).
    log.warn(`google-oauth.json 읽기 실패 → 미연결로 간주: ${(e as Error).message}`);
  }
  cached = { ...EMPTY_STATE };
  return cached;
}

/**
 * 저장. **0600 으로 쓴다** — 이 파일 한 장이 곧 메일 발송 권한이다.
 * mode 옵션은 새로 만들 때만 적용되므로 기존 파일에도 chmod 를 한 번 더 건다.
 * tmp → rename 으로 원자적으로 바꿔, 중간에 죽어도 반쪽짜리 토큰 파일이 남지 않게 한다.
 */
function writeState(next: TokenState): void {
  cached = next;
  const dir = path.dirname(storePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${storePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, storePath);
}

function isConfigured(): boolean {
  return Boolean(config.notify.googleClientId && config.notify.googleClientSecret);
}

/**
 * access token 이 (여유분을 감안해) 아직 쓸 수 있는가.
 * 순수 함수로 분리해 시계 조작 없이 테스트한다.
 */
export function isAccessTokenUsable(
  state: { accessToken: string; expiresAt: number },
  now: number = Date.now()
): boolean {
  return Boolean(state.accessToken) && state.expiresAt - EXPIRY_SKEW_MS > now;
}

/**
 * id_token(JWT) payload 에서 email claim 을 꺼낸다.
 *
 * 서명 검증은 하지 않는다 — 이 토큰은 TLS 로 Google 토큰 엔드포인트에서 **직접** 받은 것이라
 * 중간자가 없고, 여기서 얻는 값은 화면에 "어느 계정에 연결됐는지" 보여주는 표시용일 뿐
 * 권한 판단에 쓰이지 않는다. (권한은 전적으로 refresh token 이 결정한다.)
 */
export function emailFromIdToken(idToken: string): string | null {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const claims = JSON.parse(json) as Record<string, unknown>;
    return typeof claims.email === "string" && claims.email ? claims.email : null;
  } catch {
    return null;
  }
}

/** 상태 직렬화. 토큰 자체는 절대 나가지 않는다 — 이 객체는 그대로 API 응답이 된다. */
export function getGoogleAuthStatus(): GoogleAuthStatus {
  const s = readState();
  // 발송 권한이 빠진 연결은 연결이 아니다. 예전에 저장된(grantedScope 가 null 인) 상태는
  // 판정을 보류하고 연결로 친다 — 실제 발송이 403 을 맞으면 그때 needsReauth 로 넘어간다.
  const canSend = s.grantedScope === null || s.grantedScope.split(/\s+/).includes(SEND_SCOPE);
  return {
    configured: isConfigured(),
    connected: Boolean(s.refreshToken) && !s.needsReauth && canSend,
    email: s.email,
    needsReauth: s.needsReauth || (Boolean(s.refreshToken) && !canSend),
    lastError: s.lastError,
    lastSuccessAt: s.lastSuccessAt,
    grantedScope: s.grantedScope,
  };
}

/**
 * "이 연결로는 더 보낼 수 없다"고 못 박는다. 발송 쪽에서 403(권한 누락)처럼 재시도가 무의미한
 * 응답을 받았을 때 호출한다 — 그래야 화면이 '연결됨'을 계속 보여주지 않는다.
 */
export function markNeedsReauth(reason: string): void {
  const prev = readState();
  writeState({ ...prev, needsReauth: true, lastError: reason });
}

/**
 * 동의 화면 URL.
 *
 * `access_type=offline` + `prompt=consent` 는 **refresh token 을 반드시 받기 위한** 조합이다.
 * offline 만 주면 이미 동의한 적 있는 계정에서는 refresh token 이 빠진 응답이 오고, 그러면
 * 다음 만료 이후 영영 갱신할 수 없는 상태로 조용히 굳는다.
 */
export function buildAuthUrl(redirectUri: string, state: string): string {
  if (!isConfigured()) {
    throw new GoogleAuthError("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 미설정");
  }
  const q = new URLSearchParams({
    client_id: config.notify.googleClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_ENDPOINT}?${q.toString()}`;
}

/** 토큰 엔드포인트 응답에서 우리가 쓰는 필드만. */
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  /** 실제로 부여된 scope(공백 구분). 요청분과 다를 수 있다 — TokenState.grantedScope 주석 참고. */
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * 토큰 엔드포인트 호출. 응답 본문은 파싱해서 돌려주되 **토큰 값은 로그에 남기지 않는다**.
 * HTTP 실패도 본문(error/error_description)이 필요하므로 여기서 throw 하지 않는다.
 */
async function postToken(body: URLSearchParams): Promise<{ ok: boolean; data: TokenResponse }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  let data: TokenResponse = {};
  try {
    data = (await res.json()) as TokenResponse;
  } catch {
    data = { error: "invalid_response", error_description: `HTTP ${res.status} 응답 파싱 실패` };
  }
  return { ok: res.ok, data };
}

/** error/error_description 을 사람이 읽을 한 줄로. 비밀값은 여기 실리지 않는다. */
function describe(data: TokenResponse): string {
  const e = data.error || "unknown_error";
  return data.error_description ? `${e}: ${data.error_description}` : e;
}

/**
 * 동의 후 받은 code 를 토큰으로 교환하고 저장한다.
 *
 * refresh token 이 안 오면 **성공으로 치지 않는다** — access token 만 저장해두면 한 시간 뒤
 * 조용히 죽는다. 그 자리에서 재로그인을 요구하는 편이 정직하다.
 */
export async function exchangeCode(code: string, redirectUri: string): Promise<void> {
  if (!isConfigured()) {
    throw new GoogleAuthError("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 미설정");
  }
  const { ok, data } = await postToken(
    new URLSearchParams({
      code,
      client_id: config.notify.googleClientId,
      client_secret: config.notify.googleClientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    })
  );

  if (!ok || !data.access_token) {
    const reason = describe(data);
    const prev = readState();
    writeState({ ...prev, lastError: `코드 교환 실패 — ${reason}` });
    throw new GoogleAuthError(`Google 토큰 교환 실패 — ${reason}`, data.error === "invalid_grant");
  }

  if (!data.refresh_token) {
    const msg =
      "refresh token 이 발급되지 않았습니다. " +
      "myaccount.google.com/permissions 에서 이 앱 접근을 삭제한 뒤 다시 연결하세요.";
    const prev = readState();
    writeState({ ...prev, lastError: msg, needsReauth: true });
    throw new GoogleAuthError(msg, true);
  }

  // 로그인 성공 ≠ 발송 가능. 동의 화면에서 "나를 대신하여 이메일 전송" 체크박스는 기본이
  // 미체크라, 그냥 [계속]을 누르면 refresh token 은 멀쩡히 오고 gmail.send 만 빠진다. 그대로
  // 저장하면 화면은 "연결됨"인데 발송마다 403 이 나는, 이 프로젝트가 이미 한 번 겪은 종류의
  // 침묵 실패가 된다. 그래서 여기서 즉시 걸러 재로그인을 요구한다.
  const granted = str(data.scope);
  if (!granted.split(/\s+/).includes(SEND_SCOPE)) {
    const msg =
      "메일 발송 권한이 승인되지 않았습니다. 동의 화면에서 " +
      "'나를 대신하여 이메일 전송' 항목을 체크한 뒤 다시 연결하세요.";
    const prev = readState();
    writeState({ ...prev, lastError: msg, needsReauth: true, grantedScope: granted || null });
    log.warn(`Google 계정 연결 거부 — 발송 권한 누락 (부여: ${granted || "없음"})`);
    throw new GoogleAuthError(msg, true);
  }

  const email =
    (data.id_token ? emailFromIdToken(data.id_token) : null) ||
    config.notify.gmailAddress ||
    null;

  writeState({
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: Date.now() + Math.max(0, data.expires_in ?? 0) * 1000,
    email,
    needsReauth: false,
    lastError: null,
    lastSuccessAt: new Date().toISOString(),
    grantedScope: granted,
  });
  log.info(`Google 계정 연결 완료${email ? ` (${email})` : ""}`);
}

/**
 * refresh token 으로 새 access token 을 받아 저장한다.
 *
 * `invalid_grant` 는 "refresh token 이 죽었다"는 뜻이다(사용자가 접근 권한 철회, 6개월 미사용,
 * 계정 보안 이벤트). 재시도해도 절대 살아나지 않으므로 needsReauth 로 **못 박아** 저장하고,
 * 화면이 그 사실을 드러낼 수 있게 한다 — 이 프로젝트가 앱 비밀번호로 잃었던 바로 그 신호다.
 */
async function refreshAccessToken(state: TokenState): Promise<string> {
  const { ok, data } = await postToken(
    new URLSearchParams({
      refresh_token: state.refreshToken,
      client_id: config.notify.googleClientId,
      client_secret: config.notify.googleClientSecret,
      grant_type: "refresh_token",
    })
  );

  if (!ok || !data.access_token) {
    const reason = describe(data);
    const dead = data.error === "invalid_grant";
    writeState({
      ...readState(),
      accessToken: "",
      expiresAt: 0,
      needsReauth: dead,
      lastError: `토큰 갱신 실패 — ${reason}`,
    });
    if (dead) {
      log.warn("Google refresh token 무효(invalid_grant) → 재로그인 필요. 대시보드에서 다시 연결하세요.");
      throw new GoogleAuthError(`Google 재로그인이 필요합니다 — ${reason}`, true);
    }
    throw new GoogleAuthError(`Google 토큰 갱신 실패 — ${reason}`, false);
  }

  writeState({
    ...readState(),
    // 회전(rotation)이 켜진 클라이언트는 갱신 때 새 refresh token 을 준다. 오면 갈아끼운다.
    refreshToken: data.refresh_token || state.refreshToken,
    accessToken: data.access_token,
    expiresAt: Date.now() + Math.max(0, data.expires_in ?? 0) * 1000,
    needsReauth: false,
    lastError: null,
    lastSuccessAt: new Date().toISOString(),
  });
  return data.access_token;
}

/**
 * 지금 쓸 수 있는 access token. 만료(60초 여유)면 자동으로 갱신한다.
 * 실패 시 GoogleAuthError — 재로그인이 필요한 경우 `needsReauth: true`.
 */
export async function getAccessToken(): Promise<string> {
  if (!isConfigured()) {
    throw new GoogleAuthError("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 미설정");
  }
  const state = readState();
  if (!state.refreshToken) {
    throw new GoogleAuthError("Google 계정이 연결돼 있지 않습니다. 대시보드에서 연결하세요.", true);
  }
  if (state.needsReauth) {
    throw new GoogleAuthError(
      `Google 재로그인이 필요합니다${state.lastError ? ` — ${state.lastError}` : ""}`,
      true
    );
  }
  if (isAccessTokenUsable(state)) return state.accessToken;

  // 동시에 여러 메일이 나가도 토큰 교환은 한 번만 한다.
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken(state).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * 캐시된 access token 을 버린다. 발송이 401 을 맞았을 때(서버 쪽에서 먼저 만료시킨 경우)
 * 다음 호출이 강제로 갱신을 타게 하는 용도다. refresh token 은 건드리지 않는다.
 */
export function invalidateAccessToken(): void {
  const s = readState();
  if (!s.accessToken && !s.expiresAt) return;
  writeState({ ...s, accessToken: "", expiresAt: 0 });
}

/**
 * 연결 해제. 토큰 파일을 지우고 메모리 캐시도 비운다.
 *
 * Google 쪽 권한 철회(revoke)까지 하지는 않는다 — 이 함수는 동기이고, 로컬에서 토큰을 버리면
 * 이 대시보드는 더 이상 보낼 수 없다. 완전한 철회가 필요하면 사용자가
 * myaccount.google.com/permissions 에서 직접 지운다.
 */
export function disconnect(): void {
  try {
    if (fs.existsSync(storePath)) fs.rmSync(storePath);
  } catch (e) {
    log.warn(`google-oauth.json 삭제 실패: ${(e as Error).message}`);
  }
  cached = { ...EMPTY_STATE };
  refreshInFlight = null;
  log.info("Google 계정 연결 해제됨");
}

/**
 * 테스트 전용 훅. 저장 경로를 임시 디렉터리로 돌리고 메모리 캐시를 비운다.
 * `null` 을 주면 기본 경로(data/google-oauth.json)로 되돌린다.
 */
export function __setStorePathForTest(p: string | null): void {
  storePath = p ?? DEFAULT_STORE_PATH;
  cached = null;
  refreshInFlight = null;
}
