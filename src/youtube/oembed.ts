import { log } from "../util/log.ts";
import { localDate } from "../util/date.ts";

const WATCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/**
 * YouTube oEmbed로 영상의 **실제 채널명/핸들/원제**를 가져온다.
 * LLM이 채널명을 일반명("자동차 리뷰 채널")으로 지어내거나 비우는 문제를 보정하고,
 * 명백히 존재하지 않는(400/404) 영상은 걸러내기 위함.
 */
export interface OembedInfo {
  /** 200 → enrich 가능, 채널/원제 신뢰. */
  ok: boolean;
  /** 400/404 → 존재하지 않는(지어낸/삭제된) 영상 → 드롭 대상. */
  fake: boolean;
  channel: string | null;
  handle: string | null;
  title: string | null;
}

/** author_url(예: https://www.youtube.com/@handle)에서 "@handle" 추출. 없으면 null. */
export function parseHandle(authorUrl: string | undefined | null): string | null {
  if (!authorUrl) return null;
  const m = /@([A-Za-z0-9._-]+)/.exec(authorUrl);
  return m ? `@${m[1]}` : null;
}

export async function fetchOembed(videoId: string, timeoutMs = 8000): Promise<OembedInfo> {
  const target = `https://www.youtube.com/watch?v=${videoId}`;
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(target)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (r.status === 200) {
      const d = (await r.json()) as { author_name?: string; author_url?: string; title?: string };
      return {
        ok: true,
        fake: false,
        channel: d.author_name?.trim() || null,
        handle: parseHandle(d.author_url),
        title: d.title?.trim() || null,
      };
    }
    // 400/404 = 존재하지 않음(지어냈거나 삭제). 401/403 = 존재하나 임베드 불가 → 유지.
    if (r.status === 400 || r.status === 404) return { ok: false, fake: true, channel: null, handle: null, title: null };
    return { ok: false, fake: false, channel: null, handle: null, title: null };
  } catch {
    // 네트워크/timeout → 보수적으로 유지(드롭하지 않음)
    return { ok: false, fake: false, channel: null, handle: null, title: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * watch 페이지 HTML에서 영상의 **실제 업로드 ISO 타임스탬프**를 추출한다(못 찾으면 null).
 * 우선순위: 메인 영상 microformat 의 datePublished(가장 명확) → uploadDate → publishDate.
 * (순수 함수 — 실제 라이브 마크업으로 회귀 테스트.)
 */
export function extractUploadIso(html: string): string | null {
  const m =
    /itemprop="datePublished"\s+content="([^"]+)"/.exec(html) ||
    /"uploadDate":"([^"]+)"/.exec(html) ||
    /"publishDate":"([^"]+)"/.exec(html);
  return m ? m[1] : null;
}

/**
 * 영상의 **실제 업로드일**을 유튜브 watch 페이지에서 직접 확인해 로컬 YYYY-MM-DD 로 돌려준다.
 * LLM 은 oEmbed 로 검증되지 않는 date 를 신선도 필터 통과를 위해 cutoff(경계일)로 위조하는
 * 경향이 있어(대량 오탐), 게시일만은 서버가 원본에서 재검증한다. 실패 시 null.
 */
export async function fetchUploadDate(videoId: string, timeoutMs = 8000): Promise<string | null> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        signal: ac.signal,
        headers: { "User-Agent": WATCH_UA, "Accept-Language": "ko-KR,ko;q=0.9" },
      });
      if (r.status !== 200) return null; // 404 등 → 검증 불가(존재 여부는 oEmbed가 별도 처리)
      const iso = extractUploadIso(await r.text());
      if (!iso) return null;
      const d = new Date(iso);
      return isNaN(d.getTime()) ? null : localDate(d);
    } catch {
      // 네트워크/timeout → 마지막 시도면 포기
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * 영상이 YouTube Shorts 인지 판별. `/shorts/{id}` 로 HEAD(리다이렉트 수동) 요청 시
 * **숏츠면 200, 일반 영상이면 3xx(→ /watch 로 리다이렉트)** 로 응답한다(실측으로 duration 과 100% 일치).
 * 판별 실패(네트워크/timeout)는 **false(숏츠 아님)** 로 — 정상 영상을 오제거해 탭이 비는 것을 막는다(fail-open).
 */
export async function isShort(videoId: string, timeoutMs = 6000): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
      method: "HEAD",
      redirect: "manual",
      signal: ac.signal,
      headers: { "User-Agent": WATCH_UA },
    });
    return r.status === 200; // 200 = 숏츠 / 3xx = 일반(watch 로 리다이렉트)
  } catch {
    return false; // 판별 불가 → 숏츠 아님으로 간주(fail-open)
  } finally {
    clearTimeout(timer);
  }
}

/** 목록에서 Shorts 를 제거(동시성 제한). videoId 없는 항목은 판별 불가로 유지. */
export async function filterOutShorts<T extends { videoId: string | null }>(
  items: T[],
  concurrency = 6
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const shortFlags = await Promise.all(
      batch.map((it) => (it.videoId ? isShort(it.videoId) : Promise.resolve(false)))
    );
    batch.forEach((it, idx) => {
      if (!shortFlags[idx]) out.push(it);
    });
  }
  return out;
}

/** 영상 목록을 oEmbed로 보강. 실제 채널명/핸들로 교체하고, 존재하지 않는 영상은 제거. */
export async function enrichVideos<T extends { videoId: string | null; channel: string; channelHandle?: string | null; originalTitle?: string | null }>(
  items: T[]
): Promise<T[]> {
  const out: (T | null)[] = await Promise.all(
    items.map(async (v): Promise<T | null> => {
      if (!v.videoId) return v;
      const info = await fetchOembed(v.videoId);
      if (info.fake) {
        log.warn(`유튜브 oEmbed: 존재하지 않는 영상 제거 (${v.videoId})`);
        return null;
      }
      if (info.ok) {
        return {
          ...v,
          channel: info.channel || v.channel,
          channelHandle: info.handle ?? v.channelHandle ?? null,
          originalTitle: v.originalTitle ?? info.title ?? null,
        };
      }
      return v; // 검증 불가(401/네트워크) → 원본 유지
    })
  );
  return out.filter((v): v is T => v != null);
}
