import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  RefreshCw,
  Loader2,
  Link as LinkIcon,
  LineChart as LineChartIcon,
} from "lucide-react";
import type {
  StockMarket,
  StockSlotRole,
  StockSnapshot,
  StockTicker,
  StockIndex,
  StockNewsItem,
  StockAnalysis,
  StockPositionReview,
} from "@shared/types";
import { formatPnlPct, horizonLabel } from "@shared/holdings";
import {
  marketLabel,
  formatPrice,
  changeTone,
  effectiveRole,
  isPreviewUpcoming,
  partitionWatchlist,
  roleLabel,
  watchMarket,
  foreignSectionTitle,
  isSymbolRegistered,
} from "@shared/stock";
import { safeHref } from "@shared/url";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  PageToolbar,
  Meta,
  MetaDot,
  Notice,
  SectionHeader,
  Segmented,
  StatusTag,
  TextLink,
  EmptyState,
  LoadingState,
} from "@/components/ui/page";
import { cn } from "@/lib/utils";
import { StockCard } from "@/components/StockCard";
import { StockChart } from "@/components/StockChart";
import { AddTickerDialog } from "@/components/AddTickerDialog";
import { NotifyMeta, ScheduleControl } from "@/components/ScheduleControl";

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

/**
 * 지수 시계열의 마지막 거래일. 휴장 배너·기준일 표기의 근거다.
 *
 * ⚠️ 휴장일에 `snap.sessionDate` 를 지수 기준일로 쓰면 안 된다 — 한국장 휴장의 sessionDate 는
 * '다음 거래일'(미래)이라 "07-27 종가" 같은 존재하지 않는 값을 표시하게 된다.
 * 지수 값은 언제나 history 마지막 점에서 왔으므로 기준일도 거기서 읽는다.
 */
function indexAsOf(idx: StockIndex): string | null {
  return idx.history.length ? (idx.history[idx.history.length - 1]?.date ?? null) : null;
}

/** 섹션 머리 앞 색 사각형. 기본은 탭 고유색, '해외 참고'는 슬레이트로 낮춰 부차 정보임을 보인다. */
const ACCENT = "var(--tab)";
const FOREIGN_ACCENT = "#64748b";

/** 차트 위·아래 서술 한 덩어리(지수 전망·근거). */
function Prose({ label, children }: { label?: string; children: string }) {
  return (
    <div>
      {label && <div className="mb-0.5 text-[12px] font-semibold text-muted-foreground">{label}</div>}
      <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/80">{children}</p>
    </div>
  );
}

/**
 * 지수 띠의 한 칸. 띠는 지수 수만큼 열을 두고 열 사이를 세로 헤어라인으로 나눈다.
 * asOf: 휴장일에만 넘긴다 — 값이 '오늘'이 아니라 최종 거래일 종가임을 칸 단위로 못박는다.
 */
function IndexCell({ idx, asOf }: { idx: StockIndex; asOf?: string | null }) {
  return (
    <div className="min-w-0 py-4 first:pt-1 lg:px-6 lg:pt-1 lg:first:pl-0 lg:last:pr-0">
      <div className="text-[13px] font-medium">
        {idx.name}
        {asOf && (
          <span className="ml-1.5 font-mono text-[12px] font-normal text-muted-foreground">· {asOf} 종가</span>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3">
        <span className="num font-serif text-[2rem] font-semibold leading-tight tracking-[-0.01em]">
          {idx.value != null ? idx.value.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : "-"}
        </span>
        <span className={cn("num text-[15px] font-semibold", toneClass(idx.changePct))}>
          {idx.changePct != null
            ? `${idx.changePct > 0 ? "+" : ""}${idx.changePct.toFixed(2)}%`
            : "-"}
        </span>
      </div>
      <div className="mt-2">
        <StockChart points={idx.history} height={140} />
      </div>
      {(idx.comment || (idx.outlook && idx.rationale)) && (
        <div className="mt-3 space-y-2">
          {idx.comment && <Prose>{idx.comment}</Prose>}
          {/* 근거(rationale) 없는 전망은 표시하지 않는다 — 타입 주석의 규칙. */}
          {idx.outlook && idx.rationale && (
            <>
              <Prose label="전망">{idx.outlook}</Prose>
              <Prose label="근거">{idx.rationale}</Prose>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 뉴스 한 줄(가이드 §4-B 행 문법): 제목 · 출처·날짜·원문 · 요약. */
function NewsRow({ item }: { item: StockNewsItem }) {
  const href = safeHref(item.link);
  return (
    <li className="py-3">
      <h4 className="text-[15px] font-semibold leading-snug">{item.title}</h4>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-muted-foreground">
        <span>{item.source}</span>
        <MetaDot />
        <span className="num font-mono">{item.date}</span>
        {href && (
          <>
            <MetaDot />
            <TextLink href={href} icon={<LinkIcon />}>
              원문 보기
            </TextLink>
          </>
        )}
      </p>
      <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-foreground/80">{item.summary}</p>
    </li>
  );
}

/** 목표가·손절가 칸: 가격 + 현재가 대비 거리. 값이 없으면 '-'. */
function LevelCell({ price, pct, currency }: { price: number | null; pct: number | null; currency: string }) {
  if (price == null) return <td className="num text-right text-muted-foreground">-</td>;
  return (
    <td className="num whitespace-nowrap text-right">
      {formatPrice(price, currency)}
      <div className="text-[12px] text-muted-foreground">({formatPnlPct(pct)})</div>
    </td>
  );
}

/**
 * 내 포지션 점검 표의 한 행.
 *
 * `pulseSummary` 가 이 행에서 가장 중요한 블록이다 — 시간당 취합은 화면에 피드를 남기지
 * 않으므로(인터뷰 결정), 문자 문턱을 넘지 못한 판정이 사용자에게 도달하는 **유일한 경로**다.
 */
function PositionRow({ p }: { p: StockPositionReview }) {
  return (
    <tr>
      <td className="whitespace-nowrap">
        <div className="font-semibold">{p.name}</div>
        <div className="font-mono text-[12px] text-muted-foreground">
          {p.symbol} · {horizonLabel(p.horizon)}
        </div>
      </td>
      <td className={cn("num whitespace-nowrap text-right text-[15px] font-semibold", toneClass(p.pnlPct))}>
        {formatPnlPct(p.pnlPct)}
      </td>
      <td className="num whitespace-nowrap text-right font-medium">{formatPrice(p.close, p.currency)}</td>
      <td className="num whitespace-nowrap text-right text-muted-foreground">
        {formatPrice(p.avgPrice, p.currency)}
      </td>
      <td className="num whitespace-nowrap text-right text-muted-foreground">{p.quantity}주</td>
      <LevelCell price={p.targetPrice} pct={p.toTargetPct} currency={p.currency} />
      <LevelCell price={p.stopPrice} pct={p.toStopPct} currency={p.currency} />
      <td className="min-w-[320px]">
        {p.factors && <p className="leading-relaxed">{p.factors}</p>}
        {p.pulseSummary && (
          <div
            className={cn(
              "border-l-2 border-foreground/25 pl-2.5 text-[13px] leading-relaxed text-muted-foreground",
              p.factors && "mt-2"
            )}
          >
            <strong className="font-semibold text-foreground">지난 24시간 실시간 취합</strong>
            <br />
            {p.pulseSummary}
          </div>
        )}
      </td>
    </tr>
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

  /**
   * '오늘의 관심 종목' → 등록 종목. 카드가 실패를 표시할 수 있게 **에러를 삼키지 않는다**.
   *
   * AddTickerDialog 와 같은 확정 패턴: 화면에 보이는 그 종목의 심볼을 query 로 넘긴다.
   * 종목명("엔비디아")을 넘기면 서버가 자동완성으로 다시 추측해 엉뚱한 종목이 들어올 수 있다.
   */
  async function addWatchToTickers(symbol: string) {
    await api.addTicker(market, { query: symbol });
    await load(); // 원장을 다시 읽어 '등록 종목' 섹션과 '등록됨' 표시에 즉시 반영
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
      <PageToolbar
        actions={
          <>
            <AddTickerDialog market={market} onAdded={load} />
            <Button variant="outline" onClick={refresh} disabled={collecting}>
              {collecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {collecting ? "수집 중…" : "지금 갱신"}
            </Button>
          </>
        }
      >
        <Segmented
          aria-label="시장"
          className="mr-1.5"
          value={market}
          onChange={setMarket}
          options={MARKETS.map((m) => ({ value: m, label: marketLabel(m) }))}
        />
        <ScheduleControl tab="stock" job={market === "kr" ? "stockKr" : "stockUs"} />
        <MetaDot />
        <NotifyMeta notify="stock" suffix="(지금 갱신 포함)" fallback="수집 시 이메일 발송(지금 갱신 포함)" />
        {snap && (
          <>
            <MetaDot />
            <Meta>{snap.date}</Meta>
          </>
        )}
        {sessionText && (
          <>
            <MetaDot />
            <Meta>{sessionText}</Meta>
          </>
        )}
        {updated && (
          <>
            <MetaDot />
            <Meta>
              최종 갱신 <strong>{updated}</strong>
            </Meta>
          </>
        )}
        {badge && (
          // title 에 판정 근거를 실어, 스케줄을 바꿨을 때 왜 이 역할이 됐는지 화면에서 바로 보이게 한다.
          <StatusTag className="ml-1" title={snap?.roleReason ?? undefined}>
            {badge}
          </StatusTag>
        )}
      </PageToolbar>

      {/* 역할 서브탭 — 아침 결산과 오늘 밤 프리뷰를 나란히 볼 수 있게 한다.
          역할 분리가 비활성이면 variants 가 비어 탭 자체가 나타나지 않는다(현행 화면 그대로). */}
      {roleViews.length > 0 && (
        <div className="mb-4">
          <Segmented
            aria-label="브리핑"
            value={view}
            onChange={setView}
            options={(["latest", ...roleViews] as SnapshotView[]).map((v) => ({
              value: v,
              // 프리뷰 탭 라벨도 본문과 같은 술어로 시제를 맞춘다. 탭만 미래형으로 남으면
              // 본문이 '종료된 세션'이라 해도 사용자는 탭 이름을 먼저 믿는다.
              label:
                v === "latest"
                  ? "최신"
                  : v === "close"
                    ? "간밤 결산"
                    : resp?.variants?.preview && isPreviewUpcoming(resp.variants.preview)
                      ? "오늘 밤 프리뷰"
                      : "지난 프리뷰",
            }))}
          />
        </div>
      )}

      {err && <Notice tone="error">{err}</Notice>}

      {collecting && (
        <Notice tone="info" progress>
          {marketLabel(market)} 브리핑을 수집하는 중입니다… 1~3분 걸릴 수 있고, 완료되면 자동으로
          반영됩니다.
        </Notice>
      )}

      {/* 휴장은 실패가 아니다 — 에러(빨강)와 구분되게 회색 안내로 표시한다. */}
      {snap?.closed && (
        <Notice tone="muted">
          {snap.date}
          {snap.closedReason ? ` ${snap.closedReason}` : ""} 휴장 —{" "}
          {role === "preview"
            ? "오늘 밤 뉴욕장이 열리지 않습니다. 다음 거래일 프리뷰를 기다립니다."
            : role === "close"
              ? `직전 마감(${snap.sessionDate ?? "미상"}) 결산은 다음 거래일 아침 브리핑이 이어받습니다.`
              : "다음 거래일 브리핑을 기다립니다."}
        </Notice>
      )}

      {loading ? (
        <LoadingState />
      ) : (
        <div className="[&>*+*]:mt-10">
          {/* 내 포지션 점검 — 브리핑 맨 앞. 보유 종목이 없으면 섹션 자체를 렌더하지 않는다
              (비어 있는 섹션이 매일 뜨면 노이즈다 — 해외 참고 섹션과 같은 판단). */}
          {!!snap?.positions?.length && (
            <section>
              <SectionHeader title="내 포지션 점검" count={snap.positions.length} accent={ACCENT} />
              <Notice tone="muted" icon={null} className="mb-2">
                손익·거리 수치는 서버가 계산한 값이고 서술은 AI 영향도 판정입니다. 매매 권유가 아닙니다.
              </Notice>
              <div className="overflow-x-auto">
                <table className="dtable">
                  <thead>
                    <tr>
                      <th>종목</th>
                      <th className="text-right">손익률</th>
                      <th className="text-right">현재가</th>
                      <th className="text-right">평단</th>
                      <th className="text-right">수량</th>
                      <th className="text-right">목표가</th>
                      <th className="text-right">손절가</th>
                      <th>오늘의 요인</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snap.positions.map((p) => (
                      <PositionRow key={`${p.market}-${p.symbol}`} p={p} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* 지수 — 휴장일에도 최종 거래일 종가로 계속 보인다(서술만 비어 있다). */}
          {!!snap?.indices.length && (
            <section>
              <SectionHeader title="지수" count={snap.indices.length} accent={ACCENT} />
              {snap.closed && (
                <Notice tone="muted" icon={null} className="mb-2">
                  휴장 중이라 {indexAsOf(snap.indices[0]) ?? "최종 거래일"} 종가 기준입니다. 값과
                  추이는 그대로 보이고, 시황 서술은 다음 거래일 브리핑에서 붙습니다.
                </Notice>
              )}
              {/* 지수 띠 — 지수 수만큼 열을 두고 세로 헤어라인으로 나눈다(lg 미만은 세로로 쌓는다). */}
              <div
                className="grid divide-y lg:grid-cols-[repeat(var(--n),minmax(0,1fr))] lg:divide-x lg:divide-y-0"
                style={{ "--n": snap.indices.length } as CSSProperties}
              >
                {snap.indices.map((idx, i) => (
                  <IndexCell
                    key={`${idx.name}-${i}`}
                    idx={idx}
                    asOf={snap.closed ? indexAsOf(idx) : null}
                  />
                ))}
              </div>
            </section>
          )}

          {/* 등록 종목 */}
          <section>
            <SectionHeader title="등록 종목" count={tickers.length} accent={ACCENT} />
            {tickers.length ? (
              <div className="divide-y">
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
              <EmptyState icon={<LineChartIcon />} action={<AddTickerDialog market={market} onAdded={load} />}>
                등록된 종목이 없습니다.
              </EmptyState>
            )}
          </section>

          {/* 오늘의 관심 종목 — 이 시장 상장 종목만 */}
          {!!domestic.length && (
            <section>
              <SectionHeader title="오늘의 관심 종목" count={domestic.length} accent={ACCENT} />
              <Notice tone="muted" icon={null} className="mb-0">
                시장에서 거론되는 사실을 정리한 것으로 매수 추천이 아닙니다.
              </Notice>
              <div className="divide-y">
                {domestic.map((w, i) => (
                  <StockCard
                    key={`${w.symbol}-${i}`}
                    analysis={w}
                    // 원장 판정은 정규화된 심볼로 한다 — watchlist 심볼 표기는 흔들린다.
                    registered={isSymbolRegistered(w.symbol, market, tickers)}
                    onAdd={() => addWatchToTickers(w.symbol)}
                    disabled={collecting}
                  />
                ))}
              </div>
            </section>
          )}

          {/* 해외 참고 — 이 브리핑 시장에 상장되지 않은 종목.
              슬레이트 색 사각형 + 별도 괘선 섹션으로 관심 종목 목록과 구조적으로 끊는다. */}
          {!!foreign.length && snap && (
            <section>
              <SectionHeader
                title={foreignSectionTitle(snap.market)}
                count={foreign.length}
                accent={FOREIGN_ACCENT}
              />
              <p className="text-[13px] text-muted-foreground">
                {marketLabel(snap.market)}에 상장되지 않은 종목입니다. 오늘 이 장에서 직접 거래되지
                않으며, 시세·통화는 해당 종목의 상장 시장 기준입니다.
              </p>
              <div className="divide-y">
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

          {/* 뉴스 — 분류(bucket)별 블록을 신문 다단에 흘려 넣는다(가이드 §4-B). */}
          {newsBuckets.length > 0 && (
            <div className="col-rule columns-1 gap-10 lg:columns-2 2xl:columns-3 min-[2200px]:columns-4">
              {newsBuckets.map((g) => (
                // break-inside-avoid: 분류 블록이 두 단에 걸쳐 쪼개지지 않게 한다.
                <section key={g.bucket} className="mb-8 break-inside-avoid">
                  <SectionHeader className="mt-0" title={g.bucket} count={g.items.length} accent={ACCENT} />
                  <ul className="divide-y">
                    {g.items.map((n, i) => (
                      <NewsRow key={`${n.title}-${i}`} item={n} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}

          {(snap?.notes || snap?.disclaimer) && (
            <footer className="space-y-6">
              {snap?.notes && <p className="whitespace-pre-line text-sm text-muted-foreground">{snap.notes}</p>}

              {/* 면책 — 보드 하단에 상시 노출 */}
              {snap?.disclaimer && (
                <p className="border-t pt-4 text-[12px] leading-relaxed text-muted-foreground">{snap.disclaimer}</p>
              )}
            </footer>
          )}
        </div>
      )}
    </div>
  );
}
