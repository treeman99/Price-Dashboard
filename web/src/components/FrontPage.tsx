import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";
import type { CategoryDef, StockMarket, StockSnapshot } from "@shared/types";
import { changeTone } from "@shared/stock";
import { safeHref } from "@shared/url";
import { api } from "@/lib/api";
import { formatWhen } from "@/lib/tabConfig";
import { cn } from "@/lib/utils";
import {
  eventsVisibleItems,
  newsItemId,
  snapshotFailed,
  youtubeFailed,
  youtubeItemId,
  type EventKind,
  type Feeds,
} from "@/lib/feed";
import { ensureBaseline, unseenIds, type SeenTabId } from "@/lib/seen";
import { LoadingState, Meta, MetaDot, PageToolbar, SectionHeader } from "@/components/ui/page";

/**
 * 1면 — 지난번 본 뒤 각 지면에 새로 들어온 것을 한 장에 추린다(1면 브리프).
 *
 * 맨 위 증시 한 줄, 그 아래 새 소식이 있는 지면(뉴스·유튜브·팝업·전시)의 머리기사, 마지막에
 * 새 소식이 없는 지면을 회색 한 줄씩. 1면은 미리 보기라 **읽음 처리하지 않는다** — 그 탭을 열고
 * 머물러야 정리된다(lib/seen.ts). 기록이 없는 지면의 기준 잡기만 예외다.
 *
 * 지면 데이터(feeds)는 App 이 탭 줄의 실패 점과 함께 불러 넘겨준다. 같은 것을 두 번 받지 않는다.
 */

/** 지면마다 1면에 올리는 머리기사 수. 나머지는 'N건 더 보기'로 그 탭에 넘긴다. */
const HEADLINES_PER_DESK = 3;
/** 증시 한 줄·다음 브리핑 시각을 다시 읽는 주기. 브리핑이 하루 몇 번뿐이라 길게 둔다. */
const STOCK_POLL_MS = 5 * 60_000;

export interface FrontTab {
  id: string;
  label: string;
  color: string;
}

interface Headline {
  id: string;
  title: string;
  href: string | null;
  meta: string[];
}

interface Desk {
  tab: SeenTabId;
  label: string;
  color: string;
  /** 불러오기 실패 — 모르는 상태를 '새 소식 없음'으로 단정하지 않는다. */
  unknown: boolean;
  hasSnapshot: boolean;
  updatedAt: string | null;
  collecting: boolean;
  failed: boolean;
  /** 지난번 그 탭을 본 뒤 새로 들어온 항목(화면 순서). */
  fresh: Headline[];
}

const EVENT_KIND_LABEL: Record<EventKind, string> = { popup: "팝업", exhibition: "전시", festival: "축제" };

/** 정의 순서대로 카테고리 라벨을 함께 펼친다(게시판과 같은 범위·순서 — lib/feed.ts 의 byDefs). */
function withCategory<T>(categories: { key: string; label: string; items: T[] }[], defs: CategoryDef[]) {
  const byKey = new Map(categories.map((c) => [c.key, c]));
  return defs.flatMap((d) => (byKey.get(d.key)?.items ?? []).map((item) => ({ item, category: d.label })));
}

function pick<T>(all: T[], ids: (t: T) => string, unseen: Set<string>): T[] {
  return all.filter((t) => unseen.has(ids(t)));
}

/** 지면별 '새로 들어온 것'. 읽음 기록은 렌더할 때마다 새로 읽는다 — 탭에 다녀오면 바로 줄어든다. */
function buildDesks(feeds: Feeds, tabs: Map<string, FrontTab>): Desk[] {
  const desk = (tab: SeenTabId): Pick<Desk, "tab" | "label" | "color"> => ({
    tab,
    label: tabs.get(tab)?.label ?? tab,
    color: tabs.get(tab)?.color ?? "currentColor",
  });
  const out: Desk[] = [];

  const news = feeds.news;
  if (news?.snap) {
    const rows = withCategory(news.snap.categories, news.defs);
    const unseen = new Set(unseenIds("news", rows.map((r) => newsItemId(r.item))));
    out.push({
      ...desk("news"),
      unknown: false,
      hasSnapshot: true,
      updatedAt: news.snap.updatedAt,
      collecting: !!news.status?.collecting,
      failed: snapshotFailed(news.snap, news.status),
      fresh: pick(rows, (r) => newsItemId(r.item), unseen).map(({ item, category }) => ({
        id: newsItemId(item),
        title: item.title,
        href: safeHref(item.link),
        meta: [item.source, category],
      })),
    });
  } else {
    out.push(emptyDesk(desk("news"), news === undefined, news?.status?.collecting));
  }

  const yt = feeds.youtube;
  if (yt?.snap) {
    const rows = withCategory(yt.snap.categories, yt.defs);
    const unseen = new Set(unseenIds("youtube", rows.map((r) => youtubeItemId(r.item))));
    out.push({
      ...desk("youtube"),
      unknown: false,
      hasSnapshot: true,
      updatedAt: yt.snap.updatedAt,
      collecting: !!yt.status?.collecting,
      failed: youtubeFailed(yt.status),
      // 이미 '본영상'으로 체크한 영상은 새 소식이 아니다(게시판의 '신규' 표시와 같은 규칙).
      fresh: pick(rows, (r) => youtubeItemId(r.item), unseen)
        .filter((r) => !r.item.watched)
        .map(({ item, category }) => ({
          id: youtubeItemId(item),
          title: item.title,
          href: safeHref(item.url),
          meta: [item.channel, category, item.duration ?? ""].filter(Boolean),
        })),
    });
  } else {
    out.push(emptyDesk(desk("youtube"), yt === undefined, yt?.status?.collecting));
  }

  const ev = feeds.events;
  if (ev?.snap) {
    const rows = eventsVisibleItems(ev.snap);
    const unseen = new Set(unseenIds("events", rows.map((r) => r.id)));
    out.push({
      ...desk("events"),
      unknown: false,
      hasSnapshot: true,
      updatedAt: ev.snap.updatedAt,
      collecting: !!ev.status?.collecting,
      failed: snapshotFailed(ev.snap, ev.status),
      fresh: pick(rows, (r) => r.id, unseen).map((r) => ({
        id: r.id,
        title: r.title,
        href: safeHref(r.link),
        meta: [EVENT_KIND_LABEL[r.kind], r.place, r.period].filter(Boolean),
      })),
    });
  } else {
    out.push(emptyDesk(desk("events"), ev === undefined, ev?.status?.collecting));
  }

  return out;
}

function emptyDesk(base: Pick<Desk, "tab" | "label" | "color">, unknown: boolean, collecting?: boolean): Desk {
  return { ...base, unknown, hasSnapshot: false, updatedAt: null, collecting: !!collecting, failed: false, fresh: [] };
}

/** 시각 표기는 다른 탭의 '최종 갱신'과 같은 형식(formatWhen: "오늘 21:19" · "내일 08:00" · "10/23(금) 18:00"). */
function whenLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : formatWhen(d, new Date());
}

/** "2026-10-23" → "10/23" */
function shortDate(ymd: string | null | undefined): string | null {
  const m = ymd?.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[1])}/${Number(m[2])}` : null;
}

export function FrontPage({
  tabs,
  feeds,
  onOpenTab,
}: {
  tabs: FrontTab[];
  /** null = 아직 첫 불러오기 전 */
  feeds: Feeds | null;
  onOpenTab: (id: string) => void;
}) {
  const tabMap = new Map(tabs.map((t) => [t.id, t]));

  // 기록이 없는 지면은 지금 목록으로 기준만 잡는다(첫 실행에 전부 '새 소식'으로 뒤덮이지 않게).
  // 기준 잡기는 부수 효과라 렌더가 아니라 여기서 한다 — 그 사이 렌더는 기록 없음 = 새 소식 0건으로 본다.
  useEffect(() => {
    if (!feeds) return;
    if (feeds.news?.snap) ensureBaseline("news", withCategory(feeds.news.snap.categories, feeds.news.defs).map((r) => newsItemId(r.item)));
    if (feeds.youtube?.snap)
      ensureBaseline("youtube", withCategory(feeds.youtube.snap.categories, feeds.youtube.defs).map((r) => youtubeItemId(r.item)));
    if (feeds.events?.snap) ensureBaseline("events", eventsVisibleItems(feeds.events.snap).map((r) => r.id));
  }, [feeds]);

  if (!feeds) return <LoadingState />;

  const desks = buildDesks(feeds, tabMap);
  const busy = desks.filter((d) => d.fresh.length > 0);
  const quiet = desks.filter((d) => d.fresh.length === 0);
  const total = busy.reduce((n, d) => n + d.fresh.length, 0);

  const open = (id: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    // 주소(#news)는 그대로 둬서 가운데 클릭·새 탭 열기가 되게 하고, 보통 클릭만 가로챈다.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onOpenTab(id);
  };

  return (
    <div>
      <PageToolbar>
        <Meta>
          <span title="탭을 열고 잠시 머물면 그 탭의 새 소식은 읽은 것으로 정리됩니다">
            지난번 본 뒤 새로 들어온 소식 <strong>{total}건</strong>
          </span>
        </Meta>
      </PageToolbar>

      <StockStrip tab={tabMap.get("stock")} onOpen={open("stock")} />

      {busy.length > 0 && (
        <div className="grid items-start gap-x-10 lg:grid-cols-2 2xl:grid-cols-3">
          {busy.map((d) => (
            <section key={d.tab} className="mb-8 min-w-0">
              <SectionHeader
                title={d.label}
                accent={d.color}
                note={`새 소식 ${d.fresh.length}건${d.updatedAt ? ` · ${whenLabel(d.updatedAt)} 갱신` : ""}`}
                className="mt-0"
              />
              {d.failed && <FailedLine />}
              <ul className="divide-y">
                {d.fresh.slice(0, HEADLINES_PER_DESK).map((h) => (
                  <HeadlineRow key={h.id} h={h} />
                ))}
              </ul>
              <DeskLink href={`#${d.tab}`} onClick={open(d.tab)}>
                {d.fresh.length > HEADLINES_PER_DESK
                  ? `${d.label}에서 ${d.fresh.length - HEADLINES_PER_DESK}건 더 보기`
                  : `${d.label} 열기`}
              </DeskLink>
            </section>
          ))}
        </div>
      )}

      {quiet.length > 0 && (
        <section>
          <SectionHeader
            title={busy.length ? "그 밖의 지면" : "새 소식 없음"}
            // 전부 조용한 날은 제목과 툴바(0건)가 이미 같은 말을 한다 — 메모를 겹쳐 달지 않는다.
            note={busy.length ? "새 소식 없음" : undefined}
          />
          <ul className="divide-y">
            {quiet.map((d) => (
              <li key={d.tab} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-2.5 text-sm">
                <span aria-hidden className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: d.color }} />
                <a
                  href={`#${d.tab}`}
                  onClick={open(d.tab)}
                  className="font-medium underline-offset-[3px] hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {d.label}
                </a>
                <span className="num text-[13px] text-muted-foreground">{quietStatus(d)}</span>
                {d.failed && <FailedLine inline />}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function quietStatus(d: Desk): string {
  if (d.collecting) return "수집 중…";
  if (d.unknown) return "불러오지 못했습니다";
  if (!d.hasSnapshot) return "아직 수집 전";
  return d.updatedAt ? `${whenLabel(d.updatedAt)} 갱신` : "새 소식 없음";
}

/** 지면 안의 수집 실패 표시. 탭 줄 경고 점과 같은 조건이고, 자세한 사유는 그 탭의 경고 띠에 있다. */
function FailedLine({ inline }: { inline?: boolean }) {
  return (
    <p
      className={cn(
        "flex items-center gap-1.5 text-[13px] font-medium text-tone-warn [&_svg]:h-3.5 [&_svg]:w-3.5",
        !inline && "mb-1"
      )}
    >
      <AlertTriangle aria-hidden />
      오늘 수집이 실패해 이전 내용입니다
    </p>
  );
}

function HeadlineRow({ h }: { h: Headline }) {
  const title = (
    <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug">
      {h.href ? (
        <a
          href={h.href}
          target="_blank"
          rel="noreferrer"
          className="underline-offset-[3px] hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {h.title}
        </a>
      ) : (
        h.title
      )}
    </h3>
  );
  return (
    <li className="py-2.5">
      {title}
      {h.meta.length > 0 && (
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-muted-foreground">
          {/* 가운뎃점은 앞 조각 끝에 붙인다 — 줄이 바뀌어도 새 줄이 점으로 시작하지 않게. */}
          {h.meta.map((m, i) => (
            <span key={i} className="inline-flex items-center gap-1.5">
              {m}
              {i < h.meta.length - 1 && <MetaDot />}
            </span>
          ))}
        </p>
      )}
    </li>
  );
}

/** 지면 끝 '그 탭으로' 링크. 행 안 보조 링크(TextLink)와 같은 말투지만 새 창이 아니라 탭 전환이다. */
function DeskLink({
  href,
  onClick,
  children,
}: {
  href: string;
  onClick: (e: MouseEvent<HTMLAnchorElement>) => void;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      onClick={onClick}
      className="mt-1.5 inline-flex items-center gap-1 text-[13px] font-medium text-muted-foreground underline-offset-[3px] transition-colors hover:text-foreground hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:h-3.5 [&_svg]:w-3.5"
    >
      {children}
      <ArrowRight aria-hidden />
    </a>
  );
}

// ── 증시 한 줄 ────────────────────────────────────────────────────────────────

interface StockState {
  kr: StockSnapshot | null;
  us: StockSnapshot | null;
  /** 다음 브리핑(한국장·미국장 중 이른 것). 둘 다 꺼져 있으면 null. */
  next: { at: string; market: StockMarket } | null;
}

function useStockLine(): StockState | null {
  const [state, setState] = useState<StockState | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [kr, us, schedule] = await Promise.all([
        api.stock("kr").catch(() => null),
        api.stock("us").catch(() => null),
        api.schedule().catch(() => null),
      ]);
      const candidates = (
        [
          ["kr", schedule?.next.stockKr],
          ["us", schedule?.next.stockUs],
        ] as const
      ).filter((c): c is readonly [StockMarket, string] => !!c[1]);
      candidates.sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]));
      const first = candidates[0];
      if (alive) setState({ kr, us, next: first ? { market: first[0], at: first[1] } : null });
    };
    void load();
    const t = setInterval(() => void load(), STOCK_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return state;
}

function StockStrip({
  tab,
  onOpen,
}: {
  tab: FrontTab | undefined;
  onOpen: (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const state = useStockLine();
  // 증시는 부가 한 줄이다. 못 불러왔으면 자리를 비워 두고(지면들이 위로 올라온다) 오류를 띄우지 않는다.
  if (!state || (!state.kr && !state.us)) return null;

  const groups: { market: StockMarket; name: string; snap: StockSnapshot }[] = [];
  for (const [market, name, snap] of [
    ["kr", "한국장", state.kr],
    ["us", "미국장", state.us],
  ] as const) {
    if (snap && snap.indices.length > 0) groups.push({ market, name, snap });
  }

  return (
    <section aria-label="증시" className="mb-9 flex flex-wrap items-baseline gap-x-6 gap-y-2">
      <a
        href="#stock"
        onClick={onOpen}
        className="inline-flex items-center gap-2 text-[15px] font-semibold underline-offset-[3px] hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: tab?.color }} />
        {tab?.label ?? "증시"}
      </a>
      {groups.map(({ market, name, snap }) => {
        // 지수 값은 마지막 거래일 종가다. 휴장일엔 그 사실을 한 번만 적는다(증시 탭의 휴장 안내와 같은 사실).
        const hist = snap.indices[0]?.history ?? [];
        const asOf = shortDate(hist[hist.length - 1]?.date);
        const closed = snap.closed ? `휴장${snap.closedReason ? `(${snap.closedReason})` : ""}` : null;
        return (
          <div key={market} className="flex flex-wrap items-baseline gap-x-4 gap-y-1" aria-label={name}>
            {snap.indices.map((idx) => (
              <span key={idx.name} className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
                <span className="text-[13px] text-muted-foreground">{idx.name}</span>
                <span className="num text-[15px] font-semibold">
                  {idx.value != null ? idx.value.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : "-"}
                </span>
                <span className={cn("num text-[13px] font-semibold", pctTone(idx.changePct))}>
                  {idx.changePct != null ? `${idx.changePct > 0 ? "+" : ""}${idx.changePct.toFixed(2)}%` : "-"}
                </span>
              </span>
            ))}
            {(closed || asOf) && (
              <span className="num text-[12.5px] text-muted-foreground">
                {[closed, asOf && `${asOf} 종가`].filter(Boolean).join(" · ")}
              </span>
            )}
          </div>
        );
      })}
      {state.next && (
        <span className="num text-[12.5px] text-muted-foreground lg:ml-auto">
          다음 브리핑 <strong className="font-medium text-foreground">{whenLabel(state.next.at)}</strong>
          {state.next.market === "us" ? " (미국장)" : " (한국장)"}
        </span>
      )}
    </section>
  );
}

function pctTone(pct: number | null): string {
  const t = changeTone(pct);
  return t === "up" ? "text-up" : t === "down" ? "text-stock-down" : "text-muted-foreground";
}
