import { isRedirectUrl, redirectKind, unwrapRedirectParam } from "../../shared/redirect-url.ts";
import { log } from "./log.ts";

/**
 * 검색 근거 경유 주소(shared/redirect-url.ts) → 원래 기사 주소.
 *
 * - param 종류(google.com/url?q= 등)는 네트워크 없이 파라미터에서 꺼낸다.
 * - network 종류(Gemini vertexaisearch 등)는 **경유 주소 자체에만** HEAD(안 되면 GET) 요청을 보내고, 따라가지 않은 채
 *   302 Location 을 읽는다. Location 이 또 경유 주소일 때만 최대 maxHops 번 더 본다. 기사 사이트에는 요청하지 않는다.
 *   (2026-11-28 실측: vertexaisearch 주소는 HEAD 에 302 + Location 으로 답하고, 6일 지난 주소도 아직 풀렸다.)
 * - 시간 제한(요청당)·동시성 제한을 둔다. 실패하면 Gemini 검색 결과에 적혀 있던 원래 사이트 도메인(힌트)으로 대체하고,
 *   그것도 없으면 '확인 불가'로 돌려준다 — 호출부는 원래 링크를 지우지 않고 그대로 둔다.
 * - 경유 주소는 시간이 지나면 만료될 수 있어 수집 직후(모델 응답을 읽은 바로 다음) 푼다.
 */

export type ResolveHow = "param" | "redirect" | "hint" | "failed";

export interface LinkResolution {
  /** 원래 받은 경유 주소. */
  original: string;
  /** 풀어 낸 원래 기사 주소. 못 풀었으면 null. */
  url: string | null;
  /** url 을 못 풀었을 때 검색 결과에 적혀 있던 원래 사이트 도메인(힌트). */
  domain: string | null;
  how: ResolveHow;
  error?: string;
}

export interface ResolveOptions {
  /** 요청 1건 시간 제한(ms). */
  timeoutMs?: number;
  /** 동시에 보내는 요청 수. */
  concurrency?: number;
  /** 경유 주소가 다시 경유 주소로 보낼 때 더 따라가는 최대 횟수. */
  maxHops?: number;
  fetchImpl?: typeof fetch;
  /** 경유 주소 → 원래 사이트 도메인 힌트(없으면 전역 힌트 저장소). */
  hint?: (url: string) => string | null;
}

export const RESOLVE_TIMEOUT_MS = 8_000;
export const RESOLVE_CONCURRENCY = 6;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

// ── Gemini 검색 결과의 원래 도메인 힌트 ──
// agy search_web 결과 본문은 근거를 `[1] [prnewswire.com](https://vertexaisearch…/grounding-api-redirect/…)` 로 적는다.
// 그 본문은 stream-json 으로 오지 않고 agy 대화 기록에만 남아(src/util/antigravity-query.ts 가 읽어 넣는다)
// 실행 프로세스 안에서만 쓰는 메모리 저장소로 둔다. 키(토큰 주소)가 검색마다 유일해 세 모델 동시 실행에도 섞이지 않는다.
const hints = new Map<string, string>();
const HINT_LIMIT = 20_000;

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** 힌트 라벨을 도메인으로 정규화(도메인 모양이 아니면 null — 예: "Reuters" 같은 이름은 버린다). */
export function hintDomain(label: string | null | undefined): string | null {
  const d = String(label ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split(/[/?#\s]/)[0]
    .replace(/\.$/, "")
    .replace(/^(www\d?|m)\./, "");
  return DOMAIN_RE.test(d) ? d : null;
}

/** 검색 결과 본문에서 `[도메인](경유 주소)` 짝을 찾아 힌트로 기억한다. 넣은 건수를 돌려준다. */
export function rememberRedirectHints(text: string): number {
  let n = 0;
  const re = /\[([^\]\n]{1,120})\]\((https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[A-Za-z0-9_\-=]+)\)/g;
  for (const m of text.matchAll(re)) {
    const d = hintDomain(m[1]);
    if (!d || hints.has(m[2])) continue;
    if (hints.size >= HINT_LIMIT) hints.delete(hints.keys().next().value!);
    hints.set(m[2], d);
    n++;
  }
  return n;
}

export function redirectHint(url: string): string | null {
  return hints.get(url) ?? null;
}

/** 테스트 전용. */
export function __clearRedirectHintsForTest(): void {
  hints.clear();
}

async function locationOf(url: string, method: "HEAD" | "GET", f: typeof fetch, timeoutMs: number): Promise<string | null> {
  const res = await f(url, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": UA, accept: "text/html,*/*" },
  });
  // 본문은 읽지 않는다(GET 이어도 Location 만 필요).
  try {
    await res.body?.cancel();
  } catch {
    /* 무시 */
  }
  if (res.status < 300 || res.status >= 400) return null;
  const loc = res.headers.get("location");
  if (!loc) return null;
  try {
    return new URL(loc, url).toString();
  } catch {
    return null;
  }
}

function isHttp(u: string | null): u is string {
  return !!u && /^https?:\/\//i.test(u);
}

/** 경유 주소 1건을 푼다. 경유 주소가 아니면 null. */
export async function resolveRedirect(url: string, opts: ResolveOptions = {}): Promise<LinkResolution | null> {
  if (!isRedirectUrl(url)) return null;
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? RESOLVE_TIMEOUT_MS;
  const maxHops = opts.maxHops ?? 3;
  let cur = url;
  let error = "";
  for (let hop = 0; hop <= maxHops; hop++) {
    const kind = redirectKind(cur);
    if (!kind) break; // 원래 주소에 닿음
    let next: string | null = null;
    if (kind === "param") {
      next = unwrapRedirectParam(cur);
      if (!next) {
        error = "주소 안에 원래 주소 파라미터가 없음";
        break;
      }
    } else {
      try {
        next = await locationOf(cur, "HEAD", f, timeoutMs);
      } catch (e) {
        error = (e as Error).message;
      }
      if (!next) {
        // HEAD 를 안 받거나(405 등) 일시 오류면 GET 으로 한 번 더(본문은 읽지 않음).
        try {
          next = await locationOf(cur, "GET", f, timeoutMs);
        } catch (e) {
          error = (e as Error).message;
        }
      }
      if (!next) {
        error ||= "리디렉트 응답(Location) 없음";
        break;
      }
    }
    if (!isHttp(next)) {
      error = "원래 주소가 http(s) 가 아님";
      break;
    }
    cur = next;
  }
  if (!redirectKind(cur) && cur !== url) {
    return { original: url, url: cur, domain: null, how: redirectKind(url) === "param" ? "param" : "redirect" };
  }
  const domain = (opts.hint ?? redirectHint)(url);
  return {
    original: url,
    url: null,
    domain,
    how: domain ? "hint" : "failed",
    error: (error || "경유 주소가 계속 이어짐").slice(0, 200),
  };
}

/** 여러 경유 주소를 동시성 제한 안에서 푼다(중복 제거). 경유 주소가 아닌 링크는 결과에 없다. */
export async function resolveRedirects(urls: Iterable<string>, opts: ResolveOptions = {}): Promise<Map<string, LinkResolution>> {
  const todo = [...new Set([...urls].filter((u) => isRedirectUrl(u)))];
  const out = new Map<string, LinkResolution>();
  const concurrency = Math.max(1, opts.concurrency ?? RESOLVE_CONCURRENCY);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
      while (i < todo.length) {
        const u = todo[i++];
        const r = await resolveRedirect(u, opts);
        if (r) out.set(u, r);
      }
    })
  );
  return out;
}

/** 결과 요약 한 줄(로그용). */
export function summarizeResolutions(res: Map<string, LinkResolution>): string {
  const c = { param: 0, redirect: 0, hint: 0, failed: 0 };
  for (const r of res.values()) c[r.how]++;
  return `경유 주소 ${res.size}건 → 원래 주소 ${c.param + c.redirect}건${c.hint ? ` · 도메인만 확인 ${c.hint}건` : ""}${c.failed ? ` · 확인 불가 ${c.failed}건` : ""}`;
}

export function logResolutions(label: string, res: Map<string, LinkResolution>): void {
  if (!res.size) return;
  const failed = [...res.values()].filter((r) => !r.url);
  (failed.length ? log.warn : log.info)(
    `${label}: ${summarizeResolutions(res)}${failed.length ? ` (예: ${failed[0].error ?? ""})` : ""}`
  );
}
