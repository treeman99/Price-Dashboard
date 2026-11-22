/**
 * 일일 보고서 — price 가 읽어 가는 구조화 결과(순수 함수만).
 *
 * 1) 탭 스냅샷(`tabs/news.json`·`tabs/youtube.json`): 세 모델 통합 결과 **전체**(증분 아님)를 price 뉴스·유튜브
 *    탭과 같은 형식으로 만든다. price 는 이 파일을 기존 스냅샷 보호 규칙(빈 결과면 직전 유지)으로 저장한다.
 *    항목은 대표 모델의 원본 항목을 그대로 쓰고(필드 손실 없음), 보조 출처와 찾은 모델만 덧붙인다.
 * 2) 보고서(`report.json`): 화면·메일·문자용. report.md 와 같은 내용(증분 — 직전 보고 이후 새 항목)을 구조로 남긴다.
 */
import type {
  NewsCategory,
  NewsItem,
  NewsSnapshot,
  YoutubeCategory,
  YoutubeSnapshot,
  YoutubeVideo,
} from "../../shared/types.ts";
import type { DailyReportEntry, DailyReportJson, DailyReportSection } from "../../shared/report.ts";
import type { ReportGroup, ReportKind } from "./merge.ts";
import { MODEL_SHORT } from "./models.ts";
import type { RenderInput } from "./render.ts";

export interface CategoryMeta {
  key: string;
  label: string;
  emoji: string;
  color: string;
}

/** 대표 항목 id → 모델이 낸 원본 항목. */
export type OriginalItems = Map<string, NewsItem | YoutubeVideo>;

const FALLBACK_COLOR = "#6b7280";
/** 뉴스 관련 출처 상한(화면 한 줄에 들어가는 정도). 원본 related 를 먼저 둔다. */
const RELATED_MAX = 4;

function foundBy(g: ReportGroup): string[] {
  return g.models.map((m) => MODEL_SHORT[m] ?? m);
}

/** 카테고리 안 순서: 여러 모델이 찾은 것 → 최신 → 원래 순서. */
function orderGroups(groups: ReportGroup[]): ReportGroup[] {
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => b.g.models.length - a.g.models.length || b.g.rep.date.localeCompare(a.g.rep.date) || a.i - b.i)
    .map((x) => x.g);
}

function byCategory(groups: ReportGroup[], kind: ReportKind): Map<string, ReportGroup[]> {
  const out = new Map<string, ReportGroup[]>();
  for (const g of groups) {
    if (g.rep.kind !== kind) continue;
    const arr = out.get(g.rep.categoryKey) ?? [];
    arr.push(g);
    out.set(g.rep.categoryKey, arr);
  }
  return out;
}

/** 정의된 카테고리 순서대로, 정의에 없는 키(삭제된 카테고리 등)는 뒤에 붙인다. */
function categoryOrder(defs: CategoryMeta[], present: Iterable<string>): CategoryMeta[] {
  const out = [...defs];
  for (const k of present) if (!out.some((c) => c.key === k)) out.push({ key: k, label: k, emoji: "", color: FALLBACK_COLOR });
  return out;
}

function newsItemOf(g: ReportGroup, originals: OriginalItems): NewsItem {
  const orig = originals.get(g.rep.id) as NewsItem | undefined;
  const base: NewsItem = orig
    ? { ...orig }
    : {
        title: g.rep.title,
        source: g.rep.source,
        date: g.rep.date,
        summary: g.rep.summary,
        link: g.rep.url,
        related: g.rep.related ?? [],
      };
  const seen = new Set<string>([base.link ?? ""]);
  const related: NewsItem["related"] = [];
  for (const r of [...(base.related ?? []), ...g.secondary]) {
    if (!r?.link || seen.has(r.link)) continue;
    seen.add(r.link);
    related.push({ label: r.label, link: r.link });
  }
  return { ...base, related: related.slice(0, RELATED_MAX), foundBy: foundBy(g) };
}

function youtubeItemOf(g: ReportGroup, originals: OriginalItems): YoutubeVideo {
  const orig = originals.get(g.rep.id) as YoutubeVideo | undefined;
  const base: YoutubeVideo = orig
    ? { ...orig }
    : {
        title: g.rep.title,
        originalTitle: g.rep.originalTitle ?? null,
        channel: g.rep.source,
        date: g.rep.date,
        summary: g.rep.summary,
        url: g.rep.url ?? "",
        videoId: g.rep.videoId ?? null,
        thumbnail: g.rep.videoId ? `https://i.ytimg.com/vi/${g.rep.videoId}/hqdefault.jpg` : null,
      };
  // 읽기 시점 주석·사용자 배치는 스냅샷에 싣지 않는다(price 가 읽을 때 다시 붙인다).
  delete base.watched;
  delete base.movedByUser;
  return { ...base, foundBy: foundBy(g) };
}

/**
 * 세 모델 통합 결과 전체 → price 탭 스냅샷 두 개. 성공 모델이 없으면 호출하지 않는다.
 * 카테고리는 탭 정의 순서를 따르고, 항목이 없는 카테고리도 빈 칸으로 남긴다(단일 모델 수집과 같은 모양).
 */
export function buildTabSnapshots(input: {
  now: Date;
  date: string;
  freshDays: number;
  groups: ReportGroup[];
  originals: OriginalItems;
  newsCategories: CategoryMeta[];
  youtubeCategories: CategoryMeta[];
  note: string | null;
}): { news: NewsSnapshot; youtube: YoutubeSnapshot } {
  const updatedAt = input.now.toISOString();
  const newsBy = byCategory(input.groups, "news");
  const ytBy = byCategory(input.groups, "youtube");
  const newsCats: NewsCategory[] = categoryOrder(input.newsCategories, newsBy.keys()).map((c) => ({
    key: c.key,
    label: c.label,
    emoji: c.emoji,
    color: c.color,
    items: orderGroups(newsBy.get(c.key) ?? []).map((g) => newsItemOf(g, input.originals)),
  }));
  const ytCats: YoutubeCategory[] = categoryOrder(input.youtubeCategories, ytBy.keys()).map((c) => ({
    key: c.key,
    label: c.label,
    emoji: c.emoji,
    color: c.color,
    items: orderGroups(ytBy.get(c.key) ?? []).map((g) => youtubeItemOf(g, input.originals)),
  }));
  return {
    news: { date: input.date, updatedAt, source: "llm", categories: newsCats, notes: input.note },
    youtube: {
      date: input.date,
      updatedAt,
      source: "llm",
      freshDays: input.freshDays,
      categories: ytCats,
      notes: input.note,
    },
  };
}

function entryOf(g: ReportGroup): DailyReportEntry {
  return {
    kind: g.rep.kind,
    categoryKey: g.rep.categoryKey,
    categoryLabel: g.rep.categoryLabel,
    title: g.rep.title,
    summary: g.rep.summary,
    source: g.rep.source,
    url: g.rep.url,
    date: g.rep.date,
    foundBy: foundBy(g),
    secondary: g.secondary.map((s) => ({ label: s.label, link: s.link })),
    conflict: g.conflict,
    update: !!g.update,
  };
}

function sections(groups: ReportGroup[], kind: ReportKind, cats: { key: string; label: string }[]): DailyReportSection[] {
  const by = byCategory(groups, kind);
  const order = new Map(cats.map((c, i) => [c.key, i]));
  return [...by.keys()]
    .sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99))
    .map((k) => {
      const gs = by.get(k)!;
      return { key: k, label: gs[0].rep.categoryLabel, items: gs.map(entryOf) };
    });
}

/** report.md 와 같은 내용을 구조로. 입력은 renderReport 와 같다. */
export function buildReportJson(
  r: RenderInput & { trigger: string; startedAt: string; finishedAt: string }
): DailyReportJson {
  const succeeded = r.models.filter((m) => m.outcome === "success");
  const ok = succeeded.length > 0;
  const highlights = !ok || !r.groups.length
    ? []
    : r.editor.highlights.length
      ? r.editor.highlights
      : r.groups.slice(0, 5).map((g) => g.rep.title);
  const gapStart = r.lastSuccessAt && r.now.getTime() - Date.parse(r.lastSuccessAt) > 24 * 3_600_000 ? r.lastSuccessAt : null;
  const gn = r.raw.geekNews;
  const ytLabel = new Map(r.categories.youtube.map((c) => [c.key, c.label]));
  return {
    version: 1,
    runId: r.runId,
    trigger: r.trigger,
    preview: r.preview,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    ok,
    successCount: succeeded.length,
    modelCount: r.models.length,
    models: r.models.map((m) => ({
      key: m.spec.key,
      label: m.spec.label,
      model: m.spec.model,
      actualModels: m.actualModels,
      outcome: m.outcome,
      reason: m.reason.slice(0, 600),
      newsCount: m.newsCount,
      youtubeCount: m.youtubeCount,
      toolCalls: m.toolCalls,
    })),
    editor: {
      label: r.editor.spec?.label ?? null,
      model: r.editor.spec?.model ?? null,
      ok: r.editor.ok,
      note: r.editor.note,
    },
    highlights,
    counts: r.counts,
    coverage: {
      lastSuccessAt: r.lastSuccessAt,
      freshDays: r.freshDays,
      gap: gapStart ? { from: gapStart, to: new Date(r.now.getTime() - 24 * 3_600_000).toISOString() } : null,
      geekNews: { ok: gn.ok, count: gn.entries.length, since: gn.since, until: gn.until, error: gn.error },
    },
    news: ok ? sections(r.groups, "news", r.categories.news) : [],
    youtube: ok ? sections(r.groups, "youtube", r.categories.youtube) : [],
    seedsOnly: ok
      ? r.seedsOnly.map((v) => ({
          title: v.title,
          channel: v.channel,
          date: v.date,
          url: `https://www.youtube.com/watch?v=${v.videoId}`,
          categoryLabel: ytLabel.get(v.categoryKey) ?? v.categoryKey,
        }))
      : [],
    sourceFailures: r.raw.sources.filter((s) => !s.ok).map((s) => ({ label: s.label, error: s.error ?? "응답 없음" })),
  };
}
