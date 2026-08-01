import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronUp, ChevronDown, Minus, Trash2, Pin, Loader2 } from "lucide-react";
import type { StockAnalysis, StockWatchItem, StockTicker, StockPoint } from "@shared/types";
import { formatPrice, changeTone } from "@shared/stock";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { StockChart } from "./StockChart";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * 등락 배지 — 한국 증시 관례(상승 빨강 / 하락 파랑 / 보합 회색).
 * ⚠️ 쇼핑 관점의 배색(하락=싸짐=초록)을 그대로 가져오면 안 된다. 증시는 한국 관례를 따른다.
 */
function ChangeBadge({ pct }: { pct: number | null }) {
  const tone = changeTone(pct);
  if (tone === "flat" || pct == null) {
    return (
      <Badge className="border-transparent bg-muted text-muted-foreground gap-1">
        <Minus className="h-3 w-3" /> 보합
      </Badge>
    );
  }
  const isUp = tone === "up";
  return (
    <Badge
      className="border-transparent gap-1 text-white"
      style={{ backgroundColor: isUp ? "#e74c3c" : "#2563eb" }}
    >
      {isUp ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
      {Math.abs(pct).toFixed(2)}%
    </Badge>
  );
}

/** 서술 블록. rationale·risks 는 요구사항상 반드시 노출된다. */
function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <div className="mb-0.5 text-xs font-semibold text-muted-foreground">{label}</div>
      <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/80">{value}</p>
    </div>
  );
}

export function StockCard({
  analysis,
  ticker,
  canUp,
  canDown,
  onMove,
  onChanged,
  disabled,
  marketNote,
}: {
  analysis: StockAnalysis | StockWatchItem;
  /**
   * '해외 참고' 항목의 실제 시장 라벨(예: "미국장"). 있으면 심볼 줄에 배지로 뜬다.
   * 카드를 dumb 하게 유지하려고 명시적 prop 으로 받는다 — 관심 종목과 해외 참고는
   * 둘 다 StockWatchItem 이라 구조만으로는 구별할 수 없다.
   */
  marketNote?: string;
  /** 등록 종목이면 원장 행. '오늘의 관심 종목'은 원장에 없어 undefined — 편집 UI를 숨긴다. */
  ticker?: StockTicker;
  canUp?: boolean;
  canDown?: boolean;
  onMove?: (ticker: StockTicker, dir: "up" | "down") => void;
  onChanged?: () => void;
  /** 수집 중이면 편집을 막는다(기존 보드 관례). */
  disabled?: boolean;
}) {
  const [history, setHistory] = useState<StockPoint[] | null>(null);
  const [busy, setBusy] = useState(false);

  // 등록 종목은 카드가 열릴 때 차트 데이터를 따로 불러온다.
  // 실패하거나 비면 스냅샷에 실려온 history 로 폴백 — 차트가 통째로 비는 것보다 낫다.
  useEffect(() => {
    if (!ticker) return;
    let alive = true;
    api
      .tickerHistory(ticker.id, 20)
      .then((h) => {
        if (alive && h.length) setHistory(h);
      })
      .catch(() => {
        /* 폴백(analysis.history)이 있으므로 무시 */
      });
    return () => {
      alive = false;
    };
  }, [ticker]);

  const points = history ?? analysis.history;
  // 관심 종목만 갖는 필드 — 등록 종목 카드에선 렌더하지 않는다.
  const watch = "attention" in analysis ? (analysis as StockWatchItem) : null;

  // 브리핑이 아직 없는 종목(첫 수집 전·방금 추가)은 analysis.close 가 null 이라 카드가 '-' 만 뜬다.
  // 그런데 시세 자체는 이미 stock_points 에 있다(종목 추가 시 prime + 매 수집마다 적재).
  // 지어내는 게 아니라 **우리가 확정 소스로 받아둔 값**이므로 마지막 거래일 종가로 채운다.
  // 스냅샷 값이 있으면 그쪽이 우선 — 브리핑이 다룬 거래일과 어긋나지 않게.
  const last = points.length ? points[points.length - 1] : null;
  const close = analysis.close ?? last?.close ?? null;
  const changePct = analysis.changePct ?? last?.changePct ?? null;

  async function togglePin() {
    if (!ticker) return;
    setBusy(true);
    try {
      await api.updateTicker(ticker.id, { pinned: !ticker.pinned });
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!ticker) return;
    if (
      !confirm(
        `'${ticker.name}(${ticker.symbol})'을(를) 관심 종목에서 삭제할까요?\n다음 브리핑부터 제외됩니다.`
      )
    )
      return;
    setBusy(true);
    try {
      await api.deleteTicker(ticker.id, ticker.symbol);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-1.5">
              <span className="truncate">{analysis.name}</span>
              {analysis.verdict && <span className="shrink-0">{analysis.verdict}</span>}
            </CardTitle>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{analysis.symbol}</span>
              {ticker?.exchange && <span>· {ticker.exchange}</span>}
              {watch && (
                <Badge className="border-transparent bg-muted px-1.5 py-0 text-[10px] font-normal text-muted-foreground">
                  {watch.attention}
                </Badge>
              )}
              {/* 해외 참고 항목의 실제 시장. "attention" in analysis 만으로는 관심/해외참고를
                  구별할 수 없어(둘 다 StockWatchItem) 섹션이 명시적으로 내려준다. */}
              {marketNote && (
                <Badge className="border-slate-200 bg-slate-100 px-1.5 py-0 text-[10px] font-normal text-slate-600">
                  {marketNote}
                </Badge>
              )}
              {/* ⚠️ 이 배지는 **등록 종목(analyses) 전용**이다 — curate.ts 가 `verified: q.close != null`
                  로 여전히 false 를 만든다. 관심 종목·해외 참고는 드롭 정책상 verified=false 가
                  도달하지 않을 뿐이므로 데드코드로 오인해 지우지 말 것. */}
              {analysis.verified === false && (
                <Badge
                  className="border-amber-200 bg-amber-100 px-1.5 py-0 text-[10px] font-normal text-amber-700"
                  title="결정론적 시세 소스로 검증하지 못한 값입니다"
                >
                  시세 미검증
                </Badge>
              )}
            </div>
          </div>
          {ticker && (
            <div className="flex shrink-0 items-center">
              <Button
                variant="ghost"
                size="icon"
                className="group/tt relative"
                onClick={() => onMove?.(ticker, "up")}
                disabled={!canUp || disabled}
                aria-label="순서 앞으로"
              >
                <ChevronUp className="h-4 w-4" />
                <Tip>순서 앞으로</Tip>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="group/tt relative"
                onClick={() => onMove?.(ticker, "down")}
                disabled={!canDown || disabled}
                aria-label="순서 뒤로"
              >
                <ChevronDown className="h-4 w-4" />
                <Tip>순서 뒤로</Tip>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="group/tt relative"
                onClick={togglePin}
                disabled={busy || disabled}
                aria-label={ticker.pinned ? "고정 해제" : "고정"}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Pin
                    className={cn("h-4 w-4", ticker.pinned && "fill-current text-[#059669]")}
                  />
                )}
                <Tip>{ticker.pinned ? "고정 해제" : "고정(브리핑에 상세 분석 첨부)"}</Tip>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="group/tt relative"
                onClick={handleDelete}
                disabled={busy || disabled}
                aria-label="종목 삭제"
              >
                <Trash2 className="h-4 w-4" />
                <Tip>종목 삭제</Tip>
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 시세 요약 */}
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <div className="text-xs text-muted-foreground">종가</div>
            <div className="text-2xl font-bold">
              {formatPrice(close, analysis.currency)}
            </div>
          </div>
          <ChangeBadge pct={changePct} />
        </div>

        <div className="grid grid-cols-3 gap-2 text-sm">
          <div className="rounded-md bg-muted/50 px-3 py-2">
            <div className="text-xs text-muted-foreground">5일 등락</div>
            <div
              className={cn(
                "font-medium",
                changeTone(analysis.weekChangePct) === "up" && "text-up",
                changeTone(analysis.weekChangePct) === "down" && "text-stock-down",
                changeTone(analysis.weekChangePct) === "flat" && "text-muted-foreground"
              )}
            >
              {analysis.weekChangePct != null ? `${analysis.weekChangePct.toFixed(2)}%` : "-"}
            </div>
          </div>
          <div className="rounded-md bg-muted/50 px-3 py-2">
            <div className="text-xs text-muted-foreground">5일선</div>
            <div className="font-medium">{formatPrice(analysis.ma5, analysis.currency)}</div>
          </div>
          <div className="rounded-md bg-muted/50 px-3 py-2">
            <div className="text-xs text-muted-foreground">20일선</div>
            <div className="font-medium">{formatPrice(analysis.ma20, analysis.currency)}</div>
          </div>
        </div>

        <StockChart points={points} />

        <div className="space-y-3 border-t pt-3">
          <Field label="요약" value={analysis.summary} />
          <Field label="전망" value={analysis.outlook} />
          {/* rationale · risks 는 필수 노출 — 근거 없는 전망만 남기지 않는다. */}
          <Field label="근거" value={analysis.rationale} />
          <Field label="리스크" value={analysis.risks} />
          {watch && <Field label="주목 가격대" value={watch.levels} />}
        </div>
      </CardContent>
    </Card>
  );
}
