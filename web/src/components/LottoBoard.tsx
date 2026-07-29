import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  RefreshCw,
  Play,
  Pause,
  RotateCcw,
  Repeat,
  PartyPopper,
  Timer,
  Check,
} from "lucide-react";
import type { LottoStatus, LottoSnapshot, LottoRecentRound, LottoRunStat } from "@shared/lotto";
import { winningNumbers } from "@shared/lotto";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { LottoHit3Chart, LottoScoreChart, LottoCumulativeChart } from "@/components/LottoChart";

const STATUS_LABEL: Record<LottoStatus, string> = {
  idle: "대기",
  running: "진행중",
  paused: "일시정지",
  done: "완주",
};

const STATUS_BADGE: Record<LottoStatus, string> = {
  idle: "border-slate-200 bg-slate-100 text-slate-600",
  running: "border-violet-200 bg-violet-100 text-violet-700",
  paused: "border-amber-200 bg-amber-100 text-amber-700",
  done: "border-emerald-200 bg-emerald-100 text-emerald-700",
};

type BusyAction = "start" | "pause" | "sync" | "reset" | "ack" | "repeat" | null;

/** 셋 다 shadcn Progress 컴포넌트가 없어(ui/ 아래 미설치) 직접 조합한다 — 새 라이브러리 추가 금지 규칙. */
function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-[#7c3aed] transition-all"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function fmtSigned(n: number, digits = 0): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}`;
}

/** 0~1 비율을 "36.4%" 형태로. */
function fmtPct(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/**
 * 바퀴별 성적표에서 "천장에 얼마나 근접했는가"를 막대로 보여준다. 무작위~천장 구간을 0~100%로
 * 정규화한다 — 두 기준선 사이 3%p 안에서 어디쯤인지가 이 실험의 결론이라, 절대 스케일(0~100%
 * 적중률)로 그리면 막대가 거의 안 움직여 의미가 없다. 구간 밖(기준선보다 낮거나 천장을
 * 넘는 값)도 나올 수 있어 0~100으로 clamp 한다.
 */
function Hit3Bar({ rate, random, ceiling }: { rate: number; random: number; ceiling: number }) {
  const span = ceiling - random;
  const pct = span > 0 ? ((rate - random) / span) * 100 : 0;
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="mt-1 h-1.5 w-20 overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${clamped}%` }} />
    </div>
  );
}

/** 기준선 대비 색: "+면 초록, -면 회색" — 증시 탭의 상승/하락 색(빨강/파랑) 관례와 절대 섞이면
 * 안 된다는 팀 리드 지시라서, 여기서만 쓰는 별도 팔레트를 둔다. */
function diffColor(diff: number): string {
  return diff > 0 ? "text-emerald-600" : "text-slate-400";
}

/** 토큰 한도 자동 재개까지 남은 시간을 1초마다 갱신한다. 컴포넌트를 분리해 두어야 이 카운트다운
 * 때문에 보드 전체가 매초 리렌더되는 걸 막는다. */
function Countdown({ target }: { target: string }) {
  const [label, setLabel] = useState(() => remain(target));
  useEffect(() => {
    const id = setInterval(() => setLabel(remain(target)), 1000);
    return () => clearInterval(id);
  }, [target]);
  return <span className="font-mono">{label}</span>;
}

function remain(target: string): string {
  const diff = new Date(target).getTime() - Date.now();
  if (diff <= 0) return "곧 재개";
  const totalSec = Math.floor(diff / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h > 0 ? `${h}시간 ` : ""}${m}분 ${s}초`;
}

/** 세트 하나 + 그 회차 당첨번호와 대조해 맞힌 번호를 배지로 강조. */
function SetRow({
  index,
  set,
  matched,
  matches,
}: {
  index: number;
  set: number[];
  matched: Set<number>;
  matches: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <span className="w-5 shrink-0 text-muted-foreground">{index + 1}.</span>
      {set.map((n) => (
        <Badge
          key={n}
          className={
            matched.has(n)
              ? "border-[#7c3aed] bg-[#7c3aed]/15 font-semibold text-[#7c3aed]"
              : "border-muted-foreground/20 text-muted-foreground"
          }
        >
          {n}
        </Badge>
      ))}
      <span className="ml-1 text-muted-foreground">({matches}개 적중)</span>
    </div>
  );
}

function RecentRoundCard({ r }: { r: LottoRecentRound }) {
  const win = winningNumbers({
    round: r.round,
    drawDate: r.drawDate,
    numbers: r.drawNumbers,
    bonus: r.drawBonus,
  });
  const winSet = new Set(win);
  // 목표 지표(3+ 적중)의 회차 단위 관측 — bestMatch/hit3 필드가 따로 없어도 matches 배열에서
  // 바로 구해진다(레코드를 부풀리지 않으려고 백엔드가 이 값을 별도 필드로 안 내려준다).
  const bestMatch = r.matches.length ? Math.max(...r.matches) : 0;
  const hit3 = bestMatch >= 3;
  return (
    <Card className={cn("p-3", hit3 && "border-emerald-400 bg-emerald-50/50 ring-1 ring-emerald-200")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold">{r.round}회차</span>
          {hit3 && (
            <Badge className="border-emerald-300 bg-emerald-100 text-[11px] font-semibold text-emerald-700">
              🎯 3+ 적중 · 최고 {bestMatch}개
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {r.drawDate} · v{r.version}
          </span>
        </div>
        <span className={cn("text-sm font-bold", diffColor(r.score))}>{fmtSigned(r.score)}점</span>
      </div>
      <div className="mt-2 grid gap-1 sm:grid-cols-2">
        {r.sets.map((set, i) => (
          <SetRow key={i} index={i} set={set} matched={winSet} matches={r.matches[i] ?? 0} />
        ))}
      </div>
    </Card>
  );
}

/** 바퀴별 성적표 한 행 — 이 실험의 결론이 읽히는 곳이라 세대 표보다 크고 눈에 띄게 그린다. */
function RunRow({ r, hit3Random, hit3Ceiling }: { r: LottoRunStat; hit3Random: number; hit3Ceiling: number }) {
  const diff = (r.hit3Rate - hit3Random) * 100;
  return (
    <tr className={cn("border-t align-middle", r.inProgress && "bg-violet-50/60")}>
      <td className="px-3 py-3 font-semibold">{r.run}바퀴</td>
      <td className="px-3 py-3 text-right text-muted-foreground">{r.rounds}</td>
      <td className="px-3 py-3 text-muted-foreground">
        v{r.firstVersion}~v{r.lastVersion}
      </td>
      <td className="px-3 py-3">
        <div className="text-right text-base font-extrabold text-emerald-700">{fmtPct(r.hit3Rate)}</div>
        <div className={cn("text-right text-[11px] font-medium", diff > 0 ? "text-emerald-600" : "text-slate-400")}>
          ({fmtSigned(diff, 1)}%p vs 무작위)
        </div>
        <Hit3Bar rate={r.hit3Rate} random={hit3Random} ceiling={hit3Ceiling} />
      </td>
      <td className="px-3 py-3 text-right">{r.hit3Rounds}</td>
      <td className="px-3 py-3 text-right font-semibold">{r.bestMatch}</td>
      <td className="px-3 py-3 text-right text-muted-foreground">{r.avgScore.toFixed(2)}</td>
      <td className="px-3 py-3">
        {r.inProgress ? (
          <Badge className="border-violet-200 bg-violet-100 text-violet-700">진행중</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">완료</span>
        )}
      </td>
    </tr>
  );
}

/**
 * 로또 6/45 예측 실험 탭.
 *
 * 백엔드가 아직 붙지 않았을 수 있으므로(다른 담당이 동시 작업 중) `/api/lotto` 가 404/500 을
 * 내도 화면이 깨지지 않게, load 실패는 에러가 아니라 "아직 못 불러옴" 빈 상태로 처리한다.
 */
export function LottoBoard() {
  const [snap, setSnap] = useState<LottoSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  // 폴링에서 "회차가 실제로 늘었는지"만 비교하려고 마지막으로 받은 scoredThrough 를 따로 들고 있는다.
  const scoredThroughRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.lotto();
      setSnap(s);
      scoredThroughRef.current = s.scoredThrough;
      setLoadErr(null);
    } catch (e) {
      setSnap(null);
      setLoadErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // running 일 때만 폴링한다 — 대기/일시정지/완주 상태에서는 어차피 값이 안 바뀌므로 3초마다
  // 서버를 칠 이유가 없다. 폴링도 가벼운 status 엔드포인트만 치고, scoredThrough(또는 상태)가
  // 실제로 바뀌었을 때만 1200점짜리 전체 스냅샷(lotto())을 다시 받는다 — 매번 통째로 받으면
  // 3초마다 회차 1234개 × 세대 25개 데이터를 다시 그리게 되어 낭비가 크다.
  useEffect(() => {
    if (snap?.state.status !== "running") return;
    const id = setInterval(async () => {
      try {
        const st = await api.lottoStatus();
        if (st.scoredThrough !== scoredThroughRef.current || st.status !== "running") {
          await load();
        }
      } catch {
        /* 폴링 실패는 다음 주기에 재시도 — 배너를 띄우지 않는다 */
      }
    }, 3000);
    return () => clearInterval(id);
  }, [snap?.state.status, load]);

  async function run(action: Exclude<BusyAction, null>, fn: () => Promise<unknown>) {
    setBusy(action);
    setActionErr(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const start = () => run("start", api.startLotto);
  const pause = () => run("pause", api.pauseLotto);
  const sync = () => run("sync", api.syncLotto);
  const ack = () => run("ack", api.ackLotto);
  // 실험 반복은 초기화와 달리 되돌릴 게 없다(전략 세대·지난 바퀴 기록을 전부 보존한 채 새 바퀴만
  // 시작) — 그래서 confirm 창이 없다. 서버가 상태를 running 으로 올려 두고 반환하므로, 여기서
  // load() 만 해 주면 기존 폴링 useEffect(status==="running" 감시)가 알아서 이어받는다.
  const repeat = () => run("repeat", api.repeatLotto);
  async function reset() {
    if (
      !confirm(
        "모든 예측·전략을 삭제하고 1회차부터 다시 시작할까요?\n지금까지의 세대 이력과 채점 결과가 전부 사라지며 되돌릴 수 없습니다."
      )
    )
      return;
    await run("reset", api.resetLotto);
  }

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
        <p>로또 실험 데이터를 아직 불러올 수 없습니다.</p>
        <p className="mt-1 text-xs">
          백엔드 API가 아직 준비되지 않았거나 실험이 시작되지 않았을 수 있습니다.
        </p>
        {loadErr && <p className="mt-2 text-xs text-muted-foreground/70">({loadErr})</p>}
        <Button variant="outline" size="sm" className="mt-4" onClick={() => void load()}>
          다시 시도
        </Button>
      </Card>
    );
  }

  const progressPct = snap.latestDraw ? ((snap.scoredThrough ?? 0) / snap.latestDraw) * 100 : 0;
  const avgDiff = snap.avgScore != null ? snap.avgScore - snap.baselinePerRound : null;
  const currentVersion = snap.strategies.length
    ? snap.strategies[snap.strategies.length - 1].version
    : null;
  // recentResults 는 백엔드가 오름차순(최신이 뒤)으로 20건을 채워 주므로, 화면에서는
  // 최신이 위에 오도록 뒤집기만 한다(항상 배열이라 별도 폴백은 필요 없다).
  const recent = [...snap.recentResults].sort((a, b) => b.round - a.round);
  const hit3DiffVsRandom = snap.hit3Rate != null ? (snap.hit3Rate - snap.hit3Random) * 100 : null;
  // 실험 반복은 완주(done) 상태에서만 서버가 받아 준다(experiment.ts repeatExperiment 참고).
  // 버튼을 누르기 전에 이유를 보여 주기 위해 프론트에서도 같은 조건을 미리 안내한다.
  const repeatDisabledReason: string | undefined =
    snap.state.status === "done"
      ? undefined
      : snap.state.status === "running"
        ? "실험이 진행 중입니다 — 완주해야 반복할 수 있습니다."
        : snap.state.status === "paused"
          ? "일시정지 상태입니다 — 재개해 완주한 뒤 반복할 수 있습니다."
          : "아직 완주하지 않았습니다 — 완주해야 반복할 수 있습니다.";

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold" style={{ color: "#7c3aed" }}>
            🎱 로또 예측 실험
          </h2>
          <p className="text-xs text-muted-foreground">
            1회차부터 최신 회차까지 walk-forward 로 걸으며 매 회차 10세트를 채점합니다. 실제
            구매·투자 목적이 아닌 알고리즘 검증 실험입니다.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            style={{ backgroundColor: "#7c3aed" }}
            onClick={start}
            disabled={
              busy !== null ||
              snap.state.status === "running" ||
              // 완주 + 새 회차 없음 = 이어서 돌릴 대상이 없다. remaining > 0(동기화로 새 회차가
              // 들어온 경우)은 여전히 눌러야 하므로 여기서 제외한다.
              (snap.state.status === "done" && snap.remaining === 0)
            }
            title={
              snap.state.status === "done" && snap.remaining === 0
                ? "완주했습니다 — 새 회차가 있어야 이어서 진행할 수 있습니다"
                : undefined
            }
          >
            {busy === "start" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            실험 시작
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={pause}
            disabled={busy !== null || snap.state.status !== "running"}
          >
            {busy === "pause" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Pause className="h-4 w-4" />
            )}
            일시정지
          </Button>
          <Button size="sm" variant="outline" onClick={sync} disabled={busy !== null}>
            {busy === "sync" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            회차 동기화
          </Button>
          {/* 실험 반복 — 초기화(빨강, 파괴적)와 명확히 구분한다. 반복은 아무것도 지우지 않고
              전략 세대·지난 바퀴 기록을 그대로 둔 채 새 바퀴(run+1)만 1회차부터 시작하므로
              destructive 변이 아니라 별도의 초록 계열 색을 쓴다. */}
          <Button
            size="sm"
            style={{ backgroundColor: "#059669" }}
            onClick={repeat}
            disabled={busy !== null || snap.state.status !== "done"}
            title={repeatDisabledReason ?? "초기화 없이 1회차부터 한 바퀴 더 돕니다. 전략 세대와 지난 바퀴 기록은 보존됩니다."}
          >
            {busy === "repeat" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Repeat className="h-4 w-4" />
            )}
            실험 반복
          </Button>
          <Button size="sm" variant="destructive" onClick={reset} disabled={busy !== null}>
            {busy === "reset" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCcw className="h-4 w-4" />
            )}
            초기화
          </Button>
        </div>
      </div>

      {actionErr && (
        <div className="mb-4 rounded-md border border-up/40 bg-up/10 px-4 py-3 text-sm text-up">
          {actionErr}
        </div>
      )}

      {/* 완주 배너 — 확인 전까지 계속 뜬다(인터뷰 규칙). 완주 후 [회차 동기화]로 새 회차가
          들어오면(remaining > 0) status 는 여전히 "done" 이지만 더 이상 "읽을 회차가 없다"는
          말은 거짓이 되므로, remaining 으로 문구 자체를 분기한다. */}
      {snap.state.status === "done" && !snap.state.doneAcknowledged && (
        <Card className="mb-4 border-emerald-300 bg-emerald-50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <PartyPopper className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div>
                {snap.remaining > 0 ? (
                  <>
                    <p className="font-semibold text-emerald-800">
                      새 회차 {snap.remaining}건이 도착했습니다.
                    </p>
                    <p className="text-sm text-emerald-700">
                      [실험 시작]을 누르면 {snap.nextRound}회차부터 이어서 진행합니다.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-semibold text-emerald-800">
                      더 이상 읽을 회차가 없습니다. 1~{snap.latestDraw ?? snap.scoredThrough}회차
                      완주 — 모든 자동 동작이 멈췄습니다(주간 회차 동기화 포함).
                    </p>
                    <p className="text-sm text-emerald-700">
                      아래 [실험 반복]으로 초기화 없이 처음부터 다시 돌리거나, [회차 동기화]로 새
                      회차만 먼저 확인하세요.
                    </p>
                  </>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {/* 배너 안의 실험 반복 — 완주 상태에서 뜨는 배너이므로 항상 활성(busy 만 체크). */}
              <Button
                size="sm"
                variant="outline"
                className="border-emerald-400 text-emerald-800 hover:bg-emerald-100"
                onClick={repeat}
                disabled={busy !== null}
                title="초기화 없이 1회차부터 한 바퀴 더 돕니다. 전략 세대와 지난 바퀴 기록은 보존됩니다."
              >
                {busy === "repeat" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Repeat className="h-4 w-4" />
                )}
                실험 반복
              </Button>
              <Button size="sm" onClick={ack} disabled={busy === "ack"}>
                {busy === "ack" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                확인
              </Button>
            </div>
          </div>
          {snap.upcoming && (
            <div className="mt-3 rounded-md border border-emerald-200 bg-white/60 p-3">
              <p className="mb-2 text-sm font-semibold text-emerald-800">
                다음 회차({snap.upcoming.round}회차) 추천 번호 10세트
              </p>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {snap.upcoming.sets.map((set, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1 text-xs">
                    <span className="w-5 shrink-0 text-muted-foreground">{i + 1}.</span>
                    {set.map((n) => (
                      <Badge key={n} className="border-emerald-300 bg-emerald-100 text-emerald-800">
                        {n}
                      </Badge>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* 완주를 이미 확인한 뒤에도 "자동 동작이 멈춰 있다"는 사실은 상시 한 줄 안내로 남긴다 —
          큰 배너는 사라지지만 상태 배지 하나만으로는 "다음 지시를 내려야 한다"는 걸 놓치기
          쉽다(팀 리드 지시, 2026-07-29). */}
      {snap.state.status === "done" && snap.state.doneAcknowledged && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50/60 px-4 py-2 text-sm text-emerald-800">
          <PartyPopper className="h-4 w-4 shrink-0" />
          {snap.remaining > 0 ? (
            <span>
              새 회차 {snap.remaining}건 도착 — [실험 시작]을 누르면 {snap.nextRound}회차부터
              이어서 진행합니다.
            </span>
          ) : (
            <span>
              1~{snap.latestDraw ?? snap.scoredThrough}회차 완주 — 모든 자동 동작이 멈춰
              있습니다(주간 회차 동기화 포함). 다음 동작 지정 대기 중.
            </span>
          )}
        </div>
      )}

      {/* 토큰 한도 소진 안내 — 자동 재개 예정 시각을 카운트다운으로 같이 보여준다. */}
      {snap.state.status === "paused" && snap.state.pauseReason === "usage-limit" && (
        <Card className="mb-4 flex items-center gap-2 border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          <Timer className="h-4 w-4 shrink-0" />
          <span>
            토큰 한도 소진 —{" "}
            {snap.state.resumeAt ? new Date(snap.state.resumeAt).toLocaleString("ko-KR") : "알 수 없음"}
            에 자동 재개합니다
            {snap.state.resumeAt && (
              <>
                {" "}
                (<Countdown target={snap.state.resumeAt} />)
              </>
            )}
          </span>
        </Card>
      )}

      {/* 그 외 사유(수동/오류)로 멈춘 경우도 원인을 남긴다. */}
      {snap.state.status === "paused" &&
        snap.state.pauseReason &&
        snap.state.pauseReason !== "usage-limit" && (
          <div className="mb-4 rounded-md border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
            일시정지됨 ({snap.state.pauseReason === "error" ? "오류" : "수동 정지"})
            {snap.state.lastError && ` — ${snap.state.lastError}`}
          </div>
        )}

      {/* 상태 카드 — 헤드라인이 3+ 적중률로 바뀌었다(팀 리드 지시, 2026-07-29 목표 전환).
          점수/평균점수는 지우지 않고 작게 "(대조군)" 라벨과 함께 아래 서브 로우로 내렸다. */}
      <Card className="mb-6 p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <div className="text-xs text-muted-foreground">진행률</div>
            <div className="mt-1 text-lg font-bold">
              {snap.scoredThrough ?? 0} / {snap.latestDraw ?? "-"}
            </div>
            <div className="mt-2">
              <ProgressBar pct={progressPct} />
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">상태</div>
            <div className="mt-1.5">
              <Badge className={cn("px-2.5 py-1 text-sm font-semibold", STATUS_BADGE[snap.state.status])}>
                {STATUS_LABEL[snap.state.status]}
              </Badge>
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              3+ 적중률
              <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                목표 지표
              </span>
            </div>
            <div className="mt-1 text-2xl font-extrabold text-emerald-700">
              {snap.hit3Rate != null ? fmtPct(snap.hit3Rate) : "-"}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              무작위 {fmtPct(snap.hit3Random)} · 천장 {fmtPct(snap.hit3Ceiling)}
              {hit3DiffVsRandom != null && (
                <span
                  className={cn(
                    "ml-1.5 font-semibold",
                    hit3DiffVsRandom > 0 ? "text-emerald-600" : "text-slate-400"
                  )}
                >
                  ({fmtSigned(hit3DiffVsRandom, 1)}%p vs 무작위)
                </span>
              )}
            </div>
          </div>
        </div>
        {/* 대조군(점수) 요약 — 작게. 지우지 않는 이유: 점수 자체는 여전히 채점 로그이자
            "세트가 하나도 안 맞은 비율" 같은 다른 신호의 원천이라 화면에서 완전히 뺄 이유는 없다. */}
        <div className="mt-4 grid grid-cols-2 gap-4 border-t pt-3 sm:grid-cols-4">
          <div>
            <div className="text-[11px] text-muted-foreground">
              누적 점수 <span className="opacity-70">(대조군)</span>
            </div>
            <div className={cn("mt-0.5 text-sm font-semibold", diffColor(snap.cumScore))}>
              {fmtSigned(snap.cumScore)}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">
              회차당 평균 <span className="opacity-70">(대조군)</span>
            </div>
            <div className="mt-0.5 text-sm font-semibold">
              {snap.avgScore != null ? snap.avgScore.toFixed(2) : "-"}
              {avgDiff != null && (
                <span className={cn("ml-1 text-xs font-medium", diffColor(avgDiff))}>
                  ({fmtSigned(avgDiff, 2)})
                </span>
              )}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">현재 세대</div>
            <div className="mt-0.5 text-sm font-semibold">v{currentVersion ?? "-"}</div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">현재 바퀴</div>
            <div className="mt-0.5 text-sm font-semibold">{snap.state.run}바퀴째</div>
          </div>
        </div>
        {/* 새 캡션 — 이 실험이 왜 "3+ 적중률"만 유일하게 최적화 가능한지 설명한다(팀 리드 지시).
            기존 "기준선은 어떤 전략이든 동일 / 분산만 바뀜" 문장은 아래 점수 차트(대조군) 쪽으로
            옮겼다 — 그건 점수 얘기지 3+ 적중률 얘기가 아니라서 여기 남으면 헷갈린다. */}
        <p className="mt-4 border-t pt-3 text-xs leading-relaxed text-muted-foreground">
          3+ 적중 <span className="font-semibold text-foreground">세트의 총 개수</span>는 전략과
          무관하게 고정입니다. 바뀌는 것은 그 적중이{" "}
          <span className="font-semibold text-foreground">몇 개의 서로 다른 회차에 흩어지는가</span>
          입니다. 그래서 이 비율만이 유일하게 최적화 가능한 지표입니다.
        </p>
      </Card>

      {/* 3+ 적중률 추이 — 이 실험의 새 주인공 차트(LottoChart.tsx 의 LottoHit3Chart 참고). */}
      <section className="mb-6">
        <Card className="p-4">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-lg font-bold" style={{ color: "#059669" }}>
              🎯 3+ 적중률 추이
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                — 이 실험의 목표 지표
              </span>
            </h3>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-0.5 w-3 bg-[#059669]" />
                200회차 이동평균
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-0.5 w-3 bg-[#a7f3d0]" />
                누적
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-0 w-3 border-t border-dashed border-slate-400" />
                무작위 / 천장 기준선
              </span>
            </div>
          </div>
          <LottoHit3Chart
            points={snap.points}
            strategies={snap.strategies}
            hit3Random={snap.hit3Random}
            hit3Ceiling={snap.hit3Ceiling}
          />
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            y축은 25%~45%로 고정했습니다 — 자동 스케일이면 기준선(
            {fmtPct(snap.hit3Random)})과 천장({fmtPct(snap.hit3Ceiling)})의 3%p 차이가 뭉개져
            안 보입니다.
          </p>
        </Card>
      </section>

      {/* 바퀴별 성적표 — 이 실험의 결론이 읽히는 곳이라 세대 표(50회차 창, 표준오차 6.7%p)보다
          위에, 더 크게 배치한다(팀 리드 지시). run 이 쌓일수록 "반복이 실제로 도움이 되는가"가
          여기서 드러난다. */}
      <section className="mb-6">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-lg font-bold">바퀴별 성적표</h3>
          <span className="text-xs text-muted-foreground">
            현재 {snap.state.run}번째 바퀴 · 총 {snap.runs.length}바퀴
          </span>
        </div>
        {snap.runs.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            아직 완료된 바퀴가 없습니다.
          </Card>
        ) : (
          <Card className="overflow-x-auto border-emerald-200 p-0">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-emerald-50/60 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">바퀴</th>
                  <th className="px-3 py-2 text-right font-medium">회차수</th>
                  <th className="px-3 py-2 text-left font-medium">세대 범위</th>
                  <th className="px-3 py-2 text-right font-medium">3+ 적중률</th>
                  <th className="px-3 py-2 text-right font-medium">3+ 회차수</th>
                  <th className="px-3 py-2 text-right font-medium">최고적중</th>
                  <th className="px-3 py-2 text-right font-medium">평균점수 (대조군)</th>
                  <th className="px-3 py-2 text-left font-medium">상태</th>
                </tr>
              </thead>
              <tbody>
                {snap.runs.map((r) => (
                  <RunRow key={r.run} r={r} hit3Random={snap.hit3Random} hit3Ceiling={snap.hit3Ceiling} />
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      {/* 세대 이력 — hit3Rate/bestMatch 컬럼을 추가하고, 표가 넓어진 만큼 점수 관련 컬럼
          (기준선 대비/0개 세트 비율)을 뺐다. */}
      <section className="mb-6">
        <h3 className="mb-2 text-lg font-bold">세대 이력</h3>
        {snap.generations.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            아직 세대 개정이 없습니다.
          </Card>
        ) : (
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[840px] text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">세대</th>
                  <th className="px-3 py-2 text-left font-medium">회차 구간</th>
                  <th className="px-3 py-2 text-right font-medium">회차수</th>
                  <th className="px-3 py-2 text-right font-medium">3+ 적중률</th>
                  <th className="px-3 py-2 text-right font-medium">최고적중</th>
                  <th className="px-3 py-2 text-right font-medium">평균점수 (대조군)</th>
                  <th className="px-3 py-2 text-right font-medium">세트당 평균 적중</th>
                  <th className="px-3 py-2 text-left font-medium">가설 · 근거</th>
                </tr>
              </thead>
              <tbody>
                {snap.generations.map((g) => {
                  const strat = snap.strategies.find((s) => s.version === g.version);
                  return (
                    <tr key={g.version} className="border-t align-top">
                      <td className="px-3 py-2 font-semibold">v{g.version}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {g.fromRound}~{g.toRound}회
                      </td>
                      <td className="px-3 py-2 text-right">{g.rounds}</td>
                      <td className="px-3 py-2 text-right font-semibold text-emerald-700">
                        {fmtPct(g.hit3Rate)}
                      </td>
                      <td className="px-3 py-2 text-right">{g.bestMatch}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">
                        {g.avgScore.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right">{g.avgMatches.toFixed(2)}</td>
                      <td className="px-3 py-2">
                        {strat ? (
                          <details>
                            <summary className="cursor-pointer select-none text-xs font-medium text-[#7c3aed] hover:underline">
                              가설·근거 보기
                            </summary>
                            <div className="mt-1.5 max-w-md space-y-1 text-xs leading-relaxed text-foreground/80">
                              <p>
                                <span className="font-semibold text-foreground">가설</span>{" "}
                                {strat.hypothesis || "-"}
                              </p>
                              <p className="whitespace-pre-line">
                                <span className="font-semibold text-foreground">근거</span>{" "}
                                {strat.rationale || "-"}
                              </p>
                            </div>
                          </details>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      {/* 회차 점수 / 누적 점수 — 이제 대조군. 스케일이 완전히 달라 반드시 별도 차트로 그린다
          (LottoChart 주석 참고). 목표 지표(3+ 적중률) 차트보다 아래로 내렸다(팀 리드 지시). */}
      <section className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">회차 점수 추이 (대조군)</h3>
          <LottoScoreChart
            points={snap.points}
            strategies={snap.strategies}
            baselinePerRound={snap.baselinePerRound}
          />
          {/* 오독 방지 캡션 — 곡선이 기준선 위로 잠깐 올라간 구간을 "알고리즘이 통했다"로 읽는
              게 이 화면의 가장 흔한 오독이다. 결론(예측 가능/불가능)은 내리지 않고, 기대값은
              전략과 무관하게 고정이고 전략은 분산만 바꾼다는 사실만 남겨 둔다(팀 리드 지시). */}
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            기준선은 어떤 전략을 써도 수학적으로 동일합니다(무작위 기준선{" "}
            {snap.baselinePerRound.toFixed(2)}/회차) — 전략이 바꿀 수 있는 것은 기대값이 아니라{" "}
            <span className="font-semibold text-foreground">분산</span>뿐입니다. 기준선 위아래로
            흔들리는 구간은 대부분 잡음입니다.
          </p>
        </Card>
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">누적 점수 추이 (대조군)</h3>
          <LottoCumulativeChart points={snap.points} baselinePerRound={snap.baselinePerRound} />
        </Card>
      </section>

      {/* 최근 회차 — recentResults 는 shared/lotto.ts 의 LottoSnapshot 필수 필드다(항상 배열,
          채점 전이면 빈 배열). */}
      <section>
        <h3 className="mb-2 text-lg font-bold">최근 회차</h3>
        {recent.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            아직 채점된 회차가 없습니다.
          </Card>
        ) : (
          <div className="space-y-2">
            {recent.map((r) => (
              <RecentRoundCard key={r.round} r={r} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
