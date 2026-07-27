import { test } from "node:test";
import assert from "node:assert/strict";
import { isFailureSignal, preview } from "./agent-query.ts";

test("isFailureSignal — '성공을 가장한 실패 통보'를 잡아낸다", () => {
  // SDK 가 subtype:"success" 의 본문으로 돌려주는 실패들. 그냥 통과시키면 호출부에서
  // "JSON 미발견" 으로만 보여 원인을 알 수 없다.
  assert.equal(isFailureSignal('API Error: 400 {"type":"error"}'), true);
  assert.equal(isFailureSignal("Claude AI usage limit reached|1763000000"), true);
  assert.equal(isFailureSignal("Credit balance is too low"), true);
  assert.equal(isFailureSignal("Invalid API key · Please run /login"), true);
  assert.equal(isFailureSignal("OAuth token has expired"), true);
  assert.equal(isFailureSignal("Execution error"), true);
  // Claude CLI 의 짧은 한도 통보. 목록에 없던 동안 '성공'으로 통과해 빈 스냅샷만 남았다.
  assert.equal(isFailureSignal("You've hit your limit · resets 6pm (Asia/Seoul)"), true);
  // 앞쪽 공백/개행이 붙어도 잡아야 한다(스트림 조립 잔여물).
  assert.equal(isFailureSignal("\n  API Error: 500"), true);
});

test("isFailureSignal — 정상 결과는 통과시킨다", () => {
  assert.equal(isFailureSignal('{"categories":{"ai":[]}}'), false);
  assert.equal(isFailureSignal(""), false);
  // 본문 중간에 그 문구가 들어간 정상 JSON 을 실패로 오인하면 멀쩡한 수집을 버리게 된다.
  assert.equal(isFailureSignal('{"notes":"API Error: 를 다룬 영상"}'), false);
});

test("preview — 개행을 접고 길이를 제한한다", () => {
  assert.equal(preview("a\n\n  b\tc"), "a b c");
  const long = "x".repeat(500);
  const out = preview(long, 100);
  assert.equal(out.length, 101); // 100자 + 말줄임표
  assert.ok(out.endsWith("…"));
  // 한도 이내면 그대로.
  assert.equal(preview("짧음", 100), "짧음");
});
