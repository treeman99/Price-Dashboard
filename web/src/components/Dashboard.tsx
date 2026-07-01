import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Loader2, AlertTriangle, Package } from "lucide-react";
import type { ProductSummary } from "@shared/types";
import { api, type AppConfig } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ProductCard } from "@/components/ProductCard";
import { AddProductDialog } from "@/components/AddProductDialog";
import { ScheduleControl } from "@/components/ScheduleControl";

export function Dashboard() {
  const [summaries, setSummaries] = useState<ProductSummary[]>([]);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  useEffect(() => {
    load();
  }, [load]);

  async function collectNow() {
    setCollecting(true);
    try {
      await api.collectNow();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCollecting(false);
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
            지금 수집
          </Button>
          <AddProductDialog onAdded={load} />
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

      {loading ? (
        <div className="flex h-64 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 불러오는 중…
        </div>
      ) : summaries.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <Package className="h-10 w-10" />
          <p>추적 중인 상품이 없습니다.</p>
          <AddProductDialog onAdded={load} />
        </div>
      ) : (
        <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(340px,1fr))]">
          {summaries.map((s, i) => (
            <ProductCard
              key={s.product.id}
              summary={s}
              onChanged={load}
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
