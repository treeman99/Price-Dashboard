import fs from "node:fs";
import path from "node:path";
import { config, parseCollectTime } from "../config.ts";
import { log } from "../util/log.ts";
import type { ScheduleSettings } from "../../shared/types.ts";

/** 사용자 변경분 저장 위치 (카테고리 설정과 동일한 data 디렉터리). */
const STORE_PATH = path.join(path.dirname(config.dbPath), "schedule.json");

/**
 * .env 기반 기본값(모두 시각 배열). 설정 파일이 없거나 항목이 비정상일 때 사용.
 * .env 값이 "9:00"처럼 zero-pad 안 됐어도 정규화해, GET 결과가 항상 "HH:mm"이 되게 한다
 * (그래야 프론트 <input type=time>가 표시할 수 있다). config 값은 기동 시 형식 검증됨.
 */
function defaults(): ScheduleSettings {
  return {
    price: normalizeList([config.collectTime]),
    events: normalizeList([config.eventsCollectTime]),
    news: normalizeList(config.newsCollectTimes),
    youtube: normalizeList(config.youtubeCollectTimes),
  };
}

/**
 * HH:mm 형식·범위 검증 + 정규화(zero-pad). "9:00"→"09:00" 처럼 표기가 달라도
 * 같은 시각이면 같은 문자열로 만들어 중복 등록을 막는다. 형식 오류면 throw.
 */
function normalizeTime(t: string): string {
  const { hour, minute } = parseCollectTime(String(t)); // 형식/범위 오류 시 throw
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** 정규화 + 중복 제거(정규화 후 기준). */
function normalizeList(times: string[]): string[] {
  return Array.from(new Set(times.map(normalizeTime)));
}

/** 복수 시각 관대 정규화: 유효·정규화된 것만, 하나도 없으면 fallback. (읽기 경로 — throw 안 함) */
function lenientMulti(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const times: string[] = [];
  for (const t of v) {
    try {
      times.push(normalizeTime(String(t)));
    } catch {
      /* 잘못된 항목은 조용히 스킵 */
    }
  }
  const unique = Array.from(new Set(times));
  return unique.length ? unique : fallback;
}

/** 복수 시각 엄격 검증: 하나라도 형식 오류면 throw, 빈 목록도 거부. (쓰기 경로) */
function strictMulti(v: unknown, label: string): string[] {
  if (!Array.isArray(v)) throw new Error(`${label}: 시간 배열이 필요합니다.`);
  const times = normalizeList(v.map((t) => String(t)));
  if (times.length === 0) throw new Error(`${label}: 최소 1개 시간이 필요합니다.`);
  return times;
}

/** JSON.parse 결과가 '평범한 객체'일 때만 그대로, 아니면(배열/스칼라/null) 빈 객체. */
function asPlainObject(v: unknown): Partial<ScheduleSettings> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Partial<ScheduleSettings>) : {};
}

/** 저장 파일의 원본(사용자가 명시적으로 바꾼 필드만) 로드. 없거나 깨졌으면 빈 객체. */
function readStored(): Partial<ScheduleSettings> {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return asPlainObject(JSON.parse(fs.readFileSync(STORE_PATH, "utf8")));
    }
  } catch (e) {
    log.warn(`schedule.json 읽기 실패 → 기본값 사용: ${(e as Error).message}`);
  }
  return {};
}

/**
 * 현재 유효 스케줄. 저장 파일(부분 override) 위에 .env 기본값을 병합.
 * 파일이 깨졌거나 없어도 항상 유효한 값을 반환(스케줄러가 죽지 않게).
 * 저장 파일에 없는 필드는 계속 .env 를 따른다.
 */
export function getSchedule(): ScheduleSettings {
  const def = defaults();
  const raw = readStored();
  return {
    price: lenientMulti(raw.price, def.price),
    events: lenientMulti(raw.events, def.events),
    news: lenientMulti(raw.news, def.news),
    youtube: lenientMulti(raw.youtube, def.youtube),
  };
}

/**
 * 부분 수정 저장. 전달된 필드만 저장 파일에 override 로 기록하고(sparse), 나머지는
 * .env 를 계속 따르게 둔다. HH:mm 유효성을 엄격 검증·정규화(형식 오류 시 throw → 라우트 400).
 * 성공 시 최종(병합) 설정 반환.
 */
export function saveSchedule(patch: Partial<ScheduleSettings>): ScheduleSettings {
  const stored = readStored();

  if (patch.price !== undefined) stored.price = strictMulti(patch.price, "price");
  if (patch.events !== undefined) stored.events = strictMulti(patch.events, "events");
  if (patch.news !== undefined) stored.news = strictMulti(patch.news, "news");
  if (patch.youtube !== undefined) stored.youtube = strictMulti(patch.youtube, "youtube");

  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(stored, null, 2), "utf8");
  return getSchedule();
}
