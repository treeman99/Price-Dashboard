import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Trash2, Radio, AlertTriangle, Check } from "lucide-react";
import type { StockHoldingSummary, StockMarket } from "@shared/types";
import { marketLabel, formatPrice, changeTone } from "@shared/stock";
import { formatPnlPct, horizonLabel } from "@shared/holdings";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  PageToolbar,
  MetaDot,
  Meta,
  Notice,
  SectionHeader,
  SubHeader,
  StatusTag,
  IconAction,
  EmptyState,
} from "@/components/ui/page";
import { cn } from "@/lib/utils";
import { AddHoldingDialog } from "@/components/AddHoldingDialog";
import { EditHoldingDialog } from "@/components/EditHoldingDialog";
import { ScheduleControl } from "@/components/ScheduleControl";

const MARKETS: StockMarket[] = ["kr", "us"];

/** 표의 열 수. 시장 머리 행이 colSpan 으로 쓴다. */
const COLS = 8;

/**
 * ⚠️ 등락·손익 색은 **한국 증시 관례**다: 상승=빨강, 하락=파랑.
 * 쇼핑 관점(하락=좋음=초록)과 규칙이 정반대이므로 절대 섞지 말 것
 * (src/notify/stock-email.ts 상단 주석과 같은 경고다).
 */
function toneClass(pct: number | null): string {
  const t = changeTone(pct);
  return t === "up" ? "text-up" : t === "down" ? "text-stock-down" : "text-muted-foreground";
}

function HoldingRow({
  h,
  onChanged,
}: {
  h: StockHoldingSummary;
  /** 삭제·수정 후 목록 재조회. 평단·수량이 바뀌면 손익도 서버가 다시 계산해야 한다. */
  onChanged: () => void;
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
      onChanged();
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
    <tr className="group">
      <td>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[15px] font-semibold">{h.name}</span>
          <span className="text-[12px] text-muted-foreground">
            <span className="font-mono">{h.symbol}</span> · {horizonLabel(h.horizon)}
          </span>
        </div>
        {h.memo && <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{h.memo}</p>}
        {noQuote && (
          <p className="mt-0.5 flex items-center gap-1 text-[12px] text-tone-warn">
            <AlertTriangle className="h-3 w-3 shrink-0" /> 시세를 가져오지 못했습니다. 손익은 다음 조회 때 채워집니다.
          </p>
        )}
      </td>
      <td className="num text-right">
        <div className="font-medium">{formatPrice(h.close, h.currency)}</div>
        {h.changePct != null && (
          <div className={cn("text-[12px]", toneClass(h.changePct))}>
            {h.changePct > 0 ? "▲" : h.changePct < 0 ? "▼" : ""}
            {Math.abs(h.changePct).toFixed(2)}%
          </div>
        )}
      </td>
      <td className="num text-right">{formatPrice(h.avgPrice, h.currency)}</td>
      <td className="num text-right">{h.quantity}</td>
      <td className="num text-right font-medium">{formatPrice(h.marketValue, h.currency)}</td>
      <td className={cn("num text-right text-lg font-semibold leading-tight", toneClass(h.pnlPct))}>
        {formatPnlPct(h.pnlPct)}
      </td>
      <td className="num text-right text-[13px]">
        {h.targetPrice == null && h.stopPrice == null && <span className="text-muted-foreground">-</span>}
        {h.targetPrice != null && (
          <div>
            <span className="text-muted-foreground">목표 </span>
            {formatPrice(h.targetPrice, h.currency)}{" "}
            <span className="text-muted-foreground">({formatPnlPct(h.toTargetPct)})</span>
          </div>
        )}
        {h.stopPrice != null && (
          <div>
            <span className="text-muted-foreground">손절 </span>
            {formatPrice(h.stopPrice, h.currency)}{" "}
            <span className="text-muted-foreground">({formatPnlPct(h.toStopPct)})</span>
          </div>
        )}
      </td>
      <td>
        <div className="flex justify-end opacity-40 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <EditHoldingDialog h={h} onSaved={onChanged} />
          <IconAction label="보유 종목에서 삭제" danger onClick={remove} disabled={deleting}>
            {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
          </IconAction>
        </div>
      </td>
    </tr>
  );
}

/**
 * 시장 한 묶음. 시장마다 표를 따로 만들면 열 머리가 반복되고 열 위치도 어긋나서,
 * 한 표 안의 tbody 로 나누고 머리 행에 SubHeader 를 둔다.
 */
function MarketRows({
  market,
  rows,
  first,
  onChanged,
}: {
  market: StockMarket;
  rows: StockHoldingSummary[];
  first: boolean;
  onChanged: () => void;
}) {
  return (
    <tbody>
      {/* 머리 행은 데이터 행이 아니므로 .dtable 의 hover 바탕을 끈다(규칙 우선순위가 높아 ! 필요). */}
      <tr className="hover:!bg-transparent">
        <th colSpan={COLS} scope="rowgroup" className={cn("p-0 text-left font-normal", !first && "pt-5")}>
          <SubHeader count={`${rows.length}종목`}>{marketLabel(market)}</SubHeader>
        </th>
      </tr>
      {rows.map((h) => (
        <HoldingRow key={h.id} h={h} onChanged={onChanged} />
      ))}
    </tbody>
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
    <div className="mb-8 bg-muted/50 px-3.5 py-2">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-muted-foreground">
        <Radio
          className={cn("h-4 w-4 shrink-0", state.running ? "animate-pulse text-tone-success" : "text-muted-foreground")}
        />
        <span className="text-sm font-semibold text-foreground">실시간 취합(펄스)</span>
        <Meta>하루 {state.schedule.length}회</Meta>
        <MetaDot />
        <Meta>
          지난 24시간 · 문자 발송 <strong>{sent}</strong>건
          {queued > 0 && (
            <>
              {" "}
              · 야간 보류 <strong>{queued}</strong>건
            </>
          )}{" "}
          · 전체 판정 <strong>{state.recent.length}</strong>건
        </Meta>
        {state.lastRun && (
          <>
            <MetaDot />
            <Meta className="inline-flex items-center gap-1">
              마지막 실행 <strong>{state.lastRun.slot}</strong>
              {state.lastRun.ok ? (
                <Check className="h-3.5 w-3.5 text-tone-success" />
              ) : (
                <span className="text-tone-error">실패({state.lastRun.error})</span>
              )}
            </Meta>
          </>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto bg-background"
          onClick={runNow}
          disabled={starting || state.running}
        >
          {starting || state.running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          지금 실행
        </Button>
      </div>

      {!state.notifyEnabled && (
        <p className="mt-1.5 flex items-center gap-1 text-[12.5px] text-tone-warn">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          iMessage 알림이 꺼져 있어 펄스를 실행하지 않습니다. .env 의 NOTIFY_IMESSAGE / IMESSAGE_TO 를 확인하세요.
        </p>
      )}

      {/* 최근 헤드라인은 '동작 확인'용으로 몇 줄만. 피드가 아니다. */}
      {state.recent.length > 0 && (
        <ul className="mt-2 grid gap-x-8 gap-y-1 border-t border-foreground/10 pt-2 text-[12.5px] text-muted-foreground lg:grid-cols-2">
          {state.recent.slice(0, 5).map((r) => (
            <li key={r.id} className="flex min-w-0 items-center gap-1.5">
              <StatusTag tone={r.status === "sent" ? "success" : "neutral"}>
                {r.status === "sent" ? "발송" : r.status === "queued" ? "보류" : "기록"}
              </StatusTag>
              <span className="truncate">
                <span className="font-mono">{r.at.slice(11, 16)}</span> {r.symbol ? `${r.name}` : "거시"} —{" "}
                {r.headline}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
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

  const groups = MARKETS.map((m) => ({ market: m, rows: (holdings ?? []).filter((h) => h.market === m) })).filter(
    (g) => g.rows.length > 0
  );

  return (
    <div>
      <PageToolbar
        actions={
          <>
            <IconAction label="새로고침" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            </IconAction>
            {MARKETS.map((m) => (
              <AddHoldingDialog key={m} market={m} onAdded={load} />
            ))}
          </>
        }
      >
        <ScheduleControl kind="stockPulse" />
      </PageToolbar>

      <PulseStatus />

      {err && <Notice tone="error">{err}</Notice>}

      <SectionHeader
        title="보유 종목"
        count={holdings && holdings.length > 0 ? `${holdings.length}종목` : null}
        note="등록한 종목은 관심 종목에 자동 포함되고, 실시간 취합의 영향도 판정 대상이 됩니다."
      />

      {holdings && holdings.length === 0 && (
        <EmptyState>
          아직 보유 종목이 없습니다. 위 “한국장 추가”·“미국장 추가”로 등록하세요.
          <br />
          <span className="text-[13px]">보유 종목이 하나도 없으면 시간당 실시간 취합은 실행되지 않습니다.</span>
        </EmptyState>
      )}

      {groups.length > 0 && (
        <div className="overflow-x-auto">
          <table className="dtable min-w-[64rem] table-fixed">
            {/* 종목·목표가 열만 넓히고 나머지 숫자 열은 남는 폭을 고르게 나눠, 넓은 화면에서도 숫자가 한쪽에 몰리지 않게 한다. */}
            <colgroup>
              <col className="w-[20%]" />
              <col />
              <col />
              <col />
              <col />
              <col />
              <col className="w-[17%]" />
              <col className="w-[4.75rem]" />
            </colgroup>
            <thead>
              <tr>
                <th>종목</th>
                <th className="text-right">현재가 · 일간</th>
                <th className="text-right">평단</th>
                <th className="text-right">수량</th>
                <th className="text-right">평가금액</th>
                <th className="text-right">수익률</th>
                <th className="text-right">목표가 · 손절가</th>
                <th>
                  <span className="sr-only">동작</span>
                </th>
              </tr>
            </thead>
            {groups.map((g, i) => (
              <MarketRows key={g.market} market={g.market} rows={g.rows} first={i === 0} onChanged={load} />
            ))}
          </table>
        </div>
      )}

      <Notice tone="warn" className="mb-0 mt-8">
        실시간 취합은 재료의 <strong>영향 방향과 강도만</strong> 판정합니다. 매수·매도 권유가 아니며, 투자 판단과 그
        결과는 본인 책임입니다.
      </Notice>
    </div>
  );
}
