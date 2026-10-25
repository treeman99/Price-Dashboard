import { useState } from "react";
import { Bell, Clock, Settings2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Meta } from "@/components/ui/page";
import { TabConfigPanel } from "@/components/TabConfigPanel";
import { cn } from "@/lib/utils";
import { CHANNEL_LABEL, TAB_CONFIG, compactHourlyTimes, formatWhen, type ConfigTabId } from "@/lib/tabConfig";
import { reloadTabConfig, useTabConfig } from "@/lib/tabConfigStore";
import { describeRepeat, describeSchedule, nextOccurrence } from "@shared/schedule";
import type { JobSchedule, NotifyTabId, ScheduleJobId, TabSettingsResponse } from "@shared/types";

/**
 * 스케줄 한 줄 요약 + 다음 실행 표기. 꺼짐이면 next 는 null.
 * text 는 정각 시각이 많으면 묶은 것("매일 매시 정각(00~06·…시)"), full 은 서버와 같은 describeSchedule 원문이다.
 */
export function jobSummary(job: JobSchedule, now: Date): { text: string; full: string; next: string | null } {
  const next = job.enabled ? nextOccurrence(job, now) : null;
  const full = job.enabled ? describeSchedule(job) : "꺼짐";
  const compact = job.enabled ? compactHourlyTimes(job.times) : null;
  return {
    text: compact ? `${describeRepeat(job.repeat)} ${compact}` : full,
    full,
    next: next ? formatWhen(next, now) : null,
  };
}

/** 탭 알림이 실제로 나가는 채널(탭 스위치 AND 전역 스위치). */
export function activeChannels(settings: TabSettingsResponse, notify: NotifyTabId) {
  return (settings.channels[notify] ?? []).filter(
    (ch) => settings.settings.notify[notify]?.[ch] && settings.globalChannels[ch]
  );
}

/** 탭 '자동 수집·설정' 다이얼로그 제목. */
export function tabConfigTitle(tab: ConfigTabId) {
  return `${TAB_CONFIG[tab].label} 자동 수집·설정`;
}

/**
 * 탭 툴바의 '자동 수집' 버튼. 지금 스케줄 요약과 다음 실행을 보여 주고, 누르면 그 탭의
 * 스케줄(들) + 운영 설정 + 알림을 편집하는 다이얼로그가 열린다.
 *
 * - job: 툴바에 요약할 잡. 증시는 보고 있는 시장(한국장/미국장)의 브리핑을 넘긴다.
 *   다이얼로그에는 그 탭의 잡이 전부 나온다.
 * - showNext=false: 탭이 이미 서버 기준 '다음' 표기를 따로 보여 줄 때(로또).
 */
export function ScheduleControl({
  tab,
  job,
  label = "자동 수집",
  showNext = true,
}: {
  tab: ConfigTabId;
  job?: ScheduleJobId;
  label?: string;
  showNext?: boolean;
}) {
  const { schedule, scheduleErr, loading } = useTabConfig();
  const [open, setOpen] = useState(false);
  const jobId = job ?? TAB_CONFIG[tab].jobs[0];
  const summary = schedule ? jobSummary(schedule.schedule[jobId], new Date()) : null;
  const full = summary ? `${summary.full}${summary.next ? ` · 다음 ${summary.next}` : ""}` : null;

  function onOpenChange(v: boolean) {
    setOpen(v);
    // 열 때마다 서버 값을 다시 읽어 둔다(다른 창에서 바꿨을 수 있다). 편집 초안은 열린 시점 값으로 시작한다.
    if (v) void reloadTabConfig();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="group inline-flex h-6 min-w-0 max-w-full shrink items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={full ? `${label} 변경 — ${full}` : `${label} 변경`}
        >
          {/* hover 때 시계 자리에 설정 아이콘을 겹쳐 보인다 — 뒤에 따로 두면 숨긴 아이콘이 툴바 간격을 벌린다. */}
          <span aria-hidden className="relative h-3.5 w-3.5 shrink-0">
            <Clock className="absolute inset-0 h-3.5 w-3.5 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0" />
            <Settings2 className="absolute inset-0 h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          </span>
          <span className="shrink-0">{label}</span>
          {summary ? (
            <>
              {/* 펄스처럼 시각이 많으면 요약이 길다 — 툴바를 넘치지 않게 자르고 전체는 title·다이얼로그에. */}
              <span
                className={cn(
                  "num min-w-0 truncate text-foreground sm:max-w-[26rem]",
                  summary.text === "꺼짐" && "text-tone-warn"
                )}
              >
                {summary.text}
              </span>
              {showNext && summary.next && (
                <span className="num shrink-0">
                  <span aria-hidden className="text-muted-foreground/50">· </span>다음 {summary.next}
                </span>
              )}
            </>
          ) : (
            <span>{loading ? "…" : scheduleErr ? "불러오기 실패" : "…"}</span>
          )}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl p-4 sm:p-6">
        <DialogHeader className="pr-6">
          <DialogTitle>{tabConfigTitle(tab)}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            언제 자동으로 돌지, 무엇을 알릴지 정합니다. 저장하면 재시작 없이 바로 적용됩니다.
          </DialogDescription>
        </DialogHeader>
        <TabConfigPanel tab={tab} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * 툴바의 알림 문구("수집 시 이메일·iMessage 발송"). 탭별 알림 설정을 따라간다 —
 * 고정 문구로 두면 알림을 꺼도 '이메일 발송'이라고 계속 거짓말을 한다.
 * 설정을 못 읽으면(옛 서버) 원래 문구(fallback)를 그대로 보여 준다.
 */
export function NotifyMeta({
  notify,
  verb = "수집 시",
  suffix = "",
  fallback,
}: {
  notify: NotifyTabId;
  verb?: string;
  suffix?: string;
  fallback: string;
}) {
  const { settings } = useTabConfig();
  if (!settings) return <Meta>{fallback}</Meta>;
  const on = activeChannels(settings, notify);
  if (on.length === 0) return <Meta>알림 꺼짐</Meta>;
  const channels = on.map((ch) => CHANNEL_LABEL[ch]).join("·");
  // 툴바에는 어느 채널로 가는지만 둔다. 언제 나가는지(수집 시·지금 갱신 포함)는 매번 읽을 문장이
  // 아니라 툴팁으로 내린다(UI 검토: 툴바가 운영 설명서가 되어 첫 화면을 차지했다).
  return (
    <Meta>
      <span className="inline-flex items-center gap-1" title={`${verb} ${channels} 발송${suffix}`}>
        <Bell aria-hidden className="h-3.5 w-3.5" />
        알림 {channels}
      </span>
    </Meta>
  );
}
