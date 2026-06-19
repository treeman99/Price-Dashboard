import { useState, type ReactNode } from "react";
import { Construction } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dashboard } from "@/components/Dashboard";

interface TabDef {
  id: string;
  label: string;
  content: ReactNode;
}

function ComingSoon({ name }: { name: string }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
      <Construction className="h-10 w-10" />
      <p>{name} — 준비 중인 게시판입니다.</p>
    </div>
  );
}

// 새 게시판은 여기에 항목만 추가하면 탭이 늘어난다.
const TABS: TabDef[] = [
  { id: "price", label: "가격 대시보드", content: <Dashboard /> },
  { id: "board2", label: "게시판 2", content: <ComingSoon name="게시판 2" /> },
];

export default function App() {
  const [active, setActive] = useState(TABS[0].id);
  const activeTab = TABS.find((t) => t.id === active) ?? TABS[0];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto max-w-[1920px] px-4">
          <div className="flex items-center gap-6 pt-3">
            <h1 className="shrink-0 text-lg font-bold">📷 Daily Dashboard</h1>
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

      <main className="mx-auto max-w-[1920px] px-4 py-6">{activeTab.content}</main>
    </div>
  );
}
