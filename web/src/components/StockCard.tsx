import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronUp,
  ChevronDown,
  Minus,
  Trash2,
  Pin,
  Loader2,
  Plus,
  CheckCircle2,
} from "lucide-react";
import type { StockAnalysis, StockWatchItem, StockTicker, StockPoint } from "@shared/types";
import { formatPrice, changeTone } from "@shared/stock";
import { Button } from "@/components/ui/button";
import { IconAction, StatusTag } from "@/components/ui/page";
import { StockChart } from "./StockChart";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * 등락 표시 — 한국 증시 관례(상승 빨강 / 하락 파랑 / 보합 회색). 채운 알약 대신 색 글씨로 쓴다.
 * ⚠️ 쇼핑 관점의 배색(하락=싸짐=초록)을 그대로 가져오면 안 된다. 증시는 한국 관례를 따른다.
 */
function ChangeMark({ pct }: { pct: number | null }) {
  const tone = changeTone(pct);
  if (tone === "flat" || pct == null) {
    return (
      <span className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground">
        <Minus className="h-3.5 w-3.5" /> 보합
      </span>
    );
  }
  const isUp = tone === "up";
  return (
    <span
      className={cn(
        "num inline-flex items-center gap-0.5 text-[15px] font-semibold",
        isUp ? "text-up" : "text-stock-down"
      )}
    >
      {isUp ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
      {Math.abs(pct).toFixed(2)}%
    </span>
  );
}

/** 왼쪽 열 아래의 작은 키-값 한 칸(5일 등락·5일선·20일선). */
function Stat({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] text-muted-foreground">{label}</div>
      <div className={cn("num whitespace-nowrap text-[13px] font-medium", className)}>{children}</div>
    </div>
  );
}

/** 서술 블록. rationale·risks 는 요구사항상 반드시 노출된다. */
function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <div className="mb-0.5 text-[12px] font-semibold text-muted-foreground">{label}</div>
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
  onAdd,
  registered,
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
  /**
   * '등록 종목에 추가' 버튼의 **opt-in 스위치**. 넘긴 섹션에서만 버튼이 뜬다.
   *
   * ⚠️ 이 카드는 세 섹션이 공유한다(등록 종목 · 오늘의 관심 종목 · 해외 참고). 기본으로 켜면
   * 이미 원장에 있는 등록 종목에도 뜨고, 이 장에 상장되지 않은 '해외 참고' 종목에는
   * **누를 때마다 반드시 404 로 실패하는 버튼**이 달린다: 서버는
   * `candidates.find((c) => c.market === market)` 로 이 시장 후보만 남기고, 없으면
   * "종목을 찾지 못했습니다" 404 를 준다(src/api/routes.ts:1307-1308).
   * 즉 엉뚱한 시장으로 등록되지는 않고, 사용자를 실패로 유인하기만 한다. 그래서 켜는 쪽이
   * 명시적으로 넘기게 한다 — 지금 넘기는 곳은 '오늘의 관심 종목' 섹션 하나뿐이다.
   *
   * 실패는 reject 로 알린다: 카드가 그 메시지를 버튼 밑에 띄운다(조용히 실패하지 않는다).
   */
  onAdd?: () => Promise<void>;
  /** 이미 원장에 있는 종목이면 true — 버튼 대신 '등록됨' 표시. 판정은 isSymbolRegistered. */
  registered?: boolean;
}) {
  const [history, setHistory] = useState<StockPoint[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  // 추가 실패 메시지는 카드 안에 남긴다 — 누른 버튼 바로 옆이라야 어느 종목이 실패했는지 안다.
  const [addErr, setAddErr] = useState<string | null>(null);

  // 원장에 들어온 순간(다른 경로의 load() 로 registered 가 true) 이전 실패 메시지는 더 이상 참이
  // 아니다. 렌더에서 이미 가려지지만, 상태로 남겨두면 나중에 그 종목을 삭제해 registered 가
  // 다시 false 가 될 때 몇 분 전 실패가 되살아난다. 결과가 '등록됨'으로 확정됐으니 여기서 비운다.
  useEffect(() => {
    if (registered) setAddErr(null);
  }, [registered]);

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

  async function handleAdd() {
    if (!onAdd) return;
    setAdding(true);
    setAddErr(null);
    try {
      await onAdd();
    } catch (e) {
      setAddErr((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

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
    // 가로 띠(가이드 §4-D): 왼쪽 이름·시세, 가운데 차트, 오른쪽 서술. lg 미만에서는 세로로 쌓는다.
    <article className="grid gap-x-8 gap-y-4 py-5 lg:grid-cols-[260px_minmax(0,1fr)_360px] xl:grid-cols-[280px_minmax(0,1fr)_400px] 2xl:grid-cols-[300px_minmax(0,1fr)_420px]">
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-base font-semibold leading-snug">
              <span className="min-w-0 break-words">{analysis.name}</span>
              {analysis.verdict && <span className="shrink-0">{analysis.verdict}</span>}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[12px] text-muted-foreground">
              <span>{analysis.symbol}</span>
              {ticker?.exchange && <span>· {ticker.exchange}</span>}
              {watch && <StatusTag className="font-sans">{watch.attention}</StatusTag>}
              {/* 해외 참고 항목의 실제 시장. "attention" in analysis 만으로는 관심/해외참고를
                  구별할 수 없어(둘 다 StockWatchItem) 섹션이 명시적으로 내려준다. */}
              {marketNote && <StatusTag className="font-sans">{marketNote}</StatusTag>}
              {/* ⚠️ 이 배지는 **등록 종목(analyses) 전용**이다 — curate.ts 가 `verified: q.close != null`
                  로 여전히 false 를 만든다. 관심 종목·해외 참고는 드롭 정책상 verified=false 가
                  도달하지 않을 뿐이므로 데드코드로 오인해 지우지 말 것. */}
              {analysis.verified === false && (
                <StatusTag
                  tone="warn"
                  className="font-sans"
                  title="결정론적 시세 소스로 검증하지 못한 값입니다"
                >
                  시세 미검증
                </StatusTag>
              )}
            </div>
          </div>
          {ticker && (
            <div className="-mr-1.5 flex shrink-0 items-center">
              <IconAction
                label="순서 앞으로"
                onClick={() => onMove?.(ticker, "up")}
                disabled={!canUp || disabled}
              >
                <ChevronUp />
              </IconAction>
              <IconAction
                label="순서 뒤로"
                onClick={() => onMove?.(ticker, "down")}
                disabled={!canDown || disabled}
              >
                <ChevronDown />
              </IconAction>
              <IconAction
                label={ticker.pinned ? "고정 해제" : "고정(브리핑에 상세 분석 첨부)"}
                active={ticker.pinned}
                onClick={togglePin}
                disabled={busy || disabled}
              >
                {busy ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Pin className={cn(ticker.pinned && "fill-current")} />
                )}
              </IconAction>
              <IconAction label="종목 삭제" danger onClick={handleDelete} disabled={busy || disabled}>
                <Trash2 />
              </IconAction>
            </div>
          )}
        </div>

        {/* 시세 요약 */}
        <div className="mt-4">
          <div className="text-[12px] text-muted-foreground">종가</div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="num font-serif text-[1.75rem] font-semibold leading-tight tracking-[-0.01em]">
              {formatPrice(close, analysis.currency)}
            </span>
            <ChangeMark pct={changePct} />
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-3 border-t pt-2.5">
          <Stat
            label="5일 등락"
            className={cn(
              changeTone(analysis.weekChangePct) === "up" && "text-up",
              changeTone(analysis.weekChangePct) === "down" && "text-stock-down",
              changeTone(analysis.weekChangePct) === "flat" && "text-muted-foreground"
            )}
          >
            {analysis.weekChangePct != null ? `${analysis.weekChangePct.toFixed(2)}%` : "-"}
          </Stat>
          <Stat label="5일선">{formatPrice(analysis.ma5, analysis.currency)}</Stat>
          <Stat label="20일선">{formatPrice(analysis.ma20, analysis.currency)}</Stat>
        </div>

        {/* 등록 종목에 추가 — onAdd 를 넘긴 섹션('오늘의 관심 종목')에서만 뜬다. */}
        {onAdd && (
          <div className="mt-4 space-y-1.5">
            {registered ? (
              <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5" /> 등록됨
              </p>
            ) : (
              /* ⚠️ 실패 메시지는 반드시 이 가지 안에 둔다. 밖에 두면 '등록됨' 표시와 '추가 실패'가
                 한 종목에 같이 떠서(추가 실패로 addErr 이 남은 뒤 다른 경로의 load() 가 원장을
                 새로 읽어 registered 가 true 가 되는 경우) 등록이 된 건지 알 수 없게 된다.
                 실패를 숨기는 게 아니다 — 아직 등록되지 않은 동안에는 그대로 보인다. */
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={handleAdd}
                  disabled={adding || disabled}
                >
                  {adding ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  등록 종목에 추가
                </Button>
                {addErr && (
                  <p className="text-[12.5px] text-tone-error" role="alert">
                    추가 실패: {addErr}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="min-w-0">
        <StockChart points={points} height={170} />
      </div>

      <div className="min-w-0 space-y-3">
        <Field label="요약" value={analysis.summary} />
        <Field label="전망" value={analysis.outlook} />
        {/* rationale · risks 는 필수 노출 — 근거 없는 전망만 남기지 않는다. */}
        <Field label="근거" value={analysis.rationale} />
        <Field label="리스크" value={analysis.risks} />
        {watch && <Field label="주목 가격대" value={watch.levels} />}
      </div>
    </article>
  );
}
