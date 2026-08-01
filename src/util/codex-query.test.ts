import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CodexUnavailableError,
  UsageLimitError,
  buildCodexArgs,
  buildCodexPrompt,
  codexSubscriptionEnv,
  isChatGptAuthStatus,
  isCodexModel,
  isCodexUnavailableError,
  isCodexUsageLimitNotice,
  isCodexUsageLimitText,
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
