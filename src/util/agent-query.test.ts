import { test } from "node:test";
import assert from "node:assert/strict";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  FALLBACK_TIMEOUT_MS,
  __setAgentQueryDepsForTest,
  isFailureSignal,
  preview,
  runAgentQueryText,
} from "./agent-query.ts";
import { CodexTimeoutError, CodexUnavailableError, UsageLimitError } from "./codex-query.ts";
import { FALLBACK_AGENT_MODEL } from "./model-store.ts";

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

/* ------------------------------------------------------------------------- *
 * 폴백 경로 회귀 테스트
 *
 * 이 구역이 비어 있던 동안 폴백은 **구조적으로 단 한 번도 실행되지 않았다**
 * (2026-08-02 사고, 런타임 증거: data/model.json 의 fallback=null, 진입 이력 0회).
 * 정상 운영 중에는 절대 안 도는 코드라 "죽었는지" 알 방법이 테스트밖에 없다.
 * ------------------------------------------------------------------------- */

const CODEX_MODEL = "gpt-5.6-sol";
const codexOptions = { model: CODEX_MODEL } as Omit<Options, "abortController">;

interface FakeCall {
  model: unknown;
  timeoutMs: number;
  label: string;
}

/** 하위 실행기·상태 저장을 전부 가짜로 갈아끼우고 호출 내역을 수집한다. */
function withFakeDeps(spec: {
  codex?: () => Promise<string>;
  claude?: () => Promise<string>;
}): {
  codexCalls: FakeCall[];
  claudeCalls: FakeCall[];
  recorded: { from: string; reason: string }[];
  cleared: number;
  restore: () => void;
} {
  const state = {
    codexCalls: [] as FakeCall[],
    claudeCalls: [] as FakeCall[],
    recorded: [] as { from: string; reason: string }[],
    cleared: 0,
    restore: () => {},
  };
  state.restore = __setAgentQueryDepsForTest({
    runCodex: async (_prompt, options, timeoutMs, label) => {
      state.codexCalls.push({ model: options.model, timeoutMs, label });
      return spec.codex ? spec.codex() : '{"ok":true}';
    },
    runClaude: async (_prompt, options, timeoutMs, label) => {
      state.claudeCalls.push({ model: options.model, timeoutMs, label });
      return spec.claude ? spec.claude() : '{"fallback":true}';
    },
    // model.json 은 실제 운영 파일이다. 테스트가 건드리지 않도록 저장까지 가짜로 잡는다.
    recordFallback: (from, reason) => {
      state.recorded.push({ from, reason });
      return state.recorded.length === 1;
    },
    clearFallback: () => {
      state.cleared += 1;
      return true;
    },
  });
  return state;
}

test("Codex 타임아웃이면 폴백 모델로 **실제로** 재시도한다", async () => {
  // 핵심 회귀: 예전에는 타임아웃이 평범한 Error 였고(→ isCodexUnavailableError=false),
  // 설령 타입을 고쳐도 잔여 예산 계산 때문에 폴백 진입 직전에 무조건 건너뛰었다.
  const fake = withFakeDeps({
    codex: async () => {
      throw new CodexTimeoutError("Codex 응답 시간 초과(예산 3600s, 벽시계 3931s, 유효 50s)");
    },
  });
  try {
    const out = await runAgentQueryText("프롬프트", codexOptions, 3_600_000, "뉴스");
    assert.equal(out, '{"fallback":true}');
    assert.equal(fake.claudeCalls.length, 1, "폴백이 실제로 호출되어야 한다");
    assert.equal(fake.claudeCalls[0].model, FALLBACK_AGENT_MODEL);
    assert.match(fake.claudeCalls[0].label, /임시 대체/);
    // 사유가 그대로 기록돼야 화면에서 "왜 Opus 로 돌았는지"를 설명할 수 있다.
    assert.equal(fake.recorded.length, 1);
    assert.equal(fake.recorded[0].from, CODEX_MODEL);
    assert.match(fake.recorded[0].reason, /벽시계 3931s/);
  } finally {
    fake.restore();
  }
});

test("폴백 예산은 원 타임아웃과 독립이다", async () => {
  // 원 예산이 4분이든 60분이든, 이미 소진된 뒤에 들어오는 경로라 잔여를 물려받으면 안 된다.
  for (const originalTimeout of [240_000, 600_000, 3_600_000]) {
    const fake = withFakeDeps({
      codex: async () => {
        throw new CodexTimeoutError(`Codex 응답 시간 초과(예산 ${originalTimeout / 1000}s)`);
      },
    });
    try {
      await runAgentQueryText("프롬프트", codexOptions, originalTimeout, "증시");
      assert.equal(fake.claudeCalls.length, 1);
      assert.equal(
        fake.claudeCalls[0].timeoutMs,
        FALLBACK_TIMEOUT_MS,
        `원 예산 ${originalTimeout}ms 와 무관하게 자체 예산이어야 한다`
      );
    } finally {
      fake.restore();
    }
  }
});

test("원 예산이 이미 다 지나간 뒤에도 폴백은 돈다", async () => {
  // ★ 예전 버그를 정확히 겨냥한 테스트. `remaining = timeoutMs - (Date.now() - startedAt)` 는
  // startedAt 이 Codex 호출 **전**에 찍히므로 타임아웃 케이스에서 항상 0 이하가 되고,
  // 바로 뒤의 `remaining < 60_000` 이 폴백을 무조건 건너뛰었다. 아래처럼 원 예산(50ms)보다
  // 오래 끈 뒤 타임아웃을 던지면 옛 코드는 폴백 없이 그대로 실패한다.
  const fake = withFakeDeps({
    codex: async () => {
      await new Promise((r) => setTimeout(r, 80));
      throw new CodexTimeoutError("Codex 응답 시간 초과(예산 0s, 벽시계 4000s, 유효 40s)");
    },
  });
  try {
    const out = await runAgentQueryText("프롬프트", codexOptions, 50, "팝업");
    assert.equal(out, '{"fallback":true}');
    assert.equal(fake.claudeCalls.length, 1, "원 예산 소진은 폴백을 막는 이유가 될 수 없다");
    assert.equal(fake.claudeCalls[0].timeoutMs, FALLBACK_TIMEOUT_MS);
  } finally {
    fake.restore();
  }
});

test("Codex 로그인 초기화·한도 소진도 폴백으로 살린다(기존 동작 회귀 방지)", async () => {
  for (const cause of [
    new CodexUnavailableError("Codex ChatGPT 정액제 로그인이 확인되지 않습니다"),
    new UsageLimitError("Codex 정액제 한도 소진 통보"),
  ]) {
    const fake = withFakeDeps({
      codex: async () => {
        throw cause;
      },
    });
    try {
      const out = await runAgentQueryText("프롬프트", codexOptions, 600_000, "유튜브");
      assert.equal(out, '{"fallback":true}');
      assert.equal(fake.claudeCalls.length, 1);
      assert.equal(fake.claudeCalls[0].model, FALLBACK_AGENT_MODEL);
    } finally {
      fake.restore();
    }
  }
});

test("진짜 실패는 폴백을 타지 않고 그대로 던진다(과잉 폴백 방지)", async () => {
  // 프롬프트 오류·파싱 실패까지 Opus 로 넘기면 Codex 경로의 버그가 영원히 드러나지 않는다.
  const fake = withFakeDeps({
    codex: async () => {
      throw new Error("Codex 최종 응답이 없습니다. 상세 오류 없음");
    },
  });
  try {
    await assert.rejects(
      () => runAgentQueryText("프롬프트", codexOptions, 600_000, "행사"),
      /Codex 최종 응답이 없습니다/
    );
    assert.equal(fake.claudeCalls.length, 0, "폴백이 호출되면 안 된다");
    assert.equal(fake.recorded.length, 0, "대체 기록도 남으면 안 된다");
  } finally {
    fake.restore();
  }
});

test("Codex 성공은 대체 상태를 해제하고, 대체 실행 성공은 해제하지 않는다", async () => {
  // 해제 조건은 오직 "Codex 가 실제로 한 번 답했다" 뿐이다(model-store 의 설계).
  const ok = withFakeDeps({ codex: async () => '{"ok":true}' });
  try {
    const out = await runAgentQueryText("프롬프트", codexOptions, 600_000, "뉴스");
    assert.equal(out, '{"ok":true}');
    assert.equal(ok.cleared, 1);
    assert.equal(ok.recorded.length, 0);
  } finally {
    ok.restore();
  }

  const down = withFakeDeps({
    codex: async () => {
      throw new UsageLimitError("한도 소진");
    },
  });
  try {
    await runAgentQueryText("프롬프트", codexOptions, 600_000, "뉴스");
    assert.equal(down.recorded.length, 1, "대체 진입은 기록되어야 한다");
    assert.equal(
      down.cleared,
      0,
      "대체 모델이 성공해도 해제하면 안 된다 — Codex 는 여전히 죽어 있고 화면 배지가 유일한 설명이다"
    );
  } finally {
    down.restore();
  }
});

test("대체 실행마저 실패하면 그대로 실패로 올린다", async () => {
  const fake = withFakeDeps({
    codex: async () => {
      throw new CodexTimeoutError("Codex 응답 시간 초과(예산 600s, 벽시계 4000s, 유효 40s)");
    },
    claude: async () => {
      throw new Error("Agent 응답 시간 초과(예산 1200s, 벽시계 1300s, 유효 1200s)");
    },
  });
  try {
    await assert.rejects(
      () => runAgentQueryText("프롬프트", codexOptions, 600_000, "로또"),
      /Agent 응답 시간 초과/
    );
    assert.equal(fake.claudeCalls.length, 1);
  } finally {
    fake.restore();
  }
});

test("Claude 모델을 고르면 Codex 경로를 아예 타지 않는다", async () => {
  const fake = withFakeDeps({});
  try {
    const out = await runAgentQueryText(
      "프롬프트",
      { model: FALLBACK_AGENT_MODEL } as Omit<Options, "abortController">,
      600_000,
      "로또"
    );
    assert.equal(out, '{"fallback":true}');
    assert.equal(fake.codexCalls.length, 0);
    assert.equal(fake.claudeCalls[0].timeoutMs, 600_000, "직접 선택한 경로는 원 예산 그대로");
  } finally {
    fake.restore();
  }
});
