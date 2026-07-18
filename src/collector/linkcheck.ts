// 네이버 쇼핑 후보 링크의 '사망'(판매중지/삭제/잘못된 상품번호) 검증.
//
// 왜 필요한가 — 네이버 쇼핑 API 는 이미 판매가 중지된 상품도 최저가 후보로 돌려준다.
//   그 죽은 링크가 비정상적으로 싼 값이라 대시보드 최저가/ Top3 를 오염시킨다(실제 사례:
//   로보락 S10 MaxV Slim 의 11번가 1·2위 → 클릭 시 "판매가 중지된 상품" 안내).
//
// 왜 어려운가 — 실제 라이브 마크업을 프로브해 보면(§verify-parsers-with-real-markup):
//   (a) 죽은 11번가 링크도 HTTP 200 을 준다. 게이트웨이(200)가 meta-refresh/JS 로
//       실제 상품 페이지로 넘기고, 그 페이지(역시 200)의 본문이
//       `alert("...판매가 중지된 상품이거나 잘못된 상품번호...")` 뿐이다(≈200바이트).
//   (b) 정상 상품 페이지도 "품절/sold out/일시품절/만료/상품이 없" 같은 단어를 흔히 포함한다
//       (연관상품·옵션·숨은 스크립트 템플릿). cafe24 계열은 심지어 "존재하지 않는 상품/삭제된"
//       같은 문구까지 검증용 템플릿으로 본문에 박아 둔다(37degrees 629KB 라이브 페이지에서 확인).
//   (c) 정상 링크가 오히려 차단당한다: 네이버 카탈로그=418, SSG=403, 스마트스토어=로그인 리다이렉트.
//
// 결론(고정밀 규칙) — "느슨한 키워드"가 아니라 **작은 인터스티셜 페이지에 사망 문구가 곧 전체**
//   인 구조만 사망으로 본다. 실제 프로브 표본(≈65개 후보) 전체에서 이 규칙은 알려진 죽은
//   11번가 링크 2개에만 발동하고 정상 페이지에는 한 번도 발동하지 않았다.
//   판정 불가(차단/타임아웃/로그인)는 전부 '살아있음'으로 흡수한다(fail-open) — 정상 최저가를
//   오탐으로 날리는 쪽이 죽은 링크를 남기는 쪽보다 더 나쁘기 때문.

import { log } from "../util/log.ts";
import { DESKTOP_UA } from "./sources/http.ts";

/** 프로브 1회 결과(리다이렉트 추적을 위해 최종 URL 포함). */
export interface FetchedPage {
  status: number;
  finalUrl: string;
  body: string;
}

/** 주입 가능한 페이지 fetch(테스트에서 실제 네트워크 호출 금지). */
export type PageFetcher = (url: string) => Promise<FetchedPage>;

export interface LinkCheckDeps {
  fetcher?: PageFetcher;
  /** 프로브 1회 타임아웃(ms). 기본 8000. */
  timeoutMs?: number;
}

/**
 * 사망으로 볼 문구. 단독 매칭은 오탐이 많으므로(위 (b)) 반드시 '작은 인터스티셜' 게이트와
 * AND 로만 쓴다. "품절/sold out/일시품절/만료" 같은 약한 단어는 정상 페이지에 흔해 제외한다.
 */
const DEAD_PHRASES = [
  "판매가 중지된 상품",
  "잘못된 상품번호",
  "존재하지 않는 상품",
  "삭제된 상품",
  "판매가 종료된 상품",
  "판매기간이 종료",
  "더 이상 판매하지 않는 상품",
  "요청하신 상품을 찾을 수 없",
  "상품이 존재하지 않습니다",
  "판매중지된 상품",
];

/** 사망 문구가 있어도, 큰 정상 페이지(템플릿에 문구가 박힌 경우)면 사망으로 보지 않는 임계(byte). */
const INTERSTITIAL_MAX_BYTES = 2000;

/** meta-refresh / JS location 리다이렉트 대상 추출(게이트웨이 → 실제 상품 페이지 1홉 추적용). */
const META_REFRESH = /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)/i;
const JS_REDIRECT =
  /(?:document\.location\.replace|location\.replace|location\.href\s*=|document\.location\s*=)\s*\(?\s*["']([^"']+)["']/i;

/**
 * 페이지 본문이 '사망 인터스티셜'인지.
 * 사망 문구가 있고 && (페이지가 아주 작거나 || alert/history.back 형태의 에러 인터스티셜)면 true.
 * 큰 정상 상품 페이지에 문구가 스크립트/연관영역으로 섞여 있는 경우는 걸러진다.
 */
export function isDeadPage(body: string): boolean {
  if (!body) return false;
  const hasPhrase = DEAD_PHRASES.some((p) => body.includes(p));
  if (!hasPhrase) return false;

  if (body.length < INTERSTITIAL_MAX_BYTES) return true;

  // 큰 페이지라도 본문이 사실상 비어 있고(빈 body) 스크립트 알림/뒤로가기로만 이뤄진 에러 인터스티셜이면 사망.
  const emptyBody = /<body[^>]*>\s*<\/body>/i.test(body);
  const alertInterstitial =
    /history\.back\s*\(/i.test(body) &&
    /alert\s*\(\s*["'][^"']*(판매가 중지|잘못된 상품번호|존재하지 않|삭제된|판매.*종료|판매중지)/.test(body);
  return emptyBody || alertInterstitial;
}

/** 절대 URL 로 정규화한 리다이렉트 대상(없거나 자기 자신이면 null). */
function extractRedirect(body: string, baseUrl: string): string | null {
  const m = META_REFRESH.exec(body) || JS_REDIRECT.exec(body);
  if (!m) return null;
  let next = m[1].replace(/&amp;/g, "&").trim();
  try {
    next = new URL(next, baseUrl).toString();
  } catch {
    return null;
  }
  return next && next !== baseUrl ? next : null;
}

/** 브라우저 유사 헤더 + 리다이렉트 추적 + 타임아웃 + 본문 크기 상한(대용량 페이지 낭비 방지). */
function realPageFetcher(timeoutMs: number): PageFetcher {
  const READ_CAP = 96 * 1024; // 사망 인터스티셜은 아주 작다 → 앞부분만 읽어도 충분(매너/대역폭).
  return async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": DESKTOP_UA,
          "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: ctrl.signal,
      });
      const body = await readCapped(res, READ_CAP);
      return { status: res.status, finalUrl: res.url || url, body };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 응답 본문을 최대 cap 바이트까지만 읽는다(스트림 조기 종료). 실패 시 빈 문자열. */
async function readCapped(res: Response, cap: number): Promise<string> {
  const body = res.body;
  if (!body) return res.text().catch(() => "");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let out = "";
  let read = 0;
  try {
    while (read < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      out += decoder.decode(value, { stream: true });
    }
  } catch {
    // 스트림 중단(타임아웃 등) → 지금까지 읽은 것만으로 판정.
  } finally {
    reader.cancel().catch(() => {});
  }
  return out;
}

/**
 * url 이 '판매중지/삭제' 등으로 죽은 링크인지. 판정 불가/차단/오류는 전부 false(살아있음)로 흡수.
 * 게이트웨이(meta-refresh/JS) 는 최대 2홉까지 실제 상품 페이지로 추적해 판정한다.
 */
export async function isDeadListing(url: string, deps: LinkCheckDeps = {}): Promise<boolean> {
  const fetcher = deps.fetcher ?? realPageFetcher(deps.timeoutMs ?? 8000);
  try {
    let page = await fetcher(url);
    if (isDeadPage(page.body)) return true;
    for (let hop = 0; hop < 2; hop++) {
      const next = extractRedirect(page.body, page.finalUrl);
      if (!next) break;
      page = await fetcher(next);
      if (isDeadPage(page.body)) return true;
    }
    return false;
  } catch (e) {
    log.warn(`링크 검증 실패(살아있음으로 간주) [${url}]: ${(e as Error).message}`);
    return false;
  }
}
