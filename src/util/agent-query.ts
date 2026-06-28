import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { log } from "./log.ts";

/**
 * Claude Agent SDK `query()`를 실행해 마지막 success 결과 텍스트를 반환한다.
 *
 * 핵심: **타임아웃/중단 가드**. query 가 응답을 받지 못하고 멈추면(transport 정지 등)
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
  const ac = new AbortController();
  const q = query({ prompt, options: { ...options, abortController: ac } });

  let finalText = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
    log.warn(`${label}: 응답 시간 초과(${Math.round(timeoutMs / 1000)}s) → 중단`);
  }, timeoutMs);

  try {
    for await (const msg of q) {
      if (msg.type === "result" && msg.subtype === "success") finalText = msg.result;
    }
  } catch (e) {
    if (timedOut) throw new Error(`Agent 응답 시간 초과(${Math.round(timeoutMs / 1000)}s)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  // abort 가 예외 없이 스트림을 끝낸 경우도 타임아웃으로 처리
  if (timedOut) throw new Error(`Agent 응답 시간 초과(${Math.round(timeoutMs / 1000)}s)`);
  return finalText;
}
