import { useEffect, useState, type ReactNode } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Notice, Segmented } from "@/components/ui/page";
import { ScheduleEditor, finalizeJob } from "@/components/ScheduleEditor";
import { api } from "@/lib/api";
import {
  CHANNEL_LABEL,
  TAB_CONFIG,
  buildSchedulePatch,
  buildSettingsPatch,
  getAtPath,
  parseNumberField,
  setAtPath,
  type ConfigTabId,
  type SettingField,
} from "@/lib/tabConfig";
import { applySchedule, applySettings, reloadTabConfig, useTabConfig } from "@/lib/tabConfigStore";
import { SCHEDULE_JOB_LABEL } from "@shared/schedule";
import { SEVERITY_LABEL } from "@shared/pulse";
import type { JobSchedule, PulseSeverity, ScheduleConfig, ScheduleJobId, TabSettings } from "@shared/types";

const SEVERITIES: PulseSeverity[] = ["urgent", "important", "info"];

/** 문턱 = 이 강도 '이상'을 보낸다. 긴급은 맨 위라 '긴급만'. */
function thresholdLabel(s: PulseSeverity): string {
  return s === "urgent" ? `${SEVERITY_LABEL[s]}만` : `${SEVERITY_LABEL[s]} 이상`;
}

/** 편집 시작 시점의 값. 저장 본문은 이것과 비교해 **바꾼 것만** 보낸다. */
interface Seed {
  schedule: ScheduleConfig | null;
  settings: TabSettings | null;
}

/**
 * 탭 하나의 '자동 수집·설정' 편집 본문(스케줄 잡들 + 운영 설정 + 알림) + 저장/취소.
 * 탭 툴바 다이얼로그와 상단 '설정' 전체 보기의 편집 화면이 **같은 이 컴포넌트**를 쓴다.
 */
export function TabConfigPanel({
  tab,
  onDone,
  onCancel,
  cancelLabel = "취소",
}: {
  tab: ConfigTabId;
  /** 저장 성공(또는 바꾼 게 없음) 후. */
  onDone: () => void;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  const def = TAB_CONFIG[tab];
  const { schedule, scheduleErr, settings, settingsErr, loading } = useTabConfig();

  const [seed, setSeed] = useState<Seed>({ schedule: null, settings: null });
  const [jobs, setJobs] = useState<Partial<Record<ScheduleJobId, JobSchedule>>>({});
  const [draft, setDraft] = useState<TabSettings | null>(null);
  /** 숫자 칸은 입력 중 빈 값·부분 값이 있어 문자열로 들고 있다가 저장 때 검증한다. */
  const [nums, setNums] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 응답이 도착하면 초안을 **한 번만** 채운다. 이후 저장소가 다시 불려도(다른 화면의 저장·재조회)
  // 사용자가 편집 중인 값을 덮어쓰지 않는다.
  useEffect(() => {
    if (schedule && !seed.schedule) {
      setSeed((s) => ({ ...s, schedule: schedule.schedule }));
      setJobs(Object.fromEntries(def.jobs.map((id) => [id, schedule.schedule[id]])));
    }
  }, [schedule, seed.schedule, def.jobs]);
  useEffect(() => {
    if (settings && !seed.settings) {
      setSeed((s) => ({ ...s, settings: settings.settings }));
      setDraft(settings.settings);
      setNums(
        Object.fromEntries(
          def.fields
            .filter((f) => f.kind === "number")
            .map((f) => [f.path, String(getAtPath(settings.settings, f.path) ?? "")])
        )
      );
    }
  }, [settings, seed.settings, def.fields]);

  const hasSettings = def.fields.length > 0 || def.notify != null;
  const channels = def.notify && settings ? settings.channels[def.notify] ?? [] : [];

  function resetSettings() {
    if (!settings || !draft) return;
    let next = draft;
    for (const f of def.fields) next = setAtPath(next, f.path, getAtPath(settings.defaults, f.path));
    if (def.notify) next = setAtPath(next, `notify.${def.notify}`, settings.defaults.notify[def.notify]);
    setDraft(next);
    setNums(
      Object.fromEntries(
        def.fields
          .filter((f) => f.kind === "number")
          .map((f) => [f.path, String(getAtPath(settings.defaults, f.path) ?? "")])
      )
    );
  }

  async function save() {
    setErr(null);
    const now = new Date();

    // 1) 스케줄: 서버와 같은 normalizeJobSchedule 로 먼저 검증한다.
    let schedPatch: Partial<ScheduleConfig> | null = null;
    if (seed.schedule) {
      const finalized: Partial<Record<ScheduleJobId, JobSchedule>> = {};
      for (const id of def.jobs) {
        const job = jobs[id];
        if (!job) continue;
        try {
          finalized[id] = finalizeJob(job, id, now);
        } catch (e) {
          // 사유 앞에 잡 이름("증시(한국): …")이 이미 붙어 온다.
          setErr((e as Error).message);
          return;
        }
      }
      schedPatch = buildSchedulePatch(seed.schedule, finalized);
    }

    // 2) 운영 설정: 숫자는 numberRules 범위로 검증한 뒤 바꾼 필드만 고른다.
    let settingsPatch = null;
    if (seed.settings && draft && settings) {
      let next = draft;
      for (const f of def.fields) {
        if (f.kind !== "number") continue;
        const r = parseNumberField(nums[f.path] ?? "", f.label, settings.numberRules[f.path]);
        if (!r.ok) {
          setErr(r.error);
          return;
        }
        next = setAtPath(next, f.path, r.value);
      }
      settingsPatch = buildSettingsPatch(seed.settings, next, def, channels);
    }

    if (!schedPatch && !settingsPatch) {
      onDone();
      return;
    }

    setBusy(true);
    try {
      if (schedPatch) applySchedule(await api.updateSchedule(schedPatch));
      if (settingsPatch) applySettings(await api.updateSettings(settingsPatch));
      onDone();
    } catch (e) {
      // 서버 400 의 {error} 문구를 그대로 보여 준다. 스케줄은 저장되고 설정만 실패했을 수 있어
      // 화면 값은 서버에서 다시 읽어 맞춘다(편집 중인 초안은 그대로 둔다).
      setErr((e as Error).message);
      void reloadTabConfig();
    } finally {
      setBusy(false);
    }
  }

  function renderField(f: SettingField) {
    if (!draft || !settings) return null;
    const rule = settings.numberRules[f.path];
    const defVal = getAtPath(settings.defaults, f.path);
    let control: ReactNode;
    let isDefault: boolean;
    if (f.kind === "number") {
      const raw = nums[f.path] ?? "";
      isDefault = raw.trim() !== "" && Number(raw) === defVal;
      control = (
        <span className="inline-flex items-center gap-1.5">
          <Input
            type="number"
            inputMode="numeric"
            min={rule?.min}
            max={rule?.max}
            step={1}
            value={raw}
            onChange={(e) => setNums((m) => ({ ...m, [f.path]: e.target.value }))}
            className="num h-8 w-20 text-right font-mono text-[13px]"
            aria-label={f.label}
          />
          {rule?.unit && <span className="text-[13px] text-muted-foreground">{rule.unit}</span>}
        </span>
      );
    } else if (f.kind === "boolean") {
      const v = getAtPath(draft, f.path) === true;
      isDefault = v === defVal;
      control = <Switch checked={v} onCheckedChange={(c) => setDraft(setAtPath(draft, f.path, c))} aria-label={f.label} />;
    } else {
      const v = getAtPath(draft, f.path) as PulseSeverity;
      isDefault = v === defVal;
      control = (
        <Segmented
          aria-label={f.label}
          value={v}
          onChange={(s) => setDraft(setAtPath(draft, f.path, s))}
          options={SEVERITIES.map((s) => ({ value: s, label: thresholdLabel(s) }))}
        />
      );
    }
    const defText =
      f.kind === "number"
        ? `${String(defVal)}${rule?.unit ?? ""}`
        : f.kind === "boolean"
          ? defVal
            ? "켜짐"
            : "꺼짐"
          : thresholdLabel(defVal as PulseSeverity);
    return (
      <li key={f.path} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2.5">
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-sm font-medium">{f.label}</p>
          <p className="text-[12.5px] leading-snug text-muted-foreground">
            {f.hint}
            {rule && f.kind === "number" && (
              <span className="num">
                {" "}
                ({rule.min}~{rule.max}
                {rule.unit})
              </span>
            )}
            {!isDefault && <span className="num"> · 기본 {defText}</span>}
          </p>
        </div>
        {control}
      </li>
    );
  }

  const scheduleReady = !!(schedule && seed.schedule);

  return (
    <div className="space-y-5">
      {/* ── 스케줄 ── */}
      <section className="space-y-4">
        {!scheduleReady ? (
          loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 불러오는 중…
            </p>
          ) : (
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
          )
        ) : (
          def.jobs.map((id, i) => {
            const job = jobs[id];
            if (!job || !schedule) return null;
            return (
              <div key={id} className={i > 0 ? "border-t-2 border-foreground/80 pt-4" : undefined}>
                <ScheduleEditor
                  id={id}
                  value={job}
                  onChange={(v) => setJobs((m) => ({ ...m, [id]: v }))}
                  rules={schedule.rules[id]}
                  defaults={schedule.defaults[id]}
                  title={def.jobs.length > 1 ? SCHEDULE_JOB_LABEL[id] : undefined}
                />
              </div>
            );
          })
        )}
      </section>

      {/* ── 운영 설정 + 알림 ── */}
      {hasSettings && (
        <section className="border-t-2 border-foreground pt-3">
          <div className="flex items-center gap-2">
            <h3 className="font-serif text-[1.05rem] font-semibold">운영 설정</h3>
            {draft && settings && (
              <Button variant="ghost" size="sm" className="ml-auto" onClick={resetSettings}>
                <RotateCcw className="h-3.5 w-3.5" /> 기본값으로
              </Button>
            )}
          </div>
          {!draft || !settings ? (
            loading ? (
              <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> 불러오는 중…
              </p>
            ) : (
              <Notice
                tone="error"
                className="mb-0 mt-2"
                action={
                  <Button variant="outline" size="sm" onClick={() => void reloadTabConfig()}>
                    다시 시도
                  </Button>
                }
              >
                운영 설정을 불러오지 못했습니다{settingsErr ? ` — ${settingsErr}` : "."}
              </Notice>
            )
          ) : (
            <ul className="divide-y">
              {def.notify && channels.length > 0 && (
                <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2.5">
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="text-sm font-medium">알림</p>
                    <p className="text-[12.5px] text-muted-foreground">켜도 .env 전역 스위치가 꺼져 있으면 나가지 않습니다.</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                    {channels.map((ch) => {
                      const global = settings.globalChannels[ch];
                      const notify = def.notify!;
                      const on = draft.notify[notify][ch];
                      return (
                        <label key={ch} className="inline-flex items-center gap-2 text-[13px]">
                          <Switch
                            checked={global && on}
                            disabled={!global}
                            onCheckedChange={(c) => setDraft(setAtPath(draft, `notify.${notify}.${ch}`, c))}
                            aria-label={`${CHANNEL_LABEL[ch]} 알림`}
                          />
                          <span>{CHANNEL_LABEL[ch]}</span>
                          {!global && <span className="text-[12px] text-muted-foreground">전역에서 꺼짐(.env)</span>}
                        </label>
                      );
                    })}
                  </div>
                </li>
              )}
              {def.fields.map(renderField)}
            </ul>
          )}
        </section>
      )}

      {err && (
        <Notice tone="error" className="mb-0">
          {err}
        </Notice>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button onClick={() => void save()} disabled={busy || (!scheduleReady && !draft)}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          저장
        </Button>
      </div>
    </div>
  );
}
