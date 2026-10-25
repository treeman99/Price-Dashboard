import { useState, type CSSProperties } from "react";
import { ArrowLeft, Loader2, Pencil, SlidersHorizontal } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Notice } from "@/components/ui/page";
import { TabConfigPanel } from "@/components/TabConfigPanel";
import { activeChannels, jobSummary, tabConfigTitle } from "@/components/ScheduleControl";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CHANNEL_LABEL, TAB_CONFIG, type ConfigTabId } from "@/lib/tabConfig";
import { applySettings, reloadTabConfig, useTabConfig } from "@/lib/tabConfigStore";
import { SCHEDULE_JOB_LABEL } from "@shared/schedule";
import type { NotifyChannel } from "@shared/types";

export interface OverviewTab {
  id: string;
  label: string;
  /** 탭 고유색. 편집 화면에서 --tab 을 이 색으로 바꿔 스위치 색이 그 탭을 따르게 한다. */
  color: string;
}

function isConfigTab(id: string): id is ConfigTabId {
  return id in TAB_CONFIG;
}

/**
 * 상단 헤더 '설정' — 전 탭의 자동 실행·알림을 한눈에 보고, 행마다 편집한다.
 * 편집 화면은 탭 툴바 다이얼로그와 **같은 TabConfigPanel** 을 다이얼로그 안에서 바꿔 끼운다
 * (다이얼로그 위에 다이얼로그를 또 띄우면 좁은 화면에서 겹친 오버레이가 화면을 다 가린다).
 * 탭에 속하지 않는 '가동 중단 알림'(notify.uptime)도 여기서만 바꾼다.
 */
export function SettingsOverview({ tabs }: { tabs: OverviewTab[] }) {
  const { schedule, scheduleErr, settings, settingsErr, loading } = useTabConfig();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ConfigTabId | null>(null);
  const [uptimeBusy, setUptimeBusy] = useState<NotifyChannel | null>(null);
  const [uptimeErr, setUptimeErr] = useState<string | null>(null);

  const rows = tabs.filter((t): t is OverviewTab & { id: ConfigTabId } => isConfigTab(t.id));
  const editingTab = editing ? rows.find((t) => t.id === editing) : undefined;
  const now = new Date();

  function onOpenChange(v: boolean) {
    setOpen(v);
    if (v) {
      setEditing(null);
      setUptimeErr(null);
      void reloadTabConfig();
    }
  }

  /** 가동 중단 알림은 스위치 하나라 누르는 즉시 저장한다(바꾼 채널만 보낸다). */
  async function toggleUptime(ch: NotifyChannel, on: boolean) {
    setUptimeBusy(ch);
    setUptimeErr(null);
    try {
      applySettings(await api.updateSettings({ notify: { uptime: { [ch]: on } } }));
    } catch (e) {
      setUptimeErr((e as Error).message);
    } finally {
      setUptimeBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-foreground/15 px-2.5 text-[13px] text-muted-foreground transition-colors hover:border-foreground/40 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="전 탭 자동 수집·알림 설정"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          <span className="font-medium text-foreground">설정</span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl p-4 sm:p-6">
        {editingTab ? (
          <>
            <DialogHeader className="pr-6">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="-ml-1 inline-flex w-fit items-center gap-1 rounded-md px-1 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> 전체 보기
              </button>
              <DialogTitle className="flex items-center gap-2">
                <span aria-hidden className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: editingTab.color }} />
                {tabConfigTitle(editingTab.id)}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {editingTab.label} 탭의 자동 실행 스케줄과 운영 설정을 편집합니다.
              </DialogDescription>
            </DialogHeader>
            <div style={{ "--tab": editingTab.color } as CSSProperties}>
              <TabConfigPanel
                key={editingTab.id}
                tab={editingTab.id}
                onDone={() => setEditing(null)}
                onCancel={() => setEditing(null)}
                cancelLabel="목록으로"
              />
            </div>
          </>
        ) : (
          <>
            <DialogHeader className="pr-6">
              <DialogTitle>설정</DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                탭마다 언제 자동으로 돌고 무엇을 알리는지 한눈에 봅니다. 편집은 각 탭 툴바의 &lsquo;자동 수집&rsquo;과 같습니다.
              </DialogDescription>
            </DialogHeader>

            {!schedule && !loading && (
              <Notice
                tone="error"
                className="mb-0"
                action={
                  <Button variant="outline" size="sm" onClick={() => void reloadTabConfig()}>
                    다시 시도
                  </Button>
                }
              >
                스케줄을 불러오지 못했습니다{scheduleErr ? ` — ${scheduleErr}` : "."}
              </Notice>
            )}

            <ul className="divide-y border-y">
              {rows.map((t) => {
                const def = TAB_CONFIG[t.id];
                const channels = settings && def.notify ? activeChannels(settings, def.notify) : null;
                return (
                  <li
                    key={t.id}
                    className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 py-3 sm:grid-cols-[7.5rem_1fr_8.5rem_auto] sm:items-center"
                  >
                    <div className="flex items-center gap-2 text-[15px] font-semibold">
                      <span aria-hidden className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: t.color }} />
                      {t.label}
                    </div>
                    <div className="col-span-2 row-start-2 min-w-0 space-y-0.5 text-[13px] sm:col-span-1 sm:row-start-auto">
                      {def.jobs.map((id) => {
                        const s = schedule ? jobSummary(schedule.schedule[id], now) : null;
                        return (
                          <p key={id} className="num min-w-0">
                            {def.jobs.length > 1 && (
                              <span className="mr-1.5 text-muted-foreground">{SCHEDULE_JOB_LABEL[id]}</span>
                            )}
                            {s ? (
                              <>
                                <span className={cn("break-words", s.text === "꺼짐" ? "text-tone-warn" : "text-foreground")}>
                                  {s.text}
                                </span>
                                {s.next && <span className="text-muted-foreground"> · 다음 {s.next}</span>}
                              </>
                            ) : (
                              <span className="text-muted-foreground">{loading ? "…" : "—"}</span>
                            )}
                          </p>
                        );
                      })}
                    </div>
                    <div className="col-span-2 row-start-3 text-[13px] text-muted-foreground sm:col-span-1 sm:row-start-auto">
                      {def.notify == null ? (
                        "알림 없음"
                      ) : channels == null ? (
                        settingsErr ? "알림 —" : "…"
                      ) : channels.length === 0 ? (
                        <span className="text-tone-warn">알림 꺼짐</span>
                      ) : (
                        <>알림 {channels.map((ch) => CHANNEL_LABEL[ch]).join("·")}</>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="col-start-2 row-start-1 justify-self-end sm:col-start-auto sm:row-start-auto"
                      onClick={() => setEditing(t.id)}
                    >
                      <Pencil className="h-3.5 w-3.5" /> 편집
                    </Button>
                  </li>
                );
              })}
            </ul>

            <section className="space-y-2">
              <h3 className="font-serif text-[1.05rem] font-semibold">가동 중단 알림</h3>
              <p className="text-[13px] text-muted-foreground">
                맥이 잠들거나 꺼져 자동 수집이 통째로 밀렸을 때 사후 보고를 보냅니다. 누르는 즉시 저장됩니다.
              </p>
              {settings ? (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                  {(settings.channels.uptime ?? []).map((ch) => {
                    const global = settings.globalChannels[ch];
                    return (
                      <label key={ch} className="inline-flex items-center gap-2 text-[13px]">
                        <Switch
                          checked={global && settings.settings.notify.uptime[ch]}
                          disabled={!global || uptimeBusy != null}
                          onCheckedChange={(v) => void toggleUptime(ch, v)}
                          aria-label={`가동 중단 ${CHANNEL_LABEL[ch]} 알림`}
                        />
                        <span>{CHANNEL_LABEL[ch]}</span>
                        {uptimeBusy === ch && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                        {!global && <span className="text-[12px] text-muted-foreground">전역에서 꺼짐(.env)</span>}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[13px] text-muted-foreground">
                  {loading ? "불러오는 중…" : `운영 설정을 불러오지 못했습니다${settingsErr ? ` — ${settingsErr}` : "."}`}
                </p>
              )}
              {uptimeErr && (
                <Notice tone="error" className="mb-0">
                  {uptimeErr}
                </Notice>
              )}
            </section>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
