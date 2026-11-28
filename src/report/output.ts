/**
 * 일일 보고서 — price 가 읽어 가는 구조화 결과(`report.json`, 순수 함수만).
 *
 * 화면('보고서' 탭)·메일·문자용. report.md 와 같은 내용(증분 — 직전 보고 이후 새 항목)을 구조로 남긴다.
 * (2026-11-23 뉴스·유튜브 탭을 없애면서 탭 스냅샷 출력(tabs/)은 걷어 냈다.)
 */
import type { DailyReportEntry, DailyReportJson, DailyReportSection } from "../../shared/report.ts";
import { canonicalUrl, youtubeId, type ReportGroup, type ReportKind } from "./merge.ts";
import { MODEL_SHORT } from "./models.ts";
import { toLocalIso } from "../util/recency.ts";
import type { RenderInput } from "./render.ts";

function foundBy(g: ReportGroup): string[] {
  return g.models.map((m) => MODEL_SHORT[m] ?? m);
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

/**
 * 보고서 항목의 안정 키 — price 가 사용자 동작(카테고리 이동 등)을 항목에 묶을 때 쓴다.
 * 영상은 `yt:<영상 ID>`, 기사는 정규화 URL, 링크가 없으면 제목.
 */
export function reportEntryKey(kind: ReportKind, url: string | null | undefined, title: string, videoId?: string | null): string {
  if (kind === "youtube") {
    const id = videoId || youtubeId(url);
    if (id) return `yt:${id}`;
  }
  return canonicalUrl(url) ?? `t:${title.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

function entryOf(g: ReportGroup): DailyReportEntry {
  const videoId = g.rep.kind === "youtube" ? (g.rep.videoId ?? youtubeId(g.rep.url)) : null;
  return {
    key: reportEntryKey(g.rep.kind, g.rep.url, g.rep.title, videoId),
    ...(g.rep.kind === "youtube" ? { videoId, channelHandle: g.rep.channelHandle ?? null } : {}),
    kind: g.rep.kind,
    categoryKey: g.rep.categoryKey,
    categoryLabel: g.rep.categoryLabel,
    title: g.rep.title,
    summary: g.rep.summary,
    source: g.rep.source,
    url: g.rep.url,
    ...(g.rep.sourceDomain ? { sourceDomain: g.rep.sourceDomain } : {}),
    date: g.rep.date,
    publishedAt: g.rep.publishedAt ?? null,
    ...(g.rep.timeApprox ? { timeApprox: true } : {}),
    foundBy: foundBy(g),
    secondary: g.secondary.map((s) => ({ label: s.label, link: s.link, ...(s.domain ? { domain: s.domain } : {}) })),
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
      freshHours: r.freshHours,
      ...(r.windows
        ? {
            windows: {
              news: { from: toLocalIso(r.windows.news.start), to: toLocalIso(r.windows.news.end), hours: r.windows.news.hours },
              youtube: { from: toLocalIso(r.windows.youtube.start), to: toLocalIso(r.windows.youtube.end), hours: r.windows.youtube.hours },
            },
          }
        : {}),
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
