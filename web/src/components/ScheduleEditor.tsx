import { useRef, useState, type ReactNode } from "react";
import { Plus, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { IconAction, Notice, Segmented } from "@/components/ui/page";
import { cn } from "@/lib/utils";
import { formatWhen, mondayOf, sameValue, weekDays, ymd } from "@/lib/tabConfig";
import {
  describeSchedule,
  expandInterval,
  isDueDate,
  nextOccurrence,
  normalizeJobSchedule,
} from "@shared/schedule";
import type { JobSchedule, JobScheduleRules, ScheduleJobId, ScheduleRepeat, Weekday } from "@shared/types";

/**
 * 잡 1개의 스케줄 편집기(켜기/끄기 · 반복 · 요일/날짜 · 시각 목록 · 간격 생성기 · 미리보기).
 * 탭 툴바의 다이얼로그와 상단 '설정' 전체 보기가 같은 이 컴포넌트를 쓴다.
 *
 * 값은 바깥이 들고 있는 **초안**이다(controlled). 저장 직전 검증은 finalizeJob(= 서버와 같은
 * normalizeJobSchedule)으로 한다. 입력 범위는 서버 응답의 rules 를 그대로 따른다.
 */

/** 화면 칩 순서는 월~일(주 시작=월요일, 계약 §1.1), 값은 getDay() 그대로. */
const WEEK: { day: Weekday; label: string }[] = [
  { day: 1, label: "월" },
  { day: 2, label: "화" },
  { day: 3, label: "수" },
  { day: 4, label: "목" },
  { day: 5, label: "금" },
  { day: 6, label: "토" },
  { day: 0, label: "일" },
];
const WEEKDAY_NAME = ["일", "월", "화", "수", "목", "금", "토"];

const REPEAT_LABEL: Record<ScheduleRepeat["kind"], string> = {
  daily: "매일",
  weekly: "매주",
  monthly: "매월",
};

const PRESETS: { label: string; days: Weekday[] }[] = [
  { label: "매일", days: [0, 1, 2, 3, 4, 5, 6] },
  { label: "평일", days: [1, 2, 3, 4, 5] },
  { label: "주말", days: [0, 6] },
];

/** 미리보기에 보여 줄 다음 실행 횟수. */
const PREVIEW_COUNT = 3;

function intervalLabel(n: number): string {
  return n === 1 ? "매주" : n === 2 ? "격주" : `${n}주마다`;
}

/** 편집 중 비워 둔 시각 칸("")은 저장 대상이 아니다. */
function withoutBlankTimes(job: JobSchedule): JobSchedule {
  return { ...job, times: job.times.map((t) => t.trim()).filter(Boolean) };
}

/** 저장 직전 정규화·검증. 서버와 같은 함수라 여기서 통과하면 서버도 받는다(실패 시 한국어 Error). */
export function finalizeJob(job: JobSchedule, id: ScheduleJobId, now = new Date()): JobSchedule {
  return normalizeJobSchedule(withoutBlankTimes(job), id, now);
}

function sameDays(a: readonly number[], b: readonly number[]) {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/** 칩(요일·날짜) 한 개. 선택되면 잉크로 채운다(다이얼로그 선택형 버튼 규칙, ui-design-guide §5). */
function Chip({
  selected,
  disabled,
  onClick,
  children,
  className,
  label,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center justify-center rounded-md border text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-35",
        selected
          ? "border-foreground bg-foreground text-background"
          : "border-input text-foreground/80 hover:border-foreground/40 hover:bg-muted",
        className
      )}
    >
      {children}
    </button>
  );
}

/** 편집기의 한 줄(왼쪽 라벨 + 내용). 좁은 화면에서는 라벨이 위로 올라간다. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[4.5rem_1fr] sm:gap-3">
      <div className="pt-1.5 text-[13px] font-medium text-muted-foreground">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function ScheduleEditor({
  id,
  value,
  onChange,
  rules,
  defaults,
  title,
}: {
  id: ScheduleJobId;
  value: JobSchedule;
  onChange: (next: JobSchedule) => void;
  rules: JobScheduleRules;
  defaults: JobSchedule;
  /** 탭에 잡이 여러 개일 때(증시 한국장/미국장) 잡 이름. */
  title?: string;
}) {
  const now = new Date();
  const maxDays = rules.maxDays ?? 7;
  const maxDates = rules.maxDates ?? Infinity;
  const repeat = value.repeat;

  // 반복 종류를 오가도 직전에 고른 요일·날짜를 잃지 않게 기억해 둔다.
  const lastWeekly = useRef<Extract<ScheduleRepeat, { kind: "weekly" }> | null>(
    repeat.kind === "weekly" ? repeat : null
  );
  const lastMonthly = useRef<Extract<ScheduleRepeat, { kind: "monthly" }> | null>(
    repeat.kind === "monthly" ? repeat : null
  );
  if (repeat.kind === "weekly") lastWeekly.current = repeat;
  if (repeat.kind === "monthly") lastMonthly.current = repeat;

  // ── 'N시간 간격' 생성기 ──
  const [genStart, setGenStart] = useState(() => value.times.find(Boolean) ?? "08:00");
  const [genEnd, setGenEnd] = useState(() => [...value.times].reverse().find(Boolean) ?? "18:00");
  const [genEvery, setGenEvery] = useState("1");
  const [genErr, setGenErr] = useState<string | null>(null);

  function setRepeat(r: ScheduleRepeat) {
    onChange({ ...value, repeat: r });
  }

  function pickKind(kind: ScheduleRepeat["kind"]) {
    if (kind === repeat.kind) return;
    if (kind === "daily") setRepeat({ kind: "daily" });
    else if (kind === "weekly")
      setRepeat(
        lastWeekly.current ?? {
          kind: "weekly",
          days: maxDays >= 5 ? [1, 2, 3, 4, 5] : [1],
          intervalWeeks: 1,
        }
      );
    else setRepeat(lastMonthly.current ?? { kind: "monthly", dates: [1] });
  }

  function toggleDay(day: Weekday) {
    if (repeat.kind !== "weekly") return;
    const has = repeat.days.includes(day);
    let days: Weekday[];
    if (maxDays === 1) days = [day]; // 요일 1개만 되는 잡(로또·스킬 랭킹)은 라디오처럼
    else if (has) {
      if (repeat.days.length === 1) return; // 최소 1개
      days = repeat.days.filter((d) => d !== day);
    } else {
      if (repeat.days.length >= maxDays) return;
      days = [...repeat.days, day];
    }
    setRepeat({ ...repeat, days: [...days].sort((a, b) => a - b) });
  }

  function pickInterval(n: number) {
    if (repeat.kind !== "weekly") return;
    if (n <= 1) {
      // 매주로 돌아오면 기준일은 의미가 없다 — 남겨 두면 저장 파일에 죽은 값이 붙는다.
      setRepeat({ kind: "weekly", days: repeat.days, intervalWeeks: 1 });
    } else {
      // 처음 격주로 바꾸면 '이번 주부터'를 기본으로 둔다. 이미 기준일이 있으면 유지한다.
      setRepeat({ ...repeat, intervalWeeks: n, anchorDate: repeat.anchorDate ?? ymd(mondayOf(now, 0)) });
    }
  }

  function toggleDate(date: number) {
    if (repeat.kind !== "monthly") return;
    const has = repeat.dates.includes(date);
    let dates: number[];
    if (maxDates === 1) dates = [date];
    else if (has) {
      if (repeat.dates.length === 1) return;
      dates = repeat.dates.filter((d) => d !== date);
    } else {
      if (repeat.dates.length >= maxDates) return;
      dates = [...repeat.dates, date];
    }
    setRepeat({ ...repeat, dates: dates.sort((a, b) => a - b) });
  }

  function setTime(i: number, v: string) {
    onChange({ ...value, times: value.times.map((t, idx) => (idx === i ? v : t)) });
  }
  function addTime() {
    if (value.times.length >= rules.maxTimes) return;
    onChange({ ...value, times: [...value.times, ""] });
  }
  function removeTime(i: number) {
    if (value.times.length <= 1) return;
    onChange({ ...value, times: value.times.filter((_, idx) => idx !== i) });
  }

  function generate() {
    setGenErr(null);
    const hours = Number(genEvery);
    if (!Number.isInteger(hours) || hours < 1 || hours > 23) {
      setGenErr("간격은 1~23시간으로 입력하세요.");
      return;
    }
    try {
      const list = expandInterval(genStart, genEnd, hours * 60);
      if (list.length === 0) {
        setGenErr("만들어진 시각이 없습니다. 시작·끝을 확인하세요.");
        return;
      }
      if (list.length > rules.maxTimes) {
        setGenErr(`시각은 최대 ${rules.maxTimes}개입니다(이 조건이면 ${list.length}개).`);
        return;
      }
      onChange({ ...value, times: list });
    } catch (e) {
      setGenErr((e as Error).message);
    }
  }

  // ── 검증 + 미리보기(서버와 같은 함수) ──
  let normalized: JobSchedule | null = null;
  let invalid: string | null = null;
  try {
    normalized = finalizeJob(value, id, now);
  } catch (e) {
    invalid = (e as Error).message;
  }
  const upcoming: Date[] = [];
  if (normalized?.enabled) {
    let from = now;
    for (let i = 0; i < PREVIEW_COUNT; i++) {
      const n = nextOccurrence(normalized, from);
      if (!n) break;
      upcoming.push(n);
      from = n;
    }
  }

  // 격주 이상: 기준 주가 이번 주인지 다음 주인지. 실제 실행일 판정(isDueDate)으로 본다.
  const weekly = repeat.kind === "weekly" ? repeat : null;
  const runsThisWeek = weekly ? weekDays(now, 0).some((d) => isDueDate(weekly, d)) : false;
  const runsNextWeek = weekly ? weekDays(now, 1).some((d) => isDueDate(weekly, d)) : false;

  const isDefault = normalized != null && sameValue(normalized, defaults);

  return (
    <div className="space-y-3.5">
      <div className="flex items-center gap-3">
        {title && <h3 className="text-[15px] font-semibold">{title}</h3>}
        <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-[13px]">
          <span className={value.enabled ? "font-medium text-foreground" : "text-muted-foreground"}>
            자동 실행 {value.enabled ? "켜짐" : "꺼짐"}
          </span>
          <Switch
            checked={value.enabled}
            onCheckedChange={(v) => onChange({ ...value, enabled: v })}
            aria-label={`${title ?? ""} 자동 실행`.trim()}
          />
        </label>
      </div>

      <div className={cn("space-y-3.5", !value.enabled && "opacity-60")}>
        <Row label="반복">
          {rules.repeatKinds.length > 1 ? (
            <Segmented
              aria-label="반복"
              value={repeat.kind}
              onChange={pickKind}
              options={rules.repeatKinds.map((k) => ({ value: k, label: REPEAT_LABEL[k] }))}
            />
          ) : (
            <p className="pt-1.5 text-sm">{REPEAT_LABEL[rules.repeatKinds[0] ?? repeat.kind]}</p>
          )}
        </Row>

        {repeat.kind === "weekly" && (
          <>
            <Row label="요일">
              <div className="space-y-2">
                <div className="grid max-w-[19rem] grid-cols-7 gap-1">
                  {WEEK.map((w) => {
                    const selected = repeat.days.includes(w.day);
                    return (
                      <Chip
                        key={w.day}
                        selected={selected}
                        disabled={!selected && maxDays > 1 && repeat.days.length >= maxDays}
                        onClick={() => toggleDay(w.day)}
                        label={`${w.label}요일`}
                      >
                        {w.label}
                      </Chip>
                    );
                  })}
                </div>
                {maxDays >= 2 && (
                  <div className="flex flex-wrap gap-1">
                    {PRESETS.filter((p) => p.days.length <= maxDays).map((p) => (
                      <Chip
                        key={p.label}
                        selected={sameDays(repeat.days, p.days)}
                        onClick={() => setRepeat({ ...repeat, days: [...p.days].sort((a, b) => a - b) })}
                        className="px-2.5"
                      >
                        {p.label}
                      </Chip>
                    ))}
                  </div>
                )}
              </div>
            </Row>

            {rules.maxIntervalWeeks > 1 && (
              <Row label="주기">
                <div className="space-y-2">
                  <Segmented
                    aria-label="주기"
                    value={String(repeat.intervalWeeks)}
                    onChange={(v) => pickInterval(Number(v))}
                    className="flex-wrap"
                    options={Array.from({ length: rules.maxIntervalWeeks }, (_, i) => ({
                      value: String(i + 1),
                      label: intervalLabel(i + 1),
                    }))}
                  />
                  {repeat.intervalWeeks > 1 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <Chip
                        selected={runsThisWeek}
                        onClick={() => setRepeat({ ...repeat, anchorDate: ymd(mondayOf(now, 0)) })}
                        className="px-2.5"
                      >
                        이번 주부터
                      </Chip>
                      <Chip
                        selected={!runsThisWeek && runsNextWeek}
                        onClick={() => setRepeat({ ...repeat, anchorDate: ymd(mondayOf(now, 1)) })}
                        className="px-2.5"
                      >
                        다음 주부터
                      </Chip>
                    </div>
                  )}
                </div>
              </Row>
            )}
          </>
        )}

        {repeat.kind === "monthly" && (
          <Row label="날짜">
            <div className="grid max-w-[19rem] grid-cols-7 gap-1">
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => {
                const selected = repeat.dates.includes(d);
                return (
                  <Chip
                    key={d}
                    selected={selected}
                    disabled={!selected && maxDates > 1 && repeat.dates.length >= maxDates}
                    onClick={() => toggleDate(d)}
                    className="num h-7 font-mono text-[12.5px]"
                    label={`${d}일`}
                  >
                    {d}
                  </Chip>
                );
              })}
              <Chip
                selected={repeat.dates.includes(-1)}
                disabled={!repeat.dates.includes(-1) && maxDates > 1 && repeat.dates.length >= maxDates}
                onClick={() => toggleDate(-1)}
                className="col-span-4 h-7"
              >
                말일
              </Chip>
            </div>
          </Row>
        )}

        <Row label={rules.maxTimes > 1 ? `시각 ${value.times.length}/${rules.maxTimes}` : "시각"}>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-x-3 gap-y-1.5">
              {value.times.map((t, i) => (
                <div key={i} className="flex items-center">
                  <Input
                    type="time"
                    value={t}
                    onChange={(e) => setTime(i, e.target.value)}
                    className="num h-8 w-[7.25rem] font-mono text-[13px]"
                    aria-label={`실행 시각 ${i + 1}`}
                  />
                  {rules.maxTimes > 1 && (
                    <IconAction label="이 시각 삭제" onClick={() => removeTime(i)} disabled={value.times.length <= 1}>
                      <X />
                    </IconAction>
                  )}
                </div>
              ))}
            </div>
            {rules.maxTimes > 1 && (
              <Button
                variant="outline"
                size="sm"
                onClick={addTime}
                disabled={value.times.length >= rules.maxTimes}
              >
                <Plus className="h-3.5 w-3.5" /> 시각 추가
              </Button>
            )}
          </div>
        </Row>

        {rules.maxTimes > 1 && (
          <Row label="간격">
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                <Input
                  type="time"
                  value={genStart}
                  onChange={(e) => setGenStart(e.target.value)}
                  className="num h-8 w-[7.25rem] font-mono text-[13px]"
                  aria-label="간격 시작 시각"
                />
                <span className="text-muted-foreground">~</span>
                <Input
                  type="time"
                  value={genEnd}
                  onChange={(e) => setGenEnd(e.target.value)}
                  className="num h-8 w-[7.25rem] font-mono text-[13px]"
                  aria-label="간격 끝 시각"
                />
                <span className="inline-flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={1}
                    max={23}
                    step={1}
                    value={genEvery}
                    onChange={(e) => setGenEvery(e.target.value)}
                    className="num h-8 w-14 font-mono text-[13px]"
                    aria-label="간격(시간)"
                  />
                  <span className="text-muted-foreground">시간 간격</span>
                </span>
                <Button variant="outline" size="sm" onClick={generate}>
                  목록 채우기
                </Button>
              </div>
              <p className="text-[12px] text-muted-foreground">
                시작~끝(끝 포함)을 간격대로 펼쳐 위 시각 목록을 바꿉니다. 끝이 시작보다 이르면 자정을 넘깁니다.
              </p>
              {genErr && <p className="text-[13px] text-tone-error">{genErr}</p>}
            </div>
          </Row>
        )}
      </div>

      {(rules.note || rules.blackout?.length) && (
        <Notice tone="muted" className="mb-0 text-[13px]">
          {rules.note && <p>{rules.note}</p>}
          {rules.blackout?.map((b, i) => (
            <p key={i} className="text-muted-foreground">
              실행 금지: {WEEKDAY_NAME[b.day]}요일 <span className="num font-mono">{b.from}~{b.to}</span> — {b.reason}
            </p>
          ))}
        </Notice>
      )}

      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-t pt-3">
        <div className="min-w-0 flex-1 text-[13px]" aria-live="polite">
          {invalid ? (
            <p className="text-tone-error">{invalid}</p>
          ) : normalized && !normalized.enabled ? (
            <p className="text-muted-foreground">
              꺼짐 — 정시 실행과 누락 보충을 하지 않습니다. &lsquo;지금 갱신&rsquo;은 그대로 됩니다.
            </p>
          ) : normalized ? (
            <>
              <p className="font-medium">{describeSchedule(normalized)}</p>
              {upcoming.length > 0 && (
                <p className="num mt-0.5 text-muted-foreground">
                  다음 실행 {upcoming.map((d) => formatWhen(d, now)).join(" · ")}
                </p>
              )}
            </>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={() => onChange(defaults)} disabled={isDefault}>
          <RotateCcw className="h-3.5 w-3.5" /> 기본값으로
        </Button>
      </div>
    </div>
  );
}
