import type { YoutubeCategoryDef } from "./types";

/** 채널명을 알 수 없을 때 쓰는 플레이스홀더(큐레이션·UI·차단 가드 공용). 차단 키로는 부적합. */
export const UNKNOWN_CHANNEL = "(채널 미상)";

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
      "AI·LLM 모델/연구/발표를 다루는 유튜브 영상. 새 모델(GPT·Claude·Gemini·Llama 등) 공개, 논문 해설, 업계 동향. " +
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
      "다양한 AI 도구를 실전에서 활용하는 팁·노하우·강의·튜토리얼을 폭넓게 모은다(특정 도구 편중 금지 — 여러 도구를 고르게 섞어라). " +
      "다음 세 갈래를 각각 검색해 골고루 채운다: " +
      "(1) 범용 AI 활용·생산성 — ChatGPT·Gemini·Perplexity·NotebookLM·Grok 활용법과 문서·PPT·데이터 분석·리서치·업무 자동화(n8n·Make) 꿀팁, " +
      "(2) AI 코딩 에이전트 — Cursor·GitHub Copilot·Codex·Gemini CLI·Windsurf·Cline·Claude Code의 셋업·실전·도구 비교와 바이브코딩, " +
      "(3) 심화 — 에이전트 워크플로우·루프·하네스·서브에이전트·스킬·훅·MCP·컨텍스트 엔지니어링. " +
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
