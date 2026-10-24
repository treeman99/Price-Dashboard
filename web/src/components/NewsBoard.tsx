import { useEffect, useState } from "react";
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
  return (
    // break-inside-avoid: 카테고리 블록이 두 단에 걸쳐 쪼개지지 않게 한다.
    <section className="group/cat mb-8 break-inside-avoid">
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
        <ul className="divide-y">
          {items.map((it, i) => (
            <NewsRow key={i} item={it} />
          ))}
        </ul>
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
        // 신문 다단: 카테고리마다 기사가 1~3건뿐이라 그리드로 깔면 오른쪽이 빈다.
        // 블록째 단에 흘려 넣어 짧은 카테고리도 빈칸 없이 화면 폭을 채운다.
        <div className="col-rule columns-1 gap-10 lg:columns-2 2xl:columns-3 min-[2200px]:columns-4">
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
