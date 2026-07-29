import { runAgentQueryText } from "../util/agent-query.ts";
import { isCodexUsageLimitText, isCodexUsageLimitNotice } from "../util/codex-query.ts";
import { normalizeSpec } from "./strategy.ts";
import type {
  LottoGenerationStat,
  LottoRoundResult,
  LottoStrategy,
  LottoStrategySpec,
} from "../../shared/lotto.ts";
import {
  LOTTO_BASELINE_PER_ROUND,
  LOTTO_EVOLVE_EVERY,
  LOTTO_SET_COUNT,
  LOTTO_ZERO_PENALTY,
} from "../../shared/lotto.ts";

/**
 * **로또 전용 진화 에이전트.** 예측 전략을 개정하는 LLM 호출은 예외 없이 이 파일을 지난다.
 *
 * ## 모델을 프로젝트 설정에서 분리한 이유
 * 다른 수집·큐레이션은 대시보드에서 고른 공용 모델(`getAgentModel()`)을 따르고, 한도가
 * 소진되면 자동으로 갈아탄다. 이 에이전트는 **그 규칙을 따르지 않는다** — 사용자가
 * "기존 프로젝트 설정과는 별개로 Opus 5 로 동작"을 명시적으로 요구했다(2026-07-29).
 *
 * 실험 성격상으로도 그게 맞다. 50회차마다 나오는 제안이 곧 다음 50회차의 곡선을 만드는데,
 * 그 사이에 모델이 바뀌면 곡선의 변화가 전략 때문인지 모델 교체 때문인지 영원히 구분할 수
 * 없다. 실험의 통제 변인이므로 **여기서 상수로 고정**한다.
 *
 * ⚠️ 따라서 한도 소진 시 자동 대체 모델 전환도 하지 않는다. 대신 실험을 멈추고 4시간 뒤에
 *    같은 모델로 재개한다(experiment.ts). 다른 모델로 이어 붙이면 위와 같은 이유로 실험이
 *    오염되기 때문이다.
 */
export const LOTTO_AGENT_MODEL = "claude-opus-5";

/**
 * 이 에이전트는 **도구가 필요 없다.** 판단 재료는 전부 프롬프트에 들어 있고, 웹을 뒤져서
 * 얻을 수 있는 '로또 예측 비법'은 이 실험의 데이터가 아니다.
 *
 * `tools` 가 가용 도구 제한, `allowedTools` 가 무프롬프트 자동 허용이다. 둘 다 비워 둔다.
 * 증시 에이전트와 달리 permissionMode 도 올리지 않는다 — 도구가 없어야 정상이므로, 만에
 * 하나 도구가 새어 들어와도 승인 없이는 아무것도 실행되지 않는 쪽이 옳은 실패다.
 */
const LOTTO_AGENT_TOOLS: string[] = [];

/** 10분. 도구 호출이 없으므로 정상 응답은 1~2분이면 끝난다. */
const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 에이전트의 정체성.
 *
 * 핵심은 **정직성 제약**이다. 이 실험의 결론("예측이 어디까지 정확해지는가")은 곡선이
 * 말해야지 에이전트의 자평이 말하면 안 된다. 그래서 기준선 대비로만 말하게 하고,
 * 잡음을 개선이라 부르지 못하게 못박는다. 반대로 "어차피 무작위라 의미 없다"며 탐색을
 * 포기하는 것도 금지다 — 그건 실험을 하지 않겠다는 말이고, 판단은 데이터가 한다.
 */
const LOTTO_AGENT_IDENTITY = [
  "너는 로또 6/45 번호 예측 전략을 개선하는 실험 연구 에이전트다.",
  "주어진 성적표와 전략 이력만을 근거로 다음 세대 전략 사양을 제안한다.",
  "표본이 작을 때의 점수 변동은 대부분 잡음이다 — 무작위 기준선과의 차이가 잡음 범위 안이면",
  "'개선됐다'고 쓰지 말고 그렇게 보인다는 사실을 그대로 적어라.",
  "동시에, 아직 시도하지 않은 설정이 남아 있다면 탐색을 멈추지 마라. 결론은 데이터가 낸다.",
  "숫자를 지어내지 않는다 — 프롬프트에 주어진 값만 인용한다.",
  "허용된 노브 밖의 필드를 만들지 않는다. 코드나 수식이 아니라 값만 제안한다.",
  "마지막에 지정된 JSON 한 개만 출력한다. 설명 문장을 JSON 밖에 쓰지 않는다.",
].join(" ");

/** 프롬프트에 그대로 실리는 노브 설명서. 엔진의 clamp 범위와 반드시 일치해야 한다. */
const KNOB_CATALOG = `
{
  "weights": {                       // 각 특징을 z-점수로 표준화한 뒤 곱하는 계수. 범위 -5 ~ 5.
    "hot":     0,                    //   최근 windowSize 회차 출현 횟수 (양수 = 자주 나온 번호 선호)
    "cold":    0,                    //   hot 의 부호 반전 (양수 = 최근 안 나온 번호 선호)
    "overall": 0,                    //   전체 기간 출현 횟수
    "gap":     0,                    //   마지막 출현 이후 경과 회차 (양수 = 오래 안 나온 번호 선호)
    "decay":   0,                    //   halfLife 로 감쇠시킨 가중 출현 빈도
    "pair":    0                     //   직전 회차 번호와의 동반 출현 횟수
  },
  "windowSize": 50,                  // 5 ~ 500 (정수). hot/cold 창 크기.
  "halfLife": 50,                    // 1 ~ 1000. decay 반감기(회차).
  "temperature": 1,                  // 0.05 ~ 20. 작을수록 상위 번호에 확률이 몰린다.
  "explore": 0,                      // 0 ~ 1. 균등분포와의 혼합 비율. 1이면 완전 무작위.
  "coverage": "independent",         // "independent" | "partition" | "max-coverage"
                                     //   independent  = 10세트를 각각 독립 추출(겹침 허용)
                                     //   partition    = 번호를 나눠 담아 세트 간 중복 최소화
                                     //   max-coverage = 45개 번호가 최소 1회씩 반드시 등장
  "filters": {
    "sumMin": 21,                    // 21 ~ 255. 6개 합계 하한.
    "sumMax": 255,                   // sumMin ~ 255.
    "oddMin": 0,                     // 0 ~ 6. 홀수 개수 하한.
    "oddMax": 6,                     // oddMin ~ 6.
    "maxConsecutive": 6,             // 1 ~ 6. 연속번호 최대 길이.
    "maxPerDecade": 6,               // 1 ~ 6. 구간(1-9,10-19,20-29,30-39,40-45)별 최대 개수.
    "excludeLastDraw": false         // 직전 회차 당첨번호를 후보에서 제외.
                                     //   (coverage="max-coverage" 에서는 무시된다)
  }
}`.trim();

/** 프롬프트 조립에 필요한 재료. 순수 데이터라 테스트에서 그대로 만들 수 있다. */
export interface LottoEvolveContext {
  /** 다음 세대가 적용되기 시작할 회차 */
  nextRound: number;
  /** 지금까지 채점한 회차 수 */
  scoredRounds: number;
  /** 현재(직전) 세대 */
  current: LottoStrategy;
  /** 세대별 성적 요약(오래된 순) */
  generations: LottoGenerationStat[];
  /** 직전 구간의 회차별 결과(최대 LOTTO_EVOLVE_EVERY 개) */
  recent: LottoRoundResult[];
}

/** 소수 둘째 자리 문자열. 표가 흔들리지 않게 전 구간 동일 규칙을 쓴다. */
const f2 = (v: number) => v.toFixed(2);

/** 기준선 대비 차이. +면 기준선보다 잘한 것. */
const vsBaseline = (avg: number) => {
  const d = avg - LOTTO_BASELINE_PER_ROUND;
  return `${d >= 0 ? "+" : ""}${f2(d)}`;
};

export function buildEvolvePrompt(ctx: LottoEvolveContext): string {
  const genTable = ctx.generations
    .map(
      (g) =>
        `| ${g.version} | ${g.fromRound}~${g.toRound} | ${g.rounds} | ${f2(g.avgScore)} | ${vsBaseline(
          g.avgScore
        )} | ${f2(g.avgMatches)} | ${(g.zeroSetRate * 100).toFixed(1)}% |`
    )
    .join("\n");

  const recentScores = ctx.recent.map((r) => `${r.round}:${r.score}`).join(", ");
  const recentAvg =
    ctx.recent.length > 0
      ? ctx.recent.reduce((s, r) => s + r.score, 0) / ctx.recent.length
      : 0;

  return `
# 실험 규칙

- 로또 6/45. 매 회차 **${LOTTO_SET_COUNT}세트**를 제출하고 각 세트는 서로 다른 번호 6개다.
- 당첨번호는 본번호 6개 + **보너스 1개 = 7개**이며, 세트의 6개 중 이 7개와 겹친 개수가 그 세트의 적중 수다.
- 세트 점수: 적중 1개=+1, 2개=+2, … 6개=+6, **0개=${LOTTO_ZERO_PENALTY}**.
- 회차 점수 = ${LOTTO_SET_COUNT}세트 합계 (이론 범위 -60 ~ +60).
- **무작위 기준선(회차당 기대점수) = ${f2(LOTTO_BASELINE_PER_ROUND)}점.** 모든 평가는 이 값과의 차이로 한다.
- 예측은 walk-forward 다: ${ctx.nextRound}회차를 예측할 때 쓸 수 있는 정보는 ${ctx.nextRound - 1}회차까지의 결과뿐이다.

# 현재 상태

- 채점 완료 회차: ${ctx.scoredRounds}회차
- 다음 세대가 적용될 회차: **${ctx.nextRound}회차부터** (다음 개정까지 ${LOTTO_EVOLVE_EVERY}회차)
- 현재 세대: v${ctx.current.version} (${ctx.current.fromRound}회차부터 적용)

## 세대별 성적

| 세대 | 회차 구간 | 회차수 | 평균점수 | 기준선대비 | 세트당평균적중 | 0적중세트비율 |
|---|---|---|---|---|---|---|
${genTable || "| (없음) | | | | | | |"}

## 직전 구간 회차별 점수 (평균 ${f2(recentAvg)}, 기준선대비 ${vsBaseline(recentAvg)})

${recentScores || "(없음)"}

## 현재 전략 사양

\`\`\`json
${JSON.stringify(ctx.current.spec, null, 2)}
\`\`\`

현재 세대의 가설: ${ctx.current.hypothesis || "(없음)"}

# 조절 가능한 노브 (이 구조와 범위를 벗어나지 마라)

\`\`\`jsonc
${KNOB_CATALOG}
\`\`\`

# 할 일

위 성적을 읽고 **다음 세대 전략 사양**을 제안하라. 판단 기준:

1. 직전 세대가 기준선 대비 어땠는지, 그 차이가 ${ctx.recent.length}회차 표본에서 의미 있는 크기인지.
2. 아직 시험하지 않은 노브 조합이 무엇인지. 한 번에 너무 많이 바꾸면 무엇이 효과였는지 알 수 없으니,
   **바꾸는 노브는 1~3개로 제한**하고 나머지는 그대로 두어라.
3. 이전 세대들에서 이미 나쁜 결과가 나온 방향을 반복하지 마라.

# 출력 형식

아래 JSON 하나만 출력한다. 다른 텍스트를 붙이지 마라.

\`\`\`json
{
  "spec": { ...위 노브 구조 전체... },
  "changed": ["바꾼 노브 이름", "..."],
  "hypothesis": "이 변경이 무엇을 어떻게 바꿀 것이라 예상하는지 한 문장. 다음 세대가 검증할 수 있게 구체적으로.",
  "rationale": "왜 그렇게 판단했는지. 성적표의 어떤 숫자를 근거로 삼았는지 명시. 3~5문장."
}
\`\`\`
`.trim();
}

/** 응답 텍스트에서 첫 '{' ~ 마지막 '}' 를 잘라 JSON 파싱. (전 큐레이터 공통 관례) */
function extractJson(text: string): Record<string, unknown> {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e <= s) throw new Error("JSON 미발견");
  return JSON.parse(text.slice(s, e + 1)) as Record<string, unknown>;
}

/**
 * 잡은 예외가 **토큰/사용량 한도**인지.
 *
 * Claude 경로에서 한도는 예외 타입이 아니라 문자열로 온다 — agent-query 의 FAILURE_SIGNALS 가
 * `You've hit your limit …` / `Claude AI usage limit reached` / `Credit balance is too low` 를
 * 실패로 승격시키면서 메시지에 원문을 실어 준다. 그래서 여기서는 **메시지 문자열**을 본다.
 *
 * 이 판정이 틀리면 실험이 4시간마다 무의미하게 되살아나거나(오탐), 한도 때문에 멈춘 실험이
 * 영영 재개되지 않는다(미탐). 그래서 codex 쪽에서 이미 실측으로 다듬어진 패턴을 재사용하고
 * (이름만 codex 지 제공자 중립적인 텍스트 매처다), Claude 전용 문구만 덧댄다.
 */
export function isLottoUsageLimit(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (!msg) return false;
  if (isCodexUsageLimitText(msg)) return true;
  return /credit balance is too low|upgrade to increase your usage limit/i.test(msg);
}

export interface LottoEvolveProposal {
  spec: LottoStrategySpec;
  hypothesis: string;
  rationale: string;
  changed: string[];
  model: string;
}

/**
 * 전략 개정 1회. 실패는 throw — 호출부가 '한도라서 멈춤'과 '그냥 실패'를 구분해 처리한다.
 *
 * ⚠️ 실패해도 **직전 세대를 그대로 이어 쓰면 안 된다**는 규칙은 여기 없다. 호출부가 정한다:
 *    한도면 멈췄다가 재개(세대 유지), 그 외 오류면 세대를 유지한 채 다음 구간으로 진행한다.
 *    전략이 없는 회차를 만들지 않는 것이 우선이기 때문이다.
 */
export async function runLottoEvolveAgent(
  ctx: LottoEvolveContext
): Promise<LottoEvolveProposal> {
  const text = await runAgentQueryText(
    buildEvolvePrompt(ctx),
    {
      tools: LOTTO_AGENT_TOOLS,
      allowedTools: LOTTO_AGENT_TOOLS,
      settingSources: [],
      model: LOTTO_AGENT_MODEL, // ⚠️ getAgentModel() 을 쓰지 않는다(파일 상단 주석 참고)
      maxTurns: 6,
      systemPrompt: LOTTO_AGENT_IDENTITY,
    },
    TIMEOUT_MS,
    `로또 진화 에이전트(v${ctx.current.version}→v${ctx.current.version + 1})`
  );

  // ⚠️ **파싱보다 먼저** 한도 통보인지 본다. 한도 메시지는 JSON 이 아니므로 그냥 파싱하면
  // "JSON 미발견" 으로 둔갑하고, 그러면 isLottoUsageLimit 가 거짓이 되어 4시간 대기 대신
  // '사양 승계' 세대가 찍히며 실험이 그대로 굴러간다 — 남은 진화 호출이 전부 같은 방식으로
  // 실패해 이후 세대가 전원 직전 사양의 복사본이 되는데, 완주까지 아무도 눈치채지 못한다.
  // agent-query 의 FAILURE_SIGNALS 를 넓혀 두었지만(라벨 6종), 그 목록이 다시 뒤처질 때를
  // 대비해 여기서도 한 번 더 본다 — 이 실험의 핵심 요구사항이 걸린 경로다.
  if (isCodexUsageLimitNotice(text)) {
    throw new Error(`토큰 한도 통보: ${text.trim()}`);
  }

  const parsed = extractJson(text);
  const changed = Array.isArray(parsed.changed)
    ? parsed.changed.filter((v): v is string => typeof v === "string").slice(0, 12)
    : [];

  return {
    // 모델이 무엇을 주든 엔진이 삼킬 수 있는 형태로 강제한다(범위 강제는 normalizeSpec).
    spec: normalizeSpec(parsed.spec),
    hypothesis: typeof parsed.hypothesis === "string" ? parsed.hypothesis.slice(0, 1000) : "",
    rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 4000) : "",
    changed,
    model: LOTTO_AGENT_MODEL,
  };
}
