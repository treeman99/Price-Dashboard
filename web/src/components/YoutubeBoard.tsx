import { useEffect, useState } from "react";
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
} from "lucide-react";
import type { YoutubeSnapshot, YoutubeVideo, YoutubeCategoryDef } from "@shared/types";
import { UNKNOWN_CHANNEL } from "@shared/youtube";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CategoryDialog, type CategoryDialogState } from "@/components/CategoryDialog";
import { BlockedChannelsDialog } from "@/components/BlockedChannelsDialog";

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

function Thumbnail({ video }: { video: YoutubeVideo }) {
  const [errored, setErrored] = useState(false);
  return (
    <a
      href={video.url}
      target="_blank"
      rel="noreferrer"
      className="group relative block aspect-video w-full overflow-hidden rounded-md bg-muted"
      title="유튜브에서 보기"
    >
      {video.thumbnail && !errored ? (
        <img
          src={video.thumbnail}
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
    </a>
  );
}

function VideoCard({
  video,
  color,
  onBlock,
}: {
  video: YoutubeVideo;
  color: string;
  onBlock: (video: YoutubeVideo) => void;
}) {
  return (
    <Card
      className="flex h-[30rem] flex-col overflow-hidden border-l-4 p-0"
      style={{ borderLeftColor: color }}
    >
      <div className="shrink-0 p-2 pb-0">
        <Thumbnail video={video} />
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
          <a
            href={video.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-[#ff0000] hover:underline"
          >
            <PlayCircle className="h-3.5 w-3.5" /> 영상 보기
          </a>
          <button
            onClick={() => onBlock(video)}
            disabled={!canBlockChannel(video)}
            title={
              canBlockChannel(video)
                ? `'${video.channel}' 채널을 조사에서 제외`
                : "채널 정보가 없어 제외할 수 없습니다"
            }
            className="inline-flex items-center gap-1 text-muted-foreground/70 transition-colors hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground/70"
          >
            <Ban className="h-3.5 w-3.5" /> 채널 제외
          </button>
        </div>
      </div>
    </Card>
  );
}

function Section({
  def,
  items,
  canDelete,
  canUp,
  canDown,
  onMove,
  onEdit,
  onDelete,
  onBlock,
}: {
  def: YoutubeCategoryDef;
  items: YoutubeVideo[];
  canDelete: boolean;
  canUp: boolean;
  canDown: boolean;
  onMove: (def: YoutubeCategoryDef, dir: "up" | "down") => void;
  onEdit: (def: YoutubeCategoryDef) => void;
  onDelete: (def: YoutubeCategoryDef) => void;
  onBlock: (video: YoutubeVideo) => void;
}) {
  const ctrl =
    "rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30";
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-2 border-b pb-2" style={{ borderColor: def.color }}>
        <h2 className="flex items-center gap-2 text-lg font-bold" style={{ color: def.color }}>
          <span>{def.emoji}</span>
          {def.label}
          <span className="text-sm font-normal text-muted-foreground">({items.length})</span>
        </h2>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => onMove(def, "up")} disabled={!canUp} title="위로" className={ctrl}>
            <ChevronUp className="h-4 w-4" />
          </button>
          <button onClick={() => onMove(def, "down")} disabled={!canDown} title="아래로" className={ctrl}>
            <ChevronDown className="h-4 w-4" />
          </button>
          <button onClick={() => onEdit(def)} title="카테고리 수정" className={ctrl}>
            <Pencil className="h-4 w-4" />
          </button>
          {canDelete && (
            <button
              onClick={() => onDelete(def)}
              title="카테고리 삭제"
              className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-destructive"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      {items.length ? (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
          {items.map((it, i) => (
            <VideoCard key={it.videoId ?? i} video={it} color={def.color} onBlock={onBlock} />
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
      }
    }, 5000);
    return () => clearInterval(id);
  }, [collecting]);

  async function blockChannel(v: YoutubeVideo) {
    const label = v.channelHandle ? `${v.channel} (${v.channelHandle})` : v.channel;
    if (
      !confirm(
        `'${label}' 채널을 앞으로 유튜브 조사에서 제외할까요?\n현재 목록의 이 채널 영상도 사라집니다.\n('제외 채널 관리'에서 언제든 되돌릴 수 있어요.)`
      )
    )
      return;
    try {
      await api.blockYoutubeChannel({ channel: v.channel, handle: v.channelHandle ?? null });
      // 낙관적 제거: 같은 채널 영상 모두 화면에서 즉시 제거
      setSnap((prev) =>
        prev
          ? {
              ...prev,
              categories: prev.categories.map((c) => ({
                ...c,
                items: c.items.filter((it) => !sameChannel(it, v)),
              })),
            }
          : prev
      );
      loadBlockCount();
      setErr(null);
    } catch (e) {
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
        <p className="text-sm text-muted-foreground">
          매일 자동 수집 · 최근 {freshDays}일 이내 영상 · AI·LLM/신제품 리뷰 전문 조사 · 수집 시 이메일 발송(지금 갱신 포함)
          {updated && ` · 최종 갱신 ${updated}`}
          {snap && ` · 총 ${total}건`}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setBlockDialogOpen(true)}>
            <Ban className="h-4 w-4" /> 제외 채널{blockCount > 0 ? ` (${blockCount})` : ""}
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
            canDelete={defs.length > 1}
            canUp={i > 0}
            canDown={i < defs.length - 1}
            onMove={move}
            onEdit={(d) => setDialog({ mode: "edit", cat: d })}
            onDelete={deleteCategory}
            onBlock={blockChannel}
          />
        ))
      )}

      <CategoryDialog kind="youtube" state={dialog} onClose={() => setDialog(null)} onSaved={load} />
      <BlockedChannelsDialog
        open={blockDialogOpen}
        onClose={() => setBlockDialogOpen(false)}
        onChanged={() => {
          load();
          loadBlockCount();
        }}
      />
    </div>
  );
}
