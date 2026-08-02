import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { log } from "./log.ts";
import { isCodexModel, isCodexUnavailableError, runCodexQueryText } from "./codex-query.ts";
import {
  createDeadline,
  formatDeadlineBudget,
  suggestTickMs,
  type Deadline,
} from "./deadline.ts";
import { FALLBACK_AGENT_MODEL, clearCodexFallback, recordCodexFallback } from "./model-store.ts";

/**
 * **대체 모델 실행에 주는 자체 예산.** 원 타임아웃과 완전히 독립이다.
 *
 * 왜 독립이어야 하나 (2026-08-02 사고의 두 번째 구멍):
 * 예전 코드는 `remaining = timeoutMs - (Date.now() - startedAt)` 로 **원 예산의 잔여분**을
 * 대체 실행에 넘겼다. 그런데 `startedAt` 은 Codex 호출 **전**에 찍히므로, 타임아웃으로 폴백에
 * 들어온 순간 잔여는 정의상 항상 0 이하다 → 바로 뒤의 `remaining < 60_000` 에 걸려 **무조건**
 * 건너뛰었다. 즉 폴백은 구조적으로 절대 실행되지 않았다(런타임 증거: data/model.json 의
 * fallback=null, 폴백 진입 이력 0회). 게다가 원 예산이 소진된 이유가 대개 '절전'이라
 * 잔여를 물려주는 것 자체가 무의미하다 — 대체 실행은 시계를 새로 재야 한다.
 *
 * 무한정은 곤란하므로 20분을 상한으로 못 박는다. 원 예산이 3600초든 240초든 대체 실행에는
 * 이 값을 그대로 준다.
 */
export const FALLBACK_TIMEOUT_MS = 20 * 60_000;

/**
 * 실행기 주입 지점. **테스트 전용**이다.
 *
 * 폴백 경로는 이 저장소에서 가장 조용히 썩기 쉬운 코드다 — 정상 운영 중에는 한 번도 안 돌고,
 * 죽은 채로 몇 달을 지나 정작 필요한 날(로그인 초기화·한도 소진·절전) 하루치를 통째로
 * 날린다. 실제로 그렇게 됐다. 회귀 테스트가 폴백 '진입'과 '실제 호출'을 검증하려면 하위
 * 실행기(Codex CLI·Claude SDK)와 상태 저장(model.json 쓰기)을 갈아끼울 수 있어야 한다.
 */
export interface AgentQueryDeps {
  runCodex: (
    prompt: string,
    options: Omit<Options, "abortController">,
    timeoutMs: number,
    label: string
  ) => Promise<string>;
  runClaude: (
    prompt: string,
    options: Omit<Options, "abortController">,
    timeoutMs: number,
    label: string
  ) => Promise<string>;
  recordFallback: (fromModel: string, reason: string) => boolean;
  clearFallback: () => boolean;
}

const defaultDeps: AgentQueryDeps = {
  runCodex: runCodexQueryText,
  runClaude: runClaudeAgentQueryText,
  recordFallback: recordCodexFallback,
  clearFallback: clearCodexFallback,
};

let deps: AgentQueryDeps = defaultDeps;

/** 테스트에서 실행기를 갈아끼운다. 반환된 함수로 반드시 원복할 것(운영 코드는 호출 금지). */
export function __setAgentQueryDepsForTest(patch: Partial<AgentQueryDeps>): () => void {
  const prev = deps;
  deps = { ...deps, ...patch };
  return () => {
    deps = prev;
  };
}

/** 로그용 한 줄 미리보기(개행 제거 + 길이 제한). 원문이 길어도 로그가 터지지 않게. */
export function preview(text: string, max = 400): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 하위 CLI 가 "결과"(subtype:"success")로 돌려주지만 실제로는 실패 통보인 문자열들.
 * 이들은 JSON 이 아니라서 호출부에는 "JSON 미발견" 으로만 보이는데, 그 메시지만으로는
 * 원인(한도 소진/인증/크레딧)을 알 수 없어 원인 규명이 막힌다(실측: 실패 원문이 로그에
 * 전혀 남지 않아 반나절을 헤맴). 여기서 실패로 승격해 원문을 에러 메시지에 실어 보낸다.
 *
 * `You've hit your limit · resets 6pm (Asia/Seoul)` 은 Claude CLI 의 한도 통보 형태다.
 * 목록에 없던 동안 이 47자짜리 결과가 '성공'으로 통과해 빈 스냅샷만 남겼다(로그 실측).
 * 한도 소진 시 자동 전환의 도착지가 Claude 이므로, 이 문구가 조용하면 전환 후 실패가
 * 그대로 묻힌다.
 *
 * ⚠️ 한도 문구에는 **라벨이 붙는다.** 번들 CLI(`node_modules/@anthropic-ai/claude-agent-sdk/cli.js`)
 * 는 `You've hit your ${라벨}` 로 문장을 만들고, 라벨은 `limit` / `session limit`(5시간) /
 * `Opus limit`(주간 Opus) / `weekly limit` / `Sonnet limit` / `usage limit` 6종이다.
 * 예전 패턴 `You'?ve hit your limit` 은 **그중 첫 번째 하나만** 잡았고 나머지 5종은 전부
 * 통과했다(2026-07-29 실측: `isFailureSignal("You've hit your Opus limit · resets 3pm")` === false).
 * 그래서 라벨 자리를 낱말 2개까지 허용한다 — Codex 쪽 패턴과 같은 방식이다.
 * 이게 조용하면 한도 소진이 "JSON 미발견" 으로 둔갑해, 한도 기반 대기·전환 로직이 통째로
 * 발화하지 않는다(로또 실험의 4시간 자동 재개가 바로 이 경로에 걸려 있었다).
 */
const FAILURE_SIGNALS =
  /^\s*(API Error:|Claude AI usage limit reached|You'?ve hit your (?:\w+ ){0,2}limit|Credit balance is too low|Invalid API key|OAuth token has expired|Please run \/login|Execution error)/i;

/** 결과 텍스트가 '성공을 가장한 실패 통보'인지. */
export function isFailureSignal(text: string): boolean {
  return FAILURE_SIGNALS.test(text);
}

/**
 * 선택 모델에 따라 Claude Agent SDK 또는 Codex CLI를 실행해 마지막 결과 텍스트를 반환한다.
 *
 * Codex 를 골랐으면 **실행할 때마다 Codex 가용성을 먼저 확인**하고(runCodexQueryText 첫 단계),
 * 못 쓰는 상태면 그 실행만 대체 모델로 살린다. 사용자의 선택은 그대로 두고 다음 실행에서 다시
 * 확인하므로 복귀 시점을 달력에 고정할 필요가 없다 — 예전의 주간 복귀 cron 이 하던 일이다.
 *
 * Claude 경로의 핵심: **타임아웃/중단 가드**. query 가 응답을 받지 못하고 멈추면(transport 정지 등)
 * `for await` 루프가 영원히 대기하고, 호출부의 `running` 플래그가 영구히 잠겨
 * 이후 모든 수집(수동 '지금 갱신' 포함)이 막힌다. timeoutMs 초과 시 AbortController 로
 * 하위 프로세스를 중단하고 에러를 던져, 호출부가 정상적으로 실패 처리(+running 해제)하게 한다.
 *
 * ⚠️ 여기서 말하는 timeoutMs 는 **유효 시간**(맥북이 자는 동안은 흐르지 않는다) 기준이다.
 * 벽시계 기준이던 시절, 덮개를 닫아 둔 하룻밤 사이 전 탭이 0턴 상태로 동시에 타임아웃했다
 * (2026-08-02). deadline.ts 참고.
 */
export async function runAgentQueryText(
  prompt: string,
  options: Omit<Options, "abortController">,
  timeoutMs: number,
  label = "agent"
): Promise<string> {
  if (!isCodexModel(options.model)) {
    return deps.runClaude(prompt, options, timeoutMs, label);
  }

  let finalText: string;
  try {
    finalText = await deps.runCodex(prompt, options, timeoutMs, label);
  } catch (e) {
    // 가용성 문제(로그인 초기화·CLI 없음·한도·시간 초과)만 대체로 넘긴다.
    // 나머지(프롬프트 오류·파싱 실패 등)는 진짜 실패라 그대로 올린다 — 그것까지 대체로 넘기면
    // Codex 경로의 버그가 Opus 실행에 묻혀 영원히 드러나지 않는다.
    if (!isCodexUnavailableError(e)) throw e;
    return runOnFallbackModel(prompt, options, label, e);
  }
  // 여기까지 왔다 = Codex 가 살아서 답했다. 대체 상태 해제는 오직 이 성공에만 걸어 둔다.
  // (대체 모델이 성공한 것으로는 풀지 않는다. Codex 는 여전히 죽어 있고, 화면의 '임시 대체'
  //  배지는 그 사실을 설명하는 유일한 근거다.)
  deps.clearFallback();
  return validateFinalText(finalText, label);
}

/**
 * Codex 를 쓸 수 없을 때 **이번 실행만** 대체 모델(Opus 5)로 살린다.
 *
 * 기록만 하고 던지면 그 수집은 통째로 빈 스냅샷이 된다 — 로그인은 아무 때나 풀리고 한도는
 * 정오에도 소진되므로 "다음 수집부터 정상"은 하루치 결과를 버리는 것과 같다.
 *
 * ⚠️ **예산은 원 타임아웃과 무관하게 새로 준다**(FALLBACK_TIMEOUT_MS 주석 참고). 예전의
 * "원 예산 잔여분을 넘기고 1분 미만이면 건너뜀" 규칙은 폴백을 100% 무력화하던 장본인이다.
 */
async function runOnFallbackModel(
  prompt: string,
  options: Omit<Options, "abortController">,
  label: string,
  cause: Error
): Promise<string> {
  const from = String(options.model);
  const first = deps.recordFallback(from, cause.message);
  const note = first
    ? `${from} 사용 불가 → 이번 실행은 ${FALLBACK_AGENT_MODEL} 로 대체 (다음 실행에서 재확인)`
    : `${from} 사용 불가 지속 → 이번 실행도 ${FALLBACK_AGENT_MODEL} 로 대체`;

  log.warn(
    `${label}: ${note} — 자체 예산 ${Math.round(FALLBACK_TIMEOUT_MS / 1000)}초로 즉시 재시도. ` +
      `원인: ${preview(cause.message, 300)}`
  );
  return deps.runClaude(
    prompt,
    { ...options, model: FALLBACK_AGENT_MODEL },
    FALLBACK_TIMEOUT_MS,
    `${label}(임시 대체)`
  );
}

/**
 * Claude 모델은 기존 Agent SDK 스트리밍 경로를 그대로 사용한다.
 *
 * ⚠️ 타임아웃은 **슬립 내성 데드라인**이다. 이번 사고는 Codex 전용 문제가 아니었다 —
 * 로또 탭(Claude/Opus 경로, 600초 예산)도 0턴 상태로 똑같이 죽었다. 벽시계 setTimeout 하나로
 * 재는 한 제공자와 무관하게 같은 방식으로 무너진다.
 */
async function runClaudeAgentQueryText(
  prompt: string,
  options: Omit<Options, "abortController">,
  timeoutMs: number,
  label = "agent"
): Promise<string> {
  const ac = new AbortController();
  const q = query({ prompt, options: { ...options, abortController: ac } });

  let finalText = "";
  let timedOut = false;
  const deadline = createDeadline(timeoutMs, {
    label,
    tickMs: suggestTickMs(timeoutMs),
    onExpire: () => {
      timedOut = true;
      ac.abort();
      log.warn(
        `${label}: 응답 시간 초과(${formatDeadlineBudget(timeoutMs, deadline)}) → 중단 ` +
          `(${turns}턴, 도구 ${toolCalls}회 진행 중이었음)`
      );
    },
  });

  // 진행 상황 계측. 타임아웃으로 잘렸을 때 "멈춘 것"인지 "아직 일하는 중"인지 구분할 근거가
  // 없으면 타임아웃 값을 올려야 할지 작업량을 줄여야 할지 판단할 수 없다(실측: 30분 초과가
  // 반복됐는데 어디서 시간을 쓰는지 알 길이 없었다). 몇 분마다 한 줄만 남긴다.
  // 벽시계와 유효 경과를 함께 찍는 이유: 둘의 격차가 곧 절전 시간이라, 로그만 보고
  // "일을 오래 한 것"과 "맥이 자느라 시계만 흐른 것"을 구분할 수 있다.
  let turns = 0;
  let toolCalls = 0;
  let nonSuccessSubtype: string | null = null;
  const heartbeat = setInterval(
    () => {
      log.info(
        `${label}: 진행 중 — ${formatDeadlineBudget(timeoutMs, deadline)}, ${turns}턴, 도구 ${toolCalls}회`
      );
    },
    5 * 60 * 1000
  );

  try {
    for await (const msg of q) {
      if (msg.type === "assistant") {
        turns += 1;
        const content = (msg as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) {
          toolCalls += content.filter((c) => (c as { type?: string })?.type === "tool_use").length;
        }
      }
      if (msg.type === "result") {
        if (msg.subtype === "success") finalText = msg.result;
        else {
          // success 가 아닌 종료(대표적으로 maxTurns 소진: "error_max_turns"). 결과 텍스트가
          // 없으므로 호출부에는 "결과가 비어 있습니다"로만 보여, 작업량이 상한을 넘었다는
          // 사실이 드러나지 않는다. 상한 조정 판단에 필요한 정보라 명시적으로 남긴다.
          nonSuccessSubtype = msg.subtype;
          log.warn(`${label}: 비정상 종료 — subtype=${msg.subtype} (${turns}턴, 도구 ${toolCalls}회)`);
        }
      }
    }
  } catch (e) {
    if (timedOut) throw agentTimeoutError(timeoutMs, deadline, turns, toolCalls);
    // 이미 success 결과를 받아둔 뒤에 스트림이 터지는 경우가 실제로 있다(하위 CLI 프로세스가
    // 결과를 내보내고 나서 종료 코드 1로 죽는 사례를 실측). 그대로 rethrow 하면 멀쩡히 받아온
    // 큐레이션 결과를 통째로 버리고 빈 스냅샷으로 저하되는데, 결과가 손에 있는 이상 그건 손해다.
    // 종료 단계의 잡음은 경고만 남기고 결과를 살린다. 결과가 없으면 진짜 실패이므로 rethrow.
    if (!finalText) throw e;
    log.warn(
      `${label}: 결과 수신 후 스트림 종료 오류(무시하고 결과 사용) — ${(e as Error).message} · 수신 ${finalText.length}자: ${preview(finalText)}`
    );
  } finally {
    deadline.dispose();
    clearInterval(heartbeat);
  }

  // abort 가 예외 없이 스트림을 끝낸 경우도 타임아웃으로 처리
  if (timedOut) throw agentTimeoutError(timeoutMs, deadline, turns, toolCalls);

  log.info(
    `${label}: 완료 — 유효 ${Math.round(deadline.elapsedMs() / 1000)}초` +
      `(벽시계 ${Math.round(deadline.wallElapsedMs() / 1000)}초), ` +
      `${turns}턴, 도구 ${toolCalls}회, 결과 ${finalText.length}자`
  );

  // 결과 없이 비정상 종료(maxTurns 소진 등)한 경우. "결과가 비어 있습니다"로 뭉뚱그리면 무엇을
  // 조정해야 할지(상한? 타임아웃? 작업량?) 알 수 없으므로 종료 사유와 소진량을 그대로 올린다.
  if (!finalText && nonSuccessSubtype) {
    throw new Error(
      `Agent 비정상 종료(${nonSuccessSubtype}) — ${turns}턴, 도구 ${toolCalls}회 소진`
    );
  }

  // ⚠️ SDK 가 API 오류를 subtype:"success" 결과의 **본문 문자열**로 감싸 돌려주는 경우가 있다
  // (실측: `API Error: 400 ... tool_use ids must be unique`, 사용량 한도 소진 통보 등). 그대로
  // 통과시키면 호출부는 "성공했는데 JSON 이 없네" 로 오해해 빈 결과를 정상 저장한다 — 조용한
  // 실패라 며칠간 아무도 모른다. 여기서 실패로 승격시켜 호출부의 저하 경로(빈 스냅샷 + notes)를
  // 타게 한다.
  return validateFinalText(finalText, label);
}

/**
 * 타임아웃 오류 메시지. **예산 · 벽시계 경과 · 유효 경과** 3종을 반드시 병기한다.
 *
 * 이번 사고에서 남은 것은 "Agent 응답 시간 초과(600s)" 한 줄뿐이었고, 그 문장은 "600초 동안
 * 일했지만 못 끝냈다"로 읽힌다. 실제로는 맥이 자느라 몇십 초밖에 돌지 못했다. 세 숫자를
 * 나란히 두면 격차 자체가 절전의 증거가 되어, 다음번엔 로그 한 줄로 원인을 짚을 수 있다.
 * 진행량(턴·도구)까지 붙이는 이유는 "정지"와 "느림"을 구분하기 위해서다.
 */
function agentTimeoutError(
  timeoutMs: number,
  deadline: Deadline,
  turns: number,
  toolCalls: number
): Error {
  return new Error(
    `Agent 응답 시간 초과(${formatDeadlineBudget(timeoutMs, deadline)}) — ` +
      `${turns}턴, 도구 ${toolCalls}회 진행 중이었음`
  );
}

/** 제공자와 무관하게 마지막 응답에 동일한 실패·JSON 진단 규칙을 적용한다. */
function validateFinalText(finalText: string, label: string): string {
  if (isFailureSignal(finalText)) {
    throw new Error(`Agent API 오류: ${preview(finalText, 300)}`);
  }
  // 호출부는 대부분 JSON 을 기대한다. 중괄호조차 없으면 파싱은 반드시 "JSON 미발견" 으로 실패하는데,
  // 그 메시지만 로그에 남으면 무엇이 왔는지 알 길이 없다(실측: 원인 규명에 실패). 원문을 남긴다.
  if (!finalText.includes("{")) {
    log.warn(`${label}: 응답에 JSON 이 없음 — ${finalText.length}자: ${preview(finalText)}`);
  }
  return finalText;
}
