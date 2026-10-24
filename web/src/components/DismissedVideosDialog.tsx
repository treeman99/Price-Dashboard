import { useEffect, useState } from "react";
import { Loader2, EyeOff, RotateCcw, Youtube, Tag, Check, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice, StatusTag, EmptyState } from "@/components/ui/page";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { safeHref } from "@shared/url";
import type { DismissedVideo, YoutubeCategoryDef } from "@shared/types";

/**
 * 자주 쓰는 제외 사유. 한 번 클릭하면 그대로 저장된다(직접 입력도 가능).
 * 수집 에이전트가 부정 예시로 받아 "이런 종류"를 회피하는 데 쓰므로,
 * 영상 한 편이 아니라 '유형'을 가리키는 말로 고정해 둔다.
 */
const QUICK_REASONS = [
  "광고·협찬성",
  "낚시성 제목",
  "너무 입문용",
  "잡담·비주제",
  "재탕·요약본",
] as const;

export function DismissedVideosDialog({
  open,
  defs,
  onClose,
  onChanged,
}: {
  open: boolean;
  /** 카테고리 정의(제외한 카테고리 key→라벨 표시용). */
  defs: YoutubeCategoryDef[];
  onClose: () => void;
  /** 제외 해제 등으로 목록이 바뀌었을 때(보드가 스냅샷을 다시 불러오도록). */
  onChanged: () => void;
}) {
  const [list, setList] = useState<DismissedVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** 사유 편집 중인 videoId(한 번에 한 행만 연다). */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 편집 중인 행의 직접 입력값. */
  const [draft, setDraft] = useState("");

  async function load() {
    setLoading(true);
    try {
      setList(await api.youtubeDismissed());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      load();
      setEditingId(null); // 다시 열 때 편집 상태가 남아 있지 않도록 초기화
      setDraft("");
    }
  }, [open]);

  /** 사유 저장/삭제. reason 이 null 이면 사유만 지우고 제외는 유지한다. */
  async function saveReason(videoId: string, reason: string | null) {
    setBusyId(videoId);
    try {
      const updated = await api.updateYoutubeDismissReason(videoId, reason);
      setList((prev) => prev.map((d) => (d.videoId === videoId ? updated : d)));
      setEditingId(null);
      setDraft("");
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function undismiss(d: DismissedVideo) {
    setBusyId(d.videoId);
    try {
      await api.undismissYoutubeVideo(d.videoId);
      setList((prev) => prev.filter((x) => x.videoId !== d.videoId));
      onChanged(); // 보드 스냅샷 갱신 → 해제된 영상 즉시 복원
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  // 최근 제외한 것이 위로. 서버 정렬을 신뢰하지 않고 화면에서 한 번 더 보장한다.
  const ordered = [...list].sort((a, b) => (b.dismissedAt || "").localeCompare(a.dismissedAt || ""));

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <EyeOff className="h-4 w-4" /> 제외한 영상 관리
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            여기 있는 영상은 만료 없이 계속 화면·수집에서 빠집니다('본영상'은 일정 기간 뒤 돌아오지만 이쪽은 아니에요).
            사유를 붙이면 다음 수집 때 에이전트가 부정 예시로 받아 비슷한 종류의 영상까지 피합니다 — 선택이지만 붙일수록 정확해져요.
          </DialogDescription>
        </DialogHeader>

        {err && (
          <Notice tone="error" className="mb-0">
            {err}
          </Notice>
        )}

        {loading ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 불러오는 중…
          </div>
        ) : ordered.length === 0 ? (
          <EmptyState icon={<Youtube />} className="py-10">
            <p>제외한 영상이 없습니다.</p>
            <p className="text-[12.5px]">각 영상의 '이 영상 제외' 버튼으로 추가할 수 있어요.</p>
          </EmptyState>
        ) : (
          <ul className="max-h-[55vh] divide-y overflow-y-auto border-y">
            {ordered.map((d) => {
              const href = safeHref(d.url);
              const editing = editingId === d.videoId;
              const busy = busyId === d.videoId;
              const catLabel = d.categoryKey
                ? (defs.find((c) => c.key === d.categoryKey)?.label ?? d.categoryKey)
                : null;
              return (
                <li
                  key={d.videoId}
                  // 사유가 붙은 항목은 옅은 경고 바탕으로 구분 — 에이전트가 더 강한 신호로 쓴다는 걸 눈으로 알 수 있게.
                  className={cn("px-3 py-2.5", d.reason && "bg-tone-warn/[0.06]")}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          className="line-clamp-2 text-[15px] font-medium underline-offset-[3px] hover:underline"
                          title={d.title || d.videoId}
                        >
                          {d.title || d.videoId}
                        </a>
                      ) : (
                        <p className="line-clamp-2 text-[15px] font-medium" title={d.title || d.videoId}>
                          {d.title || d.videoId}
                        </p>
                      )}
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 truncate text-[12.5px] text-muted-foreground">
                        {d.channel && <span>{d.channel}</span>}
                        {catLabel && <StatusTag>{catLabel}</StatusTag>}
                        <span className="num">{new Date(d.dismissedAt).toLocaleString("ko-KR")} 제외</span>
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => undismiss(d)}
                      disabled={busy}
                      className="shrink-0"
                    >
                      {busy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RotateCcw className="h-4 w-4" />
                      )}
                      해제
                    </Button>
                  </div>

                  {/* 사유 — 선택 항목이라 평소엔 접혀 있고, 누르면 빠른 태그 + 직접 입력이 열린다. */}
                  <div className="mt-2">
                    {editing ? (
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-1.5">
                          {QUICK_REASONS.map((r) => (
                            <button
                              key={r}
                              onClick={() => saveReason(d.videoId, r)}
                              disabled={busy}
                              title={`'${r}' 사유로 저장`}
                              aria-pressed={d.reason === r}
                              className={cn(
                                "h-6 rounded-[3px] border px-2 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                                d.reason === r
                                  ? "border-foreground bg-foreground font-medium text-background"
                                  : "border-input text-muted-foreground hover:border-foreground/40 hover:bg-muted hover:text-foreground"
                              )}
                            >
                              {r}
                            </button>
                          ))}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Input
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                              // 엔터로 바로 저장 — 빈 값이면 아무 일도 하지 않는다(삭제는 별도 버튼).
                              if (e.key === "Enter" && draft.trim()) saveReason(d.videoId, draft.trim());
                            }}
                            placeholder="직접 입력 (예: 스펙 나열만 하고 실사용 얘기가 없음)"
                            className="h-8"
                            disabled={busy}
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => saveReason(d.videoId, draft.trim())}
                            disabled={busy || !draft.trim()}
                            className="shrink-0"
                          >
                            <Check className="h-4 w-4" /> 저장
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setEditingId(null);
                              setDraft("");
                            }}
                            disabled={busy}
                            className="shrink-0"
                          >
                            <X className="h-4 w-4" /> 취소
                          </Button>
                        </div>
                        {d.reason && (
                          <button
                            onClick={() => saveReason(d.videoId, null)}
                            disabled={busy}
                            className="text-[12px] text-muted-foreground underline-offset-[3px] transition-colors hover:text-tone-error hover:underline disabled:opacity-50"
                          >
                            사유 지우기 (제외는 유지)
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        {d.reason ? (
                          <StatusTag tone="warn" className="min-w-0 shrink gap-1">
                            <Tag className="h-3 w-3 shrink-0" />
                            <span className="truncate">{d.reason}</span>
                          </StatusTag>
                        ) : (
                          <span className="text-[12px] text-muted-foreground">사유 없음</span>
                        )}
                        <button
                          onClick={() => {
                            setEditingId(d.videoId);
                            setDraft(d.reason ?? "");
                          }}
                          className="ml-auto shrink-0 text-[12px] text-muted-foreground underline-offset-[3px] transition-colors hover:text-foreground hover:underline"
                        >
                          {d.reason ? "사유 수정" : "사유 붙이기"}
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
