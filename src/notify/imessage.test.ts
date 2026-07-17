import { test } from "node:test";
import assert from "node:assert/strict";
import { sendIMessage, IMessageError } from "./imessage.ts";

// 실제 발송(osascript)까지 가기 전 입력 검증 단계를 확인한다.
// osascript 를 부르지 않고 즉시 reject 되는 경로만 테스트(실제 발송은 수동 PoC 로 검증).

test("sendIMessage: 수신자 미지정이면 IMessageError", async () => {
  await assert.rejects(() => sendIMessage("본문", ""), IMessageError);
  await assert.rejects(() => sendIMessage("본문", "   "), IMessageError);
});

test("sendIMessage: 본문이 비면 IMessageError", async () => {
  await assert.rejects(() => sendIMessage("", "+821012345678"), IMessageError);
  await assert.rejects(() => sendIMessage("   ", "+821012345678"), IMessageError);
});

test("sendIMessage: macOS 가 아니면 IMessageError (darwin 외)", async (t) => {
  if (process.platform === "darwin") {
    t.skip("darwin 에서는 플랫폼 가드가 통과하므로 이 검증은 건너뜀");
    return;
  }
  await assert.rejects(() => sendIMessage("본문", "+821012345678"), IMessageError);
});
