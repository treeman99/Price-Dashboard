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
    description: "기본값 — ChatGPT 정액제 Codex, 못 쓰는 동안만 Opus 5로 임시 대체",
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    description: "Codex를 못 쓸 때 대신 실행 — 가장 높은 수집·큐레이션 품질",
  },
  {
    id: "gpt-5.6-terra",
    label: "Codex 5.6 Terra",
    description: "ChatGPT 정액제 Codex — medium 추론, 일상 수집용 균형 모델",
  },
];

/** 기본 모델 = 목록 첫 항목(Codex 5.6 Sol). */
export const DEFAULT_AGENT_MODEL = AGENT_MODEL_OPTIONS[0].id;

/** 평상시 모델. 저장된 선택이 없을 때의 값이자 UI 의 '기본' 표식. */
export const PRIMARY_AGENT_MODEL = DEFAULT_AGENT_MODEL;

/** Codex 를 쓸 수 없을 때 대신 실행할 모델. Codex 와 다른 제공자여야 의미가 있다. */
export const FALLBACK_AGENT_MODEL = "claude-opus-5";

/**
 * data/model.json 의 스키마.
 *
 * ⚠️ `model` 은 **사용자가 고른 값 하나뿐**이다. 자동 대체는 이 값을 절대 덮어쓰지 않는다 —
 * 예전에는 한도 소진 시 여기를 Opus 로 바꿔 놓고 주간 cron(수요일 21:00)이 되돌렸는데,
 * 그 복귀 시각에 맥이 꺼져 있거나 Codex 가 예정보다 일찍/늦게 살아나면 선택이 실제 상태와
 * 어긋난 채 남았다(2026-08-01: Codex 로그인이 초기화되자 그대로 수집이 죽었다).
 * 지금은 실행할 때마다 Codex 를 확인해 그 실행만 대체하므로 복귀에 달력이 필요 없다.
 *
 * `model` 만 있던 옛 파일, `lastWeeklyResetAt` 이 남은 파일도 그대로 읽힌다(무시).
 */
interface ModelState {
  model: string;
  /** 지금 Codex 를 못 써서 대체 실행 중이면 그 내역. 다시 성공하면 null 로 지운다. */
  fallback: AgentModelFallbackState | null;
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
      const fallback = validFallback(raw?.fallback);
      let model = validModel(raw?.model) ?? DEFAULT_AGENT_MODEL;
      // 옛 스키마 이관: 예전 자동 전환은 `model` 자체를 대체 모델로 덮어썼고 주간 cron 이
      // 되돌렸다. 그 cron 이 사라졌으므로 남아 있는 덮어쓰기를 원래 선택(fallback.from)으로
      // 돌려놓는다 — 그러지 않으면 고른 적 없는 Opus 5 에 영원히 눌러앉는다.
      // (수동 선택은 fallback 을 null 로 지우므로 사용자가 직접 고른 Opus 는 여기 걸리지 않는다.)
      if (fallback && model === FALLBACK_AGENT_MODEL) {
        model = validModel(fallback.from) ?? model;
      }
      return { model, fallback };
    }
  } catch (e) {
    log.warn(`model.json 읽기 실패 → 기본 모델 사용: ${(e as Error).message}`);
  }
  return { model: DEFAULT_AGENT_MODEL, fallback: null };
}

function writeState(state: ModelState): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2), "utf8");
}

/**
 * 사용자가 고른 모델 ID. 각 수집/큐레이션 실행 시작 시 호출해 최신 선택을 반영한다
 * (스케줄과 동일하게 파일에서 매번 새로 읽어, 서버 재시작 없이 **다음 수집부터** 적용).
 *
 * ⚠️ 이건 '선택'이지 '이번 실행에 실제로 쓰인 모델'이 아니다. Codex 를 고른 상태에서 Codex 가
 * 죽어 있으면 runAgentQueryText 가 그 실행만 FALLBACK_AGENT_MODEL 로 돌린다(agent-query.ts).
 */
export function getAgentModel(): string {
  return readState().model;
}

/** GET 응답용: 현재 선택 + 선택지 목록 + 임시 대체 상태. */
export function getModelSettings(): AgentModelSettings {
  const state = readState();
  return {
    model: state.model,
    options: AGENT_MODEL_OPTIONS,
    primary: PRIMARY_AGENT_MODEL,
    fallbackModel: FALLBACK_AGENT_MODEL,
    fallback: state.fallback,
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
 * Codex 를 못 쓴다는 사실을 기록한다(로그인 초기화·CLI 없음·정액제 한도 소진).
 *
 * **선택 모델은 건드리지 않는다.** 실제 대체는 실행 시점에 한 번만 일어나고(agent-query),
 * 여기 남는 건 화면에 "지금 왜 Opus 로 돌고 있는지"를 설명할 근거뿐이다.
 *
 * 반환값은 '이번이 첫 기록인지'. 같은 모델에 대한 기록이 이미 있으면 `at`(처음 막힌 시각)을
 * 보존하고 사유만 갱신한다 — 매 실행마다 `at` 을 밀면 언제부터 막혔는지 알 수 없게 된다.
 */
export function recordCodexFallback(fromModel: string, reason: string): boolean {
  const state = readState();
  const first = state.fallback?.from !== fromModel;
  writeState({
    ...state,
    fallback: {
      from: fromModel,
      at: first ? new Date().toISOString() : state.fallback!.at,
      reason: reason.slice(0, 300),
    },
  });
  if (first) {
    log.warn(
      `${fromModel} 사용 불가 감지 → 수집·큐레이션을 ${FALLBACK_AGENT_MODEL} 로 임시 대체 ` +
        `(다음 실행에서 ${fromModel} 를 다시 확인). 사유: ${reason.slice(0, 200)}`
    );
  }
  return first;
}

/**
 * Codex 가 다시 응답했을 때 임시 대체 상태를 해제한다.
 *
 * 복귀 조건이 "달력상의 어떤 시각"이 아니라 "실제로 한 번 성공했다"인 것이 이 설계의 핵심이다.
 * 한도가 언제 리셋되든, 로그인을 언제 다시 하든, 다음 실행이 성공하는 순간 저절로 풀린다.
 */
export function clearCodexFallback(): boolean {
  const state = readState();
  if (!state.fallback) return false;
  writeState({ ...state, fallback: null });
  log.info(`${state.fallback.from} 정상 응답 확인 → 임시 대체 상태 해제`);
  return true;
}
