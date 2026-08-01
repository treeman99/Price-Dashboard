import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "./log.ts";
import type {
  AgentModelFallbackState,
  AgentModelOption,
  AgentModelSettings,
} from "../../shared/types.ts";

/** 사용자 선택 저장 위치 (schedule.json 과 같은 data 디렉터리). */
const STORE_PATH = path.join(path.dirname(config.dbPath), "model.json");

/**
 * 수집/큐레이션 에이전트가 쓸 수 있는 모델 목록.
 *
 * `claude-*`는 Claude Agent SDK, `gpt-*`는 Codex CLI로 라우팅한다.
 * id 는 각 실행기의 모델 옵션에 그대로 전달하므로 풀 모델 ID를 쓴다.
 *
 * ⚠️ 목록 **첫 항목이 기본값**이다(DEFAULT_AGENT_MODEL). 순서를 바꾸면 기본값도 바뀐다.
 *
 * 목록에서 뺀 모델 ID 가 data/model.json 에 남아 있어도 안전하다 — validModel 이 걸러
 * 기본값으로 fail-open 한다.
 */
export const AGENT_MODEL_OPTIONS: AgentModelOption[] = [
  {
    id: "gpt-5.6-sol",
    label: "Codex 5.6 Sol",
    description: "기본값 — ChatGPT 정액제 Codex, 한도 소진 시 Opus 5로 자동 전환",
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    description: "한도 소진 시 자동 전환 대상 — 가장 높은 수집·큐레이션 품질",
  },
  {
    id: "gpt-5.6-terra",
    label: "Codex 5.6 Terra",
    description: "ChatGPT 정액제 Codex — medium 추론, 일상 수집용 균형 모델",
  },
];

/** 기본 모델 = 목록 첫 항목(Codex 5.6 Sol). 주간 복귀도 이 값으로 되돌린다. */
export const DEFAULT_AGENT_MODEL = AGENT_MODEL_OPTIONS[0].id;

/** 평상시 모델. 주간 복귀가 되돌리는 대상. */
export const PRIMARY_AGENT_MODEL = DEFAULT_AGENT_MODEL;

/** 한도 소진 시 자동으로 넘어갈 모델. Codex 와 다른 제공자여야 의미가 있다. */
export const FALLBACK_AGENT_MODEL = "claude-opus-5";

/**
 * 주간 복귀 시각: **수요일(3) 21시**. cron 식과 catch-up 계산이 이 상수를 공유한다.
 *
 * 왜 수요일인가: 이 복귀는 "Codex 주간 한도가 리셋됐으니 기본 모델로 돌아간다"는 뜻이고,
 * 기준이 되는 것은 달력의 주 시작이 아니라 **Codex 쪽 한도 리셋 요일**이다. 처음에는 일요일로
 * 잡았으나 실제 리셋이 수요일이라, 일요일에 복귀하면 한도가 아직 안 찬 상태로 기본 모델에
 * 돌아가 곧바로 폴백으로 튕기는 구간이 생겼다(2026-08-01 정정).
 *
 * ⚠️ 요일을 다시 옮길 때는 이 상수만 바꾸면 된다 — cron 식·catch-up 계산(previousWeeklyResetAt)·
 * 화면 라벨이 전부 여기서 파생된다. node-cron 의 요일 번호와 JS `Date.getDay()` 는 둘 다
 * 0=일요일 체계라 같은 값을 그대로 쓸 수 있다.
 */
export const WEEKLY_RESET_DAY = 3;
export const WEEKLY_RESET_HOUR = 21;
export const WEEKLY_RESET_CRON = `0 ${WEEKLY_RESET_HOUR} * * ${WEEKLY_RESET_DAY}`;
/** 라벨도 상수에서 파생한다 — 요일명을 하드코딩하면 DAY 를 옮길 때 화면만 조용히 어긋난다. */
const WEEKDAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;
export const WEEKLY_RESET_LABEL =
  `${WEEKDAY_NAMES[WEEKLY_RESET_DAY]}요일 ${String(WEEKLY_RESET_HOUR).padStart(2, "0")}:00`;

/** data/model.json 의 스키마. `model` 만 있던 옛 파일도 그대로 읽힌다. */
interface ModelState {
  model: string;
  /** 자동 전환 중이면 그 내역. 수동 선택·주간 복귀 시 null 로 지운다. */
  fallback: AgentModelFallbackState | null;
  /**
   * 마지막 주간 복귀 시각(ISO). 서버가 복귀 예정 시각에 꺼져 있었는지 판정하는 유일한 근거다.
   * null 이면 '아직 한 번도 복귀한 적 없음' 이 아니라 '기준선 미설정' 으로 보고, 즉시 되돌리는
   * 대신 지금 시각을 기준선으로 심는다 — 설치 직후 catch-up 이 사용자의 수동 선택을 덮어쓰지
   * 않게 하려는 것이다.
   */
  lastWeeklyResetAt: string | null;
}

/** id 가 허용 목록에 있으면 그대로, 아니면 null. */
function validModel(id: unknown): string | null {
  return typeof id === "string" && AGENT_MODEL_OPTIONS.some((o) => o.id === id) ? id : null;
}

/** 저장된 fallback 객체를 검증한다. 형태가 깨졌으면 '전환 중 아님'으로 접는다. */
function validFallback(raw: unknown): AgentModelFallbackState | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.from !== "string" || typeof f.at !== "string") return null;
  return { from: f.from, at: f.at, reason: typeof f.reason === "string" ? f.reason : "" };
}

/** 저장 파일에서 상태 로드. 없거나 깨졌거나 미허용 값이면 기본값(수집이 죽지 않게 fail-open). */
function readState(): ModelState {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as Record<string, unknown>;
      return {
        model: validModel(raw?.model) ?? DEFAULT_AGENT_MODEL,
        fallback: validFallback(raw?.fallback),
        lastWeeklyResetAt:
          typeof raw?.lastWeeklyResetAt === "string" ? raw.lastWeeklyResetAt : null,
      };
    }
  } catch (e) {
    log.warn(`model.json 읽기 실패 → 기본 모델 사용: ${(e as Error).message}`);
  }
  return { model: DEFAULT_AGENT_MODEL, fallback: null, lastWeeklyResetAt: null };
}

function writeState(state: ModelState): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2), "utf8");
}

/**
 * 현재 유효 모델 ID. 각 수집/큐레이션 실행 시작 시 호출해 최신 선택을 반영한다
 * (스케줄과 동일하게 파일에서 매번 새로 읽어, 서버 재시작 없이 **다음 수집부터** 적용).
 */
export function getAgentModel(): string {
  return readState().model;
}

/** GET 응답용: 현재 모델 + 선택지 목록 + 자동 전환 상태. */
export function getModelSettings(): AgentModelSettings {
  const state = readState();
  return {
    model: state.model,
    options: AGENT_MODEL_OPTIONS,
    primary: PRIMARY_AGENT_MODEL,
    fallbackModel: FALLBACK_AGENT_MODEL,
    fallback: state.fallback,
    weeklyResetLabel: WEEKLY_RESET_LABEL,
  };
}

/**
 * 모델 선택 저장. 허용 목록에 없는 id 면 throw(→ 라우트 400).
 *
 * 수동 선택은 자동 전환 상태를 **해제**한다. 그러지 않으면 사용자가 직접 Codex 로 되돌린 뒤에도
 * UI 에 "한도 소진으로 전환됨" 배지가 남아 현재 상태를 잘못 설명한다.
 */
export function saveAgentModel(id: unknown): AgentModelSettings {
  const model = validModel(id);
  if (!model) {
    const allowed = AGENT_MODEL_OPTIONS.map((o) => o.id).join(", ");
    throw new Error(`허용되지 않은 모델입니다. 가능한 값: ${allowed}`);
  }
  const state = readState();
  writeState({ ...state, model, fallback: null });
  log.info(`수집·큐레이션 에이전트 변경: ${model}`);
  return getModelSettings();
}

/**
 * 한도 소진 감지 → 대체 모델로 자동 전환하고 그 사실을 기록한다.
 *
 * 반환값은 '이 호출이 실제로 모델을 바꿨는지'다. 이미 대체 모델을 쓰고 있으면 아무것도 하지
 * 않고 false — 같은 전환을 반복 기록하면 `at`(최초 전환 시각)이 계속 밀려 언제부터 한도에
 * 걸렸는지 알 수 없게 된다.
 */
export function recordUsageLimitFallback(fromModel: string, reason: string): boolean {
  const state = readState();
  if (state.model === FALLBACK_AGENT_MODEL) return false;
  writeState({
    ...state,
    model: FALLBACK_AGENT_MODEL,
    fallback: {
      from: fromModel,
      at: new Date().toISOString(),
      reason: reason.slice(0, 300),
    },
  });
  log.warn(
    `${fromModel} 한도 소진 감지 → 수집·큐레이션 모델을 ${FALLBACK_AGENT_MODEL} 로 자동 전환 ` +
      `(${WEEKLY_RESET_LABEL} 에 ${PRIMARY_AGENT_MODEL} 로 자동 복귀). 사유: ${reason.slice(0, 200)}`
  );
  return true;
}

/**
 * 주간 복귀: 기본 모델로 되돌리고 복귀 시각을 남긴다.
 *
 * 사용자가 수동으로 다른 모델을 골라 뒀어도 되돌린다 — "매주 한도 리셋 시각에 다시 기본
 * 모델로"가 이 기능의 요구사항 자체이기 때문이다. 되돌릴 게 없으면 시각만 갱신한다(그래야
 * catch-up 이 같은 주에 재발화하지 않는다).
 */
export function restoreWeeklyPrimary(trigger: string): boolean {
  const state = readState();
  const changed = state.model !== PRIMARY_AGENT_MODEL;
  writeState({
    model: PRIMARY_AGENT_MODEL,
    fallback: null,
    lastWeeklyResetAt: new Date().toISOString(),
  });
  if (changed) {
    log.info(
      `주간 복귀[${trigger}]: 수집·큐레이션 모델 ${state.model} → ${PRIMARY_AGENT_MODEL}`
    );
  } else {
    log.info(`주간 복귀[${trigger}]: 이미 ${PRIMARY_AGENT_MODEL} — 복귀 시각만 갱신`);
  }
  return changed;
}

/**
 * `now` 기준으로 **가장 최근에 지난** 주간 복귀 시각(WEEKLY_RESET_DAY 요일 21:00)을 구한다.
 * catch-up 판정에만 쓰이므로 순수 함수로 분리해 테스트로 못박는다.
 */
export function previousWeeklyResetAt(now: Date): Date {
  const d = new Date(now);
  d.setHours(WEEKLY_RESET_HOUR, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - WEEKLY_RESET_DAY + 7) % 7));
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 7);
  return d;
}

/**
 * 주간 복귀 catch-up: 서버가 복귀 예정 시각에 꺼져 있었으면 켜진 뒤에 1회 보충한다.
 *
 * 기준선(lastWeeklyResetAt)이 없으면 **되돌리지 않고 지금 시각만 심는다.** 설치·업데이트 직후
 * 첫 기동에서 사용자의 수동 선택을 말없이 덮어쓰는 것이 이 기능의 유일한 오작동 시나리오라,
 * 그 한 번을 명시적으로 비운다.
 */
export function checkWeeklyResetCatchup(now: Date = new Date()): boolean {
  const state = readState();
  if (!state.lastWeeklyResetAt) {
    writeState({ ...state, lastWeeklyResetAt: now.toISOString() });
    return false;
  }
  const last = new Date(state.lastWeeklyResetAt);
  const due = previousWeeklyResetAt(now);
  if (Number.isNaN(last.getTime()) || last.getTime() >= due.getTime()) return false;
  log.info(
    `주간 복귀 누락 감지 (마지막 ${state.lastWeeklyResetAt}, 예정 ${due.toISOString()}) → catch-up 실행`
  );
  restoreWeeklyPrimary("catchup");
  return true;
}
