import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Loader2, AlertTriangle, Package, PowerOff } from "lucide-react";
import type { ProductSummary } from "@shared/types";
import { api, type AppConfig } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ProductCard } from "@/components/ProductCard";
import { AddProductDialog } from "@/components/AddProductDialog";

export default function App() {
  const [summaries, setSummaries] = useState<ProductSummary[]>([]);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [serviceInstalled, setServiceInstalled] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([api.products(showInactive), api.config()]);
      setSummaries(s);
      setCfg(c);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [showInactive]);

  useEffect(() => {
    load();
    api.serviceStatus().then((s) => setServiceInstalled(s.installed)).catch(() => {});
  }, [load]);

  async function uninstallService() {
    if (
      !confirm(
        "백그라운드 자동 수집 서비스를 제거할까요?\n제거하면 매일 자동 수집이 중단되고 이 서버도 종료됩니다.\n(저장된 데이터/이력은 보존됩니다)"
      )
    )
      return;
    setUninstalling(true);
    try {
      const r = await api.uninstallService();
      setNotice(
        `${r.message}\n다시 켜려면 터미널에서 ./service/install.sh 를 실행하세요.`
      );
      setServiceInstalled(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUninstalling(false);
    }
  }

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
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1920px] items-center justify-between gap-4 px-4 py-3">
          <div>
            <h1 className="text-lg font-bold">📷 Daily Price Dashboard</h1>
            {cfg && (
              <p className="text-xs text-muted-foreground">
                매일 {cfg.collectTime} 자동 수집 · 이메일 알림 {cfg.notify.email ? "켜짐" : "꺼짐"}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              중지된 항목
            </label>
            <Button variant="outline" onClick={collectNow} disabled={collecting}>
              {collecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              지금 수집
            </Button>
            <AddProductDialog onAdded={load} />
            {serviceInstalled && (
              <Button
                variant="destructive"
                onClick={uninstallService}
                disabled={uninstalling}
                title="launchd 자동 수집 서비스 제거"
              >
                {uninstalling ? <Loader2 className="h-4 w-4 animate-spin" /> : <PowerOff className="h-4 w-4" />}
                서비스 제거
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1920px] px-4 py-6">
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

        {notice && (
          <div className="mb-4 whitespace-pre-line rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            {notice}
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
      </main>
    </div>
  );
}
