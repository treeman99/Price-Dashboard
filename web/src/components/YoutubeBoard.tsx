import { useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  Loader2,
  Youtube,
  PlayCircle,
  CalendarDays,
  Eye,
  Ban,
  X,
  Pencil,
  Plus,
  ChevronUp,
  ChevronDown,
  FolderInput,
  CheckCircle2,
  Circle,
  Star,
  EyeOff,
} from "lucide-react";
import type { YoutubeSnapshot, YoutubeVideo, YoutubeCategoryDef } from "@shared/types";
import { safeHref } from "@shared/url";
import {
  UNKNOWN_CHANNEL,
  isRecommendedChannel,
  recommendedChannelValue,
  addRecommendedChannel,
  removeRecommendedChannel,
  autoWatchedNotice,
  shouldAutoMarkWatched,
} from "@shared/youtube";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { ScheduleControl } from "@/components/ScheduleControl";
import { CategoryDialog, type CategoryDialogState } from "@/components/CategoryDialog";
import { BlockedChannelsDialog } from "@/components/BlockedChannelsDialog";
import { DismissedVideosDialog } from "@/components/DismissedVideosDialog";

/** 프론트 낙관적 제거용 채널 동일성 판정(백엔드 buildBlockMatcher와 동일 규칙). */
function sameChannel(a: YoutubeVideo, b: YoutubeVideo): boolean {
  const norm = (s?: string | null) => (s ?? "").trim().toLowerCase();
  const normH = (s?: string | null) => norm(s).replace(/^@+/, "");
  const ah = normH(a.channelHandle);
  const bh = normH(b.channelHandle);
  if (ah && bh) return ah === bh;
  return norm(a.channel) === norm(b.channel);
}

/** 채널을 식별할 수 있어야(핸들 또는 미상 아닌 채널명) 채널 단위 제외가 가능하다. */
function canBlockChannel(v: YoutubeVideo): boolean {
  return !!(v.channelHandle && v.channelHandle.trim()) || (!!v.channel && v.channel !== UNKNOWN_CHANNEL);
}

function Thumbnail({ video, onOpen }: { video: YoutubeVideo; onOpen: () => void }) {
  const [errored, setErrored] = useState(false);
  const href = safeHref(video.url);
  const thumbSrc = safeHref(video.thumbnail);
  const inner = (
    <>
      {thumbSrc && !errored ? (
        <img
          src={thumbSrc}
          alt=""
          loading="lazy"
          onError={() => setErrored(true)}
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-muted to-muted-foreground/20">
          <Youtube className="h-10 w-10 text-muted-foreground/50" />
        </div>
      )}
      {/* 재생 오버레이 */}
      <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/20">
        <PlayCircle className="h-12 w-12 text-white/0 drop-shadow-lg transition-all group-hover:text-white/90" />
      </div>
      {video.duration && (
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 text-[11px] font-medium text-white">
          {video.duration}
        </span>
      )}
    </>
  );
  if (!href) {
    return (
      <div className="group relative block aspect-video w-full overflow-hidden rounded-md bg-muted">
        {inner}
      </div>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={onOpen}
      className="group relative block aspect-video w-full overflow-hidden rounded-md bg-muted"
      title="유튜브에서 보기 — 보고 돌아오면 자동으로 '본영상' 체크됩니다"
    >
      {inner}
    </a>
  );
}

function MoveMenu({
  video,
  currentKey,
  allDefs,
  disabled,
  onMove,
}: {
  video: YoutubeVideo;
  currentKey: string;
  allDefs: YoutubeCategoryDef[];
  disabled: boolean;
  onMove: (video: YoutubeVideo, fromKey: string, toKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const targets = allDefs.filter((d) => d.key !== currentKey);
  if (!targets.length) return null;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={disabled ? "수집 중에는 이동할 수 없습니다" : "다른 카테고리로 이동"}
        className="inline-flex items-center gap-1 text-muted-foreground/70 transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground/70"
      >
        <FolderInput className="h-3.5 w-3.5" /> 이동
      </button>
      {open && (
        <>
          {/* 바깥 클릭 시 닫기 */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 z-20 mb-1 max-h-60 w-52 overflow-y-auto rounded-md border bg-card p-1 shadow-lg">
            <p className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
              이동할 카테고리 선택
            </p>
            {targets.map((d) => (
              <button
                key={d.key}
                onClick={() => {
                  setOpen(false);
                  onMove(video, currentKey, d.key);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <span>{d.emoji}</span>
                <span className="truncate">{d.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function WatchedToggle({
  video,
  onToggleWatched,
}: {
  video: YoutubeVideo;
  onToggleWatched: (video: YoutubeVideo) => void;
}) {
  const watched = !!video.watched;
  return (
    <button
      onClick={() => onToggleWatched(video)}
      disabled={!video.videoId}
      title={
        watched
          ? "본영상 해제 — 다시 검색(수집)에 노출됩니다"
          : "본영상으로 체크 — 1주일간 검색(수집)에서 제외됩니다"
      }
      className={`absolute left-3.5 top-3.5 z-10 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium shadow-sm backdrop-blur transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        watched ? "bg-emerald-600 text-white" : "bg-black/55 text-white hover:bg-emerald-600"
      }`}
    >
      {watched ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
      {watched ? "본영상" : "본영상 체크"}
    </button>
  );
}

/**
 * 카드 우상단 '이 영상 제외' — 한 번 누르면 확인 없이 바로 사라진다(사유는 선택, 나중에 붙임).
 * 좌상단 '본영상 체크'(emerald·기간제)와 같은 오버레이 줄이지만 반대편·붉은색으로 두어,
 * "잠깐 숨김"과 "영구 제외"를 색과 위치로 구분한다.
 */
function DismissButton({
  video,
  onDismiss,
}: {
  video: YoutubeVideo;
  onDismiss: (video: YoutubeVideo) => void;
}) {
  return (
    <button
      onClick={() => onDismiss(video)}
      disabled={!video.videoId}
      title={
        video.videoId
          ? "이 영상 제외 — 만료 없이 영구히 숨기고, 다음 수집 때 비슷한 영상도 피합니다('제외 영상'에서 되돌릴 수 있어요)"
          : "영상 식별자가 없어 제외할 수 없습니다"
      }
      className="absolute right-3.5 top-3.5 z-10 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-1 text-[11px] font-medium text-white shadow-sm backdrop-blur transition-colors hover:bg-destructive disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-black/55"
    >
      <EyeOff className="h-3.5 w-3.5" />
      이 영상 제외
    </button>
  );
}

function VideoCard({
  video,
  color,
  currentKey,
  allDefs,
  moveDisabled,
  recommended,
  onToggleRecommend,
  onBlock,
  onMove,
  onToggleWatched,
  onDismiss,
  onOpenVideo,
}: {
  video: YoutubeVideo;
  color: string;
  currentKey: string;
  allDefs: YoutubeCategoryDef[];
  moveDisabled: boolean;
  /** 이 카드의 채널이 현재 카테고리 추천 채널에 등록되어 있는지 */
  recommended: boolean;
  onToggleRecommend: (video: YoutubeVideo) => void;
  onBlock: (video: YoutubeVideo, categoryKey: string) => void;
  onMove: (video: YoutubeVideo, fromKey: string, toKey: string) => void;
  onToggleWatched: (video: YoutubeVideo) => void;
  onDismiss: (video: YoutubeVideo) => void;
  /** 썸네일·'영상 보기'로 유튜브를 연 순간(복귀 시 자동 본영상 체크 대상 등록) */
  onOpenVideo: (video: YoutubeVideo) => void;
}) {
  const canRecommend = !!recommendedChannelValue(video.channel, video.channelHandle);
  const videoHref = safeHref(video.url);
  return (
    <Card
      className={`flex h-[30rem] flex-col overflow-hidden border-l-4 p-0 transition-opacity ${
        video.watched ? "opacity-75" : ""
      }`}
      style={{ borderLeftColor: color }}
    >
      {/* isolate: '본영상' 버튼(z-10)이 카드 밖으로 튀어나와 sticky 탭 헤더(z-10) 위에 겹치지
          않도록 독립 스태킹 컨텍스트를 만든다 → 버튼도 카드처럼 헤더 아래로 스크롤된다. */}
      <div className="relative isolate shrink-0 p-2 pb-0">
        <Thumbnail video={video} onOpen={() => onOpenVideo(video)} />
        <WatchedToggle video={video} onToggleWatched={onToggleWatched} />
        <DismissButton video={video} onDismiss={onDismiss} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-3 pt-2">
        {/* 제목 — 2줄 고정 */}
        <h4 className="line-clamp-2 min-h-[2.6em] font-semibold leading-snug" title={video.originalTitle ?? video.title}>
          {video.title}
        </h4>
        {/* 채널 / 날짜 / 조회수 */}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">
            {video.channel}
            {video.channelHandle ? ` · ${video.channelHandle}` : ""}
          </span>
          <span className="inline-flex items-center gap-1">
            <CalendarDays className="h-3 w-3" /> {video.date}
          </span>
          {video.views && (
            <span className="inline-flex items-center gap-1">
              <Eye className="h-3 w-3" /> {video.views}
            </span>
          )}
        </p>
        {/* 요약 — 남는 공간을 채우고, 길면 카드 내부에서 스크롤되어 전부 보임 */}
        <p className="mt-2 min-h-0 flex-1 overflow-y-auto whitespace-pre-line pr-1 text-sm leading-relaxed text-foreground/80">
          {video.summary}
        </p>
        {/* 액션 */}
        <div className="mt-3 flex items-center justify-between gap-2 border-t pt-2 text-xs">
          {videoHref ? (
            <a
              href={videoHref}
              target="_blank"
              rel="noreferrer"
              onClick={() => onOpenVideo(video)}
              title="유튜브에서 보기 — 보고 돌아오면 자동으로 '본영상' 체크됩니다"
              className="inline-flex items-center gap-1 font-medium text-[#ff0000] hover:underline"
            >
              <PlayCircle className="h-3.5 w-3.5" /> 영상 보기
            </a>
          ) : (
            <span className="inline-flex items-center gap-1 font-medium text-muted-foreground">
              <PlayCircle className="h-3.5 w-3.5" /> 영상 보기
            </span>
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={() => onToggleRecommend(video)}
              disabled={!canRecommend}
              title={
                !canRecommend
                  ? "채널 정보가 없어 추천 채널로 추가할 수 없습니다"
                  : recommended
                    ? `'${video.channel}' 채널을 추천 채널에서 해제`
                    : `'${video.channel}' 채널을 이 카테고리의 추천 채널로 추가 — 다음 수집부터 우선 확인합니다`
              }
              className={`inline-flex items-center gap-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                recommended
                  ? "font-medium text-amber-500 hover:text-amber-600"
                  : "text-muted-foreground/70 hover:text-amber-500"
              }`}
            >
              <Star className="h-3.5 w-3.5" fill={recommended ? "currentColor" : "none"} />
              {recommended ? "추천됨" : "추천"}
            </button>
            <MoveMenu
              video={video}
              currentKey={currentKey}
              allDefs={allDefs}
              disabled={moveDisabled}
              onMove={onMove}
            />
            <button
              onClick={() => onBlock(video, currentKey)}
              disabled={!canBlockChannel(video)}
              title={
                canBlockChannel(video)
                  ? `'${video.channel}' 채널을 이 카테고리 조사에서 제외`
                  : "채널 정보가 없어 제외할 수 없습니다"
              }
              className="inline-flex items-center gap-1 text-muted-foreground/70 transition-colors hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground/70"
            >
              <Ban className="h-3.5 w-3.5" /> 채널 제외
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Section({
  def,
  items,
  allDefs,
  canDelete,
  canUp,
  canDown,
  moveDisabled,
  onMove,
  onEdit,
  onDelete,
  onBlock,
  onMoveVideo,
  onToggleWatched,
  onToggleRecommend,
  onDismiss,
  onOpenVideo,
}: {
  def: YoutubeCategoryDef;
  items: YoutubeVideo[];
  allDefs: YoutubeCategoryDef[];
  canDelete: boolean;
  canUp: boolean;
  canDown: boolean;
  moveDisabled: boolean;
  onMove: (def: YoutubeCategoryDef, dir: "up" | "down") => void;
  onEdit: (def: YoutubeCategoryDef) => void;
  onDelete: (def: YoutubeCategoryDef) => void;
  onBlock: (video: YoutubeVideo, categoryKey: string) => void;
  onMoveVideo: (video: YoutubeVideo, fromKey: string, toKey: string) => void;
  onToggleWatched: (video: YoutubeVideo) => void;
  onToggleRecommend: (video: YoutubeVideo, categoryKey: string) => void;
  onDismiss: (video: YoutubeVideo, categoryKey: string) => void;
  onOpenVideo: (video: YoutubeVideo) => void;
}) {
  const ctrl =
    "rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30";
  // 카드는 항상 최신(업로드일 내림차순) 우선으로 표시한다. date 는 "YYYY-MM-DD"라 문자열 비교로 정렬 가능.
  const ordered = [...items].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-2 border-b pb-2" style={{ borderColor: def.color }}>
        <h2 className="flex items-center gap-2 text-lg font-bold" style={{ color: def.color }}>
          <span>{def.emoji}</span>
          {def.label}
          <span className="text-sm font-normal text-muted-foreground">({items.length})</span>
        </h2>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => onMove(def, "up")}
            disabled={!canUp}
            aria-label="위로"
            className={`${ctrl} group/tt relative`}
          >
            <ChevronUp className="h-4 w-4" />
            <Tip>위로</Tip>
          </button>
          <button
            onClick={() => onMove(def, "down")}
            disabled={!canDown}
            aria-label="아래로"
            className={`${ctrl} group/tt relative`}
          >
            <ChevronDown className="h-4 w-4" />
            <Tip>아래로</Tip>
          </button>
          <button
            onClick={() => onEdit(def)}
            aria-label="카테고리 수정"
            className={`${ctrl} group/tt relative`}
          >
            <Pencil className="h-4 w-4" />
            <Tip>카테고리 수정</Tip>
          </button>
          {canDelete && (
            <button
              onClick={() => onDelete(def)}
              aria-label="카테고리 삭제"
              className="group/tt relative rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-destructive"
            >
              <X className="h-4 w-4" />
              <Tip>카테고리 삭제</Tip>
            </button>
          )}
        </div>
      </div>
      {items.length ? (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
          {ordered.map((it, i) => (
            <VideoCard
              key={it.videoId ?? i}
              video={it}
              color={def.color}
              currentKey={def.key}
              allDefs={allDefs}
              moveDisabled={moveDisabled}
              recommended={isRecommendedChannel(def.recommendedChannels, it.channel, it.channelHandle)}
              onToggleRecommend={(v) => onToggleRecommend(v, def.key)}
              onBlock={onBlock}
              onMove={onMoveVideo}
              onToggleWatched={onToggleWatched}
              onDismiss={(v) => onDismiss(v, def.key)}
              onOpenVideo={onOpenVideo}
            />
          ))}
        </div>
      ) : (
        <p className="rounded-md bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          최근 새 영상이 없습니다.
        </p>
      )}
    </section>
  );
}

export function YoutubeBoard() {
  const [snap, setSnap] = useState<YoutubeSnapshot | null>(null);
  const [defs, setDefs] = useState<YoutubeCategoryDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dialog, setDialog] = useState<CategoryDialogState | null>(null);
  const [blockCount, setBlockCount] = useState(0);
  const [blockDialogOpen, setBlockDialogOpen] = useState(false);
  const [dismissCount, setDismissCount] = useState(0);
  const [dismissDialogOpen, setDismissDialogOpen] = useState(false);
  /** 자동 체크 결과 알림(되돌리기 제공). ids 는 방금 자동 체크된 videoId 들. */
  const [autoNotice, setAutoNotice] = useState<{ ids: string[]; text: string } | null>(null);
  /** 유튜브로 연 뒤 아직 복귀 처리되지 않은 영상들: videoId → 마킹에 쓸 메타 */
  const pendingRef = useRef(new Map<string, { title: string; channel: string }>());
  /** 영상을 연 뒤 이 탭이 숨겨진 시각(ms). 복귀 시 이탈 시간을 재는 기준. */
  const hiddenAtRef = useRef<number | null>(null);

  async function load() {
    try {
      const [s, d] = await Promise.all([api.youtube(), api.youtubeCategories()]);
      setSnap(s);
      setDefs(d);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  async function loadBlockCount() {
    try {
      setBlockCount((await api.youtubeBlocklist()).length);
    } catch {
      /* 차단 수 표시는 부가 정보라 실패해도 무시 */
    }
  }
  async function loadDismissCount() {
    try {
      setDismissCount((await api.youtubeDismissed()).length);
    } catch {
      /* 제외 영상 수 표시도 부가 정보라 실패해도 무시 */
    }
  }
  async function checkStatus() {
    try {
      setCollecting((await api.youtubeStatus()).collecting);
    } catch {
      /* 상태 폴링 실패는 무시 */
    }
  }
  useEffect(() => {
    load();
    loadBlockCount();
    loadDismissCount();
    checkStatus(); // 진입 시 (예: 정시 수집이 돌고 있으면) '수집 중'을 즉시 반영
  }, []);

  // 수집 중이면 5초마다 상태 확인 → 완료되면 스냅샷을 자동으로 다시 불러온다.
  useEffect(() => {
    if (!collecting) return;
    const id = setInterval(async () => {
      let done = false;
      try {
        done = !(await api.youtubeStatus()).collecting;
      } catch {
        return; // 일시 오류는 다음 주기에 재시도
      }
      if (done) {
        setCollecting(false);
        await load(); // 완료 → 새 결과 반영
        loadBlockCount();
        loadDismissCount();
      }
    }, 5000);
    return () => clearInterval(id);
  }, [collecting]);

  /**
   * '보고 돌아오면 자동 본영상 체크'. 카드에서 유튜브를 열면 새 탭이 뜨면서 이 탭은 hidden 이 되고,
   * 돌아오면 visible 이 된다 → 그 사이 이탈 시간이 충분하면 열어 둔 영상들을 본영상으로 체크한다.
   * 곧바로 돌아온 경우(오클릭)는 체크하지 않지만 대기열은 남겨 둔다 — 탭을 띄워 두고 나중에 보는
   * 흐름에서도 그때 돌아오면 체크되도록. (cmd+클릭 등 배경 탭으로 열면 hidden 이 없어 체크되지 않는다.)
   */
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === "hidden") {
        if (pendingRef.current.size && hiddenAtRef.current == null) hiddenAtRef.current = Date.now();
        return;
      }
      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null; // 복귀했으니 다음 이탈부터 다시 잰다
      if (!shouldAutoMarkWatched(hiddenAt, Date.now(), pendingRef.current.size)) return;
      const entries = [...pendingRef.current.entries()];
      pendingRef.current.clear();
      autoMarkWatched(entries);
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // 자동 체크 알림은 되돌릴 시간을 준 뒤 스스로 사라진다.
  useEffect(() => {
    if (!autoNotice) return;
    const id = setTimeout(() => setAutoNotice(null), 12000);
    return () => clearTimeout(id);
  }, [autoNotice]);

  async function blockChannel(v: YoutubeVideo, categoryKey: string) {
    const label = v.channelHandle ? `${v.channel} (${v.channelHandle})` : v.channel;
    const catLabel = defs.find((d) => d.key === categoryKey)?.label ?? categoryKey;
    if (
      !confirm(
        `'${label}' 채널을 '${catLabel}' 카테고리에서 제외할까요?\n이 카테고리의 해당 채널 영상만 사라지고, 다른 카테고리에서는 계속 나올 수 있어요.\n('제외 채널 관리'에서 언제든 되돌릴 수 있어요.)`
      )
    )
      return;
    try {
      await api.blockYoutubeChannel({ channel: v.channel, handle: v.channelHandle ?? null, categoryKey });
      // 낙관적 제거: 이 카테고리에서만 같은 채널 영상 즉시 제거(다른 카테고리는 유지)
      setSnap((prev) =>
        prev
          ? {
              ...prev,
              categories: prev.categories.map((c) =>
                c.key === categoryKey
                  ? { ...c, items: c.items.filter((it) => !sameChannel(it, v)) }
                  : c
              ),
            }
          : prev
      );
      loadBlockCount();
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  /** 카드 ⭐: 이 채널을 해당 카테고리의 추천 채널에 추가/해제. 낙관적 토글 후 서버 응답으로 확정. */
  async function toggleRecommend(video: YoutubeVideo, categoryKey: string) {
    const def = defs.find((d) => d.key === categoryKey);
    if (!def) return;
    const input = { channel: video.channel, handle: video.channelHandle ?? null };
    const wasOn = isRecommendedChannel(def.recommendedChannels, video.channel, video.channelHandle);
    const prev = defs;
    // 낙관적 토글: 공유 헬퍼로 다음 목록을 즉시 반영 — 연타해도 두 번째 클릭이 반대 방향(해제/재추가)으로 간다.
    const optimistic = wasOn
      ? removeRecommendedChannel(def.recommendedChannels, video.channel, video.channelHandle)
      : addRecommendedChannel(def.recommendedChannels, video.channel, video.channelHandle);
    if (optimistic)
      setDefs((p) =>
        p.map((d) => (d.key === categoryKey ? { ...d, recommendedChannels: optimistic } : d))
      );
    try {
      const updated = wasOn
        ? await api.removeYoutubeRecommendedChannel(categoryKey, input)
        : await api.addYoutubeRecommendedChannel(categoryKey, input);
      setDefs((p) => p.map((d) => (d.key === categoryKey ? updated : d))); // 서버 권위로 확정
      setErr(null);
    } catch (e) {
      setDefs(prev); // 실패 시 롤백
      setErr((e as Error).message);
    }
  }

  /** 여러 카드의 watched 플래그를 한 번에 반영(수동 토글·자동 체크·롤백 공용). */
  function applyWatchedFlag(ids: Set<string>, value: boolean) {
    if (!ids.size) return;
    setSnap((s) =>
      s
        ? {
            ...s,
            categories: s.categories.map((c) => ({
              ...c,
              items: c.items.map((it) =>
                it.videoId && ids.has(it.videoId) ? { ...it, watched: value } : it
              ),
            })),
          }
        : s
    );
  }

  async function toggleWatched(video: YoutubeVideo) {
    const videoId = video.videoId;
    if (!videoId) {
      setErr("영상 식별자가 없어 본영상 체크를 할 수 없습니다.");
      return;
    }
    const next = !video.watched;
    const ids = new Set([videoId]);
    // 사용자가 직접 정한 상태가 우선 — 자동 체크 대기열에서 빼서 복귀 시 되덮이지 않게 한다.
    pendingRef.current.delete(videoId);
    // 낙관적 업데이트: 카드를 제거하지 않고 watched 상태만 토글(되돌리기 가능).
    applyWatchedFlag(ids, next);
    try {
      if (next) await api.markYoutubeWatched({ videoId, title: video.title, channel: video.channel });
      else await api.unmarkYoutubeWatched(videoId);
      setErr(null);
    } catch (e) {
      applyWatchedFlag(ids, !next); // 실패 시 이 카드만 롤백
      setErr((e as Error).message);
    }
  }

  /**
   * 카드에서 유튜브를 연 순간(썸네일·'영상 보기' 클릭). 여기서 바로 체크하지 않고 대기열에만 넣는다 —
   * 실제 체크는 사용자가 영상을 보고 이 탭으로 돌아왔을 때(visibilitychange) 이뤄진다.
   */
  function openVideo(video: YoutubeVideo) {
    const videoId = video.videoId;
    if (!videoId || video.watched) return; // 식별 불가·이미 체크된 영상은 대상 아님
    pendingRef.current.set(videoId, { title: video.title, channel: video.channel });
  }

  /** 복귀 시점의 자동 체크. 실패한 항목만 되돌리고, 성공분은 '되돌리기' 알림으로 안내한다. */
  async function autoMarkWatched(entries: [string, { title: string; channel: string }][]) {
    applyWatchedFlag(new Set(entries.map(([id]) => id)), true); // 낙관적
    const results = await Promise.allSettled(
      entries.map(([videoId, meta]) =>
        api.markYoutubeWatched({ videoId, title: meta.title, channel: meta.channel })
      )
    );
    const ok = entries.filter((_, i) => results[i].status === "fulfilled");
    const failed = entries.filter((_, i) => results[i].status === "rejected");
    if (failed.length) applyWatchedFlag(new Set(failed.map(([id]) => id)), false);
    if (!ok.length) return;
    setAutoNotice({ ids: ok.map(([id]) => id), text: autoWatchedNotice(ok.map(([, m]) => m.title)) });
  }

  /** 자동 체크 되돌리기 — 방금 체크된 영상만 해제한다(수동 체크분은 건드리지 않음). */
  async function undoAutoWatched() {
    const notice = autoNotice;
    if (!notice) return;
    setAutoNotice(null);
    applyWatchedFlag(new Set(notice.ids), false);
    const results = await Promise.allSettled(notice.ids.map((id) => api.unmarkYoutubeWatched(id)));
    const failed = notice.ids.filter((_, i) => results[i].status === "rejected");
    if (failed.length) {
      applyWatchedFlag(new Set(failed), true);
      setErr("일부 영상의 본영상 체크를 되돌리지 못했습니다.");
    }
  }

  /**
   * 카드 '이 영상 제외': 확인 창도 사유 입력도 없이 즉시 제외한다(사유는 관리 다이얼로그에서 나중에).
   * 되돌리기는 '제외 영상' 관리의 [해제]뿐이라, 실수해도 복구 경로가 있음을 버튼 툴팁에 적어 두었다.
   */
  async function dismissVideo(video: YoutubeVideo, categoryKey: string) {
    const videoId = video.videoId;
    if (!videoId) {
      setErr("영상 식별자가 없어 제외할 수 없습니다.");
      return;
    }
    const prev = snap;
    // 낙관적 제거: 제외 원장은 videoId 기준 전역이라 모든 카테고리에서 함께 빠진다(서버 필터와 동일).
    setSnap((s) =>
      s
        ? {
            ...s,
            categories: s.categories.map((c) => ({
              ...c,
              items: c.items.filter((it) => it.videoId !== videoId),
            })),
          }
        : s
    );
    try {
      await api.dismissYoutubeVideo({
        videoId,
        title: video.title,
        channel: video.channel,
        url: video.url ?? null,
        categoryKey,
      });
      loadDismissCount();
      setErr(null);
    } catch (e) {
      setSnap(prev ?? null); // 실패 시 롤백 → 카드가 다시 나타난다
      setErr((e as Error).message);
    }
  }

  async function refresh() {
    setErr(null);
    try {
      await api.refreshYoutube(); // 백그라운드 시작(202) 또는 이미 수집 중(409) → 둘 다 정상
      setCollecting(true); // '수집 중' 배너 + 폴링 시작 → 완료되면 자동 반영
      api.youtubeCategories().then(setDefs).catch(() => {}); // 새 카테고리 즉시 반영
    } catch (e) {
      setErr((e as Error).message); // 5xx 등 진짜 실패만 표시
    }
  }

  async function moveVideo(video: YoutubeVideo, fromKey: string, toKey: string) {
    if (!video.videoId) {
      setErr("영상 식별자가 없어 이동할 수 없습니다.");
      return;
    }
    if (collecting) {
      setErr("수집이 진행 중입니다. 완료된 뒤 카드를 이동해 주세요.");
      return;
    }
    const videoId = video.videoId;
    const prev = snap;
    const target = defs.find((d) => d.key === toKey);
    // 낙관적 업데이트: 모든 카테고리에서 제거 후 대상 맨 앞에 삽입.
    setSnap((s) => {
      if (!s) return s;
      const moved = { ...video, movedByUser: true };
      let placed = false;
      const categories = s.categories.map((c) => {
        const items = c.items.filter((v) => v.videoId !== videoId);
        if (c.key === toKey) {
          placed = true;
          return { ...c, items: [moved, ...items] };
        }
        return { ...c, items };
      });
      // 대상 카테고리가 아직 스냅샷에 없으면(수집 이후 추가된 경우) 새 섹션으로 추가.
      if (!placed && target) {
        categories.push({
          key: target.key,
          label: target.label,
          emoji: target.emoji,
          color: target.color,
          items: [moved],
        });
      }
      return { ...s, categories };
    });
    try {
      const updated = await api.moveYoutubeVideo({ videoId, fromKey, toKey });
      setSnap(updated); // 서버 권위 스냅샷으로 확정
      setErr(null);
    } catch (e) {
      setSnap(prev ?? null); // 실패 시 롤백
      setErr((e as Error).message);
      checkStatus(); // 409(수집 중)일 수 있으니 상태 재동기화 → 폴링 재개
    }
  }

  async function move(def: YoutubeCategoryDef, dir: "up" | "down") {
    const idx = defs.findIndex((d) => d.key === def.key);
    const j = dir === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || j < 0 || j >= defs.length) return;
    const next = defs.slice();
    [next[idx], next[j]] = [next[j], next[idx]];
    setDefs(next); // 낙관적 업데이트
    try {
      await api.reorderYoutubeCategories(next.map((d) => d.key));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
      load(); // 실패 시 서버 상태로 복구
    }
  }

  async function deleteCategory(def: YoutubeCategoryDef) {
    if (!confirm(`'${def.label}' 카테고리를 삭제할까요?\n(다음 수집부터 제외됩니다)`)) return;
    try {
      await api.deleteYoutubeCategory(def.key);
      setDefs((prev) => prev.filter((c) => c.key !== def.key));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 불러오는 중…
      </div>
    );
  }

  // 카테고리 정의(defs)를 기준으로 렌더하고, 스냅샷에서 key가 일치하는 영상만 매칭한다.
  const itemsByKey = new Map<string, YoutubeVideo[]>();
  snap?.categories.forEach((c) => itemsByKey.set(c.key, c.items));

  const updated = snap?.updatedAt ? new Date(snap.updatedAt).toLocaleString("ko-KR") : null;
  const total = defs.reduce((a, d) => a + (itemsByKey.get(d.key)?.length ?? 0), 0);
  const freshDays = snap?.freshDays ?? 7;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <ScheduleControl kind="youtube" />
          <span>
            · 최근 {freshDays}일 이내 영상 · AI·LLM/신제품 리뷰 전문 조사 · 수집 시 이메일 발송(지금 갱신 포함)
            {" · 영상을 보고 돌아오면 자동 본영상 체크"}
            {updated && ` · 최종 갱신 ${updated}`}
            {snap && ` · 총 ${total}건`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setBlockDialogOpen(true)}>
            <Ban className="h-4 w-4" /> 제외 채널{blockCount > 0 ? ` (${blockCount})` : ""}
          </Button>
          <Button variant="outline" onClick={() => setDismissDialogOpen(true)}>
            <EyeOff className="h-4 w-4" /> 제외 영상{dismissCount > 0 ? ` (${dismissCount})` : ""}
          </Button>
          <Button variant="outline" onClick={() => setDialog({ mode: "add" })}>
            <Plus className="h-4 w-4" /> 카테고리 추가
          </Button>
          <Button variant="outline" onClick={refresh} disabled={collecting}>
            {collecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {collecting ? "수집 중…" : "지금 갱신"}
          </Button>
        </div>
      </div>

      {err && (
        <div className="mb-4 rounded-md border border-up/40 bg-up/10 px-4 py-3 text-sm text-up">{err}</div>
      )}

      {collecting && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          유튜브 소식을 수집하는 중입니다… 카테고리가 많으면 수 분~수십 분 걸릴 수 있고, 완료되면 자동으로 반영됩니다.
        </div>
      )}

      {!defs.length ? (
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <Youtube className="h-10 w-10" />
          <p>카테고리가 없습니다. 카테고리를 추가하세요.</p>
          <Button variant="outline" onClick={() => setDialog({ mode: "add" })}>
            <Plus className="h-4 w-4" /> 카테고리 추가
          </Button>
        </div>
      ) : (
        defs.map((def, i) => (
          <Section
            key={def.key}
            def={def}
            items={itemsByKey.get(def.key) ?? []}
            allDefs={defs}
            canDelete={defs.length > 1}
            canUp={i > 0}
            canDown={i < defs.length - 1}
            moveDisabled={collecting}
            onMove={move}
            onEdit={(d) => setDialog({ mode: "edit", cat: d })}
            onDelete={deleteCategory}
            onBlock={blockChannel}
            onMoveVideo={moveVideo}
            onToggleWatched={toggleWatched}
            onToggleRecommend={toggleRecommend}
            onDismiss={dismissVideo}
            onOpenVideo={openVideo}
          />
        ))
      )}

      <CategoryDialog kind="youtube" state={dialog} onClose={() => setDialog(null)} onSaved={load} />
      <BlockedChannelsDialog
        open={blockDialogOpen}
        defs={defs}
        onClose={() => setBlockDialogOpen(false)}
        onChanged={() => {
          load();
          loadBlockCount();
        }}
      />
      <DismissedVideosDialog
        open={dismissDialogOpen}
        defs={defs}
        onClose={() => setDismissDialogOpen(false)}
        onChanged={() => {
          load(); // 해제된 영상이 스냅샷에 다시 나타나도록
          loadDismissCount();
        }}
      />

      {/* 자동 체크 알림 — 우하단 '맨 위로' 버튼과 겹치지 않게 화면 하단 중앙에 띄운다. */}
      {autoNotice && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 flex max-w-[min(92vw,34rem)] -translate-x-1/2 items-center gap-3 rounded-full border bg-card px-4 py-2 text-sm shadow-lg"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span className="truncate">{autoNotice.text}</span>
          <button
            onClick={undoAutoWatched}
            className="shrink-0 font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            되돌리기
          </button>
          <button
            onClick={() => setAutoNotice(null)}
            aria-label="알림 닫기"
            className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
