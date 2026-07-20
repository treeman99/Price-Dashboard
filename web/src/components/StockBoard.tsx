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
  StockSlotRole,
  StockSnapshot,
  StockTicker,
  StockIndex,
  StockNewsItem,
  StockAnalysis,
} from "@shared/types";
import {
  marketLabel,
  changeTone,
  effectiveRole,
  isPreviewUpcoming,
  partitionWatchlist,
  roleLabel,
  watchMarket,
  foreignSectionTitle,
} from "@shared/stock";
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

/**
 * `GET /stock/:market` 응답. 본문은 '가장 최신' 스냅샷이고, 역할별 스냅샷은 variants 로 덧붙는다.
 * 미국장은 슬롯마다 성격이 다른 브리핑이 별도 파일에 저장되므로(마감결산/개장프리뷰),
 * 이게 없으면 오후 프리뷰가 화면에서 아침 결산을 가려 하루 종일 한쪽만 보인다.
 */
type StockSnapshotResponse = StockSnapshot & {
  variants?: Partial<Record<StockSlotRole, StockSnapshot | null>>;
};

/** 역할 서브탭 선택값. "latest" = 가장 최근에 갱신된 브리핑(기본). */
type SnapshotView = "latest" | "close" | "preview";

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

/** tone: 섹션 강조색. 기본은 보드 브랜드 초록, '해외 참고'는 슬레이트로 낮춰 부차 정보임을 보인다. */
function SectionTitle({
  children,
  count,
  tone = "#059669",
}: {
  children: ReactNode;
  count?: number;
  tone?: string;
}) {
  return (
    <div className="mb-3 flex items-center gap-2 border-b pb-2" style={{ borderColor: tone }}>
      <h2 className="flex items-center gap-2 text-lg font-bold" style={{ color: tone }}>
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
  const [resp, setResp] = useState<StockSnapshotResponse | null>(null);
  const [view, setView] = useState<SnapshotView>("latest");
  const [tickers, setTickers] = useState<StockTicker[]>([]);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([api.stock(market), api.stockTickers(market)]);
      setResp(s as StockSnapshotResponse | null);
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
    setResp(null);
    setView("latest");
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

  // 서브탭 선택에 따라 실제로 그릴 스냅샷을 고른다. 선택한 역할 브리핑이 아직 없으면 null
  // (예: 배포 직후 아침 결산만 돌고 프리뷰가 아직 안 돈 상태).
  const snap: StockSnapshot | null =
    view === "latest" ? resp : (resp?.variants?.[view] ?? null);
  // 서브탭은 역할별 브리핑이 실제로 존재할 때만 띄운다. 역할 분리가 비활성이면(슬롯 1개 등)
  // variants 가 비어 있어 탭이 나타나지 않고 화면이 현행과 동일하다.
  const roleViews = (["close", "preview"] as const).filter((r) => !!resp?.variants?.[r]);

  const updated = snap?.updatedAt ? new Date(snap.updatedAt).toLocaleString("ko-KR") : null;
  // 역할 배지·거래일 라벨. 구 스냅샷은 role 이 없으므로 반드시 effectiveRole 을 거친다
  // (직접 snap.role 을 읽으면 undefined 가 화면으로 샌다).
  const role = snap ? effectiveRole(snap) : "both";
  const badge = snap ? roleLabel(role) : null;
  // ⚠️ `sessionDate !== date` 조건은 role='both'·한국장에만 쓴다. 프리뷰의 sessionDate 는
  // '오늘 밤 뉴욕 세션'이라 KST 수집일과 같아지는 날이 대부분이고, 그러면 대상 세션 표기가
  // 조용히 사라진다. 역할이 있으면 항상 표시하고 라벨로 두 브리핑을 구분한다.
  // ⚠️ 프리뷰의 '오늘 밤'은 **조건부**다. 프리뷰는 오후 슬롯에서만 갱신되므로 다음 오후까지
  // 약 9시간 동안 어제 밤 프리뷰가 남아 있고, 그것을 '오늘 밤'이라 단언하면 이미 지나간
  // 세션을 미래형으로 읽게 된다. 지난 프리뷰는 시제를 과거로 돌려 두 브리핑을 구분한다.
  const previewUpcoming = !!snap && isPreviewUpcoming(snap);
  const sessionText = !snap?.sessionDate
    ? null
    : role === "close"
      ? `거래일 ${snap.sessionDate}(마감)`
      : role === "preview"
        ? previewUpcoming
          ? `대상 세션 ${snap.sessionDate}(오늘 밤)`
          : `대상 세션 ${snap.sessionDate}(종료된 세션 · 지난 프리뷰)`
        : snap.sessionDate !== snap.date
          ? `거래일 ${snap.sessionDate}`
          : null;

  const bySymbol = new Map<string, StockAnalysis>();
  snap?.analyses.forEach((a) => bySymbol.set(a.symbol, a));

  // 관심 종목은 '이 시장 종목'과 '해외 참고'가 한 배열에 섞여 온다 — 반드시 공용 헬퍼로 가른다
  // (이메일도 같은 함수를 쓴다). 헬퍼가 watchlist 부재를 방어하므로 옛 스냅샷도 안전하다.
  const { domestic, foreign } = snap
    ? partitionWatchlist(snap)
    : { domestic: [], foreign: [] };

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
            {sessionText && ` · ${sessionText}`}
            {updated && ` · 최종 갱신 ${updated}`}
          </span>
          {badge && (
            // title 에 판정 근거를 실어, 스케줄을 바꿨을 때 왜 이 역할이 됐는지 화면에서 바로 보이게 한다.
            <span
              className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-foreground/80"
              title={snap?.roleReason ?? undefined}
            >
              {badge}
            </span>
          )}
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

      {/* 역할 서브탭 — 아침 결산과 오늘 밤 프리뷰를 나란히 볼 수 있게 한다.
          역할 분리가 비활성이면 variants 가 비어 탭 자체가 나타나지 않는다(현행 화면 그대로). */}
      {roleViews.length > 0 && (
        <div className="mb-4 flex items-center gap-1">
          {(["latest", ...roleViews] as SnapshotView[]).map((v) => (
            <Button
              key={v}
              variant={v === view ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setView(v)}
            >
              {/* 프리뷰 탭 라벨도 본문과 같은 술어로 시제를 맞춘다. 탭만 미래형으로 남으면
                  본문이 '종료된 세션'이라 해도 사용자는 탭 이름을 먼저 믿는다. */}
              {v === "latest"
                ? "최신"
                : v === "close"
                  ? "간밤 결산"
                  : resp?.variants?.preview && isPreviewUpcoming(resp.variants.preview)
                    ? "오늘 밤 프리뷰"
                    : "지난 프리뷰"}
            </Button>
          ))}
        </div>
      )}

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
            {snap.date}
            {snap.closedReason ? ` ${snap.closedReason}` : ""} 휴장 —{" "}
            {role === "preview"
              ? "오늘 밤 뉴욕장이 열리지 않습니다. 다음 거래일 프리뷰를 기다립니다."
              : role === "close"
                ? `직전 마감(${snap.sessionDate ?? "미상"}) 결산은 다음 거래일 아침 브리핑이 이어받습니다.`
                : "다음 거래일 브리핑을 기다립니다."}
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

          {/* 오늘의 관심 종목 — 이 시장 상장 종목만 */}
          {!!domestic.length && (
            <section className="mt-8">
              <SectionTitle count={domestic.length}>🔍 오늘의 관심 종목</SectionTitle>
              <p className="mb-3 rounded-md bg-muted/50 px-4 py-2 text-sm text-muted-foreground">
                시장에서 거론되는 사실을 정리한 것으로 매수 추천이 아닙니다.
              </p>
              <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(340px,1fr))]">
                {domestic.map((w, i) => (
                  <StockCard key={`${w.symbol}-${i}`} analysis={w} />
                ))}
              </div>
            </section>
          )}

          {/* 해외 참고 — 이 브리핑 시장에 상장되지 않은 종목.
              점선 테두리 + 음영으로 관심 종목 그리드와 구조적으로 끊는다. */}
          {!!foreign.length && snap && (
            <section className="mt-8 rounded-lg border border-dashed border-muted-foreground/30 bg-muted/20 p-4">
              <SectionTitle count={foreign.length} tone="#64748b">
                {foreignSectionTitle(snap.market)}
              </SectionTitle>
              <p className="mb-3 text-sm text-muted-foreground">
                {marketLabel(snap.market)}에 상장되지 않은 종목입니다. 오늘 이 장에서 직접 거래되지
                않으며, 시세·통화는 해당 종목의 상장 시장 기준입니다.
              </p>
              <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(340px,1fr))]">
                {foreign.map((w, i) => (
                  <StockCard
                    key={`${w.symbol}-${i}`}
                    analysis={w}
                    marketNote={marketLabel(watchMarket(w, snap.market))}
                  />
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
