import { log } from "../util/log.ts";

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
