// 신뢰할 수 없는 링크(LLM 큐레이션·웹 수집 결과)를 href 에 넣기 전 거르는 공용 가드.
// 백엔드(이메일 HTML 문자열 조립)와 프론트(React href={}) 양쪽이 같은 규칙을 쓴다.

/**
 * http(s) 링크만 통과시키고 그 외는 null.
 *
 * 링크는 LLM 이 만들어 온 값이라 신뢰할 수 없다. `javascript:`/`data:` 스킴이 그대로
 * href 에 박히면 클릭 시 임의 스크립트가 실행된다. React 18 은 `javascript:` href 를
 * 개발 빌드에서 경고만 하고 프로덕션 빌드에선 아예 검사하지 않으므로, 프론트도 이 가드가 필요하다.
 *
 * 호출부는 null 이면 앵커 자체를 렌더하지 않아야 한다(빈 href 로 렌더 금지).
 */
export function safeHref(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    const u = new URL(link);
    return u.protocol === "http:" || u.protocol === "https:" ? link : null;
  } catch {
    // 스킴 없는 상대경로·파싱 불가 문자열 → 버린다
    return null;
  }
}
