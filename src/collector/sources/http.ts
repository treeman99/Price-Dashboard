// 가격비교 소스 공용 HTTP 유틸 + 매너 하드요구사항(문서 §8·§11) 코드 구현.
//   (a) 현실적 헤더(UA + Accept-Language: ko-KR + Referer + X-Requested-With)
//   (b) 호출 간 지연 + 상품 간 지터
//   (c) 로컬 전용 가드: 사설/가정용 IP가 아니면 경고 + ajax 자동 비활성화
//   (d) 차단 감지(403/빈 응답/캡차/비정상 HTML)
// 외부 fetch 는 주입 가능(Fetcher)하게 설계 → 단위테스트에서 실제 네트워크 호출 금지.

import os from "node:os";

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

// ── 로컬 전용 가드 (사설/가정용 IP 판별) ─────────────────
/** 사설/로컬/CGNAT IPv4 여부. 가정용 공유기·통신사 NAT 대역 포함. */
export function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map((x) => Number(x));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = p;
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT(통신사/가정용)
  if (a === 127) return true; // loopback
  return false;
}

export interface LocalGuard {
  /** 로컬/가정용 환경으로 보이면 true. false면 데이터센터 의심 → ajax 비활성. */
  isLocal: boolean;
  reason: string;
}

/** 자기 머신의 외부 IPv4 인터페이스를 보고 로컬/데이터센터 여부를 판별한다. */
export function detectLocalGuard(): LocalGuard {
  const ifaces = os.networkInterfaces();
  const ipv4: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) ipv4.push(ni.address);
    }
  }
  if (ipv4.length === 0) {
    // 외부 IPv4 인터페이스 없음 → 오프라인/로컬로 간주(안전: ajax 허용하되 호출은 어차피 실패)
    return { isLocal: true, reason: "외부 IPv4 인터페이스 없음(로컬/오프라인 추정)" };
  }
  const priv = ipv4.filter(isPrivateIPv4);
  if (priv.length > 0) {
    return { isLocal: true, reason: `사설/가정용 IP 확인(${priv.join(", ")})` };
  }
  return {
    isLocal: false,
    reason: `사설 IP 미검출 — 데이터센터 의심(${ipv4.join(", ")})`,
  };
}
