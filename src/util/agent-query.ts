import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { log } from "./log.ts";
import { isCodexModel, isUsageLimitError, runCodexQueryText } from "./codex-query.ts";
import {
  FALLBACK_AGENT_MODEL,
  PRIMARY_AGENT_MODEL,
  WEEKLY_RESET_LABEL,
  recordUsageLimitFallback,
} from "./model-store.ts";

/** 로그용 한 줄 미리보기(개행 제거 + 길이 제한). 원문이 길어도 로그가 터지지 않게. */
export function preview(text: string, max = 400): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 하위 CLI 가 "결과"(subtype:"success")로 돌려주지만 실제로는 실패 통보인 문자열들.
 * 이들은 JSON 이 아니라서 호출부에는 "JSON 미발견" 으로만 보이는데, 그 메시지만으로는
 * 원인(한도 소진/인증/크레딧)을 알 수 없어 원인 규명이 막힌다(실측: 실패 원문이 로그에
 * 전혀 남지 않아 반나절을 헤맴). 여기서 실패로 승격해 원문을 에러 메시지에 실어 보낸다.
 *
 * `You've hit your limit · resets 6pm (Asia/Seoul)` 은 Claude CLI 의 한도 통보 형태다.
 * 목록에 없던 동안 이 47자짜리 결과가 '성공'으로 통과해 빈 스냅샷만 남겼다(로그 실측).
 * 한도 소진 시 자동 전환의 도착지가 Claude 이므로, 이 문구가 조용하면 전환 후 실패가
 * 그대로 묻힌다.
 *
 * ⚠️ 한도 문구에는 **라벨이 붙는다.** 번들 CLI(`node_modules/@anthropic-ai/claude-agent-sdk/cli.js`)
 * 는 `You've hit your ${라벨}` 로 문장을 만들고, 라벨은 `limit` / `session limit`(5시간) /
 * `Opus limit`(주간 Opus) / `weekly limit` / `Sonnet limit` / `usage limit` 6종이다.
 * 예전 패턴 `You'?ve hit your limit` 은 **그중 첫 번째 하나만** 잡았고 나머지 5종은 전부
 * 통과했다(2026-07-29 실측: `isFailureSignal("You've hit your Opus limit · resets 3pm")` === false).
 * 그래서 라벨 자리를 낱말 2개까지 허용한다 — Codex 쪽 패턴과 같은 방식이다.
 * 이게 조용하면 한도 소진이 "JSON 미발견" 으로 둔갑해, 한도 기반 대기·전환 로직이 통째로
 * 발화하지 않는다(로또 실험의 4시간 자동 재개가 바로 이 경로에 걸려 있었다).
 */
const FAILURE_SIGNALS =
  /^\s*(API Error:|Claude AI usage limit reached|You'?ve hit your (?:\w+ ){0,2}limit|Credit balance is too low|Invalid API key|OAuth token has expired|Please run \/login|Execution error)/i;

/** 결과 텍스트가 '성공을 가장한 실패 통보'인지. */
export function isFailureSignal(text: string): boolean {
  return FAILURE_SIGNALS.test(text);
}

/**
 * 선택 모델에 따라 Claude Agent SDK 또는 Codex CLI를 실행해 마지막 결과 텍스트를 반환한다.
 *
 * Claude 경로의 핵심: **타임아웃/중단 가드**. query 가 응답을 받지 못하고 멈추면(transport 정지 등)
 * `for await` 루프가 영원히 대기하고, 호출부의 `running` 플래그가 영구히 잠겨
 * 이후 모든 수집(수동 '지금 갱신' 포함)이 막힌다. timeoutMs 초과 시 AbortController 로
 * 하위 프로세스를 중단하고 에러를 던져, 호출부가 정상적으로 실패 처리(+running 해제)하게 한다.
 */
export async function runAgentQueryText(
  prompt: string,
  options: Omit<Options, "abortController">,
  timeoutMs: number,
  label = "agent"
): Promise<string> {
  if (!isCodexModel(options.model)) {
    return runClaudeAgentQueryText(prompt, options, timeoutMs, label);
  }

  const startedAt = Date.now();
  try {
    const finalText = await runCodexQueryText(prompt, options, timeoutMs, label);
    return validateFinalText(finalText, label);
  } catch (e) {
    if (!isUsageLimitError(e)) throw e;
    return runUsageLimitFallback(prompt, options, timeoutMs, label, startedAt, e as Error);
  }
}

/**
 * Codex 정액제 한도 소진 → 대체 모델(Opus 5)로 전환하고 **이번 실행도 그 모델로 살린다.**
 *
 * 저장만 하고 던지면 오늘 그 수집은 통째로 빈 스냅샷이 된다 — 한도는 정오에도 소진되므로
 * "다음 수집부터 정상"은 하루치 결과를 버리는 것과 같다. 남은 시간이 너무 적으면(< 1분)
 * 재시도가 또 타임아웃으로 죽을 뿐이라 전환만 기록하고 실패시킨다.
 */
async function runUsageLimitFallback(
  prompt: string,
  options: Omit<Options, "abortController">,
  timeoutMs: number,
  label: string,
  startedAt: number,
  cause: Error
): Promise<string> {
  const from = String(options.model);
  const switched = recordUsageLimitFallback(from, cause.message);
  const note = switched
    ? `${from} 한도 소진 → ${FALLBACK_AGENT_MODEL} 로 전환 (${WEEKLY_RESET_LABEL} 에 ${PRIMARY_AGENT_MODEL} 복귀)`
    : `${from} 한도 소진 (이미 ${FALLBACK_AGENT_MODEL} 로 전환된 상태)`;

  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining < 60_000) {
    throw new Error(`${note} — 남은 시간이 부족해 이번 실행은 건너뜀. 원인: ${cause.message}`);
  }
  log.warn(`${label}: ${note} — 남은 ${Math.round(remaining / 1000)}초로 즉시 재시도`);
  return runClaudeAgentQueryText(
    prompt,
    { ...options, model: FALLBACK_AGENT_MODEL },
    remaining,
    `${label}(한도 대체)`
  );
}

/** Claude 모델은 기존 Agent SDK 스트리밍 경로를 그대로 사용한다. */
async function runClaudeAgentQueryText(
  prompt: string,
  options: Omit<Options, "abortController">,
  timeoutMs: number,
  label = "agent"
): Promise<string> {
  const ac = new AbortController();
  const q = query({ prompt, options: { ...options, abortController: ac } });

  let finalText = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
    log.warn(
      `${label}: 응답 시간 초과(${Math.round(timeoutMs / 1000)}s) → 중단 (${turns}턴, 도구 ${toolCalls}회 진행 중이었음)`
    );
  }, timeoutMs);

  // 진행 상황 계측. 타임아웃으로 잘렸을 때 "멈춘 것"인지 "아직 일하는 중"인지 구분할 근거가
  // 없으면 타임아웃 값을 올려야 할지 작업량을 줄여야 할지 판단할 수 없다(실측: 30분 초과가
  // 반복됐는데 어디서 시간을 쓰는지 알 길이 없었다). 몇 분마다 한 줄만 남긴다.
  const startedAt = Date.now();
  let turns = 0;
  let toolCalls = 0;
  let nonSuccessSubtype: string | null = null;
  const heartbeat = setInterval(
    () => {
      const min = Math.round((Date.now() - startedAt) / 60000);
      log.info(`${label}: 진행 중 — ${min}분 경과, ${turns}턴, 도구 ${toolCalls}회`);
    },
    5 * 60 * 1000
  );

  try {
    for await (const msg of q) {
      if (msg.type === "assistant") {
        turns += 1;
        const content = (msg as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) {
          toolCalls += content.filter((c) => (c as { type?: string })?.type === "tool_use").length;
        }
      }
      if (msg.type === "result") {
        if (msg.subtype === "success") finalText = msg.result;
        else {
          // success 가 아닌 종료(대표적으로 maxTurns 소진: "error_max_turns"). 결과 텍스트가
          // 없으므로 호출부에는 "결과가 비어 있습니다"로만 보여, 작업량이 상한을 넘었다는
          // 사실이 드러나지 않는다. 상한 조정 판단에 필요한 정보라 명시적으로 남긴다.
          nonSuccessSubtype = msg.subtype;
          log.warn(`${label}: 비정상 종료 — subtype=${msg.subtype} (${turns}턴, 도구 ${toolCalls}회)`);
        }
      }
    }
  } catch (e) {
    if (timedOut) throw new Error(`Agent 응답 시간 초과(${Math.round(timeoutMs / 1000)}s)`);
    // 이미 success 결과를 받아둔 뒤에 스트림이 터지는 경우가 실제로 있다(하위 CLI 프로세스가
    // 결과를 내보내고 나서 종료 코드 1로 죽는 사례를 실측). 그대로 rethrow 하면 멀쩡히 받아온
    // 큐레이션 결과를 통째로 버리고 빈 스냅샷으로 저하되는데, 결과가 손에 있는 이상 그건 손해다.
    // 종료 단계의 잡음은 경고만 남기고 결과를 살린다. 결과가 없으면 진짜 실패이므로 rethrow.
    if (!finalText) throw e;
    log.warn(
      `${label}: 결과 수신 후 스트림 종료 오류(무시하고 결과 사용) — ${(e as Error).message} · 수신 ${finalText.length}자: ${preview(finalText)}`
    );
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
  }

  // abort 가 예외 없이 스트림을 끝낸 경우도 타임아웃으로 처리
  if (timedOut) throw new Error(`Agent 응답 시간 초과(${Math.round(timeoutMs / 1000)}s)`);

  log.info(
    `${label}: 완료 — ${Math.round((Date.now() - startedAt) / 1000)}초, ${turns}턴, 도구 ${toolCalls}회, 결과 ${finalText.length}자`
  );

  // 결과 없이 비정상 종료(maxTurns 소진 등)한 경우. "결과가 비어 있습니다"로 뭉뚱그리면 무엇을
  // 조정해야 할지(상한? 타임아웃? 작업량?) 알 수 없으므로 종료 사유와 소진량을 그대로 올린다.
  if (!finalText && nonSuccessSubtype) {
    throw new Error(
      `Agent 비정상 종료(${nonSuccessSubtype}) — ${turns}턴, 도구 ${toolCalls}회 소진`
    );
  }

  // ⚠️ SDK 가 API 오류를 subtype:"success" 결과의 **본문 문자열**로 감싸 돌려주는 경우가 있다
  // (실측: `API Error: 400 ... tool_use ids must be unique`, 사용량 한도 소진 통보 등). 그대로
  // 통과시키면 호출부는 "성공했는데 JSON 이 없네" 로 오해해 빈 결과를 정상 저장한다 — 조용한
  // 실패라 며칠간 아무도 모른다. 여기서 실패로 승격시켜 호출부의 저하 경로(빈 스냅샷 + notes)를
  // 타게 한다.
  return validateFinalText(finalText, label);
}

/** 제공자와 무관하게 마지막 응답에 동일한 실패·JSON 진단 규칙을 적용한다. */
function validateFinalText(finalText: string, label: string): string {
  if (isFailureSignal(finalText)) {
    throw new Error(`Agent API 오류: ${preview(finalText, 300)}`);
  }
  // 호출부는 대부분 JSON 을 기대한다. 중괄호조차 없으면 파싱은 반드시 "JSON 미발견" 으로 실패하는데,
  // 그 메시지만 로그에 남으면 무엇이 왔는지 알 길이 없다(실측: 원인 규명에 실패). 원문을 남긴다.
  if (!finalText.includes("{")) {
    log.warn(`${label}: 응답에 JSON 이 없음 — ${finalText.length}자: ${preview(finalText)}`);
  }
  return finalText;
}
