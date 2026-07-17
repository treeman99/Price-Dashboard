// 이메일 HTML 빌더 공용 헬퍼.
// 알림 모듈(가격·뉴스·이벤트·유튜브·증시)이 같은 이스케이프/링크 규칙을 쓰도록 한 곳에 모은다.
//
// 이스케이프는 문자열로 HTML 을 조립하는 백엔드 전용이다(프론트는 JSX 가 알아서 이스케이프한다).
// 반면 링크 가드는 프론트도 똑같이 필요하므로 shared/url.ts 에 두고 여기서 다시 내보낸다.

export { safeHref } from "../../shared/url.ts";

/** 텍스트를 HTML 본문에 넣기 안전하게. null/undefined 는 빈 문자열. */
export function escapeHtml(s: string | null | undefined): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 속성값용. 작은따옴표까지 막아 attr 탈출을 차단한다. */
export function escapeAttr(s: string | null | undefined): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
