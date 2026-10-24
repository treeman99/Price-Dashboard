import { useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  Loader2,
  Newspaper,
  Link as LinkIcon,
  X,
  Pencil,
  Plus,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import type { NewsSnapshot, NewsItem, NewsCategoryDef } from "@shared/types";
import { safeHref } from "@shared/url";
import { api, type CollectAttempt } from "@/lib/api";
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
import { ScheduleControl } from "@/components/ScheduleControl";
import { CategoryDialog, type CategoryDialogState } from "@/components/CategoryDialog";
import { SnapshotNotice, snapshotHealth } from "@/components/SnapshotNotice";

function NewsRow({ item }: { item: NewsItem }) {
  const href = safeHref(item.link);
  return (
    <li className="py-3">
      <h3 className="text-[15px] font-semibold leading-snug">{item.title}</h3>
      {/* 출처 / 날짜 */}
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        {item.source}
        <span aria-hidden className="mx-1.5 text-muted-foreground/50">
          ·
        </span>
        <span className="num">{item.date}</span>
      </p>
      {/* 요약 — 고정 높이 없이 전문을 그대로 보여준다(다단이 높이 차이를 흡수한다) */}
      <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-foreground/80">{item.summary}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {href && (
          <TextLink href={href} icon={<LinkIcon />}>
            원문 보기
          </TextLink>
        )}
        {item.related.map((r, i) => {
          const rHref = safeHref(r.link);
          // 관련 링크 라벨은 길 수 있어 좁은 단에서 줄바꿈되게 둔다.
          return rHref ? (
            <TextLink key={i} href={rHref} className="whitespace-normal">
              {r.label}
            </TextLink>
          ) : (
            <span key={i} className="text-[12.5px] text-muted-foreground">
              {r.label}
            </span>
          );
        })}
      </div>
    </li>
  );
}

/**
 * 카테고리마다 처음에 보이는 기사 수. 평소엔 카테고리당 1~3건이라 버튼이 안 뜨고,
 * 많은 날(실측 최대 총 76건·한 카테고리 12건)에도 카테고리 한 줄이 화면 한 장 남짓에 머문다.
 */
const PREVIEW_COUNT = 4;

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
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const hidden = items.length - PREVIEW_COUNT;
  const shown = open || hidden <= 0 ? items : items.slice(0, PREVIEW_COUNT);

  function collapse() {
    setOpen(false);
    // 긴 목록 아래에서 접으면 카테고리 머리가 화면 위로 사라지므로 머리로 되돌아간다.
    const el = ref.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start" });
  }

  return (
    // scroll-mt: 상단 고정 헤더에 카테고리 머리가 가려지지 않게.
    <section ref={ref} className="group/cat scroll-mt-32">
      <SectionHeader
        className="mt-0"
        title={`${def.emoji} ${def.label}`}
        accent={def.color}
        count={items.length}
        actions={
          // 평소엔 흐리게 두고, 블록에 마우스를 올리거나 키보드 포커스가 들어오면 또렷하게.
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
        <>
          <ul className="divide-y">
            {shown.map((it, i) => (
              <NewsRow key={i} item={it} />
            ))}
          </ul>
          {hidden > 0 && (
            <button
              type="button"
              onClick={open ? collapse : () => setOpen(true)}
              aria-expanded={open}
              className="flex w-full items-center gap-1 border-t py-2.5 text-left text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {open ? (
                <>
                  <ChevronUp className="h-3.5 w-3.5" /> 접기
                </>
              ) : (
                <>
                  <ChevronDown className="h-3.5 w-3.5" /> {hidden}건 더 보기
                </>
              )}
            </button>
          )}
        </>
      ) : (
        <EmptyLine>오늘은 해당 카테고리의 최신 뉴스가 없습니다.</EmptyLine>
      )}
    </section>
  );
}

export function NewsBoard() {
  const [snap, setSnap] = useState<NewsSnapshot | null>(null);
  const [defs, setDefs] = useState<NewsCategoryDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 마지막 수집 '시도'의 성패. 스냅샷만으로는 "실패해서 어제 것"과 "아직 오늘 수집 전"을 못 가른다.
  const [attempt, setAttempt] = useState<CollectAttempt | null>(null);
  // 다른 탭이 AI 수집을 붙잡고 있어 '지금 갱신'이 시작조차 못 한 경우의 안내.
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
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
  /** 진행 상태 + 마지막 시도 기록을 갱신하고 '수집 중'인지 돌려준다(실패하면 null). */
  async function checkStatus(): Promise<boolean | null> {
    try {
      const s = await api.newsStatus();
      setCollecting(s.collecting);
      setAttempt(s.lastAttempt ?? null);
      return s.collecting;
    } catch {
      return null; // 상태 폴링 실패는 무시(다음 주기에 재시도)
    }
  }
  useEffect(() => {
    load();
    checkStatus(); // 진입 시 (예: 정시 수집이 돌고 있으면) '수집 중'을 즉시 반영
  }, []);

  // 수집 중이면 5초마다 상태 확인 → 완료되면 스냅샷을 자동으로 다시 불러온다.
  // 실패로 끝났다면 스냅샷은 그대로겠지만, 함께 받아 둔 시도 기록이 안내 배너로 이유를 설명한다.
  useEffect(() => {
    if (!collecting) return;
    const id = setInterval(async () => {
      if ((await checkStatus()) === false) await load(); // 완료 → 새 결과 반영
    }, 5000);
    return () => clearInterval(id);
  }, [collecting]);

  async function refresh() {
    setErr(null);
    setBusyMsg(null);
    try {
      const r = await api.refreshNews(); // 백그라운드 시작(202) 또는 시작 불가(409)
      if (r.busy && !r.collecting) {
        // 다른 탭이 AI 수집을 붙잡고 있다 → 시작된 게 없으므로 '수집 중'으로 넘어가면 안 된다.
        setBusyMsg(r.reason);
        return;
      }
      setCollecting(true); // '수집 중' 배너 + 폴링 시작 → 완료되면 자동 반영
      api.newsCategories().then(setDefs).catch(() => {}); // 새 카테고리 즉시 반영
    } catch (e) {
      setErr((e as Error).message); // 5xx 등 진짜 실패만 표시
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
    return <LoadingState />;
  }

  // 카테고리 정의(defs)를 기준으로 렌더하고, 스냅샷에서 key가 일치하는 기사만 매칭한다.
  // → 추가한 카테고리는 빈 섹션으로 즉시 보이고, 삭제한 카테고리는 바로 사라진다.
  const itemsByKey = new Map<string, NewsItem[]>();
  snap?.categories.forEach((c) => itemsByKey.set(c.key, c.items));

  const updated = snap?.updatedAt ? new Date(snap.updatedAt).toLocaleString("ko-KR") : null;
  const total = defs.reduce((a, d) => a + (itemsByKey.get(d.key)?.length ?? 0), 0);

  return (
    <div>
      <PageToolbar
        actions={
          <>
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
        <ScheduleControl kind="news" />
        <MetaDot />
        <Meta>최근 24시간 뉴스</Meta>
        <MetaDot />
        <Meta>수집 시 이메일 발송(지금 갱신 포함)</Meta>
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

      {busyMsg && <Notice tone="warn">{busyMsg}</Notice>}

      {collecting && (
        <Notice tone="info" progress>
          뉴스를 수집하는 중입니다… 1~3분 걸릴 수 있고, 완료되면 자동으로 반영됩니다.
        </Notice>
      )}

      {/* 실패해도 어제 스냅샷이 그대로 남아 '오늘 것'처럼 보이므로, 어느 날짜인지 반드시 알린다. */}
      <SnapshotNotice
        health={snapshotHealth(snap, attempt, { collecting })}
        notes={snap?.notes}
      />

      {!defs.length ? (
        <EmptyState
          icon={<Newspaper />}
          action={
            <Button variant="outline" onClick={() => setDialog({ mode: "add" })}>
              <Plus className="h-4 w-4" /> 카테고리 추가
            </Button>
          }
        >
          카테고리가 없습니다. 카테고리를 추가하세요.
        </EmptyState>
      ) : (
        // 카테고리를 가로로 줄 세운다(왼→오, 위→아래 = 카테고리 순서). 세로 다단(columns)은 기사가 많은 날
        // 한 단이 화면 대여섯 장 길이가 되어, 끝까지 내려 읽고 다시 맨 위로 올라가 다음 단을 읽어야 했다.
        // 줄마다 높이는 PREVIEW_COUNT 가 묶어 둔다.
        <div className="grid grid-cols-1 items-start gap-x-10 gap-y-10 lg:grid-cols-2 2xl:grid-cols-3 min-[2200px]:grid-cols-4">
          {defs.map((def, i) => (
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
          ))}
        </div>
      )}

      <CategoryDialog state={dialog} onClose={() => setDialog(null)} onSaved={load} />
    </div>
  );
}
