import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 에이전트 실행 근거(어떤 모델이 실제로 응답했고, 어떤 검색·읽기 도구를 썼는지) 수집기.
 *
 * 일일 보고서는 세 모델이 **각자** 출처를 검색·열람했다는 증거를 모델별 중간 결과로 남겨야 한다.
 * 큐레이션 함수(curateNews/curateYoutube) 시그니처에 콜백을 줄줄이 꿰지 않으려고 비동기 문맥에
 * 수집기를 걸어 둔다 — 문맥 밖(대시보드의 평소 수집)에서는 emit 이 아무 일도 하지 않는다.
 */
export interface QueryTraceEvent {
  /** 실행기: claude(Agent SDK) · codex(Codex CLI) · antigravity(agy). */
  runner: "claude" | "codex" | "antigravity";
  /** 호출부가 요청한 모델 ID. */
  requestedModel: string;
  /** 실행기가 응답에 찍어 준 실제 모델 ID. 실행기가 알려 주지 않으면 null. */
  actualModel: string | null;
  label: string;
  /** 검색·열람 등 도구 호출(이름 + 짧은 인자). */
  tools: { name: string; input: string }[];
  durationMs: number;
  ok: boolean;
  error?: string;
}

const store = new AsyncLocalStorage<QueryTraceEvent[]>();

/** fn 안에서 일어난 모든 에이전트 호출 근거를 sink 에 모은다. */
export function withQueryTrace<T>(sink: QueryTraceEvent[], fn: () => Promise<T>): Promise<T> {
  return store.run(sink, fn);
}

/** 현재 문맥에 수집기가 있으면 근거를 남긴다(없으면 무시). */
export function emitQueryTrace(event: QueryTraceEvent): void {
  store.getStore()?.push(event);
}

/** 도구 인자를 근거로 남길 만큼만 줄인다(프롬프트 원문·긴 본문이 로그를 채우지 않게). */
export function briefToolInput(input: unknown, max = 240): string {
  let s: string;
  if (typeof input === "string") s = input;
  else {
    try {
      s = JSON.stringify(input) ?? "";
    } catch {
      s = String(input);
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
