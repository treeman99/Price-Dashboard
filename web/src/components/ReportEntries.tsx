import { useState } from "react";
import { Ban, Check, Eye, EyeOff, Globe, Link as LinkIcon, Loader2, Star, X } from "lucide-react";
import type { CategoryDef } from "@shared/types";
import type { DailyReportEntryView, DailyReportSectionView } from "@shared/report";
import { safeHref } from "@shared/url";
import { api } from "@/lib/api";
import { isHiddenEntry } from "@/lib/feed";
import { NewTag } from "@/components/NewTag";
import { EmptyLine, IconAction, SectionHeader, StatusTag, SubHeader, TextLink } from "@/components/ui/page";
import { cn } from "@/lib/utils";

/**
 * 보고서 본문의 항목 목록 + 항목별 사용자 동작(2026-11-23 뉴스·유튜브 탭을 없애며 여기로 옮겼다).
 *
 * - 공통: 카테고리 이동(화면 즉시 반영 + 다음 실행 분류 학습).
 * - 뉴스: 이 사이트 취합 제외(세 모델 프롬프트·통합 단계에서 제외).
 * - 영상: 영상 보기(누르면 본영상 체크) · 본영상 토글 · 영상 제외 · 채널 차단(이 카테고리/전체) · 추천 채널 추가/해제.
 *   기존 저장 파일(youtube-watched/dismissed/blocklist/categories.json)을 그대로 쓴다.
 * 제외·차단·제외 사이트 항목은 기본으로 숨기고, 위의 '숨긴 항목 보기'로 펼친다.
 */

export interface EntryActionsContext {
  runId: string;
  newsDefs: CategoryDef[];
  youtubeDefs: CategoryDef[];
  isNew: (key: string) => boolean;
  /** 동작 뒤 보고서 보기를 다시 읽는다(서버가 상태를 다시 계산한다). */
  reload: () => Promise<void>;
  /** 이동 응답으로 받은 보기를 바로 반영한다. */
  onMoved: (report: import("@shared/report").DailyReportRunView) => void;
  onError: (msg: string) => void;
}

function thumb(videoId: string | null | undefined): string | null {
  return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null;
}

function EntryRow({ e, ctx }: { e: DailyReportEntryView; ctx: EntryActionsContext }) {
  const [busy, setBusy] = useState<string | null>(null);
  const href = safeHref(e.url);
  const isVideo = e.kind === "youtube";
  const defs = isVideo ? ctx.youtubeDefs : ctx.newsDefs;
  const hidden = isHiddenEntry(e);

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    try {
      await fn();
      await ctx.reload();
    } catch (err) {
      ctx.onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function move(toKey: string) {
    if (!toKey || toKey === e.categoryKey) return;
    setBusy("move");
    try {
      const r = await api.moveReportEntry(ctx.runId, e.key, toKey);
      ctx.onMoved(r.report);
    } catch (err) {
      ctx.onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const videoId = e.videoId ?? null;
  const markWatched = () => (videoId ? api.markYoutubeWatched({ videoId, title: e.title, channel: e.source }) : Promise.resolve());
  const thumbSrc = isVideo ? thumb(videoId) : null;

  return (
    <li className={cn("flex gap-3 py-3", (hidden || e.state.watched) && "opacity-60")}>
      {thumbSrc && (
        <a
          href={href ?? undefined}
          target="_blank"
          rel="noreferrer"
          onClick={() => void markWatched().then(ctx.reload, () => {})}
          className="hidden w-32 shrink-0 self-start overflow-hidden rounded-[3px] bg-muted sm:block"
          tabIndex={-1}
          aria-hidden
        >
          <img src={thumbSrc} alt="" loading="lazy" className="aspect-[4/3] w-full object-cover" />
        </a>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold leading-snug">
          {ctx.isNew(e.key) && !e.state.watched && <NewTag />}
          {e.update && (
            <StatusTag tone="info" className="mr-1.5">
              새 출처
            </StatusTag>
          )}
          {e.state.watched && (
            <StatusTag tone="neutral" className="mr-1.5">
              본영상
            </StatusTag>
          )}
          {e.state.dismissed && (
            <StatusTag tone="warn" className="mr-1.5">
              제외한 영상
            </StatusTag>
          )}
          {e.state.blocked && (
            <StatusTag tone="warn" className="mr-1.5">
              차단한 채널
            </StatusTag>
          )}
          {e.state.excluded && (
            <StatusTag tone="warn" className="mr-1.5">
              제외한 사이트
            </StatusTag>
          )}
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
              onClick={isVideo ? () => void markWatched().then(ctx.reload, () => {}) : undefined}
            >
              {e.title}
            </a>
          ) : (
            e.title
          )}
        </p>
        <p className="num mt-1 text-[12.5px] text-muted-foreground">
          {e.source} · {isVideo ? `업로드 ${e.date}` : e.date} · 찾은 모델 {e.foundBy.join(", ")}
          {e.movedFrom && <> · 옮김({defs.find((d) => d.key === e.movedFrom)?.label ?? e.movedFrom} → 여기)</>}
        </p>
        <p className="mt-1.5 text-[14px] leading-relaxed text-foreground/85">{e.summary}</p>
        {e.secondary.length > 0 && (
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
            보조 출처:
            {e.secondary.slice(0, 6).map((s) => {
              const h = safeHref(s.link);
              return h ? (
                <TextLink key={s.link} href={h} target="_blank" rel="noreferrer">
                  {s.label}
                </TextLink>
              ) : (
                <span key={s.link}>{s.label}</span>
              );
            })}
          </p>
        )}
        {e.conflict && <p className="mt-1.5 text-[12.5px] text-tone-warn">⚠️ 근거 차이: {e.conflict}</p>}

        {/* 동작 줄 */}
        <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">
          {href && !isVideo && (
            <TextLink href={href} target="_blank" rel="noreferrer" icon={<LinkIcon />}>
              원문 보기
            </TextLink>
          )}
          <label className="ml-1 inline-flex items-center gap-1 text-[12.5px] text-muted-foreground">
            <span className="sr-only">카테고리 이동</span>
            <select
              className="h-7 rounded-md border border-foreground/15 bg-background px-1.5 text-[12.5px] text-foreground"
              value={e.categoryKey}
              disabled={busy === "move"}
              title="다른 카테고리로 옮기면 다음 실행부터 세 모델이 비슷한 항목을 그 카테고리로 분류합니다"
              onChange={(ev) => void move(ev.target.value)}
            >
              {defs.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.key === e.categoryKey ? `카테고리: ${d.emoji} ${d.label}` : `→ ${d.emoji} ${d.label}`}
                </option>
              ))}
            </select>
            {busy === "move" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          </label>

          {!isVideo && href && !e.state.excluded && (
            <IconAction
              label="이 사이트는 앞으로 취합에서 제외"
              danger
              disabled={!!busy}
              onClick={() => {
                if (!confirm(`'${e.source}' 사이트(${new URL(href).hostname})의 기사를 앞으로 취합에서 제외할까요?\n(보고서 탭 '수집 설정 → 제외 사이트'에서 해제할 수 있습니다)`)) return;
                void act("exclude", () => api.excludeNewsDomain({ url: href, label: e.source }));
              }}
            >
              <Globe />
            </IconAction>
          )}

          {isVideo && videoId && (
            <>
              <IconAction
                label={e.state.watched ? "본영상 해제" : "본영상으로 체크(일정 기간 수집에서 제외)"}
                active={e.state.watched}
                disabled={!!busy}
                onClick={() =>
                  void act("watched", () => (e.state.watched ? api.unmarkYoutubeWatched(videoId) : markWatched()))
                }
              >
                {e.state.watched ? <EyeOff /> : <Eye />}
              </IconAction>
              {!e.state.dismissed && (
                <IconAction
                  label="이 영상 제외(앞으로 수집하지 않음)"
                  danger
                  disabled={!!busy}
                  onClick={() =>
                    void act("dismiss", () =>
                      api.dismissYoutubeVideo({ videoId, title: e.title, channel: e.source, url: e.url, categoryKey: e.categoryKey })
                    )
                  }
                >
                  <X />
                </IconAction>
              )}
              <IconAction
                label={e.state.recommended ? "이 카테고리 추천 채널에서 해제" : "이 카테고리의 추천 채널로 추가(먼저 확인)"}
                active={e.state.recommended}
                disabled={!!busy}
                onClick={() =>
                  void act("recommend", () =>
                    e.state.recommended
                      ? api.removeYoutubeRecommendedChannel(e.categoryKey, { channel: e.source, handle: e.channelHandle ?? null })
                      : api.addYoutubeRecommendedChannel(e.categoryKey, { channel: e.source, handle: e.channelHandle ?? null })
                  )
                }
              >
                {e.state.recommended ? <Check /> : <Star />}
              </IconAction>
              {!e.state.blocked && (
                <label className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground">
                  <Ban className="h-3.5 w-3.5" aria-hidden />
                  <span className="sr-only">채널 차단</span>
                  <select
                    className="h-7 rounded-md border border-foreground/15 bg-background px-1.5 text-[12.5px] text-foreground"
                    value=""
                    disabled={!!busy}
                    onChange={(ev) => {
                      const scope = ev.target.value;
                      if (!scope) return;
                      const where = scope === "all" ? "모든 카테고리" : `'${defs.find((d) => d.key === e.categoryKey)?.label ?? e.categoryKey}' 카테고리`;
                      if (!confirm(`'${e.source}' 채널을 ${where}에서 차단할까요?\n(수집 설정 → 차단 채널에서 해제할 수 있습니다)`)) return;
                      void act("block", () =>
                        api.blockYoutubeChannel({
                          channel: e.source,
                          handle: e.channelHandle ?? null,
                          categoryKey: scope === "all" ? null : e.categoryKey,
                        })
                      );
                    }}
                  >
                    <option value="">채널 차단…</option>
                    <option value="cat">이 카테고리에서</option>
                    <option value="all">모든 카테고리에서</option>
                  </select>
                </label>
              )}
            </>
          )}
          {busy && busy !== "move" && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
      </div>
    </li>
  );
}

/** 한 종류(뉴스·유튜브)의 카테고리 섹션들. 숨긴 항목은 showHidden 일 때만 그린다. */
export function ReportSections({
  title,
  sections,
  showHidden,
  ctx,
}: {
  title: string;
  sections: DailyReportSectionView[];
  showHidden: boolean;
  ctx: EntryActionsContext;
}) {
  const visible = sections
    .map((s) => ({ ...s, items: showHidden ? s.items : s.items.filter((e) => !isHiddenEntry(e)) }))
    .filter((s) => s.items.length);
  const total = visible.reduce((a, s) => a + s.items.length, 0);
  return (
    <section className="mt-8">
      <SectionHeader title={title} count={total} />
      {total === 0 ? (
        <EmptyLine>새 항목 없음</EmptyLine>
      ) : (
        visible.map((s) => (
          <div key={s.key} className="mt-3">
            <SubHeader count={s.items.length}>{s.label}</SubHeader>
            <ul className="divide-y">
              {s.items.map((e) => (
                <EntryRow key={e.key} e={e} ctx={ctx} />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
