/**
 * 운영 의존성: price 의 실제 설정·스킵 상태·큐레이션 파이프라인에 연결한다.
 *
 * ⚠️ 이 모듈은 반드시 `DB_PATH` 를 **실행별 상태 사본**으로 바꾼 뒤에 import 해야 한다(cli.ts).
 * config.ts 가 import 시점에 data 경로를 확정하고, 카테고리·차단·제외·본영상·채널 캐시 모듈이
 * 그 경로를 읽고(채널 캐시는 쓰기도) 하기 때문이다. 원본 price/data 는 읽기만 한다(복사 원본).
 */
import { curateNews } from "../news/curate.ts";
import { loadCategories as loadNewsCategories } from "../news/categories.ts";
import { fetchGeekNews } from "../news/geeknews.ts";
import { curateYoutube, stripBlockedRecommended } from "../youtube/curate.ts";
import { loadCategories as loadYoutubeCategories } from "../youtube/categories.ts";
import { buildBlockMatcher, loadBlocklist } from "../youtube/blocklist.ts";
import { buildWatchedMatcher } from "../youtube/watched.ts";
import { buildDismissMatcher } from "../youtube/dismissed.ts";
import { fetchChannelUploadsDetailed, inWindow, resolveChannelId, type RssVideo } from "../youtube/channels.ts";
import { filterOutShorts } from "../youtube/oembed.ts";
import { getTabSettings } from "../settings/tab-settings.ts";
import { runAgentQueryText } from "../util/agent-query.ts";
import { withQueryTrace } from "../util/agent-trace.ts";
import { localDate } from "../util/date.ts";
import type { PipelineDeps, RawData, SharedSeedVideo, SourceStatus } from "./pipeline.ts";

/** 편집기 예산: 도구 없는 1턴이지만 항목이 많으면 출력이 길다. */
const EDITOR_TIMEOUT_MS = 10 * 60_000;

function toRss(v: SharedSeedVideo): RssVideo {
  return { videoId: v.videoId, title: v.title, channel: v.channel, channelId: null, date: v.date, description: v.description };
}

async function collectRaw(ctx: Parameters<PipelineDeps["collectRaw"]>[0]): Promise<RawData> {
  const now = ctx.now;
  const sources: SourceStatus[] = [];

  // GeekNews: 출처의 마지막 성공 시점과 24시간 전 중 더 이른 시점부터(실패 구간을 건너뛰지 않는다).
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000);
  const gnOk = ctx.checkpoint.sources.geeknews?.okAt;
  const gnSince = gnOk && Date.parse(gnOk) < dayAgo.getTime() ? new Date(gnOk) : dayAgo;
  const feed = await fetchGeekNews(gnSince, now);
  sources.push({
    id: "geeknews",
    label: "GeekNews 공식 피드(https://news.hada.io/rss/news)",
    ok: feed.ok,
    count: feed.entries.length,
    since: gnSince.toISOString(),
    until: now.toISOString(),
    ...(feed.error ? { error: feed.error } : {}),
  });

  // 유튜브 추천 채널 RSS: price 유튜브 탭과 같은 신선도 창 + 스킵 규칙(차단·본영상·제외·Shorts).
  const freshDays = getTabSettings().youtube.freshDays;
  const today = localDate(now);
  const defaultCutoff = localDate(new Date(now.getTime() - freshDays * 86_400_000));
  const defs = stripBlockedRecommended(loadYoutubeCategories(), loadBlocklist());
  const isBlocked = buildBlockMatcher();
  const isWatched = buildWatchedMatcher();
  const isDismissed = buildDismissMatcher();
  const seeds = new Map<string, SharedSeedVideo[]>();
  const fetched = new Map<string, { ok: boolean; videos: RssVideo[]; error?: string }>();
  const queries = [...new Set(defs.flatMap((d) => (d.recommendedChannels ?? []).map((q) => q.trim()).filter(Boolean)))];
  for (let i = 0; i < queries.length; i += 4) {
    await Promise.all(
      queries.slice(i, i + 4).map(async (q) => {
        const id = await resolveChannelId(q);
        if (!id) {
          fetched.set(q, { ok: false, videos: [], error: "채널 ID 확인 실패" });
          return;
        }
        const r = await fetchChannelUploadsDetailed(id);
        fetched.set(q, r.ok ? r : { ...r, error: "RSS 응답 없음" });
      })
    );
  }
  for (const q of queries) {
    const r = fetched.get(q)!;
    const srcId = `youtube:${q.toLowerCase()}`;
    const okAt = ctx.checkpoint.sources[srcId]?.okAt;
    // 이 채널이 지난번에 실패했으면 마지막 성공 시점부터 다시 본다(신선도 창보다 이를 때만).
    const cutoff = okAt && localDate(new Date(okAt)) < defaultCutoff ? localDate(new Date(okAt)) : defaultCutoff;
    const inWin = r.videos.filter((v) => inWindow(v.date, cutoff, today));
    sources.push({
      id: srcId,
      label: `유튜브 추천 채널 RSS: ${q}`,
      ok: r.ok,
      count: inWin.length,
      since: new Date(`${cutoff}T00:00:00+09:00`).toISOString(),
      until: now.toISOString(),
      ...(r.error ? { error: r.error } : {}),
    });
  }
  for (const d of defs) {
    const list: SharedSeedVideo[] = [];
    for (const q of d.recommendedChannels ?? []) {
      const r = fetched.get(q.trim());
      if (!r?.ok) continue;
      for (const v of r.videos) {
        if (!inWindow(v.date, defaultCutoff, today)) continue;
        if (isBlocked(v.channel, null, d.key) || isWatched(v.videoId) || isDismissed(v.videoId)) continue;
        if (list.some((x) => x.videoId === v.videoId)) continue;
        list.push({ videoId: v.videoId, title: v.title, channel: v.channel, date: v.date, categoryKey: d.key, description: v.description });
      }
    }
    seeds.set(d.key, await filterOutShorts(list));
  }
  return {
    geekNews: {
      ok: feed.ok,
      entries: feed.entries,
      error: feed.error,
      since: gnSince.toISOString(),
      until: now.toISOString(),
    },
    seeds,
    sources,
  };
}

export const defaultDeps: PipelineDeps = {
  now: () => new Date(),
  categories: () => ({
    news: loadNewsCategories().map((c) => ({ key: c.key, label: `${c.emoji} ${c.label}`, name: c.label, emoji: c.emoji, color: c.color })),
    youtube: loadYoutubeCategories().map((c) => ({ key: c.key, label: `${c.emoji} ${c.label}`, name: c.label, emoji: c.emoji, color: c.color })),
    freshDays: getTabSettings().youtube.freshDays,
  }),
  collectRaw,
  collectNews: (spec, raw) =>
    curateNews(localDate(), {
      model: spec.model,
      strict: true,
      // 공용 원자료: 피드를 못 받았으면 null → 각 모델이 예전 방식(페이지 직접 확인)으로 조사
      geekNews: raw.geekNews.ok ? raw.geekNews.entries : null,
    }),
  collectYoutube: (spec, raw) =>
    curateYoutube(localDate(), {
      model: spec.model,
      strict: true,
      sharedSeeds: new Map([...raw.seeds].map(([k, v]) => [k, v.map(toRss)])),
      seedFallback: false,
    }),
  runEditor: (spec, prompt) =>
    runAgentQueryText(
      prompt,
      {
        tools: [],
        allowedTools: [],
        permissionMode: "bypassPermissions",
        settingSources: [],
        maxTurns: 1,
        model: spec.model,
        systemPrompt:
          "너는 IT 뉴스·유튜브 일일 보고서의 편집자다. 주어진 항목만 근거로 중복을 묶고 대표를 고르며, 지정된 JSON 한 개만 출력한다.",
      },
      EDITOR_TIMEOUT_MS,
      `보고서 편집(${spec.model})`,
      { strictModel: true }
    ),
  trace: (sink, fn) => withQueryTrace(sink, fn),
  log: (msg) => console.error(`[daily-report ${new Date().toISOString()}] ${msg}`),
};
