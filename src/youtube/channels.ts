import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { localDate } from "../util/date.ts";

/**
 * 추천/발굴 유튜브 채널의 **최근 업로드를 RSS(feeds/videos.xml)로 직접** 가져온다.
 *
 * 배경: 큐레이션 에이전트의 WebSearch/WebFetch 는 "채널의 최근 업로드"를 구조적으로 못 찾는다
 * (검색은 인기순, 채널 페이지는 JS 렌더링이라 목록이 안 보임). 그 결과 창 안에 분명히 있는 영상을
 * 통째로 놓친다(실측: 잇섭이 7일 내 3개 올렸는데 0개 발견). RSS 는 **키 없이** 실제 게시일과 함께
 * 최신 15개를 주므로, 서버가 이걸로 '확정 신선 후보'를 만들어 큐레이션에 시딩한다.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export interface RssVideo {
  videoId: string;
  title: string;
  channel: string;
  channelId: string | null;
  /** 로컬 YYYY-MM-DD (RSS published 를 로컬 날짜로 변환). */
  date: string;
  /** RSS media:description 앞부분(요약 힌트로만). */
  description: string | null;
}

// ───────────────────────── 순수 파서(실제 마크업으로 회귀 테스트) ─────────────────────────

/** 문자열에서 "@handle" 추출(없으면 null). 예: "찐AI (@jjin-ai-hj)" → "@jjin-ai-hj". */
export function extractHandle(s: string): string | null {
  const m = /@([A-Za-z0-9._-]+)/.exec(s);
  return m ? `@${m[1]}` : null;
}

/**
 * 채널 검색용 이름 정규화: 괄호 핸들·@핸들 토큰 제거.
 * - "찐AI (@jjin-ai-hj)" → "찐AI"
 * - "@고몽여행" → "고몽여행" (발굴 LLM이 한글 이름에 @를 붙여 만든 가짜 핸들을 이름으로 되돌림.
 *   실제 YouTube 핸들은 ASCII 라, @한글은 핸들이 아니라 이름으로 검색해야 해석된다.)
 */
export function cleanChannelName(s: string): string {
  return s
    .replace(/\(@[^)]*\)/g, "") // "(@handle)" 괄호 병기 핸들 제거
    .replace(/@[A-Za-z0-9._-]+/g, "") // ASCII @handle 토큰 제거(실제 핸들 형태)
    .replace(/^@\s*/, "") // 남은 선행 @ 제거 — 가짜 @한글핸들을 이름으로
    .trim();
}

/** 채널/검색 페이지 HTML에서 첫 channelId(UC…) 추출(못 찾으면 null). */
export function extractChannelId(html: string): string | null {
  const m =
    /"channelId":"(UC[0-9A-Za-z_-]{22})"/.exec(html) ||
    /"externalId":"(UC[0-9A-Za-z_-]{22})"/.exec(html) ||
    /channel\/(UC[0-9A-Za-z_-]{22})/.exec(html);
  return m ? m[1] : null;
}

/** 최소 XML 엔티티 디코드(&amp; 는 마지막). */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * YouTube RSS(atom) XML → 엔트리 목록. 각 <entry>의 yt:videoId·title·author·published·description 파싱.
 * published 는 로컬 YYYY-MM-DD 로 변환. videoId·유효 날짜가 없으면 그 엔트리는 버림.
 * (피드 상단의 채널 title/author 는 <entry> 밖이라 걸리지 않는다.)
 */
export function parseRssEntries(xml: string): RssVideo[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  const out: RssVideo[] = [];
  for (const e of entries) {
    const vid = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(e)?.[1]?.trim();
    if (!vid) continue;
    const pub = /<published>([^<]+)<\/published>/.exec(e)?.[1];
    const d = pub ? new Date(pub) : null;
    if (!d || isNaN(d.getTime())) continue;
    const title = decodeXml(/<title>([\s\S]*?)<\/title>/.exec(e)?.[1] ?? "");
    const channelId = /<yt:channelId>(UC[0-9A-Za-z_-]{22})<\/yt:channelId>/.exec(e)?.[1] ?? null;
    const channel = decodeXml(/<author>\s*<name>([\s\S]*?)<\/name>/.exec(e)?.[1] ?? "");
    const descRaw = /<media:description>([\s\S]*?)<\/media:description>/.exec(e)?.[1] ?? "";
    const description = descRaw ? decodeXml(descRaw).slice(0, 400) : null;
    out.push({ videoId: vid, title, channel, channelId, date: localDate(d), description });
  }
  return out;
}

/** cutoff~today(포함) 안이면 통과. */
export function inWindow(date: string, cutoff: string, today: string): boolean {
  return date >= cutoff && date <= today;
}

// ───────────────────────── channelId 해석 캐시 ─────────────────────────
// 채널 문자열은 자주 안 바뀌므로 1회 해석해 재사용한다. 실패(null)는 음성 캐시로 짧게 보관해
// 매 수집마다 같은 실패를 반복 조회하지 않되, TTL 후 재시도한다.

const CACHE_PATH = path.join(path.dirname(config.dbPath), "youtube-channels.json");
// 해석 실패 재시도 대기. 실패는 대개 일시적(빠른 하베스트 중 검색 rate-limit 등)이라 짧게 둬
// 다음 수집에서 회복되게 한다. 성공은 영구 캐시(빠르고 안정).
const NEG_TTL_MS = 6 * 3_600_000; // 6시간

interface ChannelCacheEntry {
  channelId: string | null;
  resolvedAt: string;
}
type ChannelCache = Record<string, ChannelCacheEntry>;

function readCache(): ChannelCache {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      const v = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
      if (v && typeof v === "object" && !Array.isArray(v)) return v as ChannelCache;
    }
  } catch (e) {
    log.warn(`youtube-channels.json 읽기 실패: ${(e as Error).message}`);
  }
  return {};
}

function writeCache(c: ChannelCache): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2), "utf8");
  } catch (e) {
    log.warn(`youtube-channels.json 쓰기 실패: ${(e as Error).message}`);
  }
}

function cacheKey(query: string): string {
  return query.trim().toLowerCase();
}

async function fetchText(url: string, timeoutMs = 10_000): Promise<string | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" },
    });
    if (r.status !== 200) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** @handle → 채널 페이지, 없으면 이름으로 채널 검색(sp=EgIQAg → 채널 필터). channelId 반환. */
async function resolveUncached(query: string): Promise<string | null> {
  const handle = extractHandle(query);
  if (handle) {
    const html = await fetchText(`https://www.youtube.com/${handle}`);
    const id = html ? extractChannelId(html) : null;
    if (id) return id;
  }
  const name = cleanChannelName(query) || query.trim();
  if (!name) return null;
  const html = await fetchText(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(name)}&sp=EgIQAg%3D%3D`
  );
  return html ? extractChannelId(html) : null;
}

/** 채널 문자열(이름/@핸들) → channelId(UC…). 캐시 우선, 실패는 음성 캐시(TTL) 후 재시도. */
export async function resolveChannelId(query: string): Promise<string | null> {
  const key = cacheKey(query);
  if (!key) return null;
  const cache = readCache();
  const hit = cache[key];
  if (hit) {
    if (hit.channelId) return hit.channelId;
    const age = Date.now() - new Date(hit.resolvedAt).getTime();
    if (Number.isFinite(age) && age < NEG_TTL_MS) return null; // 최근 실패 → 재시도 보류
  }
  const id = await resolveUncached(query);
  cache[key] = { channelId: id, resolvedAt: new Date().toISOString() };
  writeCache(cache);
  return id;
}

/** channelId 의 RSS 최근 업로드(최신 15개). 실패 시 빈 배열. */
export async function fetchChannelUploads(channelId: string): Promise<RssVideo[]> {
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!xml) return [];
  return parseRssEntries(xml);
}

/**
 * 채널 문자열 목록 → 각 채널 RSS 최근 업로드 중 [cutoff, today] 안의 영상만(videoId 중복 제거).
 * 채널 해석/조회 실패는 조용히 스킵(부분 성공). 유튜브에 대한 매너로 동시성을 제한한다.
 */
export async function harvestFreshUploads(
  channelQueries: string[],
  cutoff: string,
  today: string
): Promise<RssVideo[]> {
  const uniq = Array.from(new Set(channelQueries.map((s) => s.trim()).filter(Boolean)));
  const seen = new Set<string>();
  const out: RssVideo[] = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < uniq.length; i += CONCURRENCY) {
    const batch = uniq.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (q): Promise<RssVideo[]> => {
        const id = await resolveChannelId(q);
        if (!id) return [];
        const ups = await fetchChannelUploads(id);
        return ups.filter((v) => inWindow(v.date, cutoff, today));
      })
    );
    for (const vids of results) {
      for (const v of vids) {
        if (seen.has(v.videoId)) continue;
        seen.add(v.videoId);
        out.push(v);
      }
    }
  }
  return out;
}
