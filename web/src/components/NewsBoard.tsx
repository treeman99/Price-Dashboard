import { useEffect, useState } from "react";
import {
  RefreshCw,
  Loader2,
  Newspaper,
  Link as LinkIcon,
  CalendarDays,
  X,
  Pencil,
  Plus,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import type { NewsSnapshot, NewsItem, NewsCategoryDef } from "@shared/types";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScheduleControl } from "@/components/ScheduleControl";
import { CategoryDialog, type CategoryDialogState } from "@/components/CategoryDialog";

function NewsItemCard({ item, color }: { item: NewsItem; color: string }) {
  return (
    <Card className="flex h-[20rem] flex-col border-l-4 p-4" style={{ borderLeftColor: color }}>
      {/* 제목 — 2줄 고정 */}
      <h4 className="line-clamp-2 min-h-[2.6em] font-semibold leading-snug">{item.title}</h4>
      {/* 출처 / 날짜 */}
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span>{item.source}</span>
        <span className="inline-flex items-center gap-1">
          <CalendarDays className="h-3 w-3" /> {item.date}
        </span>
      </p>
      {/* 요약 — 남는 공간을 채우고, 길면 카드 내부에서 스크롤되어 전부 보임 */}
      <p className="mt-2 min-h-0 flex-1 overflow-y-auto whitespace-pre-line pr-1 text-sm leading-relaxed text-foreground/80">
        {item.summary}
      </p>
      {/* 액션 — 항상 카드 하단 같은 위치 */}
      <div className="mt-3 flex flex-wrap items-center gap-3 border-t pt-2 text-xs">
        {item.link && (
          <a
            href={item.link}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[#4361ee] hover:underline"
          >
            <LinkIcon className="h-3 w-3" /> 원문 보기
          </a>
        )}
        {item.related.map((r, i) => (
          <a
            key={i}
            href={r.link}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:underline"
          >
            {r.label}
          </a>
        ))}
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
}: {
  def: NewsCategoryDef;
  items: NewsItem[];
  canDelete: boolean;
  canUp: boolean;
  canDown: boolean;
  onMove: (def: NewsCategoryDef, dir: "up" | "down") => void;
  onEdit: (def: NewsCategoryDef) => void;
  onDelete: (def: NewsCategoryDef) => void;
}) {
  const ctrl =
    "rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30";
  return (
    <section className="mt-8">
      <div
        className="mb-3 flex items-center gap-2 border-b pb-2"
        style={{ borderColor: def.color }}
      >
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
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          {items.map((it, i) => (
            <NewsItemCard key={i} item={it} color={def.color} />
          ))}
        </div>
      ) : (
        <p className="rounded-md bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          오늘은 해당 카테고리의 최신 뉴스가 없습니다.
        </p>
      )}
    </section>
  );
}

export function NewsBoard() {
  const [snap, setSnap] = useState<NewsSnapshot | null>(null);
  const [defs, setDefs] = useState<NewsCategoryDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dialog, setDialog] = useState<CategoryDialogState | null>(null);

  async function load() {
    try {
      const [s, d] = await Promise.all([api.news(), api.newsCategories()]);
      setSnap(s);
      setDefs(d);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      const [s] = await Promise.all([api.refreshNews(), api.newsCategories().then(setDefs)]);
      setSnap(s);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  async function move(def: NewsCategoryDef, dir: "up" | "down") {
    const idx = defs.findIndex((d) => d.key === def.key);
    const j = dir === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || j < 0 || j >= defs.length) return;
    const next = defs.slice();
    [next[idx], next[j]] = [next[j], next[idx]];
    setDefs(next); // 낙관적 업데이트
    try {
      await api.reorderNewsCategories(next.map((d) => d.key));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
      load(); // 실패 시 서버 상태로 복구
    }
  }

  async function deleteCategory(def: NewsCategoryDef) {
    if (!confirm(`'${def.label}' 카테고리를 삭제할까요?\n(다음 수집부터 제외됩니다)`)) return;
    try {
      await api.deleteNewsCategory(def.key);
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

  // 카테고리 정의(defs)를 기준으로 렌더하고, 스냅샷에서 key가 일치하는 기사만 매칭한다.
  // → 추가한 카테고리는 빈 섹션으로 즉시 보이고, 삭제한 카테고리는 바로 사라진다.
  const itemsByKey = new Map<string, NewsItem[]>();
  snap?.categories.forEach((c) => itemsByKey.set(c.key, c.items));

  const updated = snap?.updatedAt ? new Date(snap.updatedAt).toLocaleString("ko-KR") : null;
  const total = defs.reduce((a, d) => a + (itemsByKey.get(d.key)?.length ?? 0), 0);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <ScheduleControl kind="news" />
          <span>
            · 최근 24시간 뉴스 · 수집 시 이메일 발송(지금 갱신 포함)
            {updated && ` · 최종 갱신 ${updated}`}
            {snap && ` · 총 ${total}건`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setDialog({ mode: "add" })}>
            <Plus className="h-4 w-4" /> 카테고리 추가
          </Button>
          <Button variant="outline" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            지금 갱신
          </Button>
        </div>
      </div>

      {err && (
        <div className="mb-4 rounded-md border border-up/40 bg-up/10 px-4 py-3 text-sm text-up">{err}</div>
      )}

      {refreshing && !snap && (
        <p className="text-sm text-muted-foreground">뉴스를 수집하는 중입니다… (1~3분 소요)</p>
      )}

      {!defs.length ? (
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <Newspaper className="h-10 w-10" />
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
          />
        ))
      )}

      <CategoryDialog state={dialog} onClose={() => setDialog(null)} onSaved={load} />
    </div>
  );
}
