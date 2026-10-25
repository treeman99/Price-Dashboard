import type {
  CategoryDef,
  EventsSnapshot,
  ExhibitionItem,
  FestivalItem,
  NewsItem,
  NewsSnapshot,
  PopupItem,
  YoutubeSnapshot,
  YoutubeVideo,
} from "@shared/types";
import { exhibitionKey, festivalKey, popupKey, withLinkedItemsOnly } from "@shared/events";
import { snapshotHealth } from "@/components/SnapshotNotice";
import { api, type CollectStatus } from "@/lib/api";

/**
 * 1면과 '신규' 표시가 함께 쓰는 지면 단위 도구.
 *
 * 항목 식별자와 '화면에 실제로 보이는 목록'의 기준을 여기 한 곳에 둔다. 게시판이 보여 주는 목록과
 * 1면이 세는 목록이 어긋나면, 1면은 '새 소식 3건'이라는데 탭에 가면 '신규'가 없는 일이 생긴다.
 */

// ── 항목 식별자 ──────────────────────────────────────────────────────────────

/** 뉴스: 원문 링크. 링크가 없으면 출처+제목. */
export function newsItemId(item: NewsItem): string {
  return item.link ?? `${item.source}|${item.title}`;
}

/** 유튜브: videoId(11자 안정 식별자). 없으면 watch URL. */
export function youtubeItemId(video: YoutubeVideo): string {
  return video.videoId ?? video.url;
}

/** 행사: 서버 '신규' 판정과 같은 정규화 키(shared/events.ts). 전시는 전시장 묶음 이름까지 포함한다. */
export const popupItemId = (p: PopupItem) => popupKey(p.name);
export const exhibitionItemId = (venueName: string, e: ExhibitionItem) => exhibitionKey(venueName, e.title);
export const festivalItemId = (f: FestivalItem) => festivalKey(f.name);

// ── 화면에 보이는 목록 ───────────────────────────────────────────────────────

/**
 * 카테고리 정의 순서대로, 정의에 있는 카테고리의 항목만. 게시판이 그리는 순서·범위와 같다
 * (정의에서 지운 카테고리가 스냅샷에 남아 있어도 화면에는 없다).
 */
function byDefs<T>(categories: { key: string; items: T[] }[], defs: CategoryDef[]): T[] {
  const byKey = new Map(categories.map((c) => [c.key, c.items]));
  return defs.flatMap((d) => byKey.get(d.key) ?? []);
}

export function newsVisibleItems(snap: NewsSnapshot, defs: CategoryDef[]): NewsItem[] {
  return byDefs(snap.categories, defs);
}

export function youtubeVisibleItems(snap: YoutubeSnapshot, defs: CategoryDef[]): YoutubeVideo[] {
  return byDefs(snap.categories, defs);
}

export type EventKind = "popup" | "exhibition" | "festival";

export interface EventEntry {
  id: string;
  kind: EventKind;
  title: string;
  place: string;
  period: string;
  link: string | null;
}

/** 팝업 → 전시 → 축제 순. 출처 링크가 없는 항목은 게시판처럼 뺀다(withLinkedItemsOnly). */
export function eventsVisibleItems(snap: EventsSnapshot): EventEntry[] {
  const shown = withLinkedItemsOnly(snap);
  return [
    ...shown.popups.map((p) => ({
      id: popupItemId(p),
      kind: "popup" as const,
      title: p.name,
      place: p.region,
      period: p.period,
      link: p.link,
    })),
    ...shown.exhibitions.venues.flatMap((v) =>
      v.items.map((e) => ({
        id: exhibitionItemId(v.name, e),
        kind: "exhibition" as const,
        title: e.title,
        place: e.venue,
        period: e.period,
        link: e.link,
      }))
    ),
    ...shown.festivals.map((f) => ({
      id: festivalItemId(f),
      kind: "festival" as const,
      title: f.name,
      place: f.region,
      period: f.period,
      link: f.link,
    })),
  ];
}

// ── 수집 실패 판정 ───────────────────────────────────────────────────────────
// 탭 줄의 경고 점은 그 탭을 열었을 때 경고 띠가 보이는 경우와 정확히 같아야 한다.
// 그래서 각 게시판이 경고 띠를 띄우는 조건을 그대로 옮겨 둔다.

/** 뉴스·팝업·전시: SnapshotNotice 가 경고 톤(오늘 실패·원본 그대로)을 띄우는 경우. */
export function snapshotFailed(
  snap: NewsSnapshot | EventsSnapshot | null,
  status: CollectStatus | null
): boolean {
  return snapshotHealth(snap, status?.lastAttempt, { collecting: status?.collecting })?.tone === "warn";
}

/** 유튜브: 수집 중이 아니고 마지막 시도가 실패로 남아 있는 경우(YoutubeBoard 의 실패 안내와 같은 조건). */
export function youtubeFailed(status: { collecting: boolean; lastAttempt: { ok: boolean } | null } | null): boolean {
  return !!status && !status.collecting && !!status.lastAttempt && !status.lastAttempt.ok;
}

// ── 한 번에 불러오기 ─────────────────────────────────────────────────────────

type YoutubeStatus = Awaited<ReturnType<typeof api.youtubeStatus>>;

export interface FeedTab<S, T> {
  snap: S | null;
  status: T | null;
  defs: CategoryDef[];
}

export interface Feeds {
  /** 불러오기에 실패한 탭은 undefined — 모르는 상태를 '실패'나 '새 소식 없음'으로 단정하지 않는다. */
  news?: FeedTab<NewsSnapshot, CollectStatus>;
  youtube?: FeedTab<YoutubeSnapshot, YoutubeStatus>;
  events?: FeedTab<EventsSnapshot, CollectStatus>;
}

/** 상태 폴링 실패는 null 로 접는다. 스냅샷만 있으면 목록은 그릴 수 있다. */
const orNull = <T,>(p: Promise<T>) => p.catch(() => null);

export async function loadFeeds(): Promise<Feeds> {
  const [news, youtube, events] = await Promise.allSettled([
    Promise.all([api.news(), orNull(api.newsStatus()), api.newsCategories()]),
    Promise.all([api.youtube(), orNull(api.youtubeStatus()), api.youtubeCategories()]),
    Promise.all([api.events(), orNull(api.eventsStatus())]),
  ]);
  return {
    news: news.status === "fulfilled" ? { snap: news.value[0], status: news.value[1], defs: news.value[2] } : undefined,
    youtube:
      youtube.status === "fulfilled"
        ? { snap: youtube.value[0], status: youtube.value[1], defs: youtube.value[2] }
        : undefined,
    events: events.status === "fulfilled" ? { snap: events.value[0], status: events.value[1], defs: [] } : undefined,
  };
}

/** 탭 줄 경고 점: 오늘 수집이 실패한 탭 id. */
export function failedTabs(feeds: Feeds): Set<string> {
  const out = new Set<string>();
  if (feeds.news && snapshotFailed(feeds.news.snap, feeds.news.status)) out.add("news");
  if (feeds.youtube && youtubeFailed(feeds.youtube.status)) out.add("youtube");
  if (feeds.events && snapshotFailed(feeds.events.snap, feeds.events.status)) out.add("events");
  return out;
}
