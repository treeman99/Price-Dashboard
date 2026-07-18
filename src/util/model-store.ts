import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "./log.ts";
import type { AgentModelOption, AgentModelSettings } from "../../shared/types.ts";

/** 사용자 선택 저장 위치 (schedule.json 과 같은 data 디렉터리). */
const STORE_PATH = path.join(path.dirname(config.dbPath), "model.json");

/**
 * 수집/큐레이션 Agent SDK 가 쓸 수 있는 모델 목록.
 *
 * id 는 SDK `options.model` 에 **그대로** 전달된다. 별칭("opus"/"sonnet")이 아니라 풀 모델 ID 를 쓰는
 * 이유: 설치된 SDK 버전의 별칭은 그 시점에 번들된 (구)모델로 해석돼, 우리가 원하는 최신 모델(Opus 4.8 등)이
 * 아닐 수 있다. 풀 ID 를 주면 CLI 가 그 문자열을 API 로 그대로 전달한다.
 *
 * ⚠️ 목록 **첫 항목이 기본값**이다(DEFAULT_AGENT_MODEL). 순서를 바꾸면 기본값도 바뀐다.
 */
export const AGENT_MODEL_OPTIONS: AgentModelOption[] = [
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    description: "기본값 — 가장 높은 수집·큐레이션 품질",
  },
  {
    id: "claude-fable-5",
    label: "Fable 5",
    description: "Claude 5 계열 모델",
  },
];

/** 기본 모델 = 목록 첫 항목(Opus 4.8). */
export const DEFAULT_AGENT_MODEL = AGENT_MODEL_OPTIONS[0].id;

/** id 가 허용 목록에 있으면 그대로, 아니면 null. */
function validModel(id: unknown): string | null {
  return typeof id === "string" && AGENT_MODEL_OPTIONS.some((o) => o.id === id) ? id : null;
}

/** 저장 파일에서 선택 모델 로드. 없거나 깨졌거나 미허용 값이면 기본값(수집이 죽지 않게 fail-open). */
function readStoredModel(): string {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as { model?: unknown };
      return validModel(raw?.model) ?? DEFAULT_AGENT_MODEL;
    }
  } catch (e) {
    log.warn(`model.json 읽기 실패 → 기본 모델 사용: ${(e as Error).message}`);
  }
  return DEFAULT_AGENT_MODEL;
}

/**
 * 현재 유효 모델 ID. 각 수집/큐레이션 실행 시작 시 호출해 최신 선택을 반영한다
 * (스케줄과 동일하게 파일에서 매번 새로 읽어, 서버 재시작 없이 **다음 수집부터** 적용).
 */
export function getAgentModel(): string {
  return readStoredModel();
}

/** GET 응답용: 현재 모델 + 선택지 목록. */
export function getModelSettings(): AgentModelSettings {
  return { model: readStoredModel(), options: AGENT_MODEL_OPTIONS };
}

/**
 * 모델 선택 저장. 허용 목록에 없는 id 면 throw(→ 라우트 400).
 * 저장 성공 시 최신 설정 반환.
 */
export function saveAgentModel(id: unknown): AgentModelSettings {
  const model = validModel(id);
  if (!model) {
    const allowed = AGENT_MODEL_OPTIONS.map((o) => o.id).join(", ");
    throw new Error(`허용되지 않은 모델입니다. 가능한 값: ${allowed}`);
  }
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify({ model }, null, 2), "utf8");
  log.info(`Agent SDK 모델 변경: ${model}`);
  return getModelSettings();
}
