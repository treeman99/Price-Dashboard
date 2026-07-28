// 가격비교 소스 공용 HTTP 유틸 + 매너 하드요구사항(문서 §8·§11) 코드 구현.
//   (a) 현실적 헤더(UA + Accept-Language: ko-KR + Referer)
//   (b) 호출 간 지연 + 상품 간 지터
//   (c) 차단 감지(403/빈 응답/캡차/비정상 HTML)
// 외부 fetch 는 주입 가능(Fetcher)하게 설계 → 단위테스트에서 실제 네트워크 호출 금지.
//
// ⚠️ 로컬 전용 가드(detectLocalGuard/isPrivateIPv4)는 2026-07-28 제거했다. 그 가드의 유일한
//    용도가 "데이터센터에서 돌면 다나와 robots 금지 ajax 를 끈다"였는데, 쿠팡 수집과 함께
//    ajax 호출 자체가 사라져 지킬 대상이 없어졌다(남은 경로는 전부 robots 허용).

/** 데스크톱 크롬 UA (현실적 헤더) */
export const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export interface FetchInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  body: string;
}

/** 주입 가능한 fetch 추상화. 테스트에서 가짜 응답을 주입한다. */
export type Fetcher = (url: string, init?: FetchInit) => Promise<HttpResponse>;

/** 기본 Fetcher — 전역 fetch 사용 (런타임 전용, 테스트에서는 주입으로 대체). */
export const realFetcher: Fetcher = async (url, init) => {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.headers,
    body: init?.body,
  });
  const body = await res.text().catch(() => "");
  return { status: res.status, ok: res.ok, body };
};

/** 현실적 헤더 기본셋. extra 로 Referer/X-Requested-With/Content-Type 등 덧붙인다. */
export function baseHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "User-Agent": DESKTOP_UA,
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    ...extra,
  };
}

// ── 차단 감지 ───────────────────────────────────────────
const CAPTCHA_KEYWORDS = [
  "captcha",
  "보안문자",
  "자동입력 방지",
  "비정상적인 접근",
  "비정상적인 요청",
  "access denied",
  "forbidden",
  "akamai",
  "잠시 후 다시",
];

/** HTTP≠200 / 빈(짧은) 응답 / 캡차·차단 키워드 → 차단으로 판정. */
export function looksBlocked(res: HttpResponse): boolean {
  if (res.status !== 200) return true;
  if (!res.body || res.body.trim().length < 50) return true;
  const lower = res.body.toLowerCase();
  return CAPTCHA_KEYWORDS.some((k) => lower.includes(k));
}

// ── 지연/지터 ───────────────────────────────────────────
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** [minMs, maxMs) 범위 랜덤 지연(ms). 상품 간 지터 등에 사용. */
export function jitterMs(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * Math.max(0, maxMs - minMs));
}
