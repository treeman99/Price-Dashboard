import { isUsageLimitError, isCodexUsageLimitText } from "../util/codex-query.ts";
import { AntigravityError } from "../util/antigravity-query.ts";
import { LlmJsonError } from "../util/llm-json.ts";

/**
 * 일일 보고서 취합 모델(three-model-update.md, 2026-11-22 사용자 확정).
 *
 * - 지정 모델을 다른 모델로 바꾸지 않는다(GPT-6.1 Sol 대신 다른 GPT, Opus 대신 Sonnet 금지).
 * - Gemini 는 사용자 결정(price-centric-update.md)으로 Gemini 4 Neon 최상위 단계 `gemini-4-neon-xhigh`
 *   (agy 1.5.14 목록, 2026-11-22 실제 취합 요청에서 응답 모델 ID 일치 확인). 다른 Gemini 로 자동 대체하지
 *   않는다. Neon 이 실패하면 그 회차에서 건너뛴다.
 * - 배열 순서 = 최종 편집 우선순위(Opus → GPT → Gemini).
 */
export interface ModelSpec {
  key: "claude" | "gpt" | "gemini";
  label: string;
  model: string;
}

export const REPORT_MODELS: ModelSpec[] = [
  { key: "claude", label: "Claude Opus 5.5", model: "claude-opus-5-5" },
  { key: "gpt", label: "GPT-6.1 Sol", model: "gpt-6.1-sol" },
  { key: "gemini", label: "Gemini 4 Neon", model: "gemini-4-neon-xhigh" },
];

/** 보고서·탭 화면에 쓰는 짧은 표시명(찾은 모델 표기). */
export const MODEL_SHORT: Record<string, string> = { claude: "Opus 5.5", gpt: "GPT-6.1 Sol", gemini: "Gemini 4 Neon" };

export type ModelOutcome = "success" | "skipped-limit" | "skipped-error";

export const OUTCOME_LABEL: Record<ModelOutcome, string> = {
  success: "성공",
  "skipped-limit": "한도로 건너뜀",
  "skipped-error": "오류로 건너뜀(조치 필요)",
};

/**
 * Claude(Agent SDK 번들 CLI) 한도 통보. agent-query.ts FAILURE_SIGNALS 의 실측 문구
 * (`You've hit your limit · resets 6pm`, `You've hit your Opus limit`, `Claude AI usage limit reached`)
 * 와 API 의 rate_limit_error(429)를 본다.
 */
const CLAUDE_LIMIT_RE =
  /You'?ve hit your (?:\w+ ){0,2}limit|Claude AI usage limit reached|usage limit reached|rate_limit_error|rate limit|\b429\b/i;

/**
 * 실패를 '한도'와 '한도 외 오류'로 가른다. 근거는 각 CLI 의 실제 오류 문구다.
 * - Codex: codex-query 의 UsageLimitError(실측 "You've hit your usage limit ... try again at 9:00 PM")
 * - Antigravity: agy 바이너리 자체 QUOTA_RE(RESOURCE_EXHAUSTED|quota|429|exhausted your capacity|rate limit)
 * - Claude: 위 CLAUDE_LIMIT_RE
 */
export function classifyFailure(spec: ModelSpec, e: unknown): "limit" | "error" {
  // 응답은 받았는데 JSON 으로 읽지 못한 것은 한도가 아니다(메시지에 재요청 실패 사유가 섞여도 한도 재실행 금지).
  if (e instanceof LlmJsonError) return "error";
  if (spec.key === "gpt") {
    if (isUsageLimitError(e)) return "limit";
    return isCodexUsageLimitText(String((e as Error)?.message ?? e)) ? "limit" : "error";
  }
  if (spec.key === "gemini") {
    if (e instanceof AntigravityError) return e.limit ? "limit" : "error";
    return "error";
  }
  return CLAUDE_LIMIT_RE.test(String((e as Error)?.message ?? e)) ? "limit" : "error";
}

/** 한 모델의 한 작업(뉴스 또는 유튜브)을 실행하고, 한도면 짧게 쉬었다가 딱 한 번 더 해 본다. */
export type TaskFailure = {
  ok: false;
  kind: "limit" | "error";
  error: string;
  attempts: number;
  /** JSON 으로 읽지 못한 모델 원문(LlmJsonError) — 실행 폴더에 남긴다. */
  rawResponse?: string;
  reaskResponse?: string;
};

function failureOf(spec: ModelSpec, e: unknown, attempts: number): TaskFailure {
  const f: TaskFailure = { ok: false, kind: classifyFailure(spec, e), error: String((e as Error)?.message ?? e), attempts };
  if (e instanceof LlmJsonError) {
    f.rawResponse = e.rawResponse;
    if (e.reaskResponse) f.reaskResponse = e.reaskResponse;
  }
  return f;
}

export async function runWithLimitRetry<T>(
  spec: ModelSpec,
  task: () => Promise<T>,
  retryDelayMs: number,
  onRetry?: (reason: string) => void
): Promise<{ ok: true; value: T; attempts: number } | TaskFailure> {
  try {
    return { ok: true, value: await task(), attempts: 1 };
  } catch (e) {
    const first = failureOf(spec, e, 1);
    if (first.kind !== "limit") return first;
    onRetry?.(first.error);
    if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
    try {
      return { ok: true, value: await task(), attempts: 2 };
    } catch (e2) {
      return failureOf(spec, e2, 2);
    }
  }
}

/** 모델 단위 결과: 뉴스·유튜브 두 작업이 모두 성공해야 '성공'. 하나라도 한도면 한도, 아니면 오류. */
export function modelOutcome(parts: { ok: boolean; kind?: "limit" | "error" }[]): ModelOutcome {
  if (parts.every((p) => p.ok)) return "success";
  return parts.some((p) => !p.ok && p.kind === "limit") ? "skipped-limit" : "skipped-error";
}
