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
    // 이미 success 결과를 받아둔 뒤에 스트림이 터지는 경우가 실제로 있다(하위 CLI 프로세스가
    // 결과를 내보내고 나서 종료 코드 1로 죽는 사례를 실측). 그대로 rethrow 하면 멀쩡히 받아온
    // 큐레이션 결과를 통째로 버리고 빈 스냅샷으로 저하되는데, 결과가 손에 있는 이상 그건 손해다.
    // 종료 단계의 잡음은 경고만 남기고 결과를 살린다. 결과가 없으면 진짜 실패이므로 rethrow.
    if (!finalText) throw e;
    log.warn(`${label}: 결과 수신 후 스트림 종료 오류(무시하고 결과 사용) — ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  // abort 가 예외 없이 스트림을 끝낸 경우도 타임아웃으로 처리
  if (timedOut) throw new Error(`Agent 응답 시간 초과(${Math.round(timeoutMs / 1000)}s)`);

  // ⚠️ SDK 가 API 오류를 subtype:"success" 결과의 **본문 문자열**로 감싸 돌려주는 경우가 있다
  // (실측: `API Error: 400 ... tool_use ids must be unique`). 그대로 통과시키면 호출부는
  // "성공했는데 JSON 이 없네" 로 오해해 빈 결과를 정상 저장한다 — 조용한 실패라 며칠간 아무도
  // 모른다. 여기서 실패로 승격시켜 호출부의 저하 경로(빈 스냅샷 + notes)를 타게 한다.
  if (/^\s*API Error:/.test(finalText)) {
    throw new Error(`Agent API 오류: ${finalText.slice(0, 300)}`);
  }
  return finalText;
}
