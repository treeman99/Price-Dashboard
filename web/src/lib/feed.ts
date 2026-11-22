import type { EventsSnapshot, ExhibitionItem, FestivalItem, NewsSnapshot, PopupItem } from "@shared/types";
import type { DailyReportEntryView, DailyReportListResponse, DailyReportRunView } from "@shared/report";
import { exhibitionKey, festivalKey, popupKey, withLinkedItemsOnly } from "@shared/events";
import { snapshotHealth } from "@/components/SnapshotNotice";
import { api, type CollectStatus, type DailyReportRunDetail } from "@/lib/api";

/**
 * 1면과 '신규' 표시가 함께 쓰는 지면 단위 도구.
 *
 * 항목 식별자와 '화면에 실제로 보이는 목록'의 기준을 여기 한 곳에 둔다. 게시판이 보여 주는 목록과
 * 1면이 세는 목록이 어긋나면, 1면은 '새 소식 3건'이라는데 탭에 가면 '신규'가 없는 일이 생긴다.
 */

// ── 항목 식별자 ──────────────────────────────────────────────────────────────

/**
 * 보고서 항목: 서버가 준 안정 키(영상 `yt:<ID>`, 기사 정규화 URL). 2026-11-23 뉴스·유튜브 탭을 없애고
 * 보고서 탭 하나로 합치면서 1면·'신규' 표시는 이 키로 센다.
 */
export const reportItemId = (e: DailyReportEntryView) => e.key;

/** 행사: 서버 '신규' 판정과 같은 정규화 키(shared/events.ts). 전시는 전시장 묶음 이름까지 포함한다. */
export const popupItemId = (p: PopupItem) => popupKey(p.name);
export const exhibitionItemId = (venueName: string, e: ExhibitionItem) => exhibitionKey(venueName, e.title);
export const festivalItemId = (f: FestivalItem) => festivalKey(f.name);

// ── 화면에 보이는 목록 ───────────────────────────────────────────────────────

/**
 * 보고서 한 실행에서 화면에 기본으로 보이는 항목: 뉴스 → 유튜브, 카테고리 순. 사용자가 제외·차단한 항목
 * (제외 영상·차단 채널·제외 사이트)은 보고서 탭이 숨기므로 여기서도 뺀다. 본영상은 새 소식이 아니다.
 */
export function reportVisibleItems(r: DailyReportRunView): DailyReportEntryView[] {
  return [...r.news, ...r.youtube].flatMap((s) => s.items).filter((e) => !isHiddenEntry(e));
}

/** 보고서 탭이 기본으로 숨기는 항목인가(제외 영상·차단 채널·제외 사이트). */
export function isHiddenEntry(e: DailyReportEntryView): boolean {
  return !!(e.state.dismissed || e.state.blocked || e.state.excluded);
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

/** 보고서: 실행 중이 아니고 마지막 실행이 실패로 남아 있는 경우(보고서 탭의 실패 안내와 같은 조건). */
export function reportFailed(o: DailyReportListResponse | null): boolean {
  return !!o && !o.running && !!o.lastAttempt && !o.lastAttempt.ok;
}

// ── 한 번에 불러오기 ─────────────────────────────────────────────────────────

export interface FeedTab<S, T> {
  snap: S | null;
  status: T | null;
}

/** 보고서 지면: 실행 목록·상태 + 최신 실행 보기(없으면 null). */
export interface ReportFeed {
  overview: DailyReportListResponse;
  latest: DailyReportRunDetail | null;
}

export interface Feeds {
  /** 불러오기에 실패한 지면은 undefined — 모르는 상태를 '실패'나 '새 소식 없음'으로 단정하지 않는다. */
  report?: ReportFeed;
  events?: FeedTab<EventsSnapshot, CollectStatus>;
}

/** 상태 폴링 실패는 null 로 접는다. 스냅샷만 있으면 목록은 그릴 수 있다. */
const orNull = <T,>(p: Promise<T>) => p.catch(() => null);

async function loadReportFeed(): Promise<ReportFeed> {
  const overview = await api.report();
  const latestId = overview.runs[0]?.runId;
  return { overview, latest: latestId ? await orNull(api.reportRun(latestId)) : null };
}

export async function loadFeeds(): Promise<Feeds> {
  const [report, events] = await Promise.allSettled([
    loadReportFeed(),
    Promise.all([api.events(), orNull(api.eventsStatus())]),
  ]);
  return {
    report: report.status === "fulfilled" ? report.value : undefined,
    events: events.status === "fulfilled" ? { snap: events.value[0], status: events.value[1] } : undefined,
  };
}

/** 탭 줄 경고 점: 오늘 수집이 실패한 탭 id. */
export function failedTabs(feeds: Feeds): Set<string> {
  const out = new Set<string>();
  if (feeds.report && reportFailed(feeds.report.overview)) out.add("report");
  if (feeds.events && snapshotFailed(feeds.events.snap, feeds.events.status)) out.add("events");
  return out;
}
