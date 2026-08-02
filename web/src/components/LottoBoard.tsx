import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CalendarClock, Check, Copy, Loader2, RefreshCw } from "lucide-react";
import type { LottoRecentRound, LottoSnapshot } from "@shared/lotto";
import { upcomingToText, winningNumbers } from "@shared/lotto";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * 로또 탭 — **다음 회차 예상 번호**와 **지난 10회차 비교 결과** 두 가지만 보여준다.
 *
 * 2026-07-30 전면 축소. 세대 이력·바퀴별 성적표·회차 점수 추이·누적 점수 추이·가중 회차 점수
 * 추이를 전부 지웠고, 조작 버튼(실험 시작·일시정지·회차 동기화·초기화·실험 반복)도 없앴다.
 * 이제 모든 동작은 **매주 일요일 10:00 서버 cron** 이 한다(`src/lotto/cycle.ts`).
 *
 * 폴링도 없다. 데이터가 주 1회만 바뀌므로 3초마다 서버를 두드릴 이유가 없다 — 화면을 열 때
 * 한 번 받고, 갱신이 궁금하면 [새로고침]을 누르면 된다.
 */
const VIOLET = "#7c3aed";

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

/** 번호 배지 하나. tone 으로 적중/미적중/추첨번호를 구분한다. */
function NumberBadge({ n, tone }: { n: number; tone: "pick" | "hit" | "miss" | "draw" | "bonus" }) {
  const style: Record<typeof tone, string> = {
    pick: "border-[#7c3aed]/30 bg-[#7c3aed]/10 text-[#7c3aed]",
    hit: "border-[#7c3aed] bg-[#7c3aed] font-bold text-white",
    miss: "border-muted-foreground/20 text-muted-foreground",
    draw: "border-emerald-300 bg-emerald-100 font-semibold text-emerald-800",
    bonus: "border-amber-300 bg-amber-100 font-semibold text-amber-800",
  };
  return <Badge className={cn("min-w-7 justify-center tabular-nums", style[tone])}>{n}</Badge>;
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
      <Card className="p-6 text-center text-sm text-muted-foreground">
        <p>다음 회차 예상 번호가 아직 준비되지 않았습니다.</p>
        <p className="mt-1 text-xs">
          매주 일요일 10:00 자동 갱신 시 확정됩니다(서버 기동 직후에는 잠시 걸릴 수 있습니다).
        </p>
      </Card>
    );
  }
  return (
    <Card className="border-[#7c3aed]/30 p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-bold" style={{ color: VIOLET }}>
          🎱 {u.round}회차 예상 번호
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            v{u.version} · {fmtWhen(u.createdAt)} 확정
          </span>
          <Button
            variant="outline"
            size="sm"
            title={`${u.round}회차 10세트를 줄바꿈 평문으로 복사합니다`}
            onClick={() => {
              void copyToClipboard(upcomingToText(u)).then((ok) =>
                setCopied({ ok, at: Date.now() })
              );
            }}
          >
            {copied?.ok ? (
              <Check className="h-4 w-4 text-[#7c3aed]" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            {copied ? (copied.ok ? "복사됨" : "복사 실패") : "번호 복사"}
          </Button>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {u.sets.map((set, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1">
            <span className="w-5 shrink-0 text-xs text-muted-foreground">{i + 1}.</span>
            {set.map((n) => (
              <NumberBadge key={n} n={n} tone="pick" />
            ))}
          </div>
        ))}
      </div>
      {/* 이 한 줄이 없으면 "화면을 열 때마다 번호가 바뀌는 게 아닐까" 하는 의심이 남는다.
          실제로 추첨 전에 저장해 두고 다음 주에 그 번호로만 채점한다는 것을 명시한다. */}
      <p className="mt-3 border-t pt-3 text-[11px] leading-relaxed text-muted-foreground">
        추첨 전에 확정해 저장한 번호입니다 — 다시 열어도 바뀌지 않고, 다음 주 일요일에 이 번호로
        채점합니다. 실제 구매·투자 목적이 아닌 알고리즘 검증용입니다.
      </p>
    </Card>
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
  return (
    <Card className={cn("p-4", best >= 3 && "border-emerald-300 bg-emerald-50/40")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{r.round}회차</span>
          <span className="text-xs text-muted-foreground">
            {r.drawDate} · v{r.version}
          </span>
          {best >= 3 && (
            <Badge className="border-emerald-300 bg-emerald-100 text-[11px] font-semibold text-emerald-700">
              🎯 {best}개 적중
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[11px] text-muted-foreground">추첨</span>
          {r.drawNumbers.map((n) => (
            <NumberBadge key={n} n={n} tone="draw" />
          ))}
          <span className="mx-0.5 text-xs text-muted-foreground">+</span>
          <NumberBadge n={r.drawBonus} tone="bonus" />
        </div>
      </div>
      <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
        {r.sets.map((set, i) => {
          const m = r.matches[i] ?? 0;
          return (
            <div key={i} className="flex flex-wrap items-center gap-1">
              <span className="w-5 shrink-0 text-xs text-muted-foreground">{i + 1}.</span>
              {set.map((n) => (
                <NumberBadge key={n} n={n} tone={winSet.has(n) ? "hit" : "miss"} />
              ))}
              <span
                className={cn(
                  "ml-1 text-[11px]",
                  m >= 3 ? "font-semibold text-emerald-700" : "text-muted-foreground"
                )}
              >
                {m}개
              </span>
            </div>
          );
        })}
      </div>
    </Card>
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
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 불러오는 중…
      </div>
    );
  }

  if (!snap) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        <p>로또 데이터를 불러올 수 없습니다.</p>
        {err && <p className="mt-2 text-xs text-muted-foreground/70">({err})</p>}
        <Button variant="outline" size="sm" className="mt-4" onClick={() => void load(true)}>
          다시 시도
        </Button>
      </Card>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold" style={{ color: VIOLET }}>
            🎱 로또 6/45
          </h2>
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarClock className="h-3.5 w-3.5" />
            매주 일요일 10:00 자동 갱신 — 새 추첨 결과로 지난 회차를 채점하고 다음 회차 번호를
            뽑습니다.
            <span className="text-muted-foreground/70">
              (다음 {fmtWhen(snap.nextCycleAt)}
              {snap.state.lastCycleAt ? ` · 최근 ${fmtWhen(snap.state.lastCycleAt)}` : ""})
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* 눌렀는데 화면이 그대로인 게 정상이라는 것을 알려준다 — 주 1회 갱신이라 대개 '최신'이다. */}
          {feedback && (
            <span
              className={cn(
                "flex items-center gap-1 whitespace-nowrap text-xs",
                feedback.kind === "updated" ? "font-medium text-[#7c3aed]" : "text-muted-foreground"
              )}
            >
              <Check className="h-3.5 w-3.5" />
              {feedback.kind === "updated" ? "새 내용으로 갱신됨" : "이미 최신입니다 (주 1회 갱신)"}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={loading}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            새로고침
          </Button>
        </div>
      </div>

      {/* 자동 사이클이 남긴 오류는 조용히 삼키지 않는다 — 번호가 갱신되지 않은 이유가 여기 있다. */}
      {snap.state.lastError && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            마지막 자동 갱신에서 문제가 있었습니다 — {snap.state.lastError}
            {snap.state.retryAt && ` (${fmtWhen(snap.state.retryAt)} 재시도 예정)`}
          </span>
        </div>
      )}

      <section className="mb-6">
        <UpcomingCard snap={snap} />
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-lg font-bold">지난 회차 비교</h3>
          <span className="text-xs text-muted-foreground">최근 {snap.recentResults.length}회차</span>
        </div>
        {snap.recentResults.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            아직 채점된 회차가 없습니다.
          </Card>
        ) : (
          <div className="space-y-2">
            {snap.recentResults.map((r) => (
              <ResultCard key={r.round} r={r} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
