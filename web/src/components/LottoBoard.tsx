import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, RefreshCw } from "lucide-react";
import type { LottoRecentRound, LottoSnapshot } from "@shared/lotto";
import { upcomingToText, winningNumbers } from "@shared/lotto";
import { api } from "@/lib/api";
import { ScheduleControl } from "@/components/ScheduleControl";
import { useTabConfig } from "@/lib/tabConfigStore";
import { Button } from "@/components/ui/button";
import {
  PageToolbar,
  Meta,
  MetaDot,
  Notice,
  SectionHeader,
  StatusTag,
  EmptyState,
  EmptyLine,
  LoadingState,
} from "@/components/ui/page";
import { cn } from "@/lib/utils";

/**
 * 로또 탭 — **다음 회차 예상 번호**와 **지난 10회차 비교 결과** 두 가지만 보여준다.
 *
 * 2026-07-30 전면 축소. 세대 이력·바퀴별 성적표·회차 점수 추이·누적 점수 추이·가중 회차 점수
 * 추이를 전부 지웠고, 조작 버튼(실험 시작·일시정지·회차 동기화·초기화·실험 반복)도 없앴다.
 * 이제 모든 동작은 **주 1회 서버 자동 사이클**이 한다(`src/lotto/cycle.ts`). 기본 매주 일요일 10:00 이고,
 * 툴바 '자동 갱신'에서 요일·시각을 바꿀 수 있다(매주·요일 1개·시각 1개 고정, 토요일 추첨 전후 금지).
 *
 * 폴링도 없다. 데이터가 주 1회만 바뀌므로 3초마다 서버를 두드릴 이유가 없다 — 화면을 열 때
 * 한 번 받고, 갱신이 궁금하면 [새로고침]을 누르면 된다.
 *
 * 강조색은 탭 고유색(--tab, 로또는 #7c3aed)을 `text-tab`/`bg-tab` 으로 쓴다.
 */

/** ISO → "7월 30일 10:00". 연도는 뺀다(주간 갱신이라 같은 해가 아닐 일이 거의 없다). */
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("ko-KR", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 번호 공 하나. tone 으로 적중/미적중/추첨번호를 구분한다.
 * 예상(pick)=탭색 테두리, 적중(hit)=탭색 채움, 미적중(miss)=옅은 회색, 추첨(draw)=잉크 테두리,
 * 보너스(bonus)=경고 톤. 색이 비슷해지면 적중 여부를 한눈에 못 가리므로 다섯 가지를 섞지 않는다.
 */
function NumberBadge({
  n,
  tone,
  size = "md",
}: {
  n: number;
  tone: "pick" | "hit" | "miss" | "draw" | "bonus";
  size?: "md" | "lg";
}) {
  const style: Record<typeof tone, string> = {
    pick: "border-tab font-medium text-tab",
    hit: "border-tab bg-tab font-semibold text-white",
    miss: "border-foreground/15 text-muted-foreground",
    draw: "border-[1.5px] border-foreground font-semibold text-foreground",
    bonus: "border-[1.5px] border-tone-warn bg-tone-warn/10 font-semibold text-tone-warn",
  };
  return (
    <span
      className={cn(
        "num inline-flex shrink-0 items-center justify-center rounded-full border font-mono leading-none",
        size === "lg" ? "h-7 w-7 text-[13px]" : "h-[26px] w-[26px] text-[12px]",
        style[tone]
      )}
    >
      {n}
    </span>
  );
}

/**
 * 10세트를 상자 없이 행으로 여러 열에 깐다. 넓은 화면에서 세로 길이를 줄이려는 배치다.
 * 최소 폭 280px 은 1680px 화면에서 한 줄 5세트(10세트 = 2줄)가 되도록 맞춘 값이다.
 */
function SetGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid gap-x-8 [grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))]",
        className
      )}
    >
      {children}
    </div>
  );
}

/** 세트 번호(1. 2. …). 회차 번호처럼 기계적인 값이라 mono. */
function SetIndex({ i }: { i: number }) {
  return <span className="num w-6 shrink-0 font-mono text-[12px] text-muted-foreground">{i + 1}.</span>;
}

/**
 * 클립보드 복사.
 *
 * `navigator.clipboard` 는 보안 컨텍스트에만 있다. localhost 는 보안 컨텍스트라 평소엔
 * 문제없지만, 이 대시보드를 `http://<집안 IP>:7777` 로 열면 undefined 가 되어 조용히
 * 실패한다 — 사용자에게는 "버튼이 고장났다"로 보인다. 그래서 구식 execCommand 폴백을 둔다.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 권한 거부 등. 아래 폴백으로 넘어간다.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 다음 회차 예상 번호 — 이 화면의 주인공. */
function UpcomingCard({ snap }: { snap: LottoSnapshot }) {
  const u = snap.upcoming;
  /** 복사 결과 안내. `at` 으로 매번 새 객체를 만들어 연속 클릭에도 타이머가 초기화된다. */
  const [copied, setCopied] = useState<{ ok: boolean; at: number } | null>(null);

  // 안내는 잠깐만 띄운다. 훅은 아래 early return 보다 위에 있어야 한다(훅 순서 규칙).
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  if (!u) {
    return (
      <>
        <SectionHeader title="다음 회차 예상 번호" accent="var(--tab)" />
        <EmptyState>
          <p>다음 회차 예상 번호가 아직 준비되지 않았습니다.</p>
          <p className="mt-1 text-[13px]">
            다음 자동 갱신 때 확정됩니다(서버 기동 직후에는 잠시 걸릴 수 있습니다).
          </p>
        </EmptyState>
      </>
    );
  }
  return (
    <>
      <SectionHeader
        title={`${u.round}회차 예상 번호`}
        accent="var(--tab)"
        note={
          <span className="num">
            v{u.version} · {fmtWhen(u.createdAt)} 확정
          </span>
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={u.sets.length === 0}
            title="번호만 줄바꿈으로 복사합니다 (회차·세트 번호는 넣지 않음)"
            onClick={() => {
              void copyToClipboard(upcomingToText(u)).then((ok) =>
                setCopied({ ok, at: Date.now() })
              );
            }}
          >
            {copied?.ok ? <Check className="h-4 w-4 text-tab" /> : <Copy className="h-4 w-4" />}
            {copied ? (copied.ok ? "복사됨" : "복사 실패") : "번호 복사"}
          </Button>
        }
      />
      <SetGrid className="gap-y-0.5">
        {u.sets.map((set, i) => (
          <div key={i} className="flex items-center gap-1.5 border-b py-1.5">
            <SetIndex i={i} />
            {set.map((n) => (
              <NumberBadge key={n} n={n} tone="pick" size="lg" />
            ))}
          </div>
        ))}
      </SetGrid>
      {/* 이 한 줄이 없으면 "화면을 열 때마다 번호가 바뀌는 게 아닐까" 하는 의심이 남는다.
          실제로 추첨 전에 저장해 두고 다음 주에 그 번호로만 채점한다는 것을 명시한다. */}
      <p className="mt-2.5 text-[12px] leading-relaxed text-muted-foreground">
        추첨 전에 확정해 저장한 번호입니다 — 다시 열어도 바뀌지 않고, 추첨 뒤 다음 자동 갱신 때 이 번호로
        채점합니다. 실제 구매·투자 목적이 아닌 알고리즘 검증용입니다.
      </p>
    </>
  );
}

/** 지난 회차 1건 — 추첨번호와 제출 10세트를 나란히 놓고 적중 번호를 칠한다. */
function ResultCard({ r }: { r: LottoRecentRound }) {
  const winSet = new Set(
    winningNumbers({
      round: r.round,
      drawDate: r.drawDate,
      numbers: r.drawNumbers,
      bonus: r.drawBonus,
    })
  );
  const best = r.matches.length ? Math.max(...r.matches) : 0;
  // 3개 이상 적중 회차는 상자 배경 대신 머리 줄(회차 번호·태그)을 탭색으로 강조한다.
  const strong = best >= 3;
  return (
    <article className="border-t py-2 first:border-t-0 first:pt-0.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className={cn("num font-mono text-[15px] font-semibold", strong && "text-tab")}>
            {r.round}회차
          </span>
          <span className="num text-[13px] text-muted-foreground">
            {r.drawDate} · v{r.version}
          </span>
          {strong && (
            <StatusTag className="border-tab text-tab">{best}개 적중</StatusTag>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[12px] text-muted-foreground">추첨</span>
          {r.drawNumbers.map((n) => (
            <NumberBadge key={n} n={n} tone="draw" />
          ))}
          <span className="mx-0.5 text-[13px] text-muted-foreground">+</span>
          <NumberBadge n={r.drawBonus} tone="bonus" />
        </div>
      </div>
      <SetGrid className="mt-1.5 gap-y-1">
        {r.sets.map((set, i) => {
          const m = r.matches[i] ?? 0;
          return (
            <div key={i} className="flex items-center gap-1">
              <SetIndex i={i} />
              {set.map((n) => (
                <NumberBadge key={n} n={n} tone={winSet.has(n) ? "hit" : "miss"} />
              ))}
              <span
                className={cn(
                  "num ml-1.5 text-[12px]",
                  m >= 3 ? "font-semibold text-tab" : "text-muted-foreground"
                )}
              >
                {m}개
              </span>
            </div>
          );
        })}
      </SetGrid>
    </article>
  );
}

/**
 * 스냅샷이 실제로 바뀌었는지 판정할 서명.
 *
 * 주 1회만 바뀌므로 사이클 시각·확정 번호·오류만 보면 충분하다. 전체를 stringify 하지 않는
 * 이유는 recentResults 가 10회차치라 매 클릭마다 직렬화할 값어치가 없어서다.
 */
function snapshotSignature(s: LottoSnapshot): string {
  return [
    s.state.lastCycleAt ?? "",
    s.upcoming?.round ?? "",
    s.upcoming?.createdAt ?? "",
    s.state.lastError ?? "",
  ].join("|");
}

/**
 * 새로고침 스피너 최소 노출 시간.
 *
 * 이 버튼은 `GET /api/lotto` 한 번이 전부인데 서버가 localhost 라 응답이 수십 ms 다. 그래서
 * 스피너가 눈에 띄지도 않고, 데이터도 주 1회만 바뀌니 화면이 그대로여서 "눌러도 아무 반응이
 * 없다"로 읽힌다(실사용 문의로 확인). 클릭이 처리됐다는 사실 자체를 보이게 하려고 최소 시간을
 * 확보한다 — 느리게 만드는 게 아니라 **이미 끝난 일을 보이게** 하는 것이다.
 */
const MIN_SPIN_MS = 450;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function LottoBoard() {
  const [snap, setSnap] = useState<LottoSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  /** 수동 새로고침 결과 안내. `at` 으로 매번 새 객체를 만들어 연속 클릭에도 타이머가 초기화된다. */
  const [feedback, setFeedback] = useState<{ kind: "updated" | "same"; at: number } | null>(null);
  /**
   * 직전 스냅샷 서명. state 가 아니라 ref 인 이유: load 의 의존성에 snap 을 넣으면 useCallback
   * 이 매 갱신마다 새로 만들어지고, 그걸 보는 useEffect 가 다시 load 를 부르는 무한 루프가 된다.
   */
  const prevSigRef = useRef<string | null>(null);
  /**
   * 다음 실행은 스케줄 응답(next.lotto)이 정본이다. snap.nextCycleAt 은 string 계약이라 자동 실행을
   * 꺼도 스케줄상 시각을 내므로, 스케줄을 못 불러왔을 때의 폴백으로만 쓴다(null = 꺼짐).
   */
  const { schedule } = useTabConfig();

  /** manual=true 는 사용자가 버튼을 누른 경우. 최초 자동 로드에는 안내를 띄우지 않는다. */
  const load = useCallback(async (manual = false) => {
    setLoading(true);
    const startedAt = Date.now();
    try {
      const next = await api.lotto();
      const nextSig = snapshotSignature(next);
      if (manual) {
        const elapsed = Date.now() - startedAt;
        if (elapsed < MIN_SPIN_MS) await sleep(MIN_SPIN_MS - elapsed);
        setFeedback({
          kind: prevSigRef.current !== null && prevSigRef.current === nextSig ? "same" : "updated",
          at: Date.now(),
        });
      }
      prevSigRef.current = nextSig;
      setSnap(next);
      setErr(null);
    } catch (e) {
      setSnap(null);
      setErr((e as Error).message);
      setFeedback(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 안내는 잠깐만 띄운다. 남겨두면 다음에 눌렀을 때 그게 방금 것인지 아까 것인지 알 수 없다.
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 3000);
    return () => clearTimeout(t);
  }, [feedback]);

  if (loading && !snap) {
    return <LoadingState />;
  }

  if (!snap) {
    return (
      <EmptyState
        action={
          <Button variant="outline" size="sm" onClick={() => void load(true)}>
            다시 시도
          </Button>
        }
      >
        <p>로또 데이터를 불러올 수 없습니다.</p>
        {err && <p className="mt-1 text-[13px] text-muted-foreground/70">({err})</p>}
      </EmptyState>
    );
  }

  const nextCycle = schedule ? schedule.next.lotto : snap.nextCycleAt;

  return (
    <div>
      <PageToolbar
        actions={
          <>
            {/* 눌렀는데 화면이 그대로인 게 정상이라는 것을 알려준다 — 주 1회 갱신이라 대개 '최신'이다. */}
            {feedback && (
              <span
                className={cn(
                  "flex items-center gap-1 whitespace-nowrap text-[13px]",
                  feedback.kind === "updated" ? "font-medium text-tab" : "text-muted-foreground"
                )}
              >
                <Check className="h-3.5 w-3.5" />
                {feedback.kind === "updated" ? "새 내용으로 갱신됨" : "이미 최신입니다 (주 1회 갱신)"}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              새로고침
            </Button>
          </>
        }
      >
        <Meta>
          <strong>로또 6/45</strong>
        </Meta>
        <MetaDot />
        {/* 다음 실행은 바로 뒤 '다음'(nextCycle — 스케줄 next.lotto 우선)이 이미 보여 주므로 버튼에서는 뺀다. */}
        <ScheduleControl tab="lotto" label="자동 갱신" showNext={false} />
        <MetaDot />
        <Meta>새 추첨 결과로 지난 회차를 채점하고 다음 회차 번호를 뽑습니다.</Meta>
        <MetaDot />
        <Meta>
          다음 <strong>{nextCycle ? fmtWhen(nextCycle) : "자동 실행 꺼짐"}</strong>
        </Meta>
        {snap.state.lastCycleAt && (
          <>
            <MetaDot />
            <Meta>
              최근 <strong>{fmtWhen(snap.state.lastCycleAt)}</strong>
            </Meta>
          </>
        )}
      </PageToolbar>

      {/* 자동 사이클이 남긴 오류는 조용히 삼키지 않는다 — 번호가 갱신되지 않은 이유가 여기 있다. */}
      {snap.state.lastError && (
        <Notice tone="warn">
          마지막 자동 갱신에서 문제가 있었습니다 — {snap.state.lastError}
          {snap.state.retryAt && ` (${fmtWhen(snap.state.retryAt)} 재시도 예정)`}
        </Notice>
      )}

      <section>
        <UpcomingCard snap={snap} />
      </section>

      {/* SectionHeader 의 first:mt-0 은 section 안에서 적용되므로 섹션 간격은 section 이 갖는다. */}
      <section className="mt-10">
        <SectionHeader title="지난 회차 비교" count={`최근 ${snap.recentResults.length}회차`} />
        {snap.recentResults.length === 0 ? (
          <EmptyLine>아직 채점된 회차가 없습니다.</EmptyLine>
        ) : (
          <div>
            {snap.recentResults.map((r) => (
              <ResultCard key={r.round} r={r} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
