import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  RefreshCw,
  Loader2,
  CalendarDays,
  Link as LinkIcon,
  LineChart as LineChartIcon,
  Info,
} from "lucide-react";
import type {
  StockMarket,
  StockSnapshot,
  StockTicker,
  StockIndex,
  StockNewsItem,
  StockAnalysis,
} from "@shared/types";
import { marketLabel, changeTone } from "@shared/stock";
import { safeHref } from "@shared/url";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StockCard } from "@/components/StockCard";
import { StockChart } from "@/components/StockChart";
import { AddTickerDialog } from "@/components/AddTickerDialog";
import { ScheduleControl } from "@/components/ScheduleControl";

const MARKETS: StockMarket[] = ["kr", "us"];

/** 등락률 텍스트 색 — 한국 증시 관례(상승 빨강 / 하락 파랑 / 보합 회색). */
function toneClass(pct: number | null): string {
  const t = changeTone(pct);
  if (t === "up") return "text-up";
  if (t === "down") return "text-stock-down";
  return "text-muted-foreground";
}

function IndexCard({ idx }: { idx: StockIndex }) {
  return (
    <Card className="p-4">
      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="text-xs text-muted-foreground">{idx.name}</div>
          <div className="text-2xl font-bold">
            {idx.value != null ? idx.value.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : "-"}
          </div>
        </div>
        <div className={cn("text-sm font-semibold", toneClass(idx.changePct))}>
          {idx.changePct != null
            ? `${idx.changePct > 0 ? "+" : ""}${idx.changePct.toFixed(2)}%`
            : "-"}
        </div>
      </div>
      <div className="mt-2">
        <StockChart points={idx.history} />
      </div>
      <div className="mt-2 space-y-2">
        {idx.comment && (
          <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/80">
            {idx.comment}
          </p>
        )}
        {/* 근거(rationale) 없는 전망은 표시하지 않는다 — 타입 주석의 규칙. */}
        {idx.outlook && idx.rationale && (
          <div className="rounded-md bg-muted/50 px-3 py-2">
            <div className="text-xs font-semibold text-muted-foreground">전망</div>
            <p className="whitespace-pre-line text-sm leading-relaxed">{idx.outlook}</p>
            <div className="mt-1.5 text-xs font-semibold text-muted-foreground">근거</div>
            <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/80">
              {idx.rationale}
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

function NewsCard({ item }: { item: StockNewsItem }) {
  const href = safeHref(item.link);
  return (
    <Card className="flex h-[18rem] flex-col border-l-4 p-4" style={{ borderLeftColor: "#059669" }}>
      <h4 className="line-clamp-2 min-h-[2.6em] font-semibold leading-snug">{item.title}</h4>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span>{item.source}</span>
        <span className="inline-flex items-center gap-1">
          <CalendarDays className="h-3 w-3" /> {item.date}
        </span>
      </p>
      <p className="mt-2 min-h-0 flex-1 overflow-y-auto whitespace-pre-line pr-1 text-sm leading-relaxed text-foreground/80">
        {item.summary}
      </p>
      {href && (
        <div className="mt-3 flex items-center gap-3 border-t pt-2 text-xs">
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[#4361ee] hover:underline"
          >
            <LinkIcon className="h-3 w-3" /> 원문 보기
          </a>
        </div>
      )}
    </Card>
  );
}

function SectionTitle({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="mb-3 flex items-center gap-2 border-b pb-2" style={{ borderColor: "#059669" }}>
      <h2 className="flex items-center gap-2 text-lg font-bold" style={{ color: "#059669" }}>
        {children}
        {count != null && (
          <span className="text-sm font-normal text-muted-foreground">({count})</span>
        )}
      </h2>
    </div>
  );
}

/**
 * 아직 브리핑이 붙지 않은 등록 종목(예: 방금 추가)을 카드로 보여주기 위한 자리표시 분석.
 * 숫자는 전부 null 로 둔다 — 없는 값을 0 으로 채우면 '보합'처럼 보이는 가짜 시세가 된다.
 */
function placeholderAnalysis(t: StockTicker): StockAnalysis {
  return {
    symbol: t.symbol,
    name: t.name,
    quoteCode: t.quoteCode,
    close: null,
    changePct: null,
    weekChangePct: null,
    currency: t.market === "kr" ? "KRW" : "USD",
    history: [],
    ma5: null,
    ma20: null,
    summary: "아직 이 종목의 브리핑이 없습니다. 다음 브리핑에서 분석이 첨부됩니다.",
    outlook: "",
    rationale: "",
    risks: "",
    verdict: "",
    verified: true,
  };
}

export function StockBoard() {
  const [market, setMarket] = useState<StockMarket>("kr");
  const [snap, setSnap] = useState<StockSnapshot | null>(null);
  const [tickers, setTickers] = useState<StockTicker[]>([]);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([api.stock(market), api.stockTickers(market)]);
      setSnap(s);
      setTickers(t);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [market]);

  const checkStatus = useCallback(async () => {
    try {
      setCollecting((await api.stockStatus(market)).collecting);
    } catch {
      /* 상태 폴링 실패는 무시 */
    }
  }, [market]);

  // 시장을 바꾸면 스냅샷·종목목록을 다시 불러온다(이전 시장 데이터가 잠깐 비치지 않게 loading 부터 세운다).
  useEffect(() => {
    setLoading(true);
    setSnap(null);
    setTickers([]);
    load();
    checkStatus(); // 진입 시 (예: 정시 브리핑이 돌고 있으면) '수집 중'을 즉시 반영
  }, [load, checkStatus]);

  // 수집 중일 때만 5초 폴링 → 완료되면 스냅샷을 자동으로 다시 불러온다.
  useEffect(() => {
    if (!collecting) return;
    const id = setInterval(async () => {
      let done = false;
      try {
        done = !(await api.stockStatus(market)).collecting;
      } catch {
        return; // 일시 오류는 다음 주기에 재시도
      }
      if (done) {
        setCollecting(false);
        await load(); // 완료 → 새 결과 반영
      }
    }, 5000);
    return () => clearInterval(id);
  }, [collecting, market, load]);

  async function refresh() {
    setErr(null);
    try {
      await api.refreshStock(market); // 백그라운드 시작(202) 또는 이미 수집 중(409) → 둘 다 정상
      setCollecting(true); // '수집 중' 배너 + 폴링 시작 → 완료되면 자동 반영
    } catch (e) {
      setErr((e as Error).message); // 5xx 등 진짜 실패만 표시
    }
  }

  /** 종목 표시 순서 조정(인접 교환). 낙관적 업데이트 후 서버 저장, 실패 시 직전 순서로 복구. */
  async function move(ticker: StockTicker, dir: "up" | "down") {
    const idx = tickers.findIndex((t) => t.id === ticker.id);
    const j = dir === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || j < 0 || j >= tickers.length) return;
    const prev = tickers;
    const next = tickers.slice();
    [next[idx], next[j]] = [next[j], next[idx]];
    setTickers(next);
    try {
      await api.reorderTickers(
        market,
        next.map((t) => t.id)
      );
      setErr(null);
    } catch (e) {
      setTickers(prev);
      setErr(`순서 저장 실패: ${(e as Error).message}`);
    }
  }

  const updated = snap?.updatedAt ? new Date(snap.updatedAt).toLocaleString("ko-KR") : null;
  // 미국장은 수집일(KST)과 거래일(뉴욕)이 거의 항상 다르다 → 다를 때만 거래일을 병기한다.
  const showSession = snap?.sessionDate && snap.sessionDate !== snap.date;

  const bySymbol = new Map<string, StockAnalysis>();
  snap?.analyses.forEach((a) => bySymbol.set(a.symbol, a));

  // 뉴스는 bucket 으로 묶되, 스냅샷에 나온 순서를 유지한다(LLM 이 중요도순으로 준다).
  const newsBuckets: Array<{ bucket: string; items: StockNewsItem[] }> = [];
  snap?.news.forEach((n) => {
    const b = n.bucket || "기타";
    const found = newsBuckets.find((x) => x.bucket === b);
    if (found) found.items.push(n);
    else newsBuckets.push({ bucket: b, items: [n] });
  });

  return (
    <div>
      {/* 시장 토글 — shadcn Tabs 컴포넌트가 없어 Button 2개로 구성한다. */}
      <div className="mb-4 flex items-center gap-1">
        {MARKETS.map((m) => (
          <Button
            key={m}
            variant={m === market ? "default" : "outline"}
            size="sm"
            onClick={() => setMarket(m)}
            style={m === market ? { backgroundColor: "#059669" } : undefined}
          >
            {marketLabel(m)}
          </Button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <ScheduleControl kind={market === "kr" ? "stockKr" : "stockUs"} />
          <span>
            · 수집 시 이메일 발송(지금 갱신 포함)
            {snap && ` · ${snap.date}`}
            {showSession && ` · 거래일 ${snap!.sessionDate}`}
            {updated && ` · 최종 갱신 ${updated}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <AddTickerDialog market={market} onAdded={load} />
          <Button variant="outline" onClick={refresh} disabled={collecting}>
            {collecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {collecting ? "수집 중…" : "지금 갱신"}
          </Button>
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
          {marketLabel(market)} 브리핑을 수집하는 중입니다… 1~3분 걸릴 수 있고, 완료되면 자동으로
          반영됩니다.
        </div>
      )}

      {/* 휴장은 실패가 아니다 — 에러(빨강)와 구분되게 회색 안내로 표시한다. */}
      {snap?.closed && (
        <div className="mb-4 flex items-start gap-2 rounded-md border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {snap.sessionDate ?? snap.date}
            {snap.closedReason ? ` ${snap.closedReason}` : ""} 휴장 — 다음 거래일 브리핑을 기다립니다.
          </span>
        </div>
      )}

      {loading ? (
        <div className="flex h-64 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 불러오는 중…
        </div>
      ) : (
        <>
          {/* 지수 */}
          {!!snap?.indices.length && (
            <section className="mt-8">
              <SectionTitle count={snap.indices.length}>📊 지수</SectionTitle>
              <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(340px,1fr))]">
                {snap.indices.map((idx, i) => (
                  <IndexCard key={`${idx.name}-${i}`} idx={idx} />
                ))}
              </div>
            </section>
          )}

          {/* 등록 종목 */}
          <section className="mt-8">
            <SectionTitle count={tickers.length}>⭐ 등록 종목</SectionTitle>
            {tickers.length ? (
              <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(340px,1fr))]">
                {tickers.map((t, i) => (
                  <StockCard
                    key={t.id}
                    ticker={t}
                    analysis={bySymbol.get(t.symbol) ?? placeholderAnalysis(t)}
                    canUp={i > 0}
                    canDown={i < tickers.length - 1}
                    onMove={move}
                    onChanged={load}
                    disabled={collecting}
                  />
                ))}
              </div>
            ) : (
              <div className="flex h-48 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                <LineChartIcon className="h-10 w-10" />
                <p>등록된 종목이 없습니다.</p>
                <AddTickerDialog market={market} onAdded={load} />
              </div>
            )}
          </section>

          {/* 오늘의 관심 종목 */}
          {!!snap?.watchlist.length && (
            <section className="mt-8">
              <SectionTitle count={snap.watchlist.length}>🔍 오늘의 관심 종목</SectionTitle>
              <p className="mb-3 rounded-md bg-muted/50 px-4 py-2 text-sm text-muted-foreground">
                시장에서 거론되는 사실을 정리한 것으로 매수 추천이 아닙니다.
              </p>
              <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(340px,1fr))]">
                {snap.watchlist.map((w, i) => (
                  <StockCard key={`${w.symbol}-${i}`} analysis={w} />
                ))}
              </div>
            </section>
          )}

          {/* 뉴스 */}
          {newsBuckets.map((g) => (
            <section key={g.bucket} className="mt-8">
              <SectionTitle count={g.items.length}>📰 {g.bucket}</SectionTitle>
              <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
                {g.items.map((n, i) => (
                  <NewsCard key={`${n.title}-${i}`} item={n} />
                ))}
              </div>
            </section>
          ))}

          {snap?.notes && (
            <p className="mt-6 whitespace-pre-line text-sm text-muted-foreground">{snap.notes}</p>
          )}

          {/* 면책 — 보드 하단에 상시 노출 */}
          {snap?.disclaimer && (
            <p className="mt-6 border-t pt-4 text-xs text-muted-foreground">{snap.disclaimer}</p>
          )}
        </>
      )}
    </div>
  );
}
