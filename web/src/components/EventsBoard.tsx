import { useEffect, useState } from "react";
import { RefreshCw, Loader2, Sparkles, Link as LinkIcon, CalendarPlus } from "lucide-react";
import type { EventsSnapshot, PopupItem, ExhibitionItem, FestivalItem, EventTag } from "@shared/types";
import { googleCalendarUrl } from "@shared/calendar";
import { splitPopupsByRegion, withLinkedItemsOnly, POPUP_GROUPS } from "@shared/events";
import { safeHref } from "@shared/url";
import { api, type CollectAttempt } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  PageToolbar,
  Meta,
  MetaDot,
  Notice,
  SectionHeader,
  SubHeader,
  StatusTag,
  TextLink,
  EmptyState,
  EmptyLine,
  LoadingState,
  type TagTone,
} from "@/components/ui/page";
import { NotifyMeta, ScheduleControl } from "@/components/ScheduleControl";
import { SnapshotNotice, localDay, snapshotHealth } from "@/components/SnapshotNotice";
import { formatWhen } from "@/lib/tabConfig";
import { eventsVisibleItems, exhibitionItemId, festivalItemId, popupItemId } from "@/lib/feed";
import { NewMarksProvider, useIsNew, useNewMarks } from "@/lib/seen";

/** 섹션 고유색. 섹션 제목 앞 작은 사각형에만 쓴다. */
const ACCENT = { popup: "#7C3AED", exhibition: "#FF8C00", festival: "#E8590C" } as const;

const TAG_STYLE: Record<Exclude<EventTag, null>, { tone: TagTone; label: string }> = {
  신규: { tone: "new", label: "신규" },
  종료임박: { tone: "urgent", label: "종료임박" },
  예정: { tone: "soon", label: "오픈예정" },
};

/**
 * '종료임박'(7일 안에 끝남)이 축제 목록의 대부분을 덮던 날이 있었다(11건 중 9건, 그중 7건이 오늘 종료).
 * 오늘 끝나는 행사만 빨간 '오늘 종료'로 가르고, 나머지 종료임박은 호박색으로 한 단계 낮춘다.
 * 태그 계산 자체(서버 computeTag·메일)는 그대로 두고 화면 표기만 나눈다.
 */
const ENDS_TODAY = { tone: "urgent" as TagTone, label: "오늘 종료" };
const ENDING_SOON = { tone: "warn" as TagTone, label: "종료임박" };

function TagBadge({ tag, endDate }: { tag: EventTag; endDate: string | null }) {
  if (!tag) return null;
  const s = tag === "종료임박" ? (endDate === localDay() ? ENDS_TODAY : ENDING_SOON) : TAG_STYLE[tag];
  return <StatusTag tone={s.tone}>{s.label}</StatusTag>;
}

/**
 * '신규' 배지 — 날짜 기반 태그와 함께 노출된다. 두 가지 이유로 붙는다.
 *  - isNew: 서버 판정. 약 일주일 이상 목록에 없다가 새로 등장한 행사.
 *  - fresh: 화면 판정. 지난번 이 탭을 본 뒤 새로 들어온 행사(lib/seen.ts).
 * 같은 낱말에 배지를 둘 달면 무엇이 다른지 읽히지 않으므로 하나로 합치고 이유는 툴팁에 적는다.
 */
function NewBadge({ isNew, fresh }: { isNew?: boolean; fresh?: boolean }) {
  if (!isNew && !fresh) return null;
  return (
    <StatusTag
      tone={TAG_STYLE.신규.tone}
      title={isNew ? "약 일주일 만에 새로 등장한 행사" : "지난번 이 탭을 본 뒤 새로 들어온 행사"}
    >
      {TAG_STYLE.신규.label}
    </StatusTag>
  );
}

function SourceLink({ link }: { link: string | null }) {
  const href = safeHref(link);
  if (!href) return null;
  return (
    <TextLink href={href} icon={<LinkIcon />}>
      보기
    </TextLink>
  );
}

function CalendarButton({
  title,
  startDate,
  endDate,
  location,
  details,
}: {
  title: string;
  startDate: string | null;
  endDate: string | null;
  location?: string;
  details?: string;
}) {
  const url = googleCalendarUrl({ title, startDate, endDate, location, details });
  if (!url) return null; // 날짜 없으면 캘린더 추가 불가
  return (
    <TextLink href={url} icon={<CalendarPlus />} title="구글 캘린더에 추가">
      캘린더 추가
    </TextLink>
  );
}

/** 표 한 행의 공통 형태. 팝업·전시·축제가 같은 열 구성(상태·이름·장소·기간·분류·링크)을 쓴다. */
interface EventRowData {
  /** 행사 식별키(lib/feed.ts) — '지난번 본 뒤 신규' 판정에 쓴다. */
  id: string;
  title: string;
  tag: EventTag;
  isNew?: boolean;
  place: string;
  period: string;
  category?: string | null;
  summary: string;
  link: string | null;
  cal: { title: string; startDate: string | null; endDate: string | null; location: string; details: string };
}

function popupRow(p: PopupItem): EventRowData {
  return {
    id: popupItemId(p),
    title: p.name,
    tag: p.tag,
    isNew: p.isNew,
    place: p.region,
    period: p.period,
    category: p.category,
    summary: p.summary,
    link: p.link,
    cal: {
      title: p.name,
      startDate: p.startDate,
      endDate: p.endDate,
      location: p.region,
      details: [p.summary, p.link].filter(Boolean).join("\n"),
    },
  };
}

function exhRow(e: ExhibitionItem, venueName: string): EventRowData {
  return {
    id: exhibitionItemId(venueName, e),
    title: e.title,
    tag: e.tag,
    isNew: e.isNew,
    place: e.venue,
    period: e.period,
    summary: e.summary,
    link: e.link,
    cal: {
      title: e.title,
      startDate: e.startDate,
      endDate: e.endDate,
      location: e.venue,
      details: [e.summary, e.link].filter(Boolean).join("\n"),
    },
  };
}

function festivalRow(f: FestivalItem): EventRowData {
  return {
    id: festivalItemId(f),
    title: f.name,
    tag: f.tag,
    isNew: f.isNew,
    place: f.region,
    period: f.period,
    summary: f.summary,
    link: f.link,
    cal: {
      title: f.name,
      startDate: f.startDate,
      endDate: f.endDate,
      location: f.region,
      details: [f.summary, f.link].filter(Boolean).join("\n"),
    },
  };
}

function EventRow({ r }: { r: EventRowData }) {
  const { cal } = r;
  const fresh = useIsNew(r.id);
  return (
    <tr>
      <td>
        <div className="flex flex-wrap gap-1 pt-px">
          <NewBadge isNew={r.isNew} fresh={fresh} />
          <TagBadge tag={r.tag} endDate={cal.endDate} />
        </div>
      </td>
      <td>
        <div className="text-[15px] font-semibold leading-snug">
          {r.title}
          {r.category && <span className="ml-2 text-[12.5px] font-normal text-muted-foreground">{r.category}</span>}
        </div>
        {r.summary && (
          <p className="mt-0.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{r.summary}</p>
        )}
      </td>
      <td className="text-[13.5px]">{r.place}</td>
      <td className="num text-[13.5px]">{r.period}</td>
      <td>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <SourceLink link={r.link} />
          <CalendarButton
            title={cal.title}
            startDate={cal.startDate}
            endDate={cal.endDate}
            location={cal.location}
            details={cal.details}
          />
          {!safeHref(r.link) && !googleCalendarUrl({ title: cal.title, startDate: cal.startDate, endDate: cal.endDate }) && (
            <span className="text-[12.5px] text-muted-foreground/60">링크 없음</span>
          )}
        </div>
      </td>
    </tr>
  );
}

const COLS = 5;

/**
 * 세 섹션이 같은 열 너비를 쓰도록 table-fixed + 고정 colgroup 을 둔다.
 * 섹션이 바뀌어도 상태·장소·기간·링크 열이 위아래로 맞아 한 번에 훑어 내려갈 수 있다.
 */
function EventTable({ placeLabel, children }: { placeLabel: string; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="dtable min-w-[60rem] table-fixed">
        <colgroup>
          <col className="w-[8rem]" />
          <col />
          <col className="w-[11rem] 2xl:w-[13.5rem]" />
          <col className="w-[12rem]" />
          <col className="w-[11rem]" />
        </colgroup>
        <thead>
          <tr>
            <th>상태</th>
            <th>이름</th>
            <th>{placeLabel}</th>
            <th>기간</th>
            <th>링크</th>
          </tr>
        </thead>
        {children}
      </table>
    </div>
  );
}

/**
 * 표 안의 소그룹(팝업 지역 · 전시장). 머리 행에 SubHeader 를 두고 그 아래로 행을 잇는다.
 * 그룹마다 표를 따로 만들면 열 머리가 반복되고 열 위치도 어긋나서, 한 표 안의 tbody 로 나눈다.
 */
function GroupRows({
  label,
  sub,
  accent,
  rows,
  empty,
  first,
}: {
  label: string;
  sub?: string;
  accent?: string;
  rows: EventRowData[];
  empty: string;
  first?: boolean;
}) {
  return (
    <tbody>
      {/* 머리 행은 데이터 행이 아니므로 .dtable 의 hover 바탕을 끈다(규칙 우선순위가 높아 ! 필요). */}
      <tr className="hover:!bg-transparent">
        <th colSpan={COLS} scope="rowgroup" className={cn("p-0 text-left font-normal", !first && "pt-5")}>
          <SubHeader accent={accent} count={`${rows.length}건`} note={sub || undefined}>
            {label}
          </SubHeader>
        </th>
      </tr>
      {rows.length ? (
        rows.map((r, i) => <EventRow key={i} r={r} />)
      ) : (
        <tr className="hover:!bg-transparent">
          <td colSpan={COLS}>
            <EmptyLine className="py-0">{empty}</EmptyLine>
          </td>
        </tr>
      )}
    </tbody>
  );
}

export function EventsBoard() {
  const [snap, setSnap] = useState<EventsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 마지막 수집 '시도'의 성패. 스냅샷만으로는 "실패해서 어제 것"과 "아직 오늘 수집 전"을 못 가른다.
  const [attempt, setAttempt] = useState<CollectAttempt | null>(null);
  // 다른 탭이 AI 수집을 붙잡고 있어 '지금 갱신'이 시작조차 못 한 경우의 안내.
  const [busyMsg, setBusyMsg] = useState<string | null>(null);

  async function load() {
    try {
      setSnap(await api.events());
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
      const s = await api.eventsStatus();
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
      const r = await api.refreshEvents(); // 백그라운드 시작(202) 또는 시작 불가(409)
      if (r.busy && !r.collecting) {
        // 다른 탭이 AI 수집을 붙잡고 있다 → 시작된 게 없으므로 '수집 중'으로 넘어가면 안 된다.
        setBusyMsg(r.reason);
        return;
      }
      setCollecting(true); // '수집 중' 배너 + 폴링 시작 → 완료되면 자동 반영
    } catch (e) {
      setErr((e as Error).message); // 5xx 등 진짜 실패만 표시
    }
  }

  // '지난번 본 뒤 신규' — 출처 링크가 있어 화면에 보이는 행사만 센다. 1면도 같은 기준으로 센다.
  const isNew = useNewMarks("events", snap && !loading ? eventsVisibleItems(snap).map((e) => e.id) : null);

  if (loading) return <LoadingState />;

  const updated = snap?.updatedAt ? formatWhen(new Date(snap.updatedAt), new Date()) : null;

  // 출처(보기) 링크가 없는 항목은 확인이 불가하므로 표시하지 않는다(메일과 동일 기준).
  const shown = snap ? withLinkedItemsOnly(snap) : null;
  const popups = shown?.popups ?? [];
  // 서울(실제 방문이 부담)과 수원·화성 등 서울 외 지역을 나눠서 보여준다.
  const { seoul: seoulPopups, outer: outerPopups } = splitPopupsByRegion(popups);
  const venues = shown?.exhibitions.venues ?? [];
  const festivals = shown?.festivals ?? [];
  const exhibitionCount = venues.reduce((n, v) => n + v.items.length, 0);

  const page = (
    <div>
      <PageToolbar
        actions={
          <Button variant="outline" onClick={refresh} disabled={collecting}>
            {collecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {collecting ? "수집 중…" : "지금 갱신"}
          </Button>
        }
      >
        <ScheduleControl tab="events" />
        <MetaDot />
        <NotifyMeta notify="events" verb="갱신 시" fallback="갱신 시 이메일 발송" />
        {updated && (
          <>
            <MetaDot />
            <Meta>
              최종 갱신 <strong>{updated}</strong>
            </Meta>
          </>
        )}
        {/* source 가 llm 이 아닌 상황은 아래 안내 배너가 사용자 말로 설명한다.
            여기 회색 잔글씨로 'LLM 큐레이션 비활성'이라 적어 두는 건 보이지도, 읽히지도 않았다. */}
      </PageToolbar>

      {err && <Notice tone="error">{err}</Notice>}

      {busyMsg && <Notice tone="warn">{busyMsg}</Notice>}

      {collecting && (
        <Notice tone="info" progress>
          팝업·전시 정보를 수집하는 중입니다… 수 분 걸릴 수 있고, 완료되면 자동으로 반영됩니다.
        </Notice>
      )}

      {/* 수집이 실패해도 화면은 어제와 똑같이 멀쩡해 보인다 — 어느 날짜 내용인지 반드시 알린다. */}
      <SnapshotNotice health={snapshotHealth(snap, attempt, { collecting })} notes={snap?.notes} />

      {!snap ? (
        <EmptyState
          icon={<Sparkles />}
          action={
            <Button onClick={refresh} disabled={collecting}>
              {collecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {collecting ? "수집 중…" : "지금 갱신"}
            </Button>
          }
        >
          아직 수집된 정보가 없습니다.
        </EmptyState>
      ) : (
        <>
          <SectionHeader title="팝업스토어" count={popups.length} accent={ACCENT.popup} />
          {popups.length ? (
            <EventTable placeLabel="지역">
              <GroupRows {...POPUP_GROUPS.seoul} rows={seoulPopups.map(popupRow)} empty="확인된 팝업이 없습니다." first />
              <GroupRows {...POPUP_GROUPS.outer} rows={outerPopups.map(popupRow)} empty="확인된 팝업이 없습니다." />
            </EventTable>
          ) : (
            <EmptyLine>확인된 팝업이 없습니다.</EmptyLine>
          )}

          <SectionHeader
            title="주요 전시장"
            count={exhibitionCount}
            accent={ACCENT.exhibition}
            note="코엑스 · 세텍 · 킨텍스 · 수원컨벤션 · 수원메쎄"
          />
          {venues.length > 0 && (
            <EventTable placeLabel="전시장">
              {venues.map((v, i) => (
                <GroupRows
                  key={v.name}
                  label={v.name}
                  rows={v.items.map((e) => exhRow(e, v.name))}
                  empty="이번 주 확인된 행사 없음"
                  first={i === 0}
                />
              ))}
            </EventTable>
          )}

          <SectionHeader title="대한민국 축제" count={festivals.length} accent={ACCENT.festival} />
          {festivals.length ? (
            <EventTable placeLabel="지역">
              <tbody>
                {festivals.map((f, i) => (
                  <EventRow key={i} r={festivalRow(f)} />
                ))}
              </tbody>
            </EventTable>
          ) : (
            <EmptyLine>확인된 축제가 없습니다.</EmptyLine>
          )}
        </>
      )}
    </div>
  );
  // 행 깊은 곳의 '신규' 표시가 이 탭의 판정을 읽도록 감싼다.
  return <NewMarksProvider value={isNew}>{page}</NewMarksProvider>;
}
