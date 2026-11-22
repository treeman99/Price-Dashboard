import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import type { NewsCategoryDef, YoutubeCategoryDef } from "@shared/types";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IconAction, Notice } from "@/components/ui/page";
import { CategoryDialog, type CategoryDialogState, type CategoryKind } from "@/components/CategoryDialog";

/**
 * 보고서 탭 '수집 설정' — 뉴스·유튜브 카테고리 관리(추가·편집·삭제·순서).
 *
 * 2026-11-23 뉴스·유튜브 탭을 없애면서 그 탭 섹션 머리에 있던 카테고리 버튼들을 여기로 모았다. 추가·편집은 기존
 * CategoryDialog(유튜브는 검색 범위·추천 채널·제외 키워드 포함)를 그대로 쓴다. 바뀐 설정은 다음 보고서 실행부터 세 모델이 쓴다.
 */
const API = {
  news: { list: api.newsCategories, remove: api.deleteNewsCategory, reorder: api.reorderNewsCategories, noun: "뉴스" },
  youtube: { list: api.youtubeCategories, remove: api.deleteYoutubeCategory, reorder: api.reorderYoutubeCategories, noun: "유튜브" },
} as const;

type Def = NewsCategoryDef | YoutubeCategoryDef;

export function CategoriesDialog({
  open,
  kind,
  onClose,
  onChanged,
}: {
  open: boolean;
  kind: CategoryKind;
  onClose: () => void;
  onChanged: () => void;
}) {
  const cfg = API[kind];
  const [defs, setDefs] = useState<Def[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<CategoryDialogState | null>(null);

  async function load() {
    try {
      setDefs(await cfg.list());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      setLoading(true);
      void load();
    }
    // kind 가 바뀌면 다른 목록이다
  }, [open, kind]);

  async function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= defs.length) return;
    const next = defs.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setDefs(next);
    try {
      await cfg.reorder(next.map((d) => d.key));
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
      void load();
    }
  }

  async function remove(d: Def) {
    if (!confirm(`'${d.label}' 카테고리를 삭제할까요?\n(다음 보고서 실행부터 이 카테고리는 조사하지 않습니다)`)) return;
    try {
      await cfg.remove(d.key);
      setDefs((prev) => prev.filter((x) => x.key !== d.key));
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <>
      <Dialog open={open && !edit} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-lg p-4 sm:p-6">
          <DialogHeader className="pr-6">
            <DialogTitle>{cfg.noun} 카테고리</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              세 모델이 이 순서·주제로 조사합니다{kind === "youtube" ? "(검색 범위·추천 채널·제외 키워드 포함)" : ""}. 바꾸면 다음 실행부터
              반영됩니다.
            </DialogDescription>
          </DialogHeader>
          {err && <Notice tone="error">{err}</Notice>}
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> 불러오는 중…
            </p>
          ) : (
            <ul className="divide-y border-y">
              {defs.map((d, i) => (
                <li key={d.key} className="flex items-center gap-2 py-2">
                  <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: d.color }} />
                  <span className="min-w-0 flex-1 truncate text-[14px]">
                    {d.emoji} {d.label}
                    {"region" in d && d.region === "global" && <span className="ml-1.5 text-[12px] text-muted-foreground">해외 포함</span>}
                    {"recommendedChannels" in d && d.recommendedChannels?.length ? (
                      <span className="ml-1.5 text-[12px] text-muted-foreground">추천 채널 {d.recommendedChannels.length}</span>
                    ) : null}
                    {d.excludeKeywords?.length ? (
                      <span className="ml-1.5 text-[12px] text-muted-foreground">제외 키워드 {d.excludeKeywords.length}</span>
                    ) : null}
                  </span>
                  <IconAction label="위로" onClick={() => void move(i, -1)} disabled={i === 0}>
                    <ArrowUp />
                  </IconAction>
                  <IconAction label="아래로" onClick={() => void move(i, 1)} disabled={i === defs.length - 1}>
                    <ArrowDown />
                  </IconAction>
                  <IconAction label="편집" onClick={() => setEdit({ mode: "edit", cat: d as NewsCategoryDef })}>
                    <Pencil />
                  </IconAction>
                  <IconAction label="삭제" onClick={() => void remove(d)} disabled={defs.length <= 1}>
                    <Trash2 />
                  </IconAction>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-between gap-2 pt-2">
            <Button variant="outline" onClick={() => setEdit({ mode: "add" })}>
              <Plus className="h-4 w-4" /> 카테고리 추가
            </Button>
            <Button variant="outline" onClick={onClose}>
              닫기
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <CategoryDialog
        state={edit}
        kind={kind}
        onClose={() => setEdit(null)}
        onSaved={() => {
          setEdit(null);
          void load();
          onChanged();
        }}
      />
    </>
  );
}
