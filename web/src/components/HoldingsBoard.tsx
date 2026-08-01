import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Trash2, Radio, AlertTriangle, Check } from "lucide-react";
import type { StockHoldingSummary, StockMarket } from "@shared/types";
import { marketLabel, formatPrice, changeTone } from "@shared/stock";
import { formatPnlPct, horizonLabel } from "@shared/holdings";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AddHoldingDialog } from "@/components/AddHoldingDialog";
import { ScheduleControl } from "@/components/ScheduleControl";

const MARKETS: StockMarket[] = ["kr", "us"];

/**
 * ⚠️ 등락·손익 색은 **한국 증시 관례**다: 상승=빨강, 하락=파랑.
 * 쇼핑 관점(하락=좋음=초록)과 규칙이 정반대이므로 절대 섞지 말 것
 * (src/notify/stock-email.ts 상단 주석과 같은 경고다).
 */
function toneClass(pct: number | null): string {
  const t = changeTone(pct);
  return t === "up" ? "text-red-600" : t === "down" ? "text-blue-600" : "text-slate-400";
}

function HoldingRow({
  h,
  onDeleted,
}: {
  h: StockHoldingSummary;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    if (
      !confirm(
        `${h.name}(${h.symbol}) 을(를) 보유 종목에서 삭제할까요?\n` +
          `관심 종목(등록 종목)에는 그대로 남아 브리핑에 계속 나옵니다.`
      )
    )
      return;
    setDeleting(true);
    try {
      await api.deleteHolding(h.id, h.symbol);
      onDeleted();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  // 시세 조회 실패(close=null)도 행을 감추지 않는다 — 보유 사실은 시세와 무관하게 유효하고,
  // 감추면 사용자는 포지션이 사라진 것으로 오해한다(shared/holdings.ts summarizeHolding 주석).
  const noQuote = h.close == null;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold">{h.name}</span>
          <span className="text-xs text-slate-400">
            {h.symbol} · {horizonLabel(h.horizon)}
          </span>
        </div>
        <div className="flex items-baseline gap-3">
          <span className={cn("text-lg font-bold", toneClass(h.pnlPct))}>
            {formatPnlPct(h.pnlPct)}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={remove}
            disabled={deleting}
            title="보유 종목에서 삭제"
          >
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-4">
        <div>
          <span className="text-slate-400">현재가 </span>
          <span className="font-medium">{formatPrice(h.close, h.currency)}</span>
          {h.changePct != null && (
            <span className={cn("ml-1 text-xs", toneClass(h.changePct))}>
              {h.changePct > 0 ? "▲" : h.changePct < 0 ? "▼" : ""}
              {Math.abs(h.changePct).toFixed(2)}%
            </span>
          )}
        </div>
        <div>
          <span className="text-slate-400">평단 </span>
          <span className="font-medium">{formatPrice(h.avgPrice, h.currency)}</span>
        </div>
        <div>
          <span className="text-slate-400">수량 </span>
          <span className="font-medium">{h.quantity}</span>
        </div>
        <div>
          <span className="text-slate-400">평가금액 </span>
          <span className="font-medium">{formatPrice(h.marketValue, h.currency)}</span>
        </div>
      </div>

      {(h.targetPrice != null || h.stopPrice != null) && (
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
          {h.targetPrice != null && (
            <span>
              🎯 목표 {formatPrice(h.targetPrice, h.currency)}{" "}
              <span className="text-slate-400">({formatPnlPct(h.toTargetPct)})</span>
            </span>
          )}
          {h.stopPrice != null && (
            <span>
              🛡 손절 {formatPrice(h.stopPrice, h.currency)}{" "}
              <span className="text-slate-400">({formatPnlPct(h.toStopPct)})</span>
            </span>
          )}
        </div>
      )}

      {h.memo && <p className="mt-2 text-xs leading-relaxed text-slate-500">📝 {h.memo}</p>}

      {noQuote && (
        <p className="mt-2 flex items-center gap-1 text-xs text-amber-600">
          <AlertTriangle className="h-3 w-3" /> 시세를 가져오지 못했습니다. 손익은 다음 조회 때 채워집니다.
        </p>
      )}
    </Card>
  );
}

/** 펄스 상태 줄. 화면에 피드는 두지 않기로 했으므로(인터뷰 결정) 여기서 '도는지'만 보여준다. */
function PulseStatus() {
  const [state, setState] = useState<Awaited<ReturnType<typeof api.pulseStatus>> | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => {
    api
      .pulseStatus()
      .then(setState)
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function runNow() {
    setStarting(true);
    try {
      const r = await api.runPulse();
      if (r.busy) alert("펄스가 이미 실행 중입니다.");
      setTimeout(load, 3000);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  if (!state) return null;
  const sent = state.recent.filter((r) => r.status === "sent").length;
  const queued = state.recent.filter((r) => r.status === "queued").length;

  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Radio className={cn("h-4 w-4", state.running ? "animate-pulse text-emerald-600" : "text-slate-400")} />
          <span className="text-sm font-semibold">실시간 취합(펄스)</span>
          <span className="text-xs text-slate-400">하루 {state.schedule.length}회</span>
        </div>
        <Button size="sm" variant="outline" onClick={runNow} disabled={starting || state.running}>
          {starting || state.running ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 h-3 w-3" />
          )}
          지금 실행
        </Button>
      </div>

      {!state.notifyEnabled && (
        <p className="mt-2 flex items-center gap-1 text-xs text-amber-600">
          <AlertTriangle className="h-3 w-3" />
          iMessage 알림이 꺼져 있어 펄스를 실행하지 않습니다. .env 의 NOTIFY_IMESSAGE / IMESSAGE_TO 를 확인하세요.
        </p>
      )}

      <p className="mt-2 text-xs text-slate-500">
        지난 24시간 · 문자 발송 {sent}건
        {queued > 0 && ` · 야간 보류 ${queued}건`} · 전체 판정 {state.recent.length}건
        {state.lastRun && (
          <>
            {" · "}마지막 실행 {state.lastRun.slot}{" "}
            {state.lastRun.ok ? (
              <Check className="inline h-3 w-3 text-emerald-600" />
            ) : (
              <span className="text-red-500">실패({state.lastRun.error})</span>
            )}
          </>
        )}
      </p>

      {/* 최근 헤드라인은 '동작 확인'용으로 몇 줄만. 피드가 아니다. */}
      {state.recent.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-slate-500">
          {state.recent.slice(0, 5).map((r) => (
            <li key={r.id} className="truncate">
              <span
                className={cn(
                  "mr-1 font-medium",
                  r.status === "sent" ? "text-emerald-600" : "text-slate-400"
                )}
              >
                [{r.status === "sent" ? "발송" : r.status === "queued" ? "보류" : "기록"}]
              </span>
              {r.at.slice(11, 16)} {r.symbol ? `${r.name}` : "거시"} — {r.headline}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * 보유 종목 탭. 한국장·미국장 브리핑 탭과 **별개**다(인터뷰 결정).
 * 여기 등록한 종목이 시간당 펄스의 영향도 판정 대상이 되고, 일일 브리핑의
 * '내 포지션 점검' 섹션에 실린다.
 */
export function HoldingsBoard() {
  const [holdings, setHoldings] = useState<StockHoldingSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setHoldings(await api.holdings());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">💼 보유 종목</h2>
          <p className="text-xs text-slate-500">
            등록한 종목은 관심 종목에 자동 포함되고, 실시간 취합의 영향도 판정 대상이 됩니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={load} disabled={loading}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
          {MARKETS.map((m) => (
            <AddHoldingDialog key={m} market={m} onAdded={load} />
          ))}
        </div>
      </div>

      <ScheduleControl kind="stockPulse" />

      <div className="mt-4">
        <PulseStatus />
      </div>

      {err && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>
      )}

      {holdings && holdings.length === 0 && (
        <Card className="p-8 text-center text-sm text-slate-500">
          아직 보유 종목이 없습니다. 위 “보유 종목 추가”로 등록하세요.
          <br />
          <span className="text-xs">
            보유 종목이 하나도 없으면 시간당 실시간 취합은 실행되지 않습니다.
          </span>
        </Card>
      )}

      {MARKETS.map((m) => {
        const rows = (holdings ?? []).filter((h) => h.market === m);
        if (!rows.length) return null;
        return (
          <section key={m} className="mb-6">
            <h3 className="mb-2 text-sm font-semibold text-slate-600">
              {m === "kr" ? "🇰🇷" : "🇺🇸"} {marketLabel(m)}
              <span className="ml-2 text-xs font-normal text-slate-400">{rows.length}종목</span>
            </h3>
            <div className="space-y-2">
              {rows.map((h) => (
                <HoldingRow key={h.id} h={h} onDeleted={load} />
              ))}
            </div>
          </section>
        );
      })}

      <p className="mt-6 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
        ⚠️ 실시간 취합은 재료의 <strong>영향 방향과 강도만</strong> 판정합니다. 매수·매도 권유가 아니며,
        투자 판단과 그 결과는 본인 책임입니다.
      </p>
    </div>
  );
}
