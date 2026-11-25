import { runAgentQueryText } from "./agent-query.ts";

/**
 * JSON 재출력 요청 1회의 상한. 원문을 그대로 다시 쓰는 일이라 웹 조사가 없다. 2026-11-25 Gemini 4 Neon 뉴스 응답
 * (31,355자·출력 34,322토큰)의 최종 응답 생성이 약 4.5분이었다 → 그 두 배 남짓. 수집기 전체 상한(75분)과
 * 실측 실행(17분 안팎)에 여유가 있다.
 */
export const JSON_REASK_TIMEOUT_MS = 10 * 60_000;

/**
 * 같은 모델에 'JSON 만 다시 출력'을 보내는 함수(parseLlmJsonOrReask 의 reask). 도구 없이 1턴, 대체 모델 금지 여부는
 * 원 호출과 같게(strictModel) — 보고서에서는 Gemini 를 다른 모델로 바꾸지 않는다.
 */
export function modelJsonReasker(model: string, label: string, strictModel?: boolean): (prompt: string) => Promise<string> {
  return (prompt) =>
    runAgentQueryText(
      prompt,
      {
        tools: [],
        allowedTools: [],
        permissionMode: "bypassPermissions",
        settingSources: [],
        maxTurns: 1,
        model,
        systemPrompt: "너는 JSON 교정기다. 주어진 원래 응답의 내용은 그대로 두고 문법만 고쳐 올바른 JSON 하나만 출력한다.",
      },
      JSON_REASK_TIMEOUT_MS,
      `${label} JSON 재요청`,
      { strictModel }
    );
}
