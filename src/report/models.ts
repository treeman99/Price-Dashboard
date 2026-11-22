import { isUsageLimitError, isCodexUsageLimitText } from "../util/codex-query.ts";
import { AntigravityError } from "../util/antigravity-query.ts";

/**
 * 일일 보고서 취합 모델(three-model-update.md, 2026-11-22 사용자 확정).
 *
 * - 지정 모델을 다른 모델로 바꾸지 않는다(GPT-6.1 Sol 대신 다른 GPT, Opus 대신 Sonnet 금지).
 * - Gemini 는 사용자 결정으로 Gemini 4 Argon `gemini-4-argon-high`(agy 1.5.14 목록의 Argon 최상위 단계).
 *   Carbon 자동 감지·Neon 대체는 하지 않는다. Argon 이 실패하면 그 회차에서 건너뛴다.
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
  { key: "gemini", label: "Gemini 4 Argon", model: "gemini-4-argon-high" },
];

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
export async function runWithLimitRetry<T>(
  spec: ModelSpec,
  task: () => Promise<T>,
  retryDelayMs: number,
  onRetry?: (reason: string) => void
): Promise<{ ok: true; value: T; attempts: number } | { ok: false; kind: "limit" | "error"; error: string; attempts: number }> {
  try {
    return { ok: true, value: await task(), attempts: 1 };
  } catch (e) {
    const kind = classifyFailure(spec, e);
    const msg = String((e as Error)?.message ?? e);
    if (kind !== "limit") return { ok: false, kind, error: msg, attempts: 1 };
    onRetry?.(msg);
    if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
    try {
      return { ok: true, value: await task(), attempts: 2 };
    } catch (e2) {
      return { ok: false, kind: classifyFailure(spec, e2), error: String((e2 as Error)?.message ?? e2), attempts: 2 };
    }
  }
}

/** 모델 단위 결과: 뉴스·유튜브 두 작업이 모두 성공해야 '성공'. 하나라도 한도면 한도, 아니면 오류. */
export function modelOutcome(parts: { ok: boolean; kind?: "limit" | "error" }[]): ModelOutcome {
  if (parts.every((p) => p.ok)) return "success";
  return parts.some((p) => !p.ok && p.kind === "limit") ? "skipped-limit" : "skipped-error";
}
