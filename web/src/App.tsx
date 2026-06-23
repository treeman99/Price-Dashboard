import { useEffect, useState, type ReactNode } from "react";
import { Loader2, PowerOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dashboard } from "@/components/Dashboard";
import { EventsBoard } from "@/components/EventsBoard";
import { NewsBoard } from "@/components/NewsBoard";

interface TabDef {
  id: string;
  label: string;
  content: ReactNode;
}

// 새 게시판은 여기에 항목만 추가하면 탭이 늘어난다.
const TABS: TabDef[] = [
  { id: "price", label: "가격 대시보드", content: <Dashboard /> },
  { id: "events", label: "팝업·전시", content: <EventsBoard /> },
  { id: "news", label: "뉴스", content: <NewsBoard /> },
];

export default function App() {
  const [active, setActive] = useState(TABS[0].id);
  const activeTab = TABS.find((t) => t.id === active) ?? TABS[0];

  // 서비스 제거는 특정 탭이 아닌 전역 기능 → 헤더에 배치
  const [serviceInstalled, setServiceInstalled] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .serviceStatus()
      .then((s) => setServiceInstalled(s.installed))
      .catch(() => {});
  }, []);

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
      setNotice(`${r.message}\n다시 켜려면 터미널에서 ./service/install.sh 를 실행하세요.`);
      setServiceInstalled(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUninstalling(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto max-w-[1920px] px-4">
          <div className="flex items-center justify-between gap-6 pt-3">
            <h1 className="shrink-0 text-lg font-bold">📷 Daily Dashboard</h1>
            {serviceInstalled && (
              <Button
                variant="destructive"
                size="sm"
                onClick={uninstallService}
                disabled={uninstalling}
                title="launchd 자동 수집 서비스 제거"
              >
                {uninstalling ? <Loader2 className="h-4 w-4 animate-spin" /> : <PowerOff className="h-4 w-4" />}
                서비스 제거
              </Button>
            )}
          </div>
          {/* 게시판 탭 메뉴 */}
          <nav className="-mb-px flex gap-1 pt-2" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={active === t.id}
                onClick={() => setActive(t.id)}
                className={cn(
                  "border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                  active === t.id
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1920px] px-4 py-6">
        {notice && (
          <div className="mb-4 whitespace-pre-line rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            {notice}
          </div>
        )}
        {err && (
          <div className="mb-4 rounded-md border border-up/40 bg-up/10 px-4 py-3 text-sm text-up">{err}</div>
        )}
        {activeTab.content}
      </main>
    </div>
  );
}
