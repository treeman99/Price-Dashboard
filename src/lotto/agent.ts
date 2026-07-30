import { runAgentQueryText } from "../util/agent-query.ts";
import { isCodexUsageLimitText, isCodexUsageLimitNotice } from "../util/codex-query.ts";
import { normalizeSpec } from "./strategy.ts";
import type {
  LottoRecentRound,
  LottoStrategy,
  LottoStrategySpec,
  LottoSummary,
} from "../../shared/lotto.ts";
import {
  LOTTO_BASELINE_PER_ROUND,
  LOTTO_P_THREE_PLUS,
  LOTTO_SET_COUNT,
  weightedHitScore,
  winningNumbers,
} from "../../shared/lotto.ts";

/**
 * **로또 전용 전략 갱신 에이전트.** 전략을 개정하는 LLM 호출은 예외 없이 이 파일을 지난다.
 *
 * 주간 운영에서 이 함수는 **주 1회** 불린다 — 토요일 추첨 결과로 지난주 추천 번호를 채점한
 * 직후, 다음 회차 번호를 뽑기 전에.
 *
 * ## 모델을 프로젝트 설정에서 분리한 이유
 * 다른 수집·큐레이션은 대시보드에서 고른 공용 모델(`getAgentModel()`)을 따르고, 한도가
 * 소진되면 자동으로 갈아탄다. 이 에이전트는 **그 규칙을 따르지 않는다** — 사용자가
 * "기존 프로젝트 설정과는 별개로 Opus 5 로 동작"을 명시적으로 요구했다(2026-07-29).
 *
 * ⚠️ 따라서 한도 소진 시 자동 대체 모델 전환도 하지 않는다. 대신 전략 갱신만 미뤘다가
 *    4시간 뒤 같은 모델로 재시도한다(cycle.ts). **번호 추출은 미루지 않는다** —
 *    한도 소진 때문에 그 주 번호가 비면 안 되므로 직전 세대로 뽑아 둔다.
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
 * 핵심은 **정직성 제약**이다. 결론은 기록이 말해야지 에이전트의 자평이 말하면 안 된다.
 * 그래서 기준선 대비로만 말하게 하고, 잡음을 개선이라 부르지 못하게 못박는다.
 *
 * ⚠️ 주간 운영으로 바뀌면서 제약이 하나 **더 세졌다**: 한 번 호출에 들어오는 새 정보가
 *    **회차 1개**뿐이다. 그 1회차 결과에 맞춰 노브를 흔드는 것이 정확히 사용자가 반복 학습을
 *    중단한 이유(과잉 정합성)이므로, 근거가 표준오차를 넘지 못하면 **사양을 그대로 유지**하는
 *    것이 정답이라고 명시한다. '아무것도 바꾸지 않음'이 실패가 아니라는 것을 못박는 문장이
 *    없으면 모델은 매주 무언가를 바꾼다.
 */
const LOTTO_AGENT_IDENTITY = [
  "너는 로또 6/45 세트 구성 전략을 관리하는 연구 에이전트다.",
  "목표는 단 하나 — **가중 회차 점수의 평균을 최대화**하는 것이다.",
  "회차 점수 = 1×[3+ 적중 세트 있음] + 2×[4+ 있음] + 4×[5+ 있음] + 8×[6개 있음]. 회차당 0~15점.",
  "너는 **매주 한 번** 불린다. 한 번에 들어오는 새 정보는 방금 추첨된 **회차 1개**뿐이다.",
  "회차 1개는 표본 1이다 — 그 결과로 노브를 흔들면 잡음에 맞추는 것이고, 그것이 이 프로젝트가",
  "반복 학습을 중단한 이유(과잉 정합성)다. 근거가 표준오차를 넘지 못하면 **사양을 그대로 유지하라**.",
  "사양 유지는 실패가 아니라 정상적인 답이다. 그때 changed 는 빈 배열로 두면 된다.",
  "아직 시도하지 않은 구조가 남아 있고 그것이 목표 지표를 움직일 근거가 있을 때만 바꿔라.",
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
  "design": {                        // ★ 10세트를 **어떻게 배치할지**. 목표 지표가 여기에 걸려 있다.
    "fullCover": false,              //   true 면 45개 번호가 10세트 전체에서 최소 1회씩 등장
    "maxSetOverlap": 6,              //   1 ~ 6. 서로 다른 두 세트가 공유할 수 있는 번호 개수 상한
                                     //     (6 = 제약 없음, 1 = 어떤 두 세트도 번호 1개까지만 공유)
    "searchSteps": 0                 //   0 ~ 60. 목표 지표(가중 회차 점수)에 대한 국소탐색 스텝 수.
                                     //     0보다 크면 엔진이 가상 추첨 표본 위에서 디자인을 직접
                                     //     다듬는다. 미래 회차를 보지 않으므로 규칙 위반이 아니다.
                                     //     대신 번호를 뽑을 때 수 초가 걸린다.
  },
  "filters": {
    "sumMin": 21,                    // 21 ~ 255. 6개 합계 하한.
    "sumMax": 255,                   // sumMin ~ 255.
    "oddMin": 0,                     // 0 ~ 6. 홀수 개수 하한.
    "oddMax": 6,                     // oddMin ~ 6.
    "maxConsecutive": 6,             // 1 ~ 6. 연속번호 최대 길이.
    "maxPerDecade": 6,               // 1 ~ 6. 구간(1-9,10-19,20-29,30-39,40-45)별 최대 개수.
    "excludeLastDraw": false         // 직전 회차 당첨번호를 후보에서 제외.
                                     //   (design.fullCover=true 에서는 무시된다)
  }
}`.trim();

/** 프롬프트에 압축 표로 싣는 최근 회차 수. */
export const LOTTO_AGENT_RECENT = 20;

/** '최근 구간' 요약의 창(회차). 표준오차를 인용할 만한 최소 크기로 잡는다. */
export const LOTTO_AGENT_WINDOW = 100;

/** 프롬프트 조립에 필요한 재료. 순수 데이터라 테스트에서 그대로 만들 수 있다. */
export interface LottoEvolveContext {
  /** 다음 세대가 적용되기 시작할 회차 */
  nextRound: number;
  /** 현재(직전) 세대 */
  current: LottoStrategy;
  /**
   * **이번 주에 새로 들어온 정보** — 방금 채점한 회차(추천 10세트 + 실제 당첨번호).
   * 이 한 건이 이번 호출의 전부다. 없으면(재시도 등) null.
   */
  latest: LottoRecentRound | null;
  /** 최근 회차 결과(오래된 순, 최대 LOTTO_AGENT_RECENT) */
  recent: LottoRecentRound[];
  /** 전체 기록 요약 */
  overall: LottoSummary;
  /** 최근 LOTTO_AGENT_WINDOW 회차 요약 */
  window: LottoSummary;
  /** 최근 전략 세대들(최신이 앞). '이미 시도한 것'을 반복하지 않게 하는 유일한 재료다 */
  history: LottoStrategy[];
}

/** 소수 둘째 자리 문자열. 표가 흔들리지 않게 전 구간 동일 규칙을 쓴다. */
const f2 = (v: number) => v.toFixed(2);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** 비율의 이항 표준오차. '이 차이가 볼 만한 크기인가'를 모델이 스스로 따질 수 있게 준다. */
function binomialSe(rate: number, n: number): number {
  return n > 0 ? Math.sqrt((rate * (1 - rate)) / n) : 0;
}

function summaryLine(s: LottoSummary): string {
  const se = binomialSe(s.hit3Rate, s.rounds);
  return `${s.rounds}회차 · 가중점수 **${s.weightedRate.toFixed(4)}** · 3+적중률 ${pct(s.hit3Rate)} (±${(se * 100).toFixed(1)}%p) · 4+회차 ${s.hit4Rounds} · 5+회차 ${s.hit5Rounds} · 3+세트수(대조군) ${s.hit3Sets} · 최고적중 ${s.bestMatch} · 평균점수(대조군) ${f2(s.avgScore)}`;
}

export function buildEvolvePrompt(ctx: LottoEvolveContext): string {
  const recentTable = ctx.recent
    .map((r) => {
      const best = r.matches.length ? Math.max(...r.matches) : 0;
      return `| ${r.round} | ${r.drawDate} | ${r.drawNumbers.join(",")} + ${r.drawBonus} | ${best} | ${weightedHitScore(best)} | v${r.version} |`;
    })
    .join("\n");

  const historyTable = ctx.history
    .map((s) => {
      const d = s.spec.design;
      return `| v${s.version} | ${s.fromRound}~ | fullCover=${d.fullCover} overlap≤${d.maxSetOverlap} search=${d.searchSteps} explore=${s.spec.explore} | ${(s.hypothesis || "(없음)").replace(/\s+/g, " ").slice(0, 120)} |`;
    })
    .join("\n");

  // 새로 들어온 회차의 전체 대조표. 이번 호출의 **유일한 새 정보**라 압축하지 않고 다 보여준다.
  let latestBlock = "이번 호출에는 새로 채점된 회차가 없다(직전 갱신이 미뤄져 재시도하는 중).";
  if (ctx.latest) {
    const win = new Set(
      winningNumbers({
        round: ctx.latest.round,
        drawDate: ctx.latest.drawDate,
        numbers: ctx.latest.drawNumbers,
        bonus: ctx.latest.drawBonus,
      })
    );
    const best = ctx.latest.matches.length ? Math.max(...ctx.latest.matches) : 0;
    const rows = ctx.latest.sets
      .map((set, i) => {
        const marked = set.map((n) => (win.has(n) ? `**${n}**` : `${n}`)).join(" ");
        return `| ${i + 1} | ${marked} | ${ctx.latest?.matches[i] ?? 0} |`;
      })
      .join("\n");
    latestBlock = [
      `**${ctx.latest.round}회차 (${ctx.latest.drawDate})** — 당첨번호 ${ctx.latest.drawNumbers.join(", ")} + 보너스 ${ctx.latest.drawBonus}`,
      `적용 세대 v${ctx.latest.version} · 최고적중 **${best}개** · 가중점수 **${weightedHitScore(best)}** · 회차점수 ${ctx.latest.score}`,
      "",
      "| 세트 | 제출 번호(굵은 글씨 = 적중) | 적중 |",
      "|---|---|---|",
      rows,
    ].join("\n");
  }

  return `
# 규칙

- 로또 6/45. 매 회차 **${LOTTO_SET_COUNT}세트**를 제출하고 각 세트는 서로 다른 번호 6개다.
- 당첨번호는 본번호 6개 + **보너스 1개 = 7개**이며, 세트의 6개 중 이 7개와 겹친 개수가 그 세트의 적중 수다.
- 운영은 walk-forward 다: ${ctx.nextRound}회차 번호는 **추첨 전에** 확정해 저장하고, 추첨 후 그 저장된
  번호로만 채점한다. 즉 ${ctx.nextRound}회차 예측에 쓸 수 있는 정보는 ${ctx.nextRound - 1}회차까지의 결과뿐이다.
- 너는 **매주 한 번** 불린다. 새 정보는 회차 1개다.

# 목표 지표 (이것만 최대화한다)

**가중 회차 점수 = 1×[3+ 적중 세트 있음] + 2×[4+ 있음] + 4×[5+ 있음] + 8×[6개 있음]** (회차당 0~15점).
평가는 이 값의 **회차 평균**으로 한다.

알아 둘 것:
- 세트 1개가 3개 이상 맞힐 확률은 **${(LOTTO_P_THREE_PLUS * 100).toFixed(3)}%** 이고, 이 값은 어떤 번호를 고르든 같다.
  당첨번호가 균등 무작위이므로 고정된 6개 집합의 적중 분포는 그 집합이 무엇이든 동일하기 때문이다.
- 따라서 **'3+ 를 달성한 세트의 총 개수'는 전략이 못 바꾼다**(기대값 선형성). 아래의 '3+세트수'는
  개선 지표가 아니라 **대조군**이다 — 크게 흔들리면 그건 잡음이거나 계산이 틀린 것이다.
- 바꿀 수 있는 것은 그 적중이 **몇 개의 서로 다른 회차에 흩어지는가**다. 같은 총량이라도 한 회차에
  3개가 몰리면 1회차만 점수가 붙고, 세 회차에 하나씩 흩어지면 세 회차 모두 점수가 붙는다.
- 같은 논리로 4+/5+ 도 회차 단위로 세지만, 그 사건들은 훨씬 희귀해서 한 회차에 두 번 겹치는 일이
  거의 없다 — 즉 **가중치가 높은 항목일수록 최적화로 얻을 것이 적다.** 점수의 대부분은 3+ 항에서 온다.
- 점수(평균점수)도 대조군이다. 지난 기록에서 **어떤 전략도 무작위 기준선 ${f2(LOTTO_BASELINE_PER_ROUND)}점을
  유의하게 넘지 못했고**, 번호 선택 특징(hot/cold/gap/decay/pair/overall)의 예측 AUC 는 1234회차 실측에서
  전부 0.50 이었다. 그 축에 시간을 쓰는 것은 권하지 않는다.

# 이번 주 새 정보

${latestBlock}

# 누적 성적

- 전체: ${summaryLine(ctx.overall)}
- 최근 ${LOTTO_AGENT_WINDOW}회차: ${summaryLine(ctx.window)}

## 최근 ${ctx.recent.length}회차

| 회차 | 추첨일 | 당첨번호 + 보너스 | 최고적중 | 가중점수 | 세대 |
|---|---|---|---|---|---|
${recentTable || "| (없음) | | | | | |"}

## 이미 시도한 전략 (최신순)

| 세대 | 적용 | 핵심 설정 | 가설 |
|---|---|---|---|
${historyTable || "| (없음) | | | |"}

## 현재 전략 사양 (v${ctx.current.version}, ${ctx.current.fromRound}회차부터 적용)

\`\`\`json
${JSON.stringify(ctx.current.spec, null, 2)}
\`\`\`

현재 세대의 가설: ${ctx.current.hypothesis || "(없음)"}

# 조절 가능한 노브 (이 구조와 범위를 벗어나지 마라)

\`\`\`jsonc
${KNOB_CATALOG}
\`\`\`

# 할 일

위 기록을 읽고 **${ctx.nextRound}회차부터 적용할 전략 사양**을 내라. 판단 순서:

1. 이번 회차 결과가 누적 성적을 의미 있게 바꿨는지 먼저 따져라. 회차 1개는 표본 1이고,
   가중 점수의 회차별 값은 대부분 0 아니면 1이다 — **한 회차 결과는 근거가 되지 못한다.**
2. 근거가 표준오차를 넘지 못하면 **현재 사양을 그대로 반복해서 출력하고 changed 를 빈 배열로 둬라.**
   그렇게 두는 주가 대부분일 것이고, 그것이 정상이다.
3. 바꿀 근거가 있을 때만 바꾸고, 그때도 **노브 1~2개**만 건드려라. 위 '이미 시도한 전략' 표에서
   나쁜 결과가 나온 방향은 반복하지 마라.

# 출력 형식

아래 JSON 하나만 출력한다. 다른 텍스트를 붙이지 마라.

\`\`\`json
{
  "spec": { ...위 노브 구조 전체... },
  "changed": ["바꾼 노브 이름", "..."],
  "hypothesis": "이 사양이 가중 점수를 어떻게 바꿀 것이라 예상하는지 한 문장. 유지했다면 유지 근거를 한 문장.",
  "rationale": "왜 그렇게 판단했는지. 어떤 숫자를 근거로 삼았는지 명시. 2~4문장."
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
