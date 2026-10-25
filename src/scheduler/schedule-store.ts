import fs from "node:fs";
import path from "node:path";
import { config, parseCollectTime } from "../config.ts";
import { log } from "../util/log.ts";
import {
  SCHEDULE_JOB_IDS,
  SCHEDULE_RULES,
  nextOccurrence,
  normalizeJobSchedule,
  toLocalIso,
} from "../../shared/schedule.ts";
import type {
  JobSchedule,
  ScheduleConfig,
  ScheduleJobId,
  ScheduleResponse,
} from "../../shared/types.ts";

/** 사용자 변경분 저장 위치 (카테고리 설정과 동일한 data 디렉터리). */
const STORE_PATH = path.join(path.dirname(config.dbPath), "schedule.json");

/**
 * 주간 잡의 기본값. 예전에는 cron 상수(src/lotto/cycle.ts 의 LOTTO_CYCLE_* ·
 * shared/skills.ts 의 SKILLS_CYCLE_*)가 정본이었다 — 값은 그대로(사용자 지시 시각) 옮겼다.
 * cycle.ts 를 import 하지 않는 이유: cycle.ts 가 이 모듈을 읽으므로 순환이 된다.
 */
export const DEFAULT_SKILLS_SCHEDULE: JobSchedule = {
  enabled: true,
  repeat: { kind: "weekly", days: [1], intervalWeeks: 1 }, // 월요일
  times: ["09:00"],
};
export const DEFAULT_LOTTO_SCHEDULE: JobSchedule = {
  enabled: true,
  repeat: { kind: "weekly", days: [0], intervalWeeks: 1 }, // 일요일
  times: ["10:00"],
};

/**
 * 읽기 경로에서 격주 기준일(anchorDate)이 빠진 저장값을 만났을 때 쓰는 **고정** 기준.
 *
 * ⚠️ normalizeJobSchedule 은 기준일이 비면 `now` 의 날짜로 채운다(쓰기 경로용 규칙). 읽을 때마다
 * 오늘 날짜를 넣으면 매일 기준 주가 바뀌어 '쉬는 주'와 '도는 주'가 하루 단위로 뒤집힌다.
 * 저장(PUT)은 항상 기준일을 채우므로 정상 경로에서는 쓰이지 않는다 — 손으로 고친 파일 방어선이다.
 */
const READ_ANCHOR_NOW = new Date(2026, 0, 5); // 2026-01-05(월)

/** 유효한 시각만 zero-pad 정규화·중복 제거·오름차순으로(읽기 경로 — throw 안 함). */
function lenientTimes(v: unknown[]): string[] {
  const out = new Set<string>();
  for (const t of v) {
    try {
      const { hour, minute } = parseCollectTime(String(t));
      out.add(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
    } catch {
      /* 잘못된 항목은 조용히 스킵 */
    }
  }
  return [...out].sort();
}

/**
 * .env 시각 목록 → 매일 스케줄. config.ts 가 기동 시 HH:mm 형식을 이미 검증했지만, 개수 상한
 * (rules.maxTimes)은 모른다 — 그 경우에도 기본값 계산이 서버를 죽이면 안 되므로 상한 없이 쓴다.
 */
function envDaily(id: ScheduleJobId, times: string[]): JobSchedule {
  try {
    return normalizeJobSchedule(times, id);
  } catch (e) {
    warnOnce(`.env 의 ${id} 기본 시각이 제약을 벗어남(그대로 사용): ${(e as Error).message}`);
    return { enabled: true, repeat: { kind: "daily" }, times: lenientTimes(times) };
  }
}

/**
 * .env 기반 기본값. events/news/youtube/증시 3종은 '매일 .env 시각'(v1 과 같은 동작),
 * 스킬 랭킹·로또는 기존 주간 cron 과 같은 시각이다.
 */
function defaults(): ScheduleConfig {
  return {
    events: envDaily("events", [config.eventsCollectTime]),
    news: envDaily("news", config.newsCollectTimes),
    youtube: envDaily("youtube", config.youtubeCollectTimes),
    stockKr: envDaily("stockKr", config.stockKrCollectTimes),
    stockUs: envDaily("stockUs", config.stockUsCollectTimes),
    stockPulse: envDaily("stockPulse", config.stockPulseTimes),
    skills: DEFAULT_SKILLS_SCHEDULE,
    lotto: DEFAULT_LOTTO_SCHEDULE,
  };
}

/**
 * 같은 경고를 한 번만 남긴다. getSchedule() 은 30분 틱·증시 런·누락 집계마다 불려서, 깨진 저장값
 * 하나가 하루 수백 줄의 같은 경고로 로그를 덮는다.
 */
const warned = new Set<string>();
function warnOnce(msg: string) {
  if (warned.has(msg)) return;
  warned.add(msg);
  log.warn(msg);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 저장 파일의 원본(사용자가 명시적으로 바꾼 잡만) 로드. 없거나 깨졌으면 빈 객체. */
function readStored(): Record<string, unknown> {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
      return isPlainObject(parsed) ? parsed : {};
    }
  } catch (e) {
    warnOnce(`schedule.json 읽기 실패 → 기본값 사용: ${(e as Error).message}`);
  }
  return {};
}

/**
 * 저장값 1건을 관대하게 읽는다(읽기 경로 — throw 안 함).
 *
 * - v1(시각 배열, 실제 data/schedule.json 형식) → 매일 + 그 시각들.
 * - v2 객체 → 엄격 정규화를 그대로 통과시킨다(금지 구간·개수 상한도 여기서 다시 지킨다 —
 *   손으로 고친 파일이 로또를 토요일 21시에 돌게 만들면 안 된다).
 * - 실패하면 깨진 **시각 항목만** 걸러 한 번 더 해 보고(v1 시절 lenientMulti 와 같은 관용도),
 *   그래도 안 되면 그 잡만 기본값이다. 파일 하나가 깨져도 스케줄러는 죽지 않는다.
 */
function lenientJob(raw: unknown, id: ScheduleJobId, fallback: JobSchedule): JobSchedule {
  if (raw === undefined) return fallback;
  try {
    return normalizeJobSchedule(raw, id, READ_ANCHOR_NOW);
  } catch {
    /* 아래에서 구제 시도 */
  }
  try {
    const salvaged = Array.isArray(raw)
      ? lenientTimes(raw)
      : isPlainObject(raw) && Array.isArray(raw.times)
        ? { ...raw, times: lenientTimes(raw.times) }
        : raw;
    return normalizeJobSchedule(salvaged, id, READ_ANCHOR_NOW);
  } catch (e) {
    warnOnce(`schedule.json 의 ${id} 값이 올바르지 않아 기본값을 씁니다: ${(e as Error).message}`);
    return fallback;
  }
}

/**
 * 현재 유효 스케줄. 저장 파일(잡 단위 override) 위에 .env 기본값을 병합.
 * 파일이 깨졌거나 없어도 항상 유효한 값을 반환한다(스케줄러가 죽지 않게).
 * 저장 파일에 없는 잡은 계속 .env 를 따른다. 호출마다 파일을 다시 읽는다(캐시 없음).
 */
export function getSchedule(): ScheduleConfig {
  const def = defaults();
  const raw = readStored();
  const out = {} as ScheduleConfig;
  for (const id of SCHEDULE_JOB_IDS) out[id] = lenientJob(raw[id], id, def[id]);
  return out;
}

/** 정규화된 두 스케줄이 같은가(키 순서가 같은 정규형이라 직렬화 비교로 충분하다). */
function sameJob(a: JobSchedule, b: JobSchedule): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 잡 단위 전체 교체 저장. 전달된 잡만 저장 파일에 override 로 기록하고(sparse), 나머지는
 * 그대로 둔다(v1 배열로 남아 있는 잡도 손대지 않는다 — 읽기가 호환한다).
 *
 * 쓰기는 엄격하다: 모르는 잡 이름·형식 오류·제약 위반이면 **아무것도 쓰지 않고** throw
 * (라우트가 400 으로 돌려준다). v1 배열이 와도 매일 스케줄로 받아 준다.
 * 정규화 결과가 .env 기본값과 같으면 override 를 지운다 — 화면의 '기본값으로 되돌리기'가
 * 기본값을 그대로 PUT 하면, 그 잡은 다시 .env 를 따르게 된다.
 *
 * @returns 최종(병합) 스케줄
 */
export function saveSchedule(patch: Partial<ScheduleConfig>, now: Date = new Date()): ScheduleConfig {
  if (!isPlainObject(patch)) {
    throw new Error("스케줄 변경 내용은 { 잡 이름: 스케줄 } 형식의 객체여야 합니다.");
  }
  const unknownKeys = Object.keys(patch).filter(
    (k) => !(SCHEDULE_JOB_IDS as readonly string[]).includes(k)
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `알 수 없는 스케줄 항목: ${unknownKeys.join(", ")} (가능: ${SCHEDULE_JOB_IDS.join(", ")})`
    );
  }

  // 전부 검증한 뒤에 쓴다 — 두 번째 잡에서 실패하면 첫 번째 잡도 저장되지 않는다.
  const normalized: Partial<ScheduleConfig> = {};
  for (const id of SCHEDULE_JOB_IDS) {
    const v = (patch as Record<string, unknown>)[id];
    if (v !== undefined) normalized[id] = normalizeJobSchedule(v, id, now);
  }

  const def = defaults();
  const stored = readStored();
  for (const [id, job] of Object.entries(normalized) as [ScheduleJobId, JobSchedule][]) {
    if (sameJob(job, def[id])) delete stored[id];
    else stored[id] = job;
  }

  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(stored, null, 2), "utf8");
  return getSchedule();
}

/** GET/PUT /api/schedule 응답. next 는 로컬 오프셋 ISO, 꺼진 잡은 null. */
export function getScheduleResponse(now: Date = new Date()): ScheduleResponse {
  const schedule = getSchedule();
  const next = {} as Record<ScheduleJobId, string | null>;
  for (const id of SCHEDULE_JOB_IDS) {
    const at = nextOccurrence(schedule[id], now);
    next[id] = at ? toLocalIso(at) : null;
  }
  return { schedule, defaults: defaults(), rules: SCHEDULE_RULES, next };
}
