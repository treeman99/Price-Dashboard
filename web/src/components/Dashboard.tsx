import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Loader2, AlertTriangle, Package } from "lucide-react";
import type { ProductSummary } from "@shared/types";
import { api, type AppConfig, type CollectStatus } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ProductCard } from "@/components/ProductCard";
import { AddProductDialog } from "@/components/AddProductDialog";
import { ScheduleControl } from "@/components/ScheduleControl";

/** 상품 id 집합이 같은지(순서 무관). 폴링마다 새 배열이 와도 불필요한 리렌더를 막는다. */
function sameIds(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

export function Dashboard() {
  const [summaries, setSummaries] = useState<ProductSummary[]>([]);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  /** 개별 즉시수집(상품 추가 1차 수집 / 재수집)이 진행 중인 상품 id → 카드에 '수집 중' 배지. */
  const [collectingIds, setCollectingIds] = useState<number[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // 폴링이 "무언가 시작/완료됐는지"를 판정하려면 직전 상태가 필요한데, state 는 인터벌 클로저에
  // 갇혀 낡은 값을 보므로 항상 최신인 ref 로 비교한다.
  const statusRef = useRef<CollectStatus>({ collecting: false, productIds: [] });
  const busy = collecting || collectingIds.length > 0;

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([api.products(), api.config()]);
      setSummaries(s);
      setCfg(c);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  /** 수집 상태를 화면에 반영하고, 직전과 달라졌는지(=무언가 시작/완료됐는지) 알려준다. */
  const applyStatus = useCallback((st: CollectStatus) => {
    const prev = statusRef.current;
    const changed = prev.collecting !== st.collecting || !sameIds(prev.productIds, st.productIds);
    statusRef.current = st;
    setCollecting(st.collecting);
    setCollectingIds((cur) => (sameIds(cur, st.productIds) ? cur : st.productIds));
    return changed;
  }, []);

  const checkStatus = useCallback(async () => {
    try {
      applyStatus(await api.collectStatus());
    } catch {
      /* 상태 폴링 실패는 무시 */
    }
  }, [applyStatus]);

  /**
   * 목록 + 수집 상태를 함께 다시 읽는다. 상품 추가·재수집은 서버가 백그라운드로 수집을
   * 시작하므로, 목록만 새로 읽으면 방금 추가한 카드가 '수집 중'인지 알 수 없다.
   */
  const refresh = useCallback(async () => {
    await Promise.all([load(), checkStatus()]);
  }, [load, checkStatus]);

  useEffect(() => {
    load();
    checkStatus(); // 진입 시 (예: 정시 수집이 돌고 있으면) '수집 중'을 즉시 반영
  }, [load, checkStatus]);

  // 수집(전체 또는 개별)이 진행 중이면 5초마다 상태 확인 → 시작/완료가 생기면 목록을 다시 읽어
  // 끝난 상품의 새 가격·리뷰를 반영한다. 남은 상품이 있어도 끝난 것부터 즉시 보여준다.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(async () => {
      let st: CollectStatus;
      try {
        st = await api.collectStatus();
      } catch {
        return; // 일시 오류는 다음 주기에 재시도
      }
      if (applyStatus(st)) await load();
    }, 5000);
    return () => clearInterval(timer);
  }, [busy, applyStatus, load]);

  async function collectNow() {
    setErr(null);
    try {
      await api.collectNow(); // 백그라운드 시작(202) 또는 이미 수집 중(409) → 둘 다 정상
      setCollecting(true); // '수집 중' 배너 + 폴링 시작 → 완료되면 자동 반영
      statusRef.current = { ...statusRef.current, collecting: true };
    } catch (e) {
      setErr((e as Error).message); // 5xx 등 진짜 실패만 표시
    }
  }

  /** 카드 표시 순서 조정(인접 카드와 교환). 낙관적 업데이트 후 서버 저장, 실패 시 복구. */
  async function move(summary: ProductSummary, dir: "up" | "down") {
    const idx = summaries.findIndex((s) => s.product.id === summary.product.id);
    const j = dir === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || j < 0 || j >= summaries.length) return;
    const prev = summaries; // 실패 시 되돌릴 직전 순서
    const next = summaries.slice();
    [next[idx], next[j]] = [next[j], next[idx]];
    setSummaries(next); // 낙관적 업데이트
    try {
      await api.reorderProducts(next.map((s) => s.product.id));
      setErr(null);
    } catch (e) {
      // 직전 순서로 로컬 복구하고 에러는 유지(load()로 덮어써 에러가 깜빡 사라지는 것 방지)
      setSummaries(prev);
      setErr(`순서 저장 실패: ${(e as Error).message}`);
    }
  }

  return (
    <div>
      {/* 대시보드 전용 툴바 */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <ScheduleControl kind="price" />
          {cfg && <span>· 이메일 알림 {cfg.notify.email ? "켜짐" : "꺼짐"}</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={collectNow} disabled={collecting}>
            {collecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {collecting ? "수집 중…" : "지금 수집"}
          </Button>
          <AddProductDialog onAdded={refresh} />
        </div>
      </div>

      {cfg?.warnings && cfg.warnings.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <ul className="space-y-0.5">
            {cfg.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
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
          가격을 수집하는 중입니다… 상품 수에 따라 수 분 걸릴 수 있고, 완료되면 자동으로 반영됩니다.
        </div>
      )}

      {loading ? (
        <div className="flex h-64 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 불러오는 중…
        </div>
      ) : summaries.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <Package className="h-10 w-10" />
          <p>추적 중인 상품이 없습니다.</p>
          <AddProductDialog onAdded={refresh} />
        </div>
      ) : (
        <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(340px,1fr))]">
          {summaries.map((s, i) => (
            <ProductCard
              key={s.product.id}
              summary={s}
              onChanged={refresh}
              collecting={collectingIds.includes(s.product.id)}
              canUp={i > 0}
              canDown={i < summaries.length - 1}
              onMove={move}
            />
          ))}
        </div>
      )}
    </div>
  );
}
