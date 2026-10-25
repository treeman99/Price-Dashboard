import type {
  DeepPartial,
  JobSchedule,
  NotifyChannel,
  NotifyTabId,
  NumberRule,
  ScheduleConfig,
  ScheduleJobId,
  TabSettings,
} from "@shared/types";
// ⚠️ 별칭(@shared) 대신 상대 경로: 이 파일의 단위 테스트는 루트에서 tsx 로 도는데(npm test), 루트 tsconfig 에는
//    web 의 paths 별칭이 없어 런타임 import 를 못 푼다(타입 import 는 지워져서 괜찮다). 가리키는 파일은 같다.
import { mondayOf } from "../../../shared/schedule";

/**
 * 탭 ↔ '자동 수집·설정' 다이얼로그 내용 매핑과, 그 다이얼로그가 쓰는 작은 순수 함수들.
 *
 * ⚠️ 스케줄의 표시 문구·다음 실행·검증·간격 펼치기는 여기서 다시 만들지 않는다 —
 *    서버와 같은 `@shared/schedule` 을 쓴다(docs/customization-contract.md §3).
 *    여기 있는 건 화면에만 필요한 것(무엇을 어느 탭에 보이나, 바꾼 값만 골라 본문 만들기, 날짜 표기)뿐이다.
 */

/** App.tsx 의 탭 id 와 같다. */
export type ConfigTabId = "news" | "youtube" | "skills" | "stock" | "events" | "holdings" | "lotto";

export type SettingField =
  /** 숫자. 범위·단위는 응답의 numberRules[path] 가 정본이다. */
  | { kind: "number"; path: string; label: string; hint?: string }
  | { kind: "boolean"; path: string; label: string; hint?: string }
  /** 펄스 알림 문턱(긴급/중요/참고). */
  | { kind: "severity"; path: string; label: string; hint?: string };

export interface TabConfigDef {
  label: string;
  /** 이 탭의 스케줄 잡(증시는 시장별 브리핑 2개). */
  jobs: ScheduleJobId[];
  /** 이 탭의 알림 주체. 로또는 알림이 없다. */
  notify: NotifyTabId | null;
  /** 운영 설정 필드(TabSettings 의 점 경로). 알림 스위치는 notify 로 따로 그린다. */
  fields: SettingField[];
}

const TIMEOUT_HINT = "AI 실행 1회가 이보다 길면 중단합니다. 다음 실행부터 적용됩니다.";

export const TAB_CONFIG: Record<ConfigTabId, TabConfigDef> = {
  news: {
    label: "뉴스",
    jobs: ["news"],
    notify: "news",
    fields: [{ kind: "number", path: "timeouts.newsMin", label: "수집 최대 대기", hint: TIMEOUT_HINT }],
  },
  youtube: {
    label: "유튜브 소식",
    jobs: ["youtube"],
    notify: "youtube",
    fields: [
      { kind: "number", path: "youtube.freshDays", label: "최근 영상 기준", hint: "이 기간 안에 게시된 영상만 채택합니다." },
      {
        kind: "number",
        path: "youtube.watchedExcludeDays",
        label: "본영상 제외 기간",
        hint: "'본영상' 체크한 영상을 이 기간 동안 수집에서 뺍니다.",
      },
      { kind: "number", path: "timeouts.youtubeMin", label: "수집 최대 대기", hint: TIMEOUT_HINT },
    ],
  },
  skills: {
    label: "스킬 랭킹",
    jobs: ["skills"],
    notify: "skills",
    fields: [
      { kind: "number", path: "timeouts.skillsSummaryMin", label: "요약 배치 최대 대기", hint: TIMEOUT_HINT },
      {
        kind: "number",
        path: "timeouts.skillsBudgetMin",
        label: "요약 전체 예산",
        hint: "넘으면 남은 저장소는 요약 없이 원문 설명으로 보여 줍니다.",
      },
    ],
  },
  stock: {
    label: "증시",
    jobs: ["stockKr", "stockUs"],
    notify: "stock",
    fields: [
      { kind: "number", path: "timeouts.stockBriefMin", label: "브리핑 최대 대기", hint: TIMEOUT_HINT },
      {
        kind: "number",
        path: "stock.historyRetentionDays",
        label: "시세 이력 보존",
        hint: "이보다 오래된 증시 시계열은 매일 04:30 정리합니다.",
      },
    ],
  },
  events: {
    label: "팝업·전시",
    jobs: ["events"],
    notify: "events",
    fields: [
      {
        kind: "number",
        path: "events.newGapDays",
        label: "'신규' 판정 공백",
        hint: "이 기간 이상 안 보이다 다시 나오면 신규로 봅니다.",
      },
      { kind: "number", path: "events.newShowDays", label: "'신규' 배지 유지", hint: "신규 배지를 이 기간 동안 붙여 둡니다." },
      {
        kind: "boolean",
        path: "events.verifyDates",
        label: "종료 날짜 검증",
        hint: "종료된 행사를 원문 날짜로 한 번 더 확인합니다.",
      },
      { kind: "number", path: "timeouts.eventsMin", label: "수집 최대 대기", hint: TIMEOUT_HINT },
    ],
  },
  holdings: {
    label: "보유 주식",
    jobs: ["stockPulse"],
    notify: "stockPulse",
    fields: [
      { kind: "number", path: "stockPulse.perSymbolCap", label: "종목당 하루 상한", hint: "종목 1개당 하루 최대 알림 건수." },
      { kind: "number", path: "stockPulse.dailyCap", label: "하루 전체 상한", hint: "종목 알림을 합친 하루 최대 건수." },
      { kind: "number", path: "stockPulse.macroCap", label: "거시·섹터 상한", hint: "종목 상한과 별도로 하루 이만큼." },
      { kind: "number", path: "stockPulse.dedupHours", label: "중복 차단 시간", hint: "같은 이슈는 이 시간 동안 다시 보내지 않습니다(강도가 오르면 예외)." },
      { kind: "severity", path: "stockPulse.threshold", label: "알림 문턱", hint: "이 강도 미만은 기록만 남기고 보내지 않습니다." },
      { kind: "number", path: "stockPulse.quietStartHour", label: "조용 시간 시작", hint: "이 시각부터는 긴급만 즉시 보냅니다." },
      { kind: "number", path: "stockPulse.quietEndHour", label: "조용 시간 끝", hint: "보류한 알림을 이 시각에 묶어서 보냅니다." },
      { kind: "number", path: "timeouts.stockPulseMin", label: "취합 최대 대기", hint: TIMEOUT_HINT },
    ],
  },
  lotto: {
    label: "로또",
    jobs: ["lotto"],
    notify: null,
    fields: [],
  },
};

export const CHANNEL_LABEL: Record<NotifyChannel, string> = {
  email: "이메일",
  imessage: "iMessage",
};

/**
 * 화면에 수동 실행 버튼이 있는 잡 → 그 버튼 이름(각 Board 의 실제 문구). 스케줄 '꺼짐' 안내에서
 * "수동으로는 그대로 된다"를 알릴 때만 쓴다. 로또는 화면 수동 실행이 없어 빠져 있다
 * (LottoBoard 의 [새로고침]은 저장된 결과를 다시 읽을 뿐 사이클을 돌리지 않는다).
 */
export const MANUAL_RUN_LABEL: Partial<Record<ScheduleJobId, string>> = {
  events: "지금 갱신",
  news: "지금 갱신",
  youtube: "지금 갱신",
  stockKr: "지금 갱신",
  stockUs: "지금 갱신",
  stockPulse: "지금 실행", // 보유 주식 탭
  skills: "지금 갱신",
};

// ── 점 경로 읽기/쓰기 ─────────────────────────────────────────────────────────

/** "youtube.freshDays" 처럼 점 경로로 값을 읽는다. 없으면 undefined. */
export function getAtPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** 점 경로에 값을 넣은 **새** 객체를 돌려준다(원본 불변). 중간 객체가 없으면 만든다. */
export function setAtPath<T extends object>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const src = obj as Record<string, unknown>;
  if (rest.length === 0) return { ...src, [head]: value } as T;
  const child = src[head];
  const base = child != null && typeof child === "object" ? (child as object) : {};
  return { ...src, [head]: setAtPath(base, rest.join("."), value) } as T;
}

// ── 저장 본문 만들기(바꾼 것만) ───────────────────────────────────────────────

/** 키 순서와 무관한 비교용 직렬화. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v != null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function sameValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

/**
 * 바뀐 잡만 담은 PUT /api/schedule 본문. 서버는 잡 단위로 통째로 교체하므로 잡 전체를 넣는다.
 * 바뀐 게 없으면 null.
 */
export function buildSchedulePatch(
  original: ScheduleConfig,
  next: Partial<Record<ScheduleJobId, JobSchedule>>
): Partial<ScheduleConfig> | null {
  const patch: Partial<ScheduleConfig> = {};
  for (const id of Object.keys(next) as ScheduleJobId[]) {
    const job = next[id];
    if (job && !sameValue(job, original[id])) patch[id] = job;
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * 탭 하나의 운영 설정 초안에서 **바뀐 필드만** 담은 PUT /api/settings 본문(DeepPartial).
 * 알림은 그 탭에 실제로 있는 채널(channels)만 본다 — 없는 채널은 서버가 어차피 무시한다.
 * 바뀐 게 없으면 null.
 */
export function buildSettingsPatch(
  original: TabSettings,
  draft: TabSettings,
  def: Pick<TabConfigDef, "fields" | "notify">,
  channels: NotifyChannel[]
): DeepPartial<TabSettings> | null {
  let patch: DeepPartial<TabSettings> = {};
  let changed = false;
  for (const f of def.fields) {
    const v = getAtPath(draft, f.path);
    if (!sameValue(v, getAtPath(original, f.path))) {
      patch = setAtPath(patch, f.path, v);
      changed = true;
    }
  }
  if (def.notify) {
    for (const ch of channels) {
      const path = `notify.${def.notify}.${ch}`;
      const v = getAtPath(draft, path);
      if (!sameValue(v, getAtPath(original, path))) {
        patch = setAtPath(patch, path, v);
        changed = true;
      }
    }
  }
  return changed ? patch : null;
}

/**
 * 숫자 입력(문자열) 검증. 통과하면 숫자, 아니면 한국어 사유.
 * 범위는 서버 numberRules 가 정본이라 그대로 쓴다(규칙이 없으면 숫자인지만 본다).
 * 서버는 정수만 받는다(src/settings/tab-settings.ts) — 1.5일 같은 값은 여기서 먼저 막는다.
 */
export function parseNumberField(
  raw: string,
  label: string,
  rule: NumberRule | undefined
): { ok: true; value: number } | { ok: false; error: string } {
  const t = raw.trim();
  const n = t === "" ? NaN : Number(t);
  if (!Number.isFinite(n)) return { ok: false, error: `${label}: 숫자를 입력하세요.` };
  if (!Number.isInteger(n) || (rule && (n < rule.min || n > rule.max))) {
    const range = rule ? `${rule.min}~${rule.max}${rule.unit} 사이의 ` : "";
    return { ok: false, error: `${label}: ${range}정수로 입력하세요.` };
  }
  return { ok: true, value: n };
}

// ── 날짜 ──────────────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 로컬 날짜 → "YYYY-MM-DD". */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** now 가 속한 주(월요일 시작)의 월요일 + weekOffset 주(00:00 로컬). 격주 판정과 같은 계산이라 서버 것을 그대로 쓴다. */
export { mondayOf };

/** 그 주의 7일(월~일). */
export function weekDays(now: Date, weekOffset = 0): Date[] {
  const mon = mondayOf(now, weekOffset);
  return Array.from({ length: 7 }, (_, i) => new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i));
}

const WEEKDAY_SHORT = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * 다음 실행 시각 표기. 오늘·내일은 말로, 그 밖은 "10/28(화) 08:00".
 * 해가 바뀌는 날짜면(연말의 격주·매월) 연도를 붙인다.
 */
export function formatWhen(at: Date, now: Date): string {
  const hm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const dayDiff = Math.round(
    (new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86_400_000
  );
  if (dayDiff === 0) return `오늘 ${hm}`;
  if (dayDiff === 1) return `내일 ${hm}`;
  const md = `${at.getMonth() + 1}/${at.getDate()}(${WEEKDAY_SHORT[at.getDay()]})`;
  return at.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${at.getFullYear()}. ${md} ${hm}`;
}
