import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Archive,
  CalendarClock,
  Clock,
  GitFork,
  Loader2,
  Scale,
  Star,
  TrendingUp,
} from "lucide-react";
import type { SkillRankEntry, SkillRankKind, SkillWindow, SkillsSnapshot } from "@shared/skills";
import { SKILLS_CYCLE_LABEL, SKILLS_RANK_SIZE } from "@shared/skills";
import { safeHref } from "@shared/url";
import { api, type CollectAttempt } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 스킬 랭킹 탭 — GitHub 의 Claude/Agent 스킬 저장소를 **총합**과 **주간 증가** 두 갈래로 본다.
 *
 * 화면에 수동 갱신 버튼이 없다. 로또 탭과 같은 규약으로 갱신은 매주 월요일 09:00 서버 cron 이
 * 전담한다(POST /api/skills/refresh 는 운영·검증용으로만 남아 있다). 주 1회만 바뀌는 값에
 * 버튼을 달아 두면 눌러도 화면이 그대로라 "고장났나" 하는 오해만 남는다.
 *
 * ★ 이 화면의 핵심 규율은 **증가분 구간을 속이지 않는 것**이다. 계약(shared/skills.ts)이
 *   SkillWindow.days 를 굳이 실어 보내는 이유가 그것이고, 여기서는 그 값을 그대로 인용한다.
 *   비교할 지난 스냅샷이 없는 첫 회차(window === null)에는 0 으로 채우거나 총합 순위를
 *   대신 보여주지 않고, 비어 있다는 사실을 그대로 말한다.
 */
const BLUE = "#2563eb";

/** 수집 진행 상태 폴링 주기. 뉴스 탭과 같은 간격으로 맞춘다. */
const POLL_MS = 5000;

/** 천 단위 구분. star·forks 처럼 자릿수가 큰 값에만 쓴다. */
const num = (n: number) => n.toLocaleString("ko-KR");

/** ISO → "9월 1일 09:00". 연도는 뺀다(주간 갱신이라 같은 해가 아닐 일이 거의 없다). */
function fmtWhen(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("ko-KR", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 마지막 푸시 시각을 "n일 전"으로. 별만 많고 죽은 저장소를 한눈에 가르는 값이라
 * 절대 시각보다 상대 표기가 읽기 쉽다. 아주 오래된 것은 일수로 적으면 자릿수만 커져
 * 개월·년으로 접는다.
 */
function relTime(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "오늘";
  if (days === 1) return "어제";
  if (days < 60) return `${days}일 전`;
  if (days < 365) return `${Math.floor(days / 30)}개월 전`;
  return `${Math.floor(days / 365)}년 전`;
}

/** 한 줄에 노출할 topic 칩 개수. 넘치면 "+n" 으로 접는다(줄바꿈으로 목록이 무너지지 않게). */
const TOPIC_LIMIT = 4;

/** 순위 변동 표시. prevRank 가 null 이면 신규 진입(NEW). */
function RankDelta({ rank, prevRank }: { rank: number; prevRank: number | null }) {
  if (prevRank === null) {
    return (
      <Badge className="border-[#2563eb]/30 bg-[#2563eb]/10 px-1.5 py-0 text-[10px] font-bold text-[#2563eb]">
        NEW
      </Badge>
    );
  }
  const diff = prevRank - rank; // 양수 = 순위가 올랐다
  if (diff === 0) return <span className="text-[11px] text-muted-foreground/50">–</span>;
  const up = diff > 0;
  return (
    <span
      className={cn(
        "text-[11px] font-semibold tabular-nums",
        up ? "text-emerald-600" : "text-slate-500"
      )}
      title={`지난 회차 ${prevRank}위`}
    >
      {up ? "▲" : "▼"}
      {Math.abs(diff)}
    </span>
  );
}

/** 랭킹 한 줄. */
function RankRow({ entry, kind }: { entry: SkillRankEntry; kind: SkillRankKind }) {
  const r = entry.repo;
  const href = safeHref(r.url);
  // 요약(LLM 한국어)이 우선이고, 없으면 GitHub 원문 설명으로 폴백한다.
  // 요약 실패가 줄을 비우면 안 된다 — 그때도 사용자는 이 저장소가 뭔지 알아야 한다.
  const desc = r.summary ?? r.description ?? "설명 없음";
  const pushed = relTime(r.pushedAt);
  const extraTopics = r.topics.length - TOPIC_LIMIT;

  return (
    <li className="flex gap-3 border-b px-3 py-3 last:border-b-0 hover:bg-muted/40">
      {/* 순위 + 변동 */}
      <div className="flex w-9 shrink-0 flex-col items-end gap-0.5 pt-0.5">
        <span className="text-sm font-bold tabular-nums text-foreground/80">{entry.rank}</span>
        <RankDelta rank={entry.rank} prevRank={entry.prevRank} />
      </div>

      {/* 저장소 이름 · 설명 · 부가 정보 */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="break-all text-sm font-semibold hover:underline"
              style={{ color: BLUE }}
            >
              <span className="font-normal opacity-70">{r.owner}/</span>
              {r.name}
            </a>
          ) : (
            <span className="break-all text-sm font-semibold">{r.fullName}</span>
          )}
          {/* 별은 많은데 관리가 끊긴 저장소를 숨기지 않는다. */}
          {r.archived && (
            <Badge className="border-amber-300 bg-amber-50 px-1.5 py-0 text-[10px] font-semibold text-amber-700">
              <Archive className="mr-0.5 h-2.5 w-2.5" /> 보관됨
            </Badge>
          )}
        </div>

        <p className="mt-1 line-clamp-3 whitespace-pre-line text-[13px] leading-relaxed text-foreground/75">
          {desc}
        </p>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {r.language && (
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
              {r.language}
            </span>
          )}
          {r.license && (
            <span className="inline-flex items-center gap-1">
              <Scale className="h-3 w-3" /> {r.license}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <GitFork className="h-3 w-3" /> {num(r.forks)}
          </span>
          {pushed && (
            <span className="inline-flex items-center gap-1" title={`마지막 푸시 ${r.pushedAt}`}>
              <Clock className="h-3 w-3" /> {pushed}
            </span>
          )}
        </div>

        {r.topics.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {r.topics.slice(0, TOPIC_LIMIT).map((t) => (
              <span
                key={t}
                className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                {t}
              </span>
            ))}
            {extraTopics > 0 && (
              <span className="text-[10px] text-muted-foreground/70">+{extraTopics}</span>
            )}
          </div>
        )}
      </div>

      {/* star 총합 · 증가분 */}
      <div className="w-[5.5rem] shrink-0 text-right">
        <div className="inline-flex items-center gap-1 text-sm font-semibold tabular-nums">
          <Star className="h-3.5 w-3.5 text-amber-500" />
          {num(r.stars)}
        </div>
        {entry.starsGained !== null && (
          <div
            className={cn(
              "mt-0.5 text-[11px] font-semibold tabular-nums",
              kind === "growth" ? "text-emerald-600" : "text-muted-foreground"
            )}
          >
            +{num(entry.starsGained)}
          </div>
        )}
      </div>
    </li>
  );
}

/** 증가 랭킹의 비교 구간 라벨. days 를 그대로 인용한다 — 7 로 하드코딩하지 않는다. */
function windowLabel(w: SkillWindow): string {
  return `최근 ${w.days}일간 증가 (${w.fromDate} → ${w.toDate} 스냅샷 비교)`;
}

export function SkillsBoard() {
  const [snap, setSnap] = useState<SkillsSnapshot | null>(null);
  const [kind, setKind] = useState<SkillRankKind>("total");
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [attempt, setAttempt] = useState<CollectAttempt | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      setSnap(await api.skills());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  /** 진행 상태를 갱신하고 '수집 중'인지 돌려준다(실패하면 null). 뉴스 탭과 같은 방식. */
  async function checkStatus(): Promise<boolean | null> {
    try {
      const s = await api.skillsStatus();
      setCollecting(s.collecting);
      setAttempt(s.lastAttempt ?? null);
      return s.collecting;
    } catch {
      return null; // 상태 폴링 실패는 무시(다음 주기에 재시도)
    }
  }

  useEffect(() => {
    void load();
    void checkStatus(); // 진입 시 (월요일 09:00 수집이 돌고 있으면) '수집 중'을 즉시 반영
  }, []);

  // 수집 중이면 5초마다 확인 → 끝나면 스냅샷을 자동으로 다시 불러온다.
  useEffect(() => {
    if (!collecting) return;
    const id = setInterval(async () => {
      if ((await checkStatus()) === false) await load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [collecting]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 불러오는 중…
      </div>
    );
  }

  if (!snap) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        <p>스킬 랭킹을 불러올 수 없습니다.</p>
        {err && <p className="mt-2 text-xs text-muted-foreground/70">({err})</p>}
        <Button variant="outline" size="sm" className="mt-4" onClick={() => void load()}>
          다시 시도
        </Button>
      </Card>
    );
  }

  const entries = kind === "total" ? snap.byStars : snap.byGrowth;
  const updated = fmtWhen(snap.updatedAt);
  // 첫 회차 = 비교할 지난주 스냅샷이 없다. 증가 랭킹은 이때 '0' 이 아니라 '없음'이다.
  const firstCycle = snap.window === null;

  return (
    <div>
      {/* 세그먼트 컨트롤 — shadcn Tabs 컴포넌트가 없어 Button 2개로 구성한다(증시 탭과 같은 방식). */}
      <div className="mb-4 flex items-center gap-1">
        <Button
          variant={kind === "total" ? "default" : "outline"}
          size="sm"
          onClick={() => setKind("total")}
          style={kind === "total" ? { backgroundColor: BLUE } : undefined}
        >
          ⭐ star 총합
        </Button>
        <Button
          variant={kind === "growth" ? "default" : "outline"}
          size="sm"
          onClick={() => setKind("growth")}
          style={kind === "growth" ? { backgroundColor: BLUE } : undefined}
        >
          🔥 이번 주 급상승
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold" style={{ color: BLUE }}>
            🧩 스킬 랭킹
          </h2>
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarClock className="h-3.5 w-3.5" />
            매주 {SKILLS_CYCLE_LABEL} 자동 갱신 — GitHub 스킬 저장소 star 를 주간 스냅샷으로
            쌓아 직접 차분합니다.
            {updated && <span className="text-muted-foreground/70">(최근 {updated})</span>}
          </p>
        </div>
      </div>

      {err && (
        <div className="mb-4 rounded-md border border-up/40 bg-up/10 px-4 py-3 text-sm text-up">
          {err}
        </div>
      )}

      {collecting && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          스킬 저장소를 수집하는 중입니다… 몇 분 걸릴 수 있고, 완료되면 자동으로 반영됩니다.
        </div>
      )}

      {/*
        수집이 실패하면 서버는 지난 회차 스냅샷을 그대로 유지한다 — 화면이 멀쩡해 보여서
        사용자는 이번 주 것으로 착각한다. notes 는 그 사실을 적어 둔 유일한 자리라 접지 않고
        눈에 띄게 띄운다.
      */}
      {snap.notes && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 whitespace-pre-line break-words">{snap.notes}</span>
        </div>
      )}

      {/* 마지막 수집 시도가 실패로 끝났다면, 아래 목록이 지난 회차라는 뜻이다. */}
      {attempt && !attempt.ok && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            마지막 수집 시도가 실패했습니다{fmtWhen(attempt.at) ? ` (${fmtWhen(attempt.at)})` : ""}
            . 아래 목록은 {snap.date} 스냅샷으로, 이번 주 것이 아닐 수 있습니다.
          </span>
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            {kind === "total" ? (
              <>
                <Star className="h-4 w-4 text-amber-500" /> star 총합 순위
              </>
            ) : (
              <>
                <TrendingUp className="h-4 w-4 text-emerald-600" /> 이번 주 급상승
              </>
            )}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {/* 증가 랭킹은 구간을 숨기지 않는다 — days 를 그대로 인용한다(7일이 아닐 수 있다). */}
            {kind === "growth" && snap.window
              ? windowLabel(snap.window)
              : `기준 ${snap.date} 스냅샷`}
          </span>
        </div>

        {kind === "growth" && firstCycle ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            <TrendingUp className="mx-auto mb-2 h-8 w-8 opacity-30" />
            <p>증가 순위는 다음 주 월요일 갱신부터 채워집니다.</p>
            <p className="mt-1 text-xs">(비교할 지난주 기록이 아직 없어요)</p>
          </div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            {snap.source === "empty"
              ? `아직 첫 수집 전입니다. 매주 ${SKILLS_CYCLE_LABEL} 자동 갱신에서 채워집니다.`
              : "표시할 저장소가 없습니다."}
          </div>
        ) : (
          <ul>
            {entries.map((e) => (
              <RankRow key={e.repo.id} entry={e} kind={kind} />
            ))}
          </ul>
        )}
      </Card>

      <p className="mt-2 px-1 text-[11px] text-muted-foreground">
        이번 주 추적 저장소 {num(snap.trackedCount)}개 중 상위 {SKILLS_RANK_SIZE} · GitHub 은
        과거 star 수를 주지 않아 매주 우리 스냅샷을 남겨 직접 차분합니다.
      </p>
    </div>
  );
}
