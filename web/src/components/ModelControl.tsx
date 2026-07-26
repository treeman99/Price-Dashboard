import { useCallback, useEffect, useState } from "react";
import { Check, Cpu, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AgentModelSettings } from "@shared/types";

/**
 * 수집·큐레이션 에이전트를 고르는 전역 컨트롤(헤더 배치).
 * 가격·뉴스·유튜브·팝업/전시·증시 등 모든 자동 수집·큐레이션에 공통 적용되며,
 * 변경은 다음 수집부터 반영된다(서버 재시작 불필요).
 */
export function ModelControl() {
  const [settings, setSettings] = useState<AgentModelSettings | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // 저장 중인 모델 id
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadErr(false);
    api
      .modelSettings()
      .then(setSettings)
      .catch(() => setLoadErr(true));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const current = settings?.options.find((o) => o.id === settings.model);
  const label = current?.label ?? (loadErr ? "불러오기 실패" : "…");

  async function pick(id: string) {
    if (!settings || id === settings.model) {
      setOpen(false);
      return;
    }
    setBusy(id);
    setErr(null);
    try {
      setSettings(await api.updateModel(id));
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
          title="수집·큐레이션 AI 모델 변경"
        >
          <Cpu className="h-3.5 w-3.5" />
          <span>
            AI 모델: <span className="text-foreground">{label}</span>
          </span>
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>수집·큐레이션 AI 모델</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            가격·뉴스·유튜브·팝업/전시·증시 등 모든 자동 수집과 큐레이션에 쓸 에이전트입니다.
            변경하면 다음 수집부터 적용됩니다.
          </DialogDescription>
        </DialogHeader>

        {loadErr && !settings ? (
          <div className="flex items-center justify-between gap-2 rounded-md border border-up/40 bg-up/10 px-3 py-2 text-sm text-up">
            <span>모델 설정을 불러오지 못했습니다.</span>
            <Button variant="outline" size="sm" onClick={load}>
              다시 시도
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {settings?.options.map((o) => {
              const selected = o.id === settings.model;
              const saving = busy === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => pick(o.id)}
                  disabled={busy != null}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                    selected ? "border-primary bg-primary/5" : "hover:bg-muted",
                    busy != null && !saving && "opacity-60"
                  )}
                >
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                    {saving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : selected ? (
                      <Check className="h-4 w-4 text-primary" />
                    ) : (
                      <span className="h-3.5 w-3.5 rounded-full border" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-semibold">{o.label}</span>
                      {selected && <span className="text-xs text-primary">현재</span>}
                      <span className="font-mono text-[11px] text-muted-foreground">{o.id}</span>
                    </span>
                    {o.description && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {o.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            {err && <p className="text-sm text-up">{err}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
