/**
 * Gmail API(`users.messages.send`) 기반 메일 발송.
 *
 * SMTP + 앱 비밀번호를 대체한다. 네 개 이메일 모듈(news/youtube/events/stock)이 각자
 * nodemailer transport 를 만들던 것을 이 한 곳으로 모은다 — 자격증명이 죽었을 때
 * "어디서 왜 실패했는지"가 네 군데로 흩어지지 않게 하는 것이 절반의 목적이다.
 *
 * MIME 생성만 nodemailer 의 MailComposer 를 재사용한다(이미 설치돼 있고, CID 인라인 첨부의
 * multipart/related 중첩을 직접 조립할 이유가 없다). 전송은 내장 fetch 로 Gmail REST 를 친다.
 */
import fs from "node:fs";
import path from "node:path";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import {
  GoogleAuthError,
  getAccessToken,
  getGoogleAuthStatus,
  invalidateAccessToken,
  markNeedsReauth,
} from "./google-auth.ts";
import { isIMessageConfigured, sendIMessage } from "./imessage.ts";

const SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

/**
 * 표준(비-업로드) 엔드포인트의 메시지 상한. 넘으면 Google 이 거절한다.
 * 증시 메일이 붙이는 차트 PNG 가 늘어날 때 원인을 바로 알 수 있게 미리 경고한다.
 */
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

/** 재시도 대상 HTTP 상태(일시적 장애). 4xx 는 다시 보내도 같은 답이 온다. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const MAX_ATTEMPTS = 3;

/**
 * 재인증 경고 iMessage 의 최소 간격(6시간).
 *
 * 하루에 도는 알림은 뉴스·유튜브·이벤트·증시(장별 2회) 로 여러 건이다. 자격증명이 죽으면
 * 그 전부가 실패하므로 실패마다 문자를 보내면 하루 예닐곱 통이 되고, 스팸이 되는 순간
 * 사람은 읽지 않는다 — 그러면 log.warn 으로 삼켰던 2026-08-05 와 결과가 같아진다.
 */
const REAUTH_ALERT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 마지막 경고 시각 저장 위치. 토큰이 아니라 타임스탬프뿐이라 0600 은 필요 없다. */
const DEFAULT_ALERT_PATH = path.join(path.dirname(config.dbPath), "mail-alert.json");

let alertPath = DEFAULT_ALERT_PATH;

/** 마지막 경고 시각(epoch ms). null 은 "아직 파일을 안 읽음", 0 은 "경고한 적 없음". */
let cachedAlertAt: number | null = null;

/** 테스트에서 갈아끼울 수 있게 한 겹 둔다. 실제 발송은 osascript 를 타므로 스텁이 필요하다. */
let imessageSender: (text: string) => Promise<void> = (text) => sendIMessage(text);

export type MailAttachment = {
  filename: string;
  content: Buffer;
  /** 지정하면 본문에서 `<img src="cid:...">` 로 인라인 참조된다. */
  cid?: string;
  contentType?: string;
};

/**
 * 발송을 **시도할 만한** 설정이 갖춰졌는가.
 *
 * 일부러 "연결됨(connected)"까지 요구하지 않는다. 연결이 끊긴 상태를 여기서 false 로 접으면
 * 호출부가 조용히 건너뛰고 끝나는데, 그게 정확히 2026-08-05 에 69건을 잃고도 3일간 몰랐던
 * 실패 모드다. 미연결이면 sendMail 이 시도하다 실패하며 **재로그인이 필요하다고 경고를 남긴다**.
 */
export function isMailConfigured(): boolean {
  return (
    config.notify.email &&
    Boolean(config.notify.gmailAddress) &&
    getGoogleAuthStatus().configured
  );
}

/**
 * RFC822 원문을 만들어 base64url 로 인코딩한다. 순수 함수 — 네트워크를 타지 않는다.
 * (Gmail API 의 `raw` 는 base64url: `+/` 대신 `-_`, 패딩 없음.)
 */
export async function buildRawMessage(opts: {
  subject: string;
  html: string;
  attachments?: MailAttachment[];
  from?: string;
  to?: string;
}): Promise<string> {
  const address = config.notify.gmailAddress;
  const composer = new MailComposer({
    from: opts.from ?? address,
    // 기존 SMTP 발송과 동일하게 자기 자신에게 보낸다.
    to: opts.to ?? address,
    subject: opts.subject,
    html: opts.html,
    attachments: opts.attachments,
  });
  const message = await composer.compile().build();
  return message.toString("base64url");
}

/** Gmail 오류 본문을 한 줄로 줄인다. 응답에 토큰은 실리지 않지만 길이는 잘라 로그를 지킨다. */
function briefError(status: number, body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return `HTTP ${status}${flat ? ` — ${flat.slice(0, 300)}` : ""}`;
}

/** 마지막 경고 시각. 파일이 없거나 깨졌으면 0 — 못 읽었다고 경고를 막아서는 안 된다(fail-open). */
function readLastAlertAt(): number {
  if (cachedAlertAt !== null) return cachedAlertAt;
  try {
    if (fs.existsSync(alertPath)) {
      const raw = JSON.parse(fs.readFileSync(alertPath, "utf8")) as Record<string, unknown>;
      cachedAlertAt = typeof raw.lastReauthAlertAt === "number" ? raw.lastReauthAlertAt : 0;
      return cachedAlertAt;
    }
  } catch (e) {
    log.warn(`mail-alert.json 읽기 실패 → 경고 이력 없음으로 간주: ${(e as Error).message}`);
  }
  cachedAlertAt = 0;
  return cachedAlertAt;
}

function writeLastAlertAt(at: number): void {
  cachedAlertAt = at;
  try {
    fs.mkdirSync(path.dirname(alertPath), { recursive: true });
    fs.writeFileSync(alertPath, JSON.stringify({ lastReauthAlertAt: at }, null, 2), "utf8");
  } catch (e) {
    // 기록에 실패해도 발송 결과를 바꾸지 않는다. 다음 실패 때 문자가 한 번 더 갈 뿐이다.
    log.warn(`mail-alert.json 쓰기 실패: ${(e as Error).message}`);
  }
}

/**
 * 재인증이 필요할 때 **살아 있는 채널로** 알린다.
 *
 * 메일이 죽었으므로 메일로는 알릴 수 없다. iMessage 가 유일하게 남은 경로다.
 * 타임스탬프는 **실제로 문자가 나간 뒤에만** 기록한다 — 발송에 실패했는데 억제 타이머를 켜면
 * 6시간 동안 아무도 모르는, 고치려던 바로 그 상황이 다시 만들어진다.
 */
async function alertReauthNeeded(): Promise<void> {
  // 채널 자체가 없으면 할 수 있는 게 없다(메일 실패는 이미 log.warn 으로 남았다).
  if (!isIMessageConfigured()) return;

  const now = Date.now();
  const last = readLastAlertAt();
  const since = now - last;
  // since < 0 은 저장된 시각이 미래라는 뜻(시계 되돌림·수동 편집). 그대로 억제하면 그 창이
  // 닫힐 때까지 영구히 침묵하므로, 이력이 이상하면 억제하지 않고 보낸다.
  if (last && since >= 0 && since < REAUTH_ALERT_INTERVAL_MS) return;

  const text =
    "⚠️ 메일 발송 실패 — Google 재로그인이 필요합니다. " +
    `http://localhost:${config.port} 대시보드에서 다시 연결하세요.`;
  try {
    await imessageSender(text);
    writeLastAlertAt(now);
  } catch (e) {
    // 여기서 throw 하면 알림 실패가 발송 경로를 깨뜨린다. sendMail 은 계속 false 만 돌려준다.
    log.warn(`재인증 경고 iMessage 발송 실패: ${(e as Error).message}`);
  }
}

/**
 * 발송이 다시 성공하면 억제 타이머를 푼다. 다음에 자격증명이 죽으면 6시간을 기다리지 않고
 * 즉시 문자가 가야 한다 — 사고와 사고 사이의 간격까지 억제할 이유가 없다.
 */
function clearReauthAlert(): void {
  if (readLastAlertAt() === 0) return;
  writeLastAlertAt(0);
}

/**
 * 메일 발송. **절대 throw 하지 않는다** — 알림 하나가 수집 런 전체를 깨면 안 된다.
 * 실패는 false + log.warn 으로만 알린다(호출부가 그대로 uptime 기록에 넘긴다).
 *
 * 예외적으로 "재로그인 필요"만은 로그에 묻어두지 않고 iMessage 로 밀어 올린다.
 */
export async function sendMail(opts: {
  subject: string;
  html: string;
  attachments?: MailAttachment[];
}): Promise<boolean> {
  if (!config.notify.email) return false;
  if (!config.notify.gmailAddress) {
    log.warn("GMAIL_ADDRESS 미설정 → 메일 발송 건너뜀");
    return false;
  }
  if (!getGoogleAuthStatus().configured) {
    log.warn("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 미설정 → 메일 발송 건너뜀");
    return false;
  }

  try {
    const raw = await buildRawMessage(opts);
    if (raw.length > MAX_MESSAGE_BYTES) {
      log.warn(
        `메일 크기 ${(raw.length / 1024 / 1024).toFixed(1)}MB — Gmail 상한(5MB) 초과 가능 [${opts.subject}]`
      );
    }

    let lastReason = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const token = await getAccessToken();
      const res = await fetch(SEND_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ raw }),
      });

      if (res.ok) {
        clearReauthAlert();
        const n = opts.attachments?.length ?? 0;
        log.info(`메일 발송 완료 [${opts.subject}]${n ? ` (첨부 ${n}개)` : ""}`);
        return true;
      }

      const body = await res.text().catch(() => "");
      lastReason = briefError(res.status, body);

      // 401: 서버 쪽에서 먼저 무효화된 토큰. 캐시를 버리고 갱신해서 딱 한 번 더.
      if (res.status === 401 && attempt < MAX_ATTEMPTS) {
        invalidateAccessToken();
        continue;
      }

      // 403 권한 누락: 토큰은 살아 있지만 gmail.send 가 없다(동의 화면에서 체크를 빠뜨린 경우).
      // 재시도·갱신으로는 절대 풀리지 않고 오직 재로그인만이 답이라, 조용히 실패하지 않고
      // 상태를 못 박은 뒤 살아 있는 채널(iMessage)로 알린다.
      if (res.status === 403 && /insufficient|PERMISSION_DENIED/i.test(body)) {
        const reason =
          "메일 발송 권한이 없습니다. 동의 화면에서 '나를 대신하여 이메일 전송'을 체크하고 다시 연결하세요.";
        markNeedsReauth(reason);
        log.warn(`메일 발송 실패 [${opts.subject}]: ${reason}`);
        await alertReauthNeeded();
        return false;
      }
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
        continue;
      }
      break;
    }

    log.warn(`메일 발송 실패 [${opts.subject}]: ${lastReason}`);
    return false;
  } catch (e) {
    if (e instanceof GoogleAuthError && e.needsReauth) {
      log.warn(
        `메일 발송 실패 [${opts.subject}]: Google 재로그인 필요 — 대시보드에서 계정을 다시 연결하세요 (${e.message})`
      );
      await alertReauthNeeded();
      return false;
    }
    log.warn(`메일 발송 예외 [${opts.subject}]: ${(e as Error).message}`);
    return false;
  }
}

/**
 * 테스트 전용 훅. 경고 이력 파일을 임시 경로로 돌리고 메모리 캐시를 비운다.
 * `null` 을 주면 기본 경로(data/mail-alert.json)로 되돌린다.
 */
export function __setAlertStorePathForTest(p: string | null): void {
  alertPath = p ?? DEFAULT_ALERT_PATH;
  cachedAlertAt = null;
}

/**
 * 테스트 전용 훅. iMessage 발송기를 스텁으로 갈아끼운다(실제 osascript 발송 방지).
 * `null` 이면 실제 sendIMessage 로 되돌린다.
 */
export function __setIMessageSenderForTest(
  fn: ((text: string) => Promise<void>) | null
): void {
  imessageSender = fn ?? ((text: string) => sendIMessage(text));
}
