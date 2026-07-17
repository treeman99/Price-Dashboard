import { useEffect, useState } from "react";
import { RefreshCw, Loader2, MapPin, CalendarDays, Building2, Sparkles, Link as LinkIcon, CalendarPlus, Tag, PartyPopper } from "lucide-react";
import type { EventsSnapshot, PopupItem, ExhibitionItem, FestivalItem, EventTag } from "@shared/types";
import { googleCalendarUrl } from "@shared/calendar";
import { safeHref } from "@shared/url";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScheduleControl } from "@/components/ScheduleControl";

const TAG_STYLE: Record<Exclude<EventTag, null>, { bg: string; label: string }> = {
  신규: { bg: "#03C75A", label: "신규" },
  종료임박: { bg: "#FF5A5A", label: "종료임박" },
  예정: { bg: "#2E86DE", label: "오픈예정" },
};

function TagBadge({ tag }: { tag: EventTag }) {
  if (!tag) return null;
  const s = TAG_STYLE[tag];
  return (
    <Badge className="shrink-0 border-transparent text-white" style={{ backgroundColor: s.bg }}>
      {s.label}
    </Badge>
  );
}

/** '신규' 배지 — 약 일주일 만에 새로 등장한 행사 표시. 날짜 기반 태그와 함께 노출된다. */
function NewBadge({ show }: { show?: boolean }) {
  if (!show) return null;
  return (
    <Badge
      className="shrink-0 border-transparent text-white"
      style={{ backgroundColor: TAG_STYLE.신규.bg }}
      title="약 일주일 만에 새로 등장한 행사"
    >
      {TAG_STYLE.신규.label}
    </Badge>
  );
}

function SourceLink({ link }: { link: string | null }) {
  const href = safeHref(link);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs text-[#4361ee] hover:underline"
    >
      <LinkIcon className="h-3 w-3" /> 보기
    </a>
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
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs text-[#1a7f37] hover:underline"
      title="구글 캘린더에 추가"
    >
      <CalendarPlus className="h-3 w-3" /> 캘린더 추가
    </a>
  );
}

/** 모든 타일이 동일한 구조/위치를 갖도록 하는 공통 카드 본문 */
function EventTile({
  accent,
  title,
  tag,
  isNew,
  metaIcon,
  metaPrimary,
  period,
  extraMeta,
  summary,
  link,
  cal,
}: {
  accent: string;
  title: string;
  tag: EventTag;
  isNew?: boolean;
  metaIcon: React.ReactNode;
  metaPrimary: string;
  period: string;
  extraMeta?: string | null;
  summary: string;
  link: string | null;
  cal: { title: string; startDate: string | null; endDate: string | null; location: string; details: string };
}) {
  return (
    <Card className="flex h-full flex-col border-l-4" style={{ borderLeftColor: accent }}>
      <div className="flex flex-1 flex-col p-4">
        {/* 제목 영역 — 2줄 고정 */}
        <div className="flex items-start justify-between gap-2">
          <h4 className="line-clamp-2 min-h-[2.6em] font-semibold leading-tight">{title}</h4>
          <div className="flex shrink-0 items-center gap-1">
            <NewBadge show={isNew} />
            <TagBadge tag={tag} />
          </div>
        </div>
        {/* 장소 / 일정 / 카테고리 — 각각 별도 줄, 영역 높이 고정 */}
        <div className="mt-1 flex min-h-[3.6em] flex-col content-start gap-0.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            {metaIcon} <span className="truncate">{metaPrimary}</span>
          </span>
          {period && (
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="h-3 w-3 shrink-0" /> {period}
            </span>
          )}
          {extraMeta && (
            <span className="inline-flex items-center gap-1">
              <Tag className="h-3 w-3 shrink-0" /> {extraMeta}
            </span>
          )}
        </div>
        {/* 요약 — 남는 공간 채움(액션을 바닥으로 밀어냄) */}
        <p className="mt-1 line-clamp-2 min-h-[2.5em] flex-1 text-sm text-muted-foreground">
          {summary}
        </p>
        {/* 액션 영역 — 항상 카드 하단 같은 위치 */}
        <div className="mt-2 flex items-center gap-3 border-t pt-2">
          <SourceLink link={link} />
          <CalendarButton
            title={cal.title}
            startDate={cal.startDate}
            endDate={cal.endDate}
            location={cal.location}
            details={cal.details}
          />
          {!safeHref(link) && !googleCalendarUrl({ title: cal.title, startDate: cal.startDate, endDate: cal.endDate }) && (
            <span className="text-xs text-muted-foreground/60">링크 없음</span>
          )}
        </div>
      </div>
    </Card>
  );
}

function PopupCard({ p }: { p: PopupItem }) {
  return (
    <EventTile
      accent="#7C3AED"
      title={p.name}
      tag={p.tag}
      isNew={p.isNew}
      metaIcon={<MapPin className="h-3 w-3" />}
      metaPrimary={p.region}
      period={p.period}
      extraMeta={p.category}
      summary={p.summary}
      link={p.link}
      cal={{
        title: p.name,
        startDate: p.startDate,
        endDate: p.endDate,
        location: p.region,
        details: [p.summary, p.link].filter(Boolean).join("\n"),
      }}
    />
  );
}

function ExhCard({ e }: { e: ExhibitionItem }) {
  return (
    <EventTile
      accent="#FF8C00"
      title={e.title}
      tag={e.tag}
      isNew={e.isNew}
      metaIcon={<Building2 className="h-3 w-3" />}
      metaPrimary={e.venue}
      period={e.period}
      summary={e.summary}
      link={e.link}
      cal={{
        title: e.title,
        startDate: e.startDate,
        endDate: e.endDate,
        location: e.venue,
        details: [e.summary, e.link].filter(Boolean).join("\n"),
      }}
    />
  );
}

function FestivalCard({ f }: { f: FestivalItem }) {
  return (
    <EventTile
      accent="#E8590C"
      title={f.name}
      tag={f.tag}
      isNew={f.isNew}
      metaIcon={<MapPin className="h-3 w-3" />}
      metaPrimary={f.region}
      period={f.period}
      summary={f.summary}
      link={f.link}
      cal={{
        title: f.name,
        startDate: f.startDate,
        endDate: f.endDate,
        location: f.region,
        details: [f.summary, f.link].filter(Boolean).join("\n"),
      }}
    />
  );
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h2 className="mb-3 mt-6 flex items-center gap-2 border-b pb-2 text-lg font-bold">
      {icon}
      {children}
    </h2>
  );
}

export function EventsBoard() {
  const [snap, setSnap] = useState<EventsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
  async function checkStatus() {
    try {
      setCollecting((await api.eventsStatus()).collecting);
    } catch {
      /* 상태 폴링 실패는 무시 */
    }
  }
  useEffect(() => {
    load();
    checkStatus(); // 진입 시 (예: 정시 수집이 돌고 있으면) '수집 중'을 즉시 반영
  }, []);

  // 수집 중이면 5초마다 상태 확인 → 완료되면 스냅샷을 자동으로 다시 불러온다.
  useEffect(() => {
    if (!collecting) return;
    const id = setInterval(async () => {
      let done = false;
      try {
        done = !(await api.eventsStatus()).collecting;
      } catch {
        return; // 일시 오류는 다음 주기에 재시도
      }
      if (done) {
        setCollecting(false);
        await load(); // 완료 → 새 결과 반영
      }
    }, 5000);
    return () => clearInterval(id);
  }, [collecting]);

  async function refresh() {
    setErr(null);
    try {
      await api.refreshEvents(); // 백그라운드 시작(202) 또는 이미 수집 중(409) → 둘 다 정상
      setCollecting(true); // '수집 중' 배너 + 폴링 시작 → 완료되면 자동 반영
    } catch (e) {
      setErr((e as Error).message); // 5xx 등 진짜 실패만 표시
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 불러오는 중…
      </div>
    );
  }

  const updated = snap?.updatedAt ? new Date(snap.updatedAt).toLocaleString("ko-KR") : null;

  // 출처(보기) 링크가 없는 항목은 확인이 불가하므로 표시하지 않는다.
  const popups = (snap?.popups ?? []).filter((p) => p.link);
  const venues = (snap?.exhibitions.venues ?? []).map((v) => ({
    ...v,
    items: v.items.filter((e) => e.link),
  }));
  const festivals = (snap?.festivals ?? []).filter((f) => f.link);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <ScheduleControl kind="events" />
          <span>
            · 갱신 시 이메일 발송
            {updated && ` · 최종 갱신 ${updated}`}
            {snap?.source === "naver-raw" && " · (검색 원본 — LLM 큐레이션 비활성)"}
          </span>
        </div>
        <Button variant="outline" onClick={refresh} disabled={collecting}>
          {collecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {collecting ? "수집 중…" : "지금 갱신"}
        </Button>
      </div>

      {err && (
        <div className="mb-4 rounded-md border border-up/40 bg-up/10 px-4 py-3 text-sm text-up">{err}</div>
      )}

      {collecting && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          팝업·전시 정보를 수집하는 중입니다… 수 분 걸릴 수 있고, 완료되면 자동으로 반영됩니다.
        </div>
      )}

      {!snap ? (
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <Sparkles className="h-10 w-10" />
          <p>아직 수집된 정보가 없습니다.</p>
          <Button onClick={refresh} disabled={collecting}>
            {collecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {collecting ? "수집 중…" : "지금 갱신"}
          </Button>
        </div>
      ) : (
        <>
          <SectionTitle icon={<Sparkles className="h-5 w-5 text-[#7C3AED]" />}>
            팝업스토어 <span className="text-sm font-normal text-muted-foreground">({popups.length})</span>
          </SectionTitle>
          {popups.length ? (
            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
              {popups.map((p, i) => (
                <PopupCard key={i} p={p} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">확인된 팝업이 없습니다.</p>
          )}

          <SectionTitle icon={<Building2 className="h-5 w-5 text-[#FF8C00]" />}>
            주요 전시장 (코엑스 · 세텍 · 킨텍스 · 수원컨벤션 · 수원메쎄)
          </SectionTitle>
          {venues.map((v) => (
            <div key={v.name} className="mb-5">
              <h3 className="mb-2 text-sm font-semibold text-muted-foreground">🏛 {v.name}</h3>
              {v.items.length ? (
                <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
                  {v.items.map((e, i) => (
                    <ExhCard key={i} e={e} />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">이번 주 확인된 행사 없음</p>
              )}
            </div>
          ))}

          <SectionTitle icon={<PartyPopper className="h-5 w-5 text-[#E8590C]" />}>
            대한민국 축제 <span className="text-sm font-normal text-muted-foreground">({festivals.length})</span>
          </SectionTitle>
          {festivals.length ? (
            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
              {festivals.map((f, i) => (
                <FestivalCard key={i} f={f} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">확인된 축제가 없습니다.</p>
          )}
        </>
      )}
    </div>
  );
}
