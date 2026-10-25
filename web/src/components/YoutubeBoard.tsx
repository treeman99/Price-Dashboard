import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  RefreshCw,
  Loader2,
  Youtube,
  PlayCircle,
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
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  PageToolbar,
  Meta,
  MetaDot,
  Notice,
  SectionHeader,
  TextLink,
  IconAction,
  EmptyState,
  EmptyLine,
  LoadingState,
} from "@/components/ui/page";
import { NotifyMeta, ScheduleControl } from "@/components/ScheduleControl";
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

/**
 * 행 동작 아이콘의 라벨 툴팁에는 예전 버튼 title 의 설명 전문이 들어간다. 한 줄로는 길어서
 * 줄바꿈되는 폭으로 열고, 오른쪽 끝 열에서 화면 밖으로 밀려나지 않게 버튼 오른쪽 끝에 맞춘다.
 */
const LONG_TIP =
  "[&_[role=tooltip]]:left-auto [&_[role=tooltip]]:right-0 [&_[role=tooltip]]:w-max [&_[role=tooltip]]:max-w-[17rem] [&_[role=tooltip]]:translate-x-0 [&_[role=tooltip]]:whitespace-normal [&_[role=tooltip]]:text-left [&_[role=tooltip]]:leading-snug";

function Thumbnail({
  video,
  onOpen,
  className,
}: {
  video: YoutubeVideo;
  onOpen: () => void;
  className?: string;
}) {
  const [errored, setErrored] = useState(false);
  const href = safeHref(video.url);
  const thumbSrc = safeHref(video.thumbnail);
  const box = cn("group/thumb relative block aspect-video overflow-hidden rounded-[3px] bg-muted", className);
  const inner = (
    <>
      {thumbSrc && !errored ? (
        <img
          src={thumbSrc}
          alt=""
          loading="lazy"
          onError={() => setErrored(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Youtube className="h-8 w-8 text-muted-foreground/50" />
        </div>
      )}
      {/* 재생 오버레이 */}
      <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover/thumb:bg-black/20">
        <PlayCircle className="h-10 w-10 text-white/0 transition-colors group-hover/thumb:text-white/90" />
      </div>
      {video.duration && (
        <span className="num absolute bottom-1 right-1 rounded-[2px] bg-black/80 px-1 py-px text-[11px] font-medium text-white">
          {video.duration}
        </span>
      )}
    </>
  );
  if (!href) {
    return <div className={box}>{inner}</div>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={onOpen}
      className={box}
      title="유튜브에서 보기 — 보고 돌아오면 자동으로 '본영상' 체크됩니다"
    >
      {inner}
    </a>
  );
}

/**
 * 요약은 3줄까지만 보이고, 넘치면 '더 보기'로 펼친다. 예전 카드는 내부 스크롤로 전문을 보여줬으니
 * 행으로 바꿔도 전문에 닿는 길은 남겨 둔다(넘칠 때만 버튼이 뜨도록 실제 높이를 잰다).
 */
function Summary({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  const toggle = "text-[12.5px] text-muted-foreground underline-offset-[3px] hover:text-foreground hover:underline";
  return (
    <div className="relative mt-1.5">
      <p
        ref={ref}
        className={cn("whitespace-pre-line text-sm leading-relaxed text-foreground/80", !open && "line-clamp-3")}
      >
        {text}
      </p>
      {open ? (
        <button type="button" onClick={() => setOpen(false)} className={toggle}>
          접기
        </button>
      ) : (
        clamped && (
          // 셋째 줄 끝을 종이색으로 덮고 그 위에 띄운다 — 버튼 때문에 행이 한 줄 더 길어지지 않게.
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={cn(
              toggle,
              "absolute bottom-0 right-0 bg-[linear-gradient(to_right,transparent,hsl(var(--background))_1.5rem)] pl-8 leading-relaxed"
            )}
          >
            더 보기
          </button>
        )
      )}
    </div>
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
      <IconAction
        label={disabled ? "수집 중에는 이동할 수 없습니다" : "다른 카테고리로 이동"}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        active={open}
        className={LONG_TIP}
      >
        <FolderInput />
      </IconAction>
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
                className="flex w-full items-center gap-2 rounded-[3px] px-2 py-1.5 text-left text-sm hover:bg-muted"
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

/**
 * '본영상 체크'(기간제 숨김)는 행 동작 줄 왼쪽에 글자 토글로, '이 영상 제외'(영구 제외)는 오른쪽 끝
 * 아이콘(hover 시 붉은색)으로 둔다 — "잠깐 숨김"과 "영구 제외"를 색과 위치로 구분한다.
 */
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
      type="button"
      onClick={() => onToggleWatched(video)}
      disabled={!video.videoId}
      aria-pressed={watched}
      title={
        watched
          ? "본영상 해제 — 다시 검색(수집)에 노출됩니다"
          : "본영상으로 체크 — 1주일간 검색(수집)에서 제외됩니다"
      }
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap text-[12.5px] underline-offset-[3px] transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:no-underline [&_svg]:h-3.5 [&_svg]:w-3.5",
        watched ? "font-medium text-tone-success" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {watched ? <CheckCircle2 /> : <Circle />}
      {watched ? "본영상" : "본영상 체크"}
    </button>
  );
}

function VideoRow({
  video,
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
  currentKey: string;
  allDefs: YoutubeCategoryDef[];
  moveDisabled: boolean;
  /** 이 행의 채널이 현재 카테고리 추천 채널에 등록되어 있는지 */
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
    <li className={cn("flex gap-4 border-b py-3.5 transition-opacity", video.watched && "opacity-75")}>
      <Thumbnail video={video} onOpen={() => onOpenVideo(video)} className="w-36 shrink-0 self-start sm:w-[208px]" />
      <div className="flex min-w-0 flex-1 flex-col">
        <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug" title={video.originalTitle ?? video.title}>
          {video.title}
        </h3>
        {/* 채널 / 날짜 / 조회수 */}
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] text-muted-foreground">
          <span className="font-medium text-foreground/70">
            {video.channel}
            {video.channelHandle ? ` · ${video.channelHandle}` : ""}
          </span>
          <MetaDot />
          <span className="num">{video.date}</span>
          {video.views && (
            <>
              <MetaDot />
              <span className="num inline-flex items-center gap-1">
                <Eye className="h-3 w-3" /> {video.views}
              </span>
            </>
          )}
        </p>
        <Summary text={video.summary} />
        {/* 동작 — 행마다 같은 자리(맨 아래)에 오도록 mt-auto */}
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2">
          {videoHref ? (
            <TextLink
              href={videoHref}
              onClick={() => onOpenVideo(video)}
              title="유튜브에서 보기 — 보고 돌아오면 자동으로 '본영상' 체크됩니다"
              icon={<PlayCircle />}
              className="font-medium text-foreground/80"
            >
              영상 보기
            </TextLink>
          ) : (
            <span className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground">
              <PlayCircle className="h-3.5 w-3.5" /> 영상 보기
            </span>
          )}
          <WatchedToggle video={video} onToggleWatched={onToggleWatched} />
          <div className="ml-auto flex items-center gap-0.5">
            <IconAction
              label={
                !canRecommend
                  ? "채널 정보가 없어 추천 채널로 추가할 수 없습니다"
                  : recommended
                    ? `'${video.channel}' 채널을 추천 채널에서 해제`
                    : `'${video.channel}' 채널을 이 카테고리의 추천 채널로 추가 — 다음 수집부터 우선 확인합니다`
              }
              onClick={() => onToggleRecommend(video)}
              disabled={!canRecommend}
              aria-pressed={recommended}
              active={recommended}
              className={cn(LONG_TIP, recommended && "text-tone-warn hover:text-tone-warn")}
            >
              <Star fill={recommended ? "currentColor" : "none"} />
            </IconAction>
            <MoveMenu
              video={video}
              currentKey={currentKey}
              allDefs={allDefs}
              disabled={moveDisabled}
              onMove={onMove}
            />
            <IconAction
              label={
                canBlockChannel(video)
                  ? `'${video.channel}' 채널을 이 카테고리 조사에서 제외`
                  : "채널 정보가 없어 제외할 수 없습니다"
              }
              onClick={() => onBlock(video, currentKey)}
              disabled={!canBlockChannel(video)}
              danger
              className={LONG_TIP}
            >
              <Ban />
            </IconAction>
            {/* 한 번 누르면 확인 없이 바로 사라진다(사유는 선택, 나중에 붙임). */}
            <IconAction
              label={
                video.videoId
                  ? "이 영상 제외 — 만료 없이 영구히 숨기고, 다음 수집 때 비슷한 영상도 피합니다('제외 영상'에서 되돌릴 수 있어요)"
                  : "영상 식별자가 없어 제외할 수 없습니다"
              }
              onClick={() => onDismiss(video)}
              disabled={!video.videoId}
              danger
              className={LONG_TIP}
            >
              <EyeOff />
            </IconAction>
          </div>
        </div>
      </div>
    </li>
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
  // 영상은 항상 최신(업로드일 내림차순) 우선으로 표시한다. date 는 "YYYY-MM-DD"라 문자열 비교로 정렬 가능.
  const ordered = [...items].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return (
    <section className="group/cat mt-12 first:mt-0">
      <SectionHeader
        title={[def.emoji, def.label].filter(Boolean).join(" ")}
        accent={def.color}
        count={items.length}
        actions={
          // 평소엔 흐리게 두고, 섹션에 마우스를 올리거나 키보드 포커스가 들어오면 또렷하게.
          <div className="flex items-center gap-0.5 opacity-40 transition-opacity focus-within:opacity-100 group-hover/cat:opacity-100">
            <IconAction label="위로" onClick={() => onMove(def, "up")} disabled={!canUp}>
              <ChevronUp />
            </IconAction>
            <IconAction label="아래로" onClick={() => onMove(def, "down")} disabled={!canDown}>
              <ChevronDown />
            </IconAction>
            <IconAction label="카테고리 수정" onClick={() => onEdit(def)}>
              <Pencil />
            </IconAction>
            {canDelete && (
              <IconAction label="카테고리 삭제" danger onClick={() => onDelete(def)}>
                <X />
              </IconAction>
            )}
          </div>
        }
      />
      {items.length ? (
        // 카드 상자 없는 가로형 행을 화면 폭에 맞춰 여러 열로 깐다(1680px 에서 3열). 행 구분은 아래 헤어라인뿐.
        <ul className="grid gap-x-10 [grid-template-columns:repeat(auto-fill,minmax(min(100%,480px),1fr))]">
          {ordered.map((it, i) => (
            <VideoRow
              key={it.videoId ?? i}
              video={it}
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
        </ul>
      ) : (
        <EmptyLine>최근 새 영상이 없습니다.</EmptyLine>
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
  /**
   * 마지막 수집 시도가 실패했을 때의 사유. 수집이 실패하면 서버가 기존 스냅샷을 유지하므로
   * 화면은 그대로고, 안내가 없으면 '갱신 버튼이 먹통'으로만 보인다(실측: 반나절 방치).
   */
  const [failure, setFailure] = useState<{ at: string; error: string } | null>(null);
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
      applyStatus(await api.youtubeStatus());
    } catch {
      /* 상태 폴링 실패는 무시 */
    }
  }
  /** status 응답을 '수집 중' 표시와 실패 안내에 함께 반영한다. */
  function applyStatus(s: Awaited<ReturnType<typeof api.youtubeStatus>>) {
    setCollecting(s.collecting);
    const a = s.lastAttempt;
    setFailure(a && !a.ok ? { at: a.at, error: a.error ?? "원인 미상" } : null);
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
        const s = await api.youtubeStatus();
        applyStatus(s); // 끝났으면 실패 사유도 함께 반영(실패 시 화면이 그대로라 안내가 필요)
        done = !s.collecting;
      } catch {
        return; // 일시 오류는 다음 주기에 재시도
      }
      if (done) {
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
    return <LoadingState />;
  }

  // 카테고리 정의(defs)를 기준으로 렌더하고, 스냅샷에서 key가 일치하는 영상만 매칭한다.
  const itemsByKey = new Map<string, YoutubeVideo[]>();
  snap?.categories.forEach((c) => itemsByKey.set(c.key, c.items));

  const updated = snap?.updatedAt ? new Date(snap.updatedAt).toLocaleString("ko-KR") : null;
  const total = defs.reduce((a, d) => a + (itemsByKey.get(d.key)?.length ?? 0), 0);
  const freshDays = snap?.freshDays ?? 7;

  return (
    <div>
      <PageToolbar
        actions={
          <>
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
          </>
        }
      >
        <ScheduleControl tab="youtube" />
        <MetaDot />
        <Meta>최근 {freshDays}일 이내 영상</Meta>
        <MetaDot />
        <Meta>AI·LLM/신제품 리뷰 전문 조사</Meta>
        <MetaDot />
        <NotifyMeta notify="youtube" suffix="(지금 갱신 포함)" fallback="수집 시 이메일 발송(지금 갱신 포함)" />
        <MetaDot />
        <Meta>영상을 보고 돌아오면 자동 본영상 체크</Meta>
        {updated && (
          <>
            <MetaDot />
            <Meta>
              최종 갱신 <strong>{updated}</strong>
            </Meta>
          </>
        )}
        {snap && (
          <>
            <MetaDot />
            <Meta>
              총 <strong>{total}</strong>건
            </Meta>
          </>
        )}
      </PageToolbar>

      {err && <Notice tone="error">{err}</Notice>}

      {collecting && (
        <Notice tone="info" progress>
          유튜브 소식을 수집하는 중입니다… 카테고리가 많으면 수 분~수십 분 걸릴 수 있고, 완료되면 자동으로 반영됩니다.
        </Notice>
      )}

      {/* 수집이 실패하면 서버가 기존 스냅샷을 유지한다 → 화면이 그대로라 실패를 알 수 없다. 명시한다. */}
      {!collecting && failure && (
        <Notice
          tone="warn"
          title={
            <>
              마지막 수집이 실패해 아래 목록은 이전 결과입니다 (
              {new Date(failure.at).toLocaleString("ko-KR")} 시도)
            </>
          }
        >
          <p className="mt-0.5 break-all text-muted-foreground">{failure.error}</p>
        </Notice>
      )}

      {!defs.length ? (
        <EmptyState
          icon={<Youtube />}
          action={
            <Button variant="outline" onClick={() => setDialog({ mode: "add" })}>
              <Plus className="h-4 w-4" /> 카테고리 추가
            </Button>
          }
        >
          카테고리가 없습니다. 카테고리를 추가하세요.
        </EmptyState>
      ) : (
        <div>
          {defs.map((def, i) => (
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
          ))}
        </div>
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
          className="fixed bottom-6 left-1/2 z-50 flex max-w-[min(92vw,34rem)] -translate-x-1/2 items-center gap-3 rounded-md border border-foreground/15 bg-card px-4 py-2 text-sm shadow-[0_12px_32px_-12px_rgba(27,26,23,0.35)]"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0 text-tone-success" />
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
            className="shrink-0 rounded-[3px] p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
