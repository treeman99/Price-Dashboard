// product_sources POST 입력 검증 (문서 §9 작업 4-1).
// 라우트에서 분리해 순수함수로 단위테스트 가능하게 한다(무거운 의존성 미포함).

import type { UpsertProductSourceInput } from "../../shared/types.ts";

/** 허용 소스 화이트리스트. PricePoint.source / product_sources.source 와 일치. */
export const SOURCE_WHITELIST = ["danawa", "enuri", "llm-websearch"] as const;

export type ParseResult =
  | { ok: true; value: UpsertProductSourceInput }
  | { ok: false; error: string };

/** POST /products/:id/sources 본문 검증. productId 는 경로에서 주입. */
export function parseSourceInput(productId: number, body: unknown): ParseResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "본문(JSON 객체)이 필요합니다." };
  }
  const { source, refId, url, confirmed } = body as Record<string, unknown>;

  if (typeof source !== "string" || !(SOURCE_WHITELIST as readonly string[]).includes(source)) {
    return { ok: false, error: `source 는 ${SOURCE_WHITELIST.join("|")} 중 하나여야 합니다.` };
  }
  if (typeof url !== "string" || url.trim() === "") {
    return { ok: false, error: "url 은 필수입니다." };
  }
  if (refId != null && typeof refId !== "string") {
    return { ok: false, error: "refId 는 문자열 또는 null 이어야 합니다." };
  }
  if (confirmed != null && typeof confirmed !== "boolean") {
    return { ok: false, error: "confirmed 는 boolean 이어야 합니다." };
  }

  const value: UpsertProductSourceInput = {
    productId,
    source,
    refId: (refId as string | undefined) ?? null,
    url: url.trim(),
  };
  if (confirmed != null) value.confirmed = confirmed;
  return { ok: true, value };
}
