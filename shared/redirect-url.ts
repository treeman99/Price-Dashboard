// 검색 근거 '경유 주소'(리디렉트) 판별 — 수집기(원래 주소로 풀기)·price 서버(화면·메일·제외 사이트)·화면이 같은 규칙을 쓴다.
//
// 왜: Gemini(agy) 의 search_web 근거 링크는 원래 기사 주소가 아니라
// `https://vertexaisearch.cloud.google.com/grounding-api-redirect/<토큰>` 형태로 온다(2026-11-22~28 보고서 12회에서
// 가장 많은 링크 도메인, 368회). 토큰은 검색마다 새로 생겨서 같은 기사라도 주소가 매번 다르다 — 출처 사이트가 안 보이고,
// 다른 모델이 찾은 같은 기사와 URL 로 묶이지 않고, 사이트 취합 제외도 걸리지 않는다. 수집기는 이런 주소를 수집 직후
// 원래 주소로 풀고(src/util/redirect-resolve.ts), 풀지 못한 것은 화면·메일에 '원래 주소 확인 불가'로 표시한다.

/** 경유 주소 종류. param = 주소 안 파라미터로 원래 주소를 바로 꺼낼 수 있음, network = 요청해서 Location 을 봐야 함. */
export type RedirectKind = "param" | "network";

function parse(url: string | null | undefined): URL | null {
  if (!url) return null;
  try {
    const u = new URL(String(url).trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Google 검색 결과 경유(`google.<tld>/url?q=…` 또는 `url=`). */
function isGoogleUrlRedirect(u: URL): boolean {
  return /^(www\.)?google\.[a-z.]{2,8}$/.test(u.hostname.toLowerCase()) && u.pathname === "/url";
}

/**
 * 경유 주소면 그 종류, 아니면 null.
 * - Gemini 검색 근거: vertexaisearch.cloud.google.com/grounding-api-redirect/… (network — 302 Location)
 * - Google 검색 결과: google.<tld>/url?q=… / url=… (param)
 * - Bing: bing.com/ck/a?…&u=a1<base64url> (param)
 * - DuckDuckGo: duckduckgo.com/l/?uddg=… (param)
 * - Facebook 외부 링크: l.facebook.com/l.php?u=… (param)
 * - Google 뉴스 기사 래퍼: news.google.com/rss/articles/… · /articles/… (network — 못 풀면 '확인 불가')
 * - X(트위터) 단축: t.co/… (network)
 */
export function redirectKind(url: string | null | undefined): RedirectKind | null {
  const u = parse(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  if (host === "vertexaisearch.cloud.google.com" && u.pathname.startsWith("/grounding-api-redirect/")) return "network";
  if (isGoogleUrlRedirect(u)) return "param";
  if (/^(www\.)?bing\.com$/.test(host) && u.pathname === "/ck/a" && u.searchParams.has("u")) return "param";
  if (/^(html\.|lite\.)?duckduckgo\.com$/.test(host) && u.pathname.startsWith("/l/") && u.searchParams.has("uddg")) return "param";
  if (/^l[m]?\.facebook\.com$/.test(host) && u.pathname === "/l.php" && u.searchParams.has("u")) return "param";
  if (host === "news.google.com" && /^\/(rss\/)?articles\//.test(u.pathname)) return "network";
  if (host === "t.co" && u.pathname.length > 1) return "network";
  return null;
}

/** 원래 사이트 주소가 아니라 검색·공유 경유 주소인가. */
export function isRedirectUrl(url: string | null | undefined): boolean {
  return redirectKind(url) !== null;
}

function httpOnly(v: string | null | undefined): string | null {
  return parse(v) ? String(v).trim() : null;
}

function decodeBingU(v: string): string | null {
  // u=a1<base64url(원래 주소)>
  if (!v.startsWith("a1")) return httpOnly(v);
  try {
    const b64 = v.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
    return httpOnly(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** 네트워크 없이 경유 주소의 파라미터에서 원래 주소를 꺼낸다(param 종류만). 못 꺼내면 null. */
export function unwrapRedirectParam(url: string | null | undefined): string | null {
  const u = parse(url);
  if (!u || redirectKind(url) !== "param") return null;
  const host = u.hostname.toLowerCase();
  if (isGoogleUrlRedirect(u)) return httpOnly(u.searchParams.get("q") ?? u.searchParams.get("url"));
  if (host.endsWith("bing.com")) return decodeBingU(u.searchParams.get("u") ?? "");
  if (host.endsWith("duckduckgo.com")) return httpOnly(u.searchParams.get("uddg"));
  if (host.endsWith("facebook.com")) return httpOnly(u.searchParams.get("u"));
  return null;
}

/** 링크의 표시용 도메인(소문자, www.·m. 제거). 경유 주소·잘못된 주소면 null. */
export function siteDomain(url: string | null | undefined): string | null {
  const u = parse(url);
  if (!u || isRedirectUrl(url)) return null;
  return u.hostname.toLowerCase().replace(/\.$/, "").replace(/^(www\d?|m)\./, "") || null;
}

/** 화면·메일 표시용 링크 정보: 원래 사이트 도메인, 또는 경유 주소라 원래 주소를 모름(힌트 도메인이 있으면 함께). */
export function linkSite(
  url: string | null | undefined,
  hintDomain?: string | null
): { domain: string | null; unresolved: boolean } {
  if (isRedirectUrl(url)) return { domain: hintDomain?.trim() || null, unresolved: true };
  return { domain: siteDomain(url), unresolved: false };
}

/** '원래 주소 확인 불가' 표기(화면·메일·마크다운 공통). */
export const UNRESOLVED_LINK_LABEL = "원래 주소 확인 불가";
