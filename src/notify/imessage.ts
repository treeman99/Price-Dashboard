import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.ts";
import { log } from "../util/log.ts";

const execFileP = promisify(execFile);

/**
 * iMessage(본인에게 1:1) 발송 — macOS Messages.app 을 osascript 로 제어한다.
 *
 * 설계 노트:
 * - 최신 macOS 권장 문법: `1st account whose service type = iMessage` + `participant` + `send`.
 *   1:1 발송은 최신 macOS(26 포함)에서도 동작한다(그룹챗·SMS 지정은 불안정 → 지원 안 함).
 * - 수신자·본문은 **문자열 보간 없이** osascript 의 `on run argv` 인자로 전달한다
 *   (따옴표·특수문자로 인한 AppleScript 인젝션/깨짐 방지).
 * - 실질 관건은 코드가 아니라 **자동화(TCC) 권한**이다: 백그라운드 launchd 프로세스가
 *   Messages 를 제어하려면 최초 1회 "…이(가) Messages를 제어하려고 합니다" 승인이 필요하다.
 *   미승인 시 osascript 가 -1743(Not authorized) 로 실패하므로, 그 stderr 를 그대로 올려 진단한다.
 */

const SEND_TEXT_SCRIPT = `on run {targetBuddy, messageText}
  tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set theBuddy to participant targetBuddy of targetService
    send messageText to theBuddy
  end tell
end run`;

export class IMessageError extends Error {}

/** iMessage 설정 완료 여부(스위치 ON + 수신자 지정). */
export function isIMessageConfigured(): boolean {
  return config.notify.imessage && !!config.notify.imessageTo;
}

/**
 * 본인 iMessage 로 텍스트 발송. 성공 시 resolve, 실패 시 IMessageError(원인 포함) reject.
 * @param text 보낼 본문(빈 문자열 금지)
 * @param to   수신자(전화번호 E.164 예: +8210… 또는 Apple ID 이메일). 미지정 시 config 값 사용.
 */
export async function sendIMessage(text: string, to?: string): Promise<void> {
  const recipient = (to ?? config.notify.imessageTo).trim();
  const body = (text ?? "").trim();
  if (!recipient) throw new IMessageError("수신자(imessageTo)가 지정되지 않았습니다.");
  if (!body) throw new IMessageError("발송할 본문이 비어 있습니다.");
  if (process.platform !== "darwin")
    throw new IMessageError("iMessage 발송은 macOS(darwin)에서만 가능합니다.");

  try {
    // 인자를 argv 로 전달(보간 없음). 20초 타임아웃으로 Messages 무응답 시 hang 방지.
    await execFileP("osascript", ["-e", SEND_TEXT_SCRIPT, recipient, body], {
      timeout: 20_000,
    });
    log.info(`iMessage 발송 완료 → ${recipient}`);
  } catch (e) {
    // execFile 실패: osascript 오류(-1743 미승인 등)는 stderr 에 상세가 담긴다.
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr || err.message || "").trim();
    throw new IMessageError(`iMessage 발송 실패: ${detail || "알 수 없는 오류"}`);
  }
}
