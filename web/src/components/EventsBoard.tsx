import { useEffect, useState } from "react";
import { RefreshCw, Loader2, MapPin, CalendarDays, Building2, Sparkles, Link as LinkIcon } from "lucide-react";
import type { EventsSnapshot, PopupItem, ExhibitionItem, EventTag } from "@shared/types";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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

function SourceLink({ link }: { link: string | null }) {
  if (!link) return null;
  return (
    <a
      href={link}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs text-[#4361ee] hover:underline"
    >
      <LinkIcon className="h-3 w-3" /> 보기
    </a>
  );
}

function PopupCard({ p }: { p: PopupItem }) {
  return (
    <Card className="border-l-4 border-l-[#7C3AED]">
      <CardContent className="space-y-1 p-4">
        <div className="flex items-start justify-between gap-2">
          <h4 className="font-semibold leading-tight">{p.name}</h4>
          <TagBadge tag={p.tag} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3 w-3" /> {p.region}
          </span>
          {p.period && (
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="h-3 w-3" /> {p.period}
            </span>
          )}
          {p.category && <span>· {p.category}</span>}
        </div>
        {p.summary && <p className="line-clamp-2 text-sm text-muted-foreground">{p.summary}</p>}
        <SourceLink link={p.link} />
      </CardContent>
    </Card>
  );
}

function ExhCard({ e }: { e: ExhibitionItem }) {
  return (
    <Card className="border-l-4 border-l-[#FF8C00]">
      <CardContent className="space-y-1 p-4">
        <div className="flex items-start justify-between gap-2">
          <h4 className="font-semibold leading-tight">{e.title}</h4>
          <TagBadge tag={e.tag} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Building2 className="h-3 w-3" /> {e.venue}
          </span>
          {e.period && (
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="h-3 w-3" /> {e.period}
            </span>
          )}
        </div>
        {e.summary && <p className="line-clamp-2 text-sm text-muted-foreground">{e.summary}</p>}
        <SourceLink link={e.link} />
      </CardContent>
    </Card>
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
  const [refreshing, setRefreshing] = useState(false);
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
  useEffect(() => {
    load();
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      setSnap(await api.refreshEvents());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRefreshing(false);
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

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          매일 10:00 자동 갱신 · 이메일 알림
          {updated && ` · 최종 갱신 ${updated}`}
          {snap?.source === "naver-raw" && " · (검색 원본 — LLM 큐레이션 비활성)"}
        </p>
        <Button variant="outline" onClick={refresh} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          지금 갱신
        </Button>
      </div>

      {err && (
        <div className="mb-4 rounded-md border border-up/40 bg-up/10 px-4 py-3 text-sm text-up">{err}</div>
      )}

      {!snap ? (
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <Sparkles className="h-10 w-10" />
          <p>아직 수집된 정보가 없습니다.</p>
          <Button onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            지금 갱신
          </Button>
        </div>
      ) : (
        <>
          <SectionTitle icon={<Sparkles className="h-5 w-5 text-[#7C3AED]" />}>
            팝업스토어 <span className="text-sm font-normal text-muted-foreground">({snap.popups.length})</span>
          </SectionTitle>
          {snap.popups.length ? (
            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
              {snap.popups.map((p, i) => (
                <PopupCard key={i} p={p} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">확인된 팝업이 없습니다.</p>
          )}

          <SectionTitle icon={<Building2 className="h-5 w-5 text-[#FF8C00]" />}>
            주요 전시장 (코엑스 · 세텍 · 킨텍스 · 수원컨벤션 · 수원메쎄)
          </SectionTitle>
          {snap.exhibitions.venues.map((v) => (
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

          <SectionTitle icon={<CalendarDays className="h-5 w-5 text-[#2E86DE]" />}>
            서울 · 경기 전시
          </SectionTitle>
          {snap.exhibitions.general.length ? (
            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
              {snap.exhibitions.general.map((e, i) => (
                <ExhCard key={i} e={e} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">확인된 일반 전시가 없습니다.</p>
          )}
        </>
      )}
    </div>
  );
}
