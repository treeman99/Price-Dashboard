import { config } from "../config.ts";
import { runAgentQueryText } from "../util/agent-query.ts";
import { getAgentModel } from "../util/model-store.ts";

/**
 * **증시 전용 에이전트.** 증시와 관련된 LLM 호출은 예외 없이 이 파일을 지난다.
 *
 * ## 왜 분리했나
 * 예전에는 증시 큐레이션이 `runAgentQueryText` 를 직접 불렀고, 뉴스·유튜브·가격 큐레이터도
 * 똑같이 각자 불렀다. 그래서 증시에만 적용해야 할 규칙(투자 권유 금지, 숫자 인용 제한,
 * 병렬 도구 호출 금지)이 증시 프롬프트 문자열 안에 흩어져 있었고, 실행 모드가 늘어날 때마다
 * 그 규칙을 복사해야 했다 — 복사가 어긋나는 순간 한쪽 모드만 투자 권유를 하게 된다.
 *
 * 이제 정체성(시스템 프롬프트)·도구·타임아웃·라벨이 여기 한 곳에 있고, 호출부는 **모드와
 * 프롬프트만** 넘긴다.
 *
 * ## 분리하지 **않은** 것: 모델
 * 사용자가 인터뷰에서 "모델은 그대로 따르고 에이전트만 분리"를 선택했다. 모델은 계속
 * `getAgentModel()`(대시보드에서 고른 Opus 5 / Codex)을 공유한다. 증시 전용 모델 선택을
 * 넣고 싶어지면 이 파일의 `model:` 한 줄만 바꾸면 된다.
 */

/**
 * 실행 모드.
 * - `briefing` — 일일 리포트(한국장 08:00 / 미국장 18:00). 조사량이 많고 오래 걸린다.
 * - `pulse`    — 시간당 실시간 취합. **짧아야 한다** (아래 타임아웃 주석 참고).
 */
export type StockAgentMode = "briefing" | "pulse";

/**
 * 전 모드 공통 정체성. 모드별 프롬프트가 무엇을 요구하든 **이 규칙이 우선**이다.
 *
 * ⚠️ '투자 권유 금지'는 완화되지 않았다. 사용자가 인터뷰에서 고른 것은 '영향도 판정까지만'
 *    이므로, 재료의 방향·강도를 판정하는 것은 허용하되 매매 행동을 지시하는 것은 계속 금지다.
 *    이 구분이 흐려지면 제품이 무면허 투자자문이 된다.
 */
const STOCK_AGENT_IDENTITY =
  "너는 한국어 증시 정보 정리 담당이다. " +
  "도구는 한 번에 하나씩만 호출한다(병렬 도구 호출 금지 — tool_use id 중복으로 API 400 이 난다). " +
  "매수·매도·비중확대·비중축소 등 **매매 행동을 지시하는 표현을 절대 쓰지 않는다.** " +
  "너가 하는 일은 관측 가능한 사실(뉴스·공시·발언·수급·컨센서스 변화)과 그 출처를 정리하고, " +
  "그 사실이 어느 방향으로 얼마나 세게 작용하는지를 **판정**하는 것까지다. " +
  "행동 지시는 사용자가 한다. " +
  "주가·등락률·지수 값은 프롬프트에 주어진 [확정 시세] 표의 숫자만 인용하고, " +
  "추정·계산·기억으로 숫자를 만들지 않는다. " +
  "출처 URL 을 지어내지 않는다 — 실제로 열어본 페이지의 URL 만 적는다. " +
  "마지막에 지정된 JSON 한 개만 출력한다.";

/** 모드별로 덧붙는 정체성. */
const MODE_IDENTITY: Record<StockAgentMode, string> = {
  briefing:
    "지금은 일일 브리핑 모드다. 하루 한 번 나가는 정기 보고서를 만든다. " +
    "'오늘의 관심 종목'은 추천이 아니라 '시장에서 왜 거론되는지'의 사실 요약이다.",
  pulse:
    "지금은 실시간 펄스 모드다. **지난 한 시간 안팎에 새로 나온 것**만 다룬다. " +
    "이미 알려진 배경 설명이나 하루 종일 반복된 이야기는 가치가 없다 — 새 사실이 없으면 " +
    "빈 배열을 내는 것이 정답이다. 억지로 채우지 마라.",
};

/**
 * 이 에이전트가 쓸 수 있는 도구.
 *
 * `tools` 는 **가용 도구 제한**이고 `allowedTools` 는 그 도구들의 무프롬프트 허용이다.
 * 둘 다 지정해야 한다 — allowedTools 만 주면 자동 허용될 뿐 Bash/Write 가 여전히 가용해서,
 * 외부 페이지의 프롬프트 인젝션이 파일을 건드릴 수 있다.
 */
const STOCK_AGENT_TOOLS = ["WebSearch", "WebFetch"];

/**
 * 모드별 타임아웃.
 *
 * 브리핑은 공용 값(`agentQueryTimeoutMs`, 기본 60분)을 그대로 쓴다 — 조사 주제가 10개 넘고
 * 실측 소요가 30분을 넘긴 적이 있다.
 *
 * ⚠️ 펄스는 **반드시 짧아야 한다.** 매시간 도는데 공용 60분을 물리면 실행 하나가 다음 정시를
 *    넘겨 겹치고, 동시 실행 가드에 막혀 그 시각이 통째로 날아간다. 기본 10분이면 정시 간격
 *    (60분)의 1/6 이라 지연이 누적되지 않는다.
 */
function timeoutFor(mode: StockAgentMode): number {
  return mode === "pulse" ? config.stockPulseTimeoutMs : config.agentQueryTimeoutMs;
}

/**
 * 모드별 최대 턴 수.
 *
 * 펄스의 병목은 **턴이 아니라 시간이어야 한다.** 타임아웃(10분)에 걸리면 그 시각을 건너뛰고
 * 다음 정시에 다시 도는 것으로 끝나지만, 턴 상한에 먼저 걸리면 `error_max_turns` 로 결과가
 * 통째로 비어 같은 시간을 쓰고도 아무것도 못 건진다.
 *
 * 처음엔 30으로 잡았다가 올렸다 — 실측(2026-07-27)에서 정상 조사 중인 런이 **5분 만에 33턴,
 * 도구 17회**를 썼다. 프롬프트가 조사 주제 4개를 순차 검색으로 요구하니(병렬 도구 호출 금지)
 * 주제당 6~8턴은 정상 소요다. 30은 정상 동작을 잘라내는 값이었다.
 */
function maxTurnsFor(mode: StockAgentMode): number {
  return mode === "pulse" ? 50 : 60;
}

export interface RunStockAgentOptions {
  mode: StockAgentMode;
  prompt: string;
  /** 로그 라벨의 꼬리표. 예: "미국장·마감결산", "08:00". */
  label: string;
}

/**
 * 증시 에이전트 1회 실행. 결과 텍스트를 그대로 돌려준다(파싱은 호출부 몫).
 * 실패는 throw — 호출부가 각자의 저하 경로(빈 스냅샷 / 펄스 스킵)를 타게 한다.
 */
export async function runStockAgent(opts: RunStockAgentOptions): Promise<string> {
  const { mode, prompt, label } = opts;
  return runAgentQueryText(
    prompt,
    {
      tools: STOCK_AGENT_TOOLS,
      allowedTools: STOCK_AGENT_TOOLS,
      permissionMode: "bypassPermissions",
      settingSources: [],
      model: getAgentModel(), // 공용 모델 — 분리 대상이 아니다(파일 상단 주석 참고)
      maxTurns: maxTurnsFor(mode),
      systemPrompt: `${STOCK_AGENT_IDENTITY} ${MODE_IDENTITY[mode]}`,
    },
    timeoutFor(mode),
    `증시 에이전트[${mode}](${label})`
  );
}

/** 응답 텍스트에서 첫 '{' ~ 마지막 '}' 를 잘라 JSON 파싱. (전 큐레이터 공통 관례) */
export function extractJson(text: string): unknown {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e <= s) throw new Error("JSON 미발견");
  return JSON.parse(text.slice(s, e + 1));
}
