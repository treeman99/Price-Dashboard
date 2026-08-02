import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CodexTimeoutError,
  CodexUnavailableError,
  UsageLimitError,
  annotateSleepTaintedFailure,
  assertCodexReady,
  buildCodexArgs,
  buildCodexPrompt,
  codexSubscriptionEnv,
  isChatGptAuthStatus,
  isCodexModel,
  isCodexTimeoutError,
  isCodexUnavailableError,
  isCodexUsageLimitNotice,
  isCodexUsageLimitText,
  isSleepTaintedLoginFailure,
  isUsageLimitError,
  parseCodexJsonl,
} from "./codex-query.ts";

test("Codex 모델만 별도 실행 경로로 분류한다", () => {
  assert.equal(isCodexModel("gpt-5.6-sol"), true);
  assert.equal(isCodexModel("gpt-5.6-terra"), true);
  assert.equal(isCodexModel("claude-opus-5"), false);
  assert.equal(isCodexModel(undefined), false);
});

test("Codex 환경은 앱/API 비밀값을 전달하지 않는다", () => {
  const env = codexSubscriptionEnv({
    HOME: "/Users/test",
    PATH: "/usr/bin:/bin",
    LANG: "ko_KR.UTF-8",
    OPENAI_API_KEY: "openai-secret",
    CODEX_API_KEY: "codex-secret",
    ANTHROPIC_API_KEY: "anthropic-secret",
    NAVER_CLIENT_SECRET: "naver-secret",
    GMAIL_APP_PASSWORD: "gmail-secret",
  });
  assert.deepEqual(env, {
    HOME: "/Users/test",
    PATH: "/usr/bin:/bin",
    LANG: "ko_KR.UTF-8",
  });
});

test("Codex 인자는 ChatGPT 로그인·Terra medium·최소 권한을 강제한다", () => {
  const webArgs = buildCodexArgs("gpt-5.6-terra", true);
  const joined = webArgs.join(" ");
  assert.ok(webArgs.includes("--search"));
  assert.match(joined, /forced_login_method="chatgpt"/);
  assert.match(joined, /model_reasoning_effort="medium"/);
  assert.match(joined, /agents\.enabled=false/);
  assert.match(joined, /default_permissions="daily_price_agent"/);
  assert.match(joined, /network=\{ enabled = false \}/);
  assert.ok(webArgs.includes("--ignore-user-config"));
  assert.ok(webArgs.includes("--ephemeral"));
  assert.ok(webArgs.includes("--json"));
  assert.equal(webArgs.includes("--dangerously-bypass-approvals-and-sandbox"), false);

  const offlineArgs = buildCodexArgs("gpt-5.6-terra", false);
  assert.equal(offlineArgs.includes("--search"), false);
  assert.ok(offlineArgs.includes('web_search="disabled"'));
});

test("Codex 프롬프트는 기존 역할·작업·안전 규칙을 보존한다", () => {
  const text = buildCodexPrompt("JSON으로 답하라", {
    systemPrompt: "너는 뉴스 큐레이터다.",
    tools: ["WebSearch", "WebFetch"],
  });
  assert.match(text, /너는 뉴스 큐레이터다/);
  assert.match(text, /최신 정보가 필요하면/);
  assert.match(text, /로컬 파일을 탐색하거나 수정하지 않는다/);
  assert.match(text, /JSON으로 답하라/);
});

test("ChatGPT 로그인 상태만 정액제 인증으로 인정한다", () => {
  assert.equal(isChatGptAuthStatus("Logged in using ChatGPT"), true);
  assert.equal(isChatGptAuthStatus("Logged in using an API key"), false);
  assert.equal(isChatGptAuthStatus("Not logged in"), false);
});

test("Codex JSONL에서 최종 답변·도구 횟수·토큰 사용량을 읽는다", () => {
  const parsed = parseCodexJsonl(
    [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"type":"web_search"}}',
      '{"type":"item.completed","item":{"type":"command_execution"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"중간"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":20,"output_tokens":30,"reasoning_output_tokens":10}}',
    ].join("\n")
  );
  assert.equal(parsed.finalText, '{"ok":true}');
  assert.equal(parsed.webSearches, 1);
  assert.equal(parsed.commands, 1);
  assert.deepEqual(parsed.usage, {
    inputTokens: 120,
    cachedInputTokens: 20,
    outputTokens: 30,
    reasoningOutputTokens: 10,
  });
  assert.deepEqual(parsed.errors, []);
});

test("Codex JSONL의 오류 이벤트를 모은다(한도 감지의 1차 근거)", () => {
  const parsed = parseCodexJsonl(
    [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"error","message":"You\'ve hit your usage limit."}',
      '{"type":"thread.failed","error":{"message":"UsageLimitReached"}}',
      '{"type":"turn.completed","usage":{}}',
    ].join("\n")
  );
  assert.equal(parsed.finalText, "");
  assert.deepEqual(parsed.errors, ["You've hit your usage limit.", "UsageLimitReached"]);
  assert.equal(isCodexUsageLimitText(parsed.errors.join("\n")), true);
});

test("한도 소진 문구를 정액제 신호로 인식한다", () => {
  // Codex CLI 바이너리에서 실측한 사용자 대면 문구들.
  assert.equal(isCodexUsageLimitText("You've hit your usage limit for gpt-5.6-sol"), true);
  assert.equal(
    isCodexUsageLimitText("Usage limit reached. You've reached your usage limit."),
    true
  );
  assert.equal(isCodexUsageLimitText("Quota exceeded. Check your plan and billing details."), true);
  assert.equal(isCodexUsageLimitText("You're out of credits. Add credits to continue."), true);
  assert.equal(isCodexUsageLimitText("stream error: status 429 Too Many Requests"), true);
  assert.equal(isCodexUsageLimitText("UsageLimitReached"), true);
  // 짧은 형태(실측: Claude CLI 가 이 형태로 통보한다)도 놓치지 않는다.
  assert.equal(isCodexUsageLimitText("You've hit your limit · resets 6pm (Asia/Seoul)"), true);
});

test("성공 종료했지만 본문이 한도 통보면 실패로 승격한다", () => {
  assert.equal(isCodexUsageLimitNotice("You've hit your limit · resets 6pm (Asia/Seoul)"), true);
  // JSON 이 있으면 정상 큐레이션 결과다 — 한도를 다룬 기사라도 버리면 안 된다.
  assert.equal(
    isCodexUsageLimitNotice('{"news":[{"title":"OpenAI, 사용 한도(usage limit) 상향"}]}'),
    false
  );
  // 길이가 긴 산문은 한도 통보가 아니라 본문이다.
  assert.equal(isCodexUsageLimitNotice(`요금제 usage limit 설명 ${"가".repeat(600)}`), false);
  assert.equal(isCodexUsageLimitNotice("정상 응답인데 JSON 이 없음"), false);
});

test("한도와 무관한 실패·정상 본문은 전환시키지 않는다", () => {
  assert.equal(isCodexUsageLimitText("Codex 비정상 종료(code=1) — spawn failed"), false);
  assert.equal(isCodexUsageLimitText("Logged in using an API key"), false);
  // 맨 숫자 429 는 웹 검색 결과에 흔해서 신호로 쓰지 않는다.
  assert.equal(isCodexUsageLimitText('{"price":429000,"name":"429 프로젝트"}'), false);
  assert.equal(isCodexUsageLimitText(""), false);
});

test("한도 오류는 타입으로 구분된다", () => {
  assert.equal(isUsageLimitError(new UsageLimitError("한도")), true);
  assert.equal(isUsageLimitError(new Error("한도")), false);
  assert.equal(isUsageLimitError("한도"), false);
});

test("가용성 오류(로그인 초기화·한도)만 대체 대상으로 분류한다", () => {
  // 로그인이 풀린 경우와 한도 소진은 모두 '지금 Codex 를 못 쓴다' → 이번 실행만 대체한다.
  assert.equal(isCodexUnavailableError(new CodexUnavailableError("로그인 초기화")), true);
  assert.equal(isCodexUnavailableError(new UsageLimitError("한도")), true);
  // 나머지 실패는 진짜 실패라 그대로 올라가야 한다 — 대체로 넘기면 Codex 버그가 묻힌다.
  assert.equal(isCodexUnavailableError(new Error("JSON 파싱 실패")), false);
  assert.equal(isCodexUnavailableError("로그인 초기화"), false);
  // 한도는 가용성 문제의 하위 종류지, 그 반대가 아니다.
  assert.equal(isUsageLimitError(new CodexUnavailableError("로그인 초기화")), false);
});

test("시간 초과도 '지금 Codex 를 못 쓴다'로 분류해 폴백을 태운다", () => {
  // ★ 2026-08-02 사고의 핵심 회귀. 예전에는 타임아웃이 평범한 Error 라 폴백 판별을 통과하지
  // 못했고, 절전으로 전 탭이 동시에 타임아웃하자 하루치가 통째로 날아갔다.
  const timeout = new CodexTimeoutError("Codex 응답 시간 초과(예산 3600s, 벽시계 3931s, 유효 50s)");
  assert.equal(isCodexUnavailableError(timeout), true);
  assert.equal(isCodexTimeoutError(timeout), true);
  assert.ok(timeout instanceof CodexUnavailableError);
  assert.ok(timeout instanceof Error);
  // 타임아웃은 한도 소진이 아니다 — 한도 전용 대기·안내 로직이 오작동하면 안 된다.
  assert.equal(isUsageLimitError(timeout), false);
  assert.equal(isCodexTimeoutError(new UsageLimitError("한도")), false);
  assert.equal(isCodexTimeoutError(new Error("Codex 응답 시간 초과")), false);
});

test("절전이 측정된 타임아웃만 '슬립 탓'으로 분류한다", () => {
  const timeout = new CodexTimeoutError("Codex 응답 시간 초과(예산 15s, 벽시계 624s, 유효 3s, 절전 617s)");
  // 확인 자체를 못 한 타임아웃 + 실제 측정된 절전 → 슬립 오판 가능성.
  assert.equal(isSleepTaintedLoginFailure(timeout, 617_000), true);
  // 절전이 측정되지 않았으면 진짜 정지다 — 재시도로 시간을 낭비하면 안 된다.
  assert.equal(isSleepTaintedLoginFailure(timeout, 0), false);
  // 타임아웃이 아닌 실패(로그인 초기화·한도)는 CLI 가 답을 한 것이므로 절전과 무관하다.
  assert.equal(isSleepTaintedLoginFailure(new CodexUnavailableError("로그인 초기화"), 617_000), false);
  assert.equal(isSleepTaintedLoginFailure(new UsageLimitError("한도"), 617_000), false);
  assert.equal(isSleepTaintedLoginFailure(new Error("spawn ENOENT"), 617_000), false);
});

test("폴백 사유에 절전 정황을 새겨 넣는다", () => {
  // agent-query 가 이 문자열을 recordFallback 으로 그대로 넘긴다 → model.json·배지 근거가 된다.
  const annotated = annotateSleepTaintedFailure("Codex 응답 시간 초과(...)", 617_000);
  assert.match(annotated, /시스템 절전 617초 감지/);
  assert.match(annotated, /Codex 자체 문제가 아니라/);
  // 절전이 없으면 원문을 그대로 둔다(없는 정황을 지어내지 않는다).
  assert.equal(annotateSleepTaintedFailure("Codex 응답 시간 초과(...)", 0), "Codex 응답 시간 초과(...)");
});

/** assertCodexReady 주입용 가짜 실행기. */
function fakeRun(results: Array<Error | { code: number; stdout: string }>) {
  let calls = 0;
  const run = async () => {
    const r = results[Math.min(calls++, results.length - 1)];
    if (r instanceof Error) throw r;
    return { code: r.code, signal: null, stdout: r.stdout, stderr: "" };
  };
  return { run, calls: () => calls };
}

const OK_LOGIN = { code: 0, stdout: "Logged in using ChatGPT (treeman99@gmail.com)" };
const sleepTimeout = () => new CodexTimeoutError("Codex 응답 시간 초과(예산 15s, 벽시계 624s, 유효 3s)");

test("★ 절전 중 로그인 확인 실패를 'Codex 사용 불가'로 오판하지 않는다", async () => {
  // 결함 ③: 15초 로그인 확인이 10.4분 절전 구간에 죽어 수집 전체가 Opus 폴백 + 오배지로 샜다.
  const f = fakeRun([sleepTimeout(), sleepTimeout(), OK_LOGIN]);
  await assertCodexReady(15_000, {
    run: f.run,
    sleptMsOf: () => 617_000, // 시도 중 절전 617초가 측정된 상황
    retryDelayMs: 0,
  });
  assert.equal(f.calls(), 3, "절전 정황이 있으면 다시 확인해야 한다");
});

test("절전이 없으면 로그인 확인을 재시도하지 않는다(진짜 정지는 즉시 실패)", async () => {
  const f = fakeRun([sleepTimeout()]);
  await assert.rejects(
    () => assertCodexReady(15_000, { run: f.run, sleptMsOf: () => 0, retryDelayMs: 0 }),
    (e: unknown) => isCodexTimeoutError(e) && !/절전/.test((e as Error).message)
  );
  assert.equal(f.calls(), 1);
});

test("로그인이 진짜로 풀렸으면(API 키·비정상 종료) 재시도 없이 즉시 폴백한다", async () => {
  const f = fakeRun([{ code: 0, stdout: "Logged in using an API key" }]);
  await assert.rejects(
    () => assertCodexReady(15_000, { run: f.run, sleptMsOf: () => 617_000, retryDelayMs: 0 }),
    (e: unknown) =>
      isCodexUnavailableError(e) && /정액제 로그인이 확인되지 않습니다/.test((e as Error).message)
  );
  assert.equal(f.calls(), 1, "CLI 가 답을 한 이상 절전과 무관하다 — 재시도는 낭비다");
});

test("재시도가 벽시계 상한을 우회하지 못한다(하룻밤 절전은 구제 대상이 아니다)", async () => {
  // 재시도는 짧은 DarkWake 창에 걸린 실패를 구제하려는 것이다. 시도 하나가 이미 상한(1시간)을
  // 다 썼다면 그 슬롯은 지났으므로, 재시도로 상한을 곱하지 말고 폴백을 태워 슬롯을 놓아 준다.
  const f = fakeRun([sleepTimeout()]);
  await assert.rejects(
    () =>
      assertCodexReady(15_000, {
        run: f.run,
        sleptMsOf: () => 3_500_000,
        wallMsOf: () => 3_600_000, // 시도 1회가 이미 벽시계 상한(1시간)을 소진
        retryDelayMs: 0,
      }),
    (e: unknown) => isCodexTimeoutError(e) && /시스템 절전 3500초 감지/.test((e as Error).message)
  );
  assert.equal(f.calls(), 1, "상한을 넘겼으면 재시도하지 않는다");
});

test("재시도까지 실패하면 폴백 사유에 절전 정황을 남긴다", async () => {
  const f = fakeRun([sleepTimeout()]);
  await assert.rejects(
    () =>
      assertCodexReady(15_000, {
        run: f.run,
        sleptMsOf: () => 617_000,
        retries: 1,
        retryDelayMs: 0,
      }),
    (e: unknown) => {
      // 폴백은 하되(가용성 오류), 사유에는 "절전 때문일 수 있다"가 남아야 한다.
      assert.equal(isCodexUnavailableError(e), true);
      assert.match((e as Error).message, /시스템 절전 617초 감지/);
      return true;
    }
  );
  assert.equal(f.calls(), 2);
});

test("타임아웃 메시지는 예산·벽시계·유효 경과를 함께 남긴다", () => {
  // 메시지에 벽시계만 있으면 "3600초를 다 썼다"로 읽힌다. 실제로는 50초만 돌았고 나머지는
  // 절전이었다는 사실이 세 숫자의 격차로만 드러난다.
  const message = new CodexTimeoutError(
    "Codex 응답 시간 초과(예산 3600s, 벽시계 3931s, 유효 50s)"
  ).message;
  assert.match(message, /예산 \d+s/);
  assert.match(message, /벽시계 \d+s/);
  assert.match(message, /유효 \d+s/);
});
