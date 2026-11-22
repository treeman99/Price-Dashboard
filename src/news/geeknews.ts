import { log } from "../util/log.ts";

/**
 * GeekNews 공식 피드(Atom) — https://news.hada.io/rss/news
 *
 * 예전 뉴스 프롬프트는 https://news.hada.io/new 페이지의 "N시간전" 상대 표기를 모델이 읽어 24시간
 * 이내를 판정했다. 공식 피드는 커뮤니티 등록 시각을 **시간대 포함 ISO**(`2026-11-22T13:52:21+09:00`)로
 * 주므로 서버가 직접 받아 정확한 시각과 함께 모델에 넘긴다(2026-11-22 실측 확인).
 *
 * ⚠️ 이 시각은 GeekNews **등록 시각**이다. 원문 기사의 최초 발행 시각과 다를 수 있다.
 */
export const GEEKNEWS_FEED_URL = "https://news.hada.io/rss/news";

export interface GeekNewsEntry {
  topicId: string;
  title: string;
  /** 토픽 링크(추적 파라미터 제거). */
  url: string;
  /** 커뮤니티 등록 시각(피드 원문 그대로, 시간대 포함). */
  publishedAt: string;
  updatedAt: string | null;
  /** 본문 요약 앞부분(태그 제거). */
  excerpt: string;
}

export interface GeekNewsFetchResult {
  ok: boolean;
  entries: GeekNewsEntry[];
  /** 피드 전체 항목 수(기간 필터 전). */
  total: number;
  feedUpdated: string | null;
  error: string | null;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** 피드 XML → 항목. 시간대가 없는 시각은 버린다(정확한 시각이 이 경로를 쓰는 이유다). */
export function parseGeekNewsFeed(xml: string): { entries: GeekNewsEntry[]; feedUpdated: string | null } {
  const feedHead = xml.split("<entry>")[0] ?? "";
  const feedUpdated = /<updated>([^<]+)<\/updated>/.exec(feedHead)?.[1]?.trim() ?? null;
  const out: GeekNewsEntry[] = [];
  for (const e of xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []) {
    const id = /<id>([^<]+)<\/id>/.exec(e)?.[1]?.trim() ?? "";
    const topicId = /[?&]id=(\d+)/.exec(id)?.[1];
    const publishedAt = /<published>([^<]+)<\/published>/.exec(e)?.[1]?.trim() ?? "";
    if (!topicId || !/[+-]\d{2}:\d{2}$|Z$/.test(publishedAt) || isNaN(Date.parse(publishedAt))) continue;
    const updatedAt = /<updated>([^<]+)<\/updated>/.exec(e)?.[1]?.trim() ?? null;
    const title = decode(/<title>([\s\S]*?)<\/title>/.exec(e)?.[1] ?? "");
    const content = decode(/<content[^>]*>([\s\S]*?)<\/content>/.exec(e)?.[1] ?? "");
    out.push({
      topicId,
      title,
      url: `https://news.hada.io/topic?id=${topicId}`,
      publishedAt,
      updatedAt,
      excerpt: stripTags(content).slice(0, 400),
    });
  }
  return { entries: out, feedUpdated };
}

/**
 * 피드를 받아 (since, until] 구간의 항목만 돌려준다. 실패해도 throw 하지 않고 ok:false 로 알린다
 * (호출부가 '미수집 출처'로 기록하거나 예전 방식으로 물러설 수 있게).
 */
export async function fetchGeekNews(
  since: Date,
  until: Date,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<GeekNewsFetchResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(GEEKNEWS_FEED_URL, {
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 (DailyDashboard)", Accept: "application/atom+xml" },
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const { entries, feedUpdated } = parseGeekNewsFeed(await res.text());
    const inWindow = entries.filter((x) => {
      const t = Date.parse(x.publishedAt);
      return t > since.getTime() && t <= until.getTime();
    });
    return { ok: true, entries: inWindow, total: entries.length, feedUpdated, error: null };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "시간 초과" : (e as Error).message;
    log.warn(`GeekNews 피드 수집 실패: ${msg}`);
    return { ok: false, entries: [], total: 0, feedUpdated: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
