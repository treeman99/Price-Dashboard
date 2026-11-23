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
import { fetchChannelUploadsDetailed, resolveChannelId, type RssVideo } from "../youtube/channels.ts";
import { filterOutShorts } from "../youtube/oembed.ts";
import { getTabSettings } from "../settings/tab-settings.ts";
import { runAgentQueryText } from "../util/agent-query.ts";
import { withQueryTrace } from "../util/agent-trace.ts";
import { localDate } from "../util/date.ts";
import { checkRecency } from "../util/recency.ts";
import { buildDomainMatcher } from "../news/excluded.ts";
import { loadNewsReclass } from "../news/reclass.ts";
import { loadReclass } from "../youtube/reclass.ts";
import type { PipelineDeps, RawData, SharedSeedVideo, SourceStatus } from "./pipeline.ts";

/** 편집기 예산: 도구 없는 1턴이지만 항목이 많으면 출력이 길다. */
const EDITOR_TIMEOUT_MS = 10 * 60_000;

function toRss(v: SharedSeedVideo): RssVideo {
  return {
    videoId: v.videoId,
    title: v.title,
    channel: v.channel,
    channelId: null,
    date: v.date,
    publishedAt: v.publishedAt ?? null,
    description: v.description,
  };
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

  // 유튜브 추천 채널 RSS: 조사 구간(실행 시점 기준 최근 N시간 — 게시 시각 단위) + 스킵 규칙(차단·본영상·제외·Shorts).
  const ytWindow = ctx.windows.youtube;
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
    // 조사 기간은 실행 시점 기준 최근 N시간으로 고정한다(2026-11-23 "24시간 이내로만") — 예전처럼 실패한 채널의
    // 마지막 성공 시점까지 거슬러 올라가지 않는다(그 구간은 보고서의 '범위 공백'으로 남는다).
    const inWin = r.videos.filter((v) => checkRecency(v, ytWindow).ok);
    sources.push({
      id: srcId,
      label: `유튜브 추천 채널 RSS: ${q}`,
      ok: r.ok,
      count: inWin.length,
      since: ytWindow.start.toISOString(),
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
        if (!checkRecency(v, ytWindow).ok) continue;
        if (isBlocked(v.channel, null, d.key) || isWatched(v.videoId) || isDismissed(v.videoId)) continue;
        if (list.some((x) => x.videoId === v.videoId)) continue;
        list.push({
          videoId: v.videoId,
          title: v.title,
          channel: v.channel,
          date: v.date,
          publishedAt: v.publishedAt ?? null,
          categoryKey: d.key,
          description: v.description,
        });
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
    freshHours: getTabSettings().youtube.freshHours,
  }),
  collectRaw,
  collectNews: (spec, raw, windows) =>
    curateNews(localDate(windows.news.end), {
      model: spec.model,
      strict: true,
      window: windows.news,
      // 공용 원자료: 피드를 못 받았으면 null → 각 모델이 예전 방식(페이지 직접 확인)으로 조사.
      // 피드는 출처별 마지막 성공부터 받아 두지만(raw 기록), 모델에는 조사 구간(최근 24시간 — 등록 시각) 안 글만 준다.
      geekNews: raw.geekNews.ok
        ? raw.geekNews.entries.filter((e) => checkRecency({ publishedAt: e.publishedAt }, windows.news).ok)
        : null,
    }),
  collectYoutube: (spec, raw, windows) =>
    curateYoutube(localDate(windows.youtube.end), {
      model: spec.model,
      strict: true,
      window: windows.youtube,
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
  // 사용자 취합 제외(보고서 탭에서 만든 기록) — 통합 단계에서 다시 거른다. 사본(state/)을 읽는다.
  exclusions: () => {
    const newsUrl = buildDomainMatcher();
    const blocked = buildBlockMatcher();
    const dismissed = buildDismissMatcher();
    return {
      newsUrl,
      youtubeChannel: (channel, handle, categoryKey) => blocked(channel, handle, categoryKey),
      youtubeVideo: (videoId) => !!videoId && dismissed(videoId),
    };
  },
  // 사용자 카테고리 이동 기록(재분류 학습) — 통합 단계의 결정론적 적용과 편집기 교정에 쓴다.
  categoryMoves: () => ({ news: loadNewsReclass(), youtube: loadReclass() }),
  trace: (sink, fn) => withQueryTrace(sink, fn),
  log: (msg) => console.error(`[daily-report ${new Date().toISOString()}] ${msg}`),
};
