import type { YoutubeCategoryDef } from "./types";

/** 채널명을 알 수 없을 때 쓰는 플레이스홀더(큐레이션·UI·차단 가드 공용). 차단 키로는 부적합. */
export const UNKNOWN_CHANNEL = "(채널 미상)";

// ── 추천 채널(recommendedChannels) 헬퍼 ──
// 목록에는 "채널명", "@핸들", "채널명 (@핸들)" 문자열이 섞여 저장된다(수동 편집 + 카드 ⭐ 버튼 공용).
// 서버(추가/해제 API)와 프론트(버튼 상태)가 같은 매칭 규칙을 쓰도록 여기서 공유한다.
// ⭐ 버튼은 "채널명 (@핸들)" 형식으로 저장한다 — 채널명 표기가 흔들려도(oEmbed 실패·개명)
// 핸들로 매칭이 유지되고, 큐레이션 프롬프트에도 이름+핸들이 함께 전달돼 조사 정확도가 높다.

/** 추천 채널 매칭용 정규화: trim + 소문자 + 콤마→공백 + 연속 공백 1칸 + 앞쪽 @ 제거. */
function normChannelToken(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/,/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^@+/, "");
}

/** 저장용 채널명 소독: 콤마 제거(콤마 구분 편집 UI·프롬프트 주입과의 충돌 방지) + 공백 정리. */
function sanitizeChannelName(channel: string | null | undefined): string {
  const name = (channel ?? "").replace(/,/g, " ").replace(/\s+/g, " ").trim();
  return name === UNKNOWN_CHANNEL ? "" : name;
}

/** 목록 항목 파싱: "채널명 (@핸들)" / "@핸들" / "채널명" → 정규화된 {name, handle}. */
function parseRecommendedEntry(entry: string): { name: string; handle: string } {
  const m = /^(.*?)\s*\(@([^\s()]+)\)\s*$/.exec(entry ?? "");
  if (m) return { name: normChannelToken(m[1]), handle: normChannelToken(m[2]) };
  const t = (entry ?? "").trim();
  if (t.startsWith("@")) return { name: "", handle: normChannelToken(t) };
  return { name: normChannelToken(t), handle: "" };
}

/**
 * 카드에서 추천 목록에 저장할 값. 이름과 핸들이 모두 있으면 "채널명 (@핸들)",
 * 한쪽만 있으면 그 값. 둘 다 식별 불가면 null(버튼 비활성 조건과 동일).
 */
export function recommendedChannelValue(
  channel: string | null | undefined,
  handle: string | null | undefined
): string | null {
  const name = sanitizeChannelName(channel);
  const h = normChannelToken(handle);
  if (name && h) return `${name} (@${h})`;
  if (h) return `@${h}`;
  return name || null;
}

/** 항목 1개가 카드의 채널과 같은지: 핸들 일치 우선, 이름 항목은 이름/핸들 어느 쪽과도 매칭(수기 항목 호환). */
function entryMatches(entry: string, name: string, h: string): boolean {
  const e = parseRecommendedEntry(entry);
  if (e.handle && h && e.handle === h) return true;
  return !!e.name && ((!!name && e.name === name) || (!!h && e.name === h));
}

/** 목록에 이 채널(이름 또는 핸들 중 하나라도 일치)이 이미 있는지. */
export function isRecommendedChannel(
  list: string[] | undefined,
  channel: string | null | undefined,
  handle: string | null | undefined
): boolean {
  if (!list?.length) return false;
  const name = normChannelToken(sanitizeChannelName(channel));
  const h = normChannelToken(handle);
  if (!name && !h) return false;
  return list.some((e) => entryMatches(e, name, h));
}

/** 채널을 추가한 새 목록(이미 있으면 그대로). 추가 불가(식별 불가)면 null. */
export function addRecommendedChannel(
  list: string[] | undefined,
  channel: string | null | undefined,
  handle: string | null | undefined
): string[] | null {
  const value = recommendedChannelValue(channel, handle);
  if (!value) return null;
  const cur = list ?? [];
  if (isRecommendedChannel(cur, channel, handle)) return [...cur];
  return [...cur, value];
}

/** 이 채널(이름/핸들 매칭 항목)을 제거한 새 목록. */
export function removeRecommendedChannel(
  list: string[] | undefined,
  channel: string | null | undefined,
  handle: string | null | undefined
): string[] {
  const name = normChannelToken(sanitizeChannelName(channel));
  const h = normChannelToken(handle);
  if (!name && !h) return [...(list ?? [])];
  return (list ?? []).filter((e) => !entryMatches(e, name, h));
}

/**
 * 유튜브 소식 기본 카테고리 시드(최초 1회 저장, 이후 사용자가 추가/삭제 가능).
 * AI/LLM·신제품 리뷰를 중심으로 전문 조사하도록 description에 추천 채널/키워드를 담는다.
 */
export const DEFAULT_YOUTUBE_CATEGORIES: YoutubeCategoryDef[] = [
  {
    key: "ai",
    label: "AI · LLM",
    emoji: "🤖",
    color: "#4361ee",
    region: "global",
    description:
      "AI·LLM 모델/연구/발표를 다루는 유튜브 영상. 새 모델 공개·업데이트(GPT·Claude·Gemini·Llama·Qwen·DeepSeek·Mistral 등 상용·오픈소스 불문), " +
      "논문·기술 해설, 벤치마크 비교, 업계 동향·이슈. 특정 회사·모델 편중 금지 — 여러 모델과 연구 주제를 고르게 다룬다. " +
      "추천 채널: Two Minute Papers, AI Explained, Matt Wolfe, bycloud, Wes Roth, Yannic Kilcher, 안될공학, 조코딩",
  },
  {
    key: "reviews",
    label: "신제품 리뷰",
    emoji: "🆕",
    color: "#06aed5",
    region: "kr",
    description:
      "한국 유튜브 채널 위주의 IT·전자기기 신제품 리뷰·언박싱·비교(스마트폰·노트북·태블릿·이어폰/헤드폰·스마트워치·카메라·모니터·PC/주변기기·가전 등). " +
      "자동차·모빌리티는 제외(별도 카테고리). 추천 채널: ITSub잇섭, UNDERkg, 디에디트, 노삼사, 방구석리뷰룸",
  },
  {
    key: "tools",
    label: "AI 활용 · 도구",
    emoji: "🛠️",
    color: "#2a9d8f",
    region: "global",
    description:
      "다양한 AI 도구·모델(Claude·GPT·Gemini·Qwen·DeepSeek 등)을 실전에서 활용하는 방법·팁·강의·튜토리얼을 폭넓게 모은다" +
      "(특정 모델·도구 편중 금지 — 갈래와 도구를 고르게 섞어라). 다음 다섯 갈래를 각각 검색해 골고루 채운다: " +
      "(1) AI 코딩·개발 — Claude Code·Cursor·GitHub Copilot·Codex·Gemini CLI·Windsurf 등 코딩 에이전트 활용법·비교·바이브코딩, " +
      "(2) 이미지 생성 — Midjourney·Nano Banana·Flux·Stable Diffusion 등 프롬프트 기법·워크플로우, " +
      "(3) 영상·음악 제작 — Sora·Veo·Runway·Kling·Suno 등 AI 영상 제작법·편집 자동화, " +
      "(4) 범용 활용·생산성 — ChatGPT·Gemini·Perplexity·NotebookLM·Grok 활용법과 문서·PPT·데이터 분석·리서치·업무 자동화(n8n·Make) 꿀팁, " +
      "(5) 심화 — 에이전트 워크플로우·서브에이전트·스킬·MCP·컨텍스트 엔지니어링·로컬 LLM(Ollama·LM Studio). " +
      "각 갈래에서 최소 1~2건씩 확보하고 강의·입문 가이드·실전 꿀팁 영상을 우선한다. " +
      "추천 채널(글로벌): Matthew Berman, AICodeKing, Riley Brown, WorldofAI, Fireship, Sam Witteveen, GosuCoder " +
      "/ (한국): 조코딩, 노마드 코더, 커리어해커 알렉스, 테디노트, CONNECT AI LAB, 잔재미코딩",
  },
  {
    key: "deepdive",
    label: "딥다이브 · 인터뷰",
    emoji: "🎙️",
    color: "#7209b7",
    region: "kr",
    description:
      "기술 심층 분석·인터뷰·팟캐스트(창업자/연구자 대담, 트렌드 해설). 한국 채널 위주. " +
      "추천 채널: EO, 티타임즈TV, 안될공학, 슈카월드",
  },
];
