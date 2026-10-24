import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Cpu, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Notice, StatusTag } from "@/components/ui/page";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AgentModelSettings } from "@shared/types";

/** ISO → "7/27 20:31". 대체 시작 시각은 '언제부터 못 쓰나'만 알면 되므로 초는 버린다. */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

/**
 * 수집·큐레이션 에이전트를 고르는 전역 컨트롤(헤더 배치).
 * 뉴스·유튜브·팝업/전시·증시 등 모든 자동 수집·큐레이션에 공통 적용되며,
 * 변경은 다음 수집부터 반영된다(서버 재시작 불필요).
 *
 * 선택은 그대로 두고 **실행할 때만** 대체 모델로 도는 구간이 있으므로(Codex 로그인 초기화·
 * 한도 소진), 지금 무엇이 실제로 돌고 있고 왜 그런지를 화면에 남긴다 — 그러지 않으면
 * "고른 대로 도는 줄 알았는데?"가 된다.
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
  const fallback = settings?.fallback ?? null;
  const fromLabel =
    settings?.options.find((o) => o.id === fallback?.from)?.label ?? fallback?.from ?? "";
  /** 대체 중 실제로 실행되는 모델. 선택(model)은 그대로이므로 이걸 따로 보여줘야 한다. */
  const fallbackLabel =
    settings?.options.find((o) => o.id === settings.fallbackModel)?.label ??
    settings?.fallbackModel ??
    "";

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
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[13px] text-muted-foreground transition-colors hover:border-foreground/40 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            fallback ? "border-tone-warn/40" : "border-foreground/15"
          )}
          title="수집·큐레이션 AI 모델 변경"
        >
          {fallback ? (
            <AlertTriangle className="h-3.5 w-3.5 text-tone-warn" />
          ) : (
            <Cpu className="h-3.5 w-3.5" />
          )}
          <span>
            AI 모델 <span className="font-semibold text-foreground">{label}</span>
            {fallback && <span className="ml-1 font-medium text-tone-warn">→ {fallbackLabel} 임시 대체</span>}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>수집·큐레이션 AI 모델</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            뉴스·유튜브·팝업/전시·증시 등 모든 자동 수집과 큐레이션에 쓸 에이전트입니다.
            변경하면 다음 수집부터 적용됩니다.
          </DialogDescription>
        </DialogHeader>

        {fallback && settings && (
          <Notice
            tone="warn"
            className="mb-0"
            title={
              <>
                {fromLabel} 사용 불가({shortTime(fallback.at)}부터) → 지금은 {fallbackLabel}(으)로
                임시 대체 실행 중
              </>
            }
          >
            <p className="mt-1 text-[13px] text-muted-foreground">
              선택은 {fromLabel} 그대로입니다. 수집을 실행할 때마다 {fromLabel}를 먼저 확인해,
              다시 응답하는 순간 별도 조작 없이 되돌아갑니다.
            </p>
            {fallback.reason && (
              <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
                {fallback.reason}
              </p>
            )}
          </Notice>
        )}

        {loadErr && !settings ? (
          <Notice
            tone="error"
            className="mb-0"
            action={
              <Button variant="outline" size="sm" onClick={load}>
                다시 시도
              </Button>
            }
          >
            모델 설정을 불러오지 못했습니다.
          </Notice>
        ) : (
          <div>
            <ul className="divide-y border-y">
              {settings?.options.map((o) => {
                const selected = o.id === settings.model;
                const saving = busy === o.id;
                return (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => pick(o.id)}
                      disabled={busy != null}
                      aria-pressed={selected}
                      className={cn(
                        "flex w-full items-start gap-3 px-2 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none",
                        busy != null && !saving && "opacity-60"
                      )}
                    >
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                        {saving ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : selected ? (
                          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background">
                            <Check className="h-3 w-3" strokeWidth={3} />
                          </span>
                        ) : (
                          <span className="h-4 w-4 rounded-full border border-foreground/30" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-semibold">{o.label}</span>
                          {selected && <span className="text-xs font-semibold text-foreground">현재</span>}
                          {o.id === settings.primary && (
                            <StatusTag tone="neutral">기본 · 사용 불가 시 {fallbackLabel} 임시 대체</StatusTag>
                          )}
                          <span className="font-mono text-[11px] text-muted-foreground">{o.id}</span>
                        </span>
                        {o.description && (
                          <span className="mt-0.5 block text-[13px] text-muted-foreground">
                            {o.description}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {err && <p className="mt-2 text-sm text-tone-error">{err}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
