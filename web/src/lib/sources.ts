// 가격 수집 소스 식별자 → 한국어 짧은 라벨.
// PricePoint.source / ProductSource.source 값: 'danawa' | 'enuri' | 'llm-websearch'.
// 일부 레거시 포인트는 'naver' 등 판매처/백본명을 담을 수 있어 fallthrough 처리한다.
export function sourceLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  switch (source) {
    case "danawa":
      return "다나와";
    case "enuri":
      return "에누리";
    case "llm-websearch":
      return "LLM 검색";
    case "naver":
      return "네이버";
    default:
      return source;
  }
}

/** 확정 pcode 연결 없이 LLM 검색으로 degrade된 소스인지(은근한 신뢰도 힌트용). */
export function isDegradedSource(source: string | null | undefined): boolean {
  return source === "llm-websearch";
}
