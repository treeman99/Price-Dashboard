import { log } from "./log.ts";
import { runAgentQueryText } from "./agent-query.ts";
import { getAgentModel } from "./model-store.ts";

/**
 * 카테고리 추가 시 수집 지침(description) 자동 생성.
 * 사용자는 이름(+짧은 힌트)만 입력해도, 큐레이터 에이전트가 폭넓게 검색할 수 있는
 * 상세 지침을 LLM이 대신 작성한다. 생성 실패 시 호출부는 사용자 입력을 그대로 쓴다.
 */

export interface DescribeInput {
  kind: "youtube" | "news";
  label: string;
  /** 사용자가 입력한 짧은 수집 가이드(있으면 의도 반영) */
  hint?: string;
  /** 유튜브 전용: 검색 범위 */
  region?: "kr" | "global";
  /** 유튜브 전용: 제외 키워드(지침이 이 주제를 피하도록 참고) */
  excludeKeywords?: string[];
  /** 유튜브 전용: 사용자가 지정한 추천 채널(지침에 반영) */
  recommendedChannels?: string[];
}

/** 이 길이 이상의 사용자 설명은 이미 충분한 지침으로 보고 자동 생성을 건너뛴다. */
export const AUTO_DESCRIBE_MAX_HINT = 100;

/** 사용자 설명이 없거나 짧으면 true(자동 생성 대상). */
export function shouldAutoDescribe(description: unknown): boolean {
  const s = typeof description === "string" ? description.trim() : "";
  return s.length < AUTO_DESCRIBE_MAX_HINT;
}

export function buildDescribePrompt(input: DescribeInput): string {
  const isYoutube = input.kind === "youtube";
  const medium = isYoutube ? "유튜브 영상" : "뉴스 기사";
  const hint = (input.hint ?? "").trim();
  const exclude = (input.excludeKeywords ?? []).filter(Boolean);
  const recChannels = (input.recommendedChannels ?? []).filter(Boolean);
  const regionLine = isYoutube
    ? `\n검색 범위: ${input.region === "global" ? "글로벌(해외 채널·영어 영상 포함)" : "한국 채널·한국어 영상만"}`
    : "";
  const excludeLine = exclude.length ? `\n제외 조건(참고): ${exclude.join(", ")}` : "";
  const recLine = recChannels.length ? `\n추천 채널(사용자 지정): ${recChannels.join(", ")}` : "";
  const channelRule = isYoutube
    ? recChannels.length
      ? `\n- 사용자가 지정한 추천 채널(${recChannels.join(
          ", "
        )})의 콘텐츠 성격을 반영해 검색 갈래를 잡는다(이 채널들을 우선 살펴보도록 지침에 담되, 여기에만 국한하지는 않는다).`
      : `\n- 실존한다고 확신하는 추천 채널 2~6개를 "추천 채널: ..." 형태로 끝에 포함한다(확신이 없으면 채널 추천은 생략). ${
          input.region === "global" ? "글로벌·한국 채널을 섞어도 된다" : "한국 채널만 추천한다"
        }.`
    : "";
  return `너는 ${medium} 수집 카테고리의 검색 지침(description) 작성 전문가다.
큐레이터 에이전트는 이 지침을 읽고 WebSearch로 최근 ${medium}을 찾는다. 지침이 구체적이고 갈래가 많을수록 수집이 폭넓어진다.

카테고리 이름: ${input.label.trim()}
사용자 의도(참고): ${hint || "(없음 — 이름에서 유추)"}${regionLine}${excludeLine}${recLine}

작성 규칙:
- 한국어 한 단락, 200~450자. 마크다운·따옴표·머리말 없이 지침 본문만 출력한다.
- 포함할 세부 주제·갈래를 "(1) … (2) …" 번호 목록으로 구체적으로 나열해 검색 폭을 넓힌다(2~5개 갈래).
- 다양성 문구를 포함한다(특정 브랜드·도구·주제 편중 금지, 여러 갈래를 고르게).
- 검색에 쓸만한 구체 키워드(제품명·용어)를 자연스럽게 담는다.${channelRule}
- 사용자 의도가 있으면 반드시 반영하고, 제외 조건과 겹치는 주제는 지침에 넣지 않는다.`;
}

/**
 * 지침 자동 생성. 실패/빈 결과면 null 반환(호출부는 사용자 입력으로 폴백).
 * 다이얼로그가 응답을 기다리므로 타임아웃을 짧게(90초) 잡는다.
 */
export async function generateCategoryDescription(input: DescribeInput): Promise<string | null> {
  const label = (input.label ?? "").trim();
  if (!label) return null;
  try {
    const text = await runAgentQueryText(
      buildDescribePrompt(input),
      {
        // tools:[] = 내장 도구 전체 비활성(단일 완성 응답). allowedTools는 '자동 허용'일 뿐 제한이 아님.
        tools: [],
        permissionMode: "bypassPermissions",
        settingSources: [],
        maxTurns: 1,
        model: getAgentModel(), // 대시보드에서 고른 수집·큐레이션 공통 모델
        systemPrompt:
          "너는 수집 카테고리의 검색 지침을 작성하는 전문가다. 요청된 형식의 지침 본문 한 단락만 출력한다.",
      },
      90_000,
      "카테고리 지침 생성"
    );
    // 감싼 따옴표 제거 + 개행을 공백으로 정규화(큐레이션 프롬프트의 한 줄 카테고리 목록에 인라인 삽입되므로)
    const cleaned = text.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\s*\n+\s*/g, " ").trim();
    if (!cleaned) return null;
    log.info(`카테고리 지침 자동 생성: "${label}" (${cleaned.length}자)`);
    return cleaned.slice(0, 700);
  } catch (e) {
    log.warn(`카테고리 지침 자동 생성 실패("${label}"): ${(e as Error).message}`);
    return null;
  }
}
