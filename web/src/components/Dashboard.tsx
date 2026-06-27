import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Loader2, AlertTriangle, Package } from "lucide-react";
import type { ProductSummary } from "@shared/types";
import { api, type AppConfig } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ProductCard } from "@/components/ProductCard";
import { AddProductDialog } from "@/components/AddProductDialog";

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

  return (
    <div>
      {/* 대시보드 전용 툴바 */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {cfg
            ? `매일 ${cfg.collectTime} 자동 수집 · 이메일 알림 ${cfg.notify.email ? "켜짐" : "꺼짐"}`
            : " "}
        </p>
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
          {summaries.map((s) => (
            <ProductCard key={s.product.id} summary={s} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}
