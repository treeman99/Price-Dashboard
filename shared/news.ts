import type { NewsCategoryKey } from "./types";

/** 뉴스 7개 카테고리 메타(순서 = 표시 순서). 지침의 섹션 색상/이모지와 동일. */
export const NEWS_CATEGORIES: {
  key: NewsCategoryKey;
  label: string;
  emoji: string;
  color: string;
}[] = [
  { key: "ai", label: "AI / LLM", emoji: "🤖", color: "#4361ee" },
  { key: "robotics", label: "로봇 / 자동화", emoji: "🦾", color: "#7209b7" },
  { key: "quantum", label: "양자컴퓨터", emoji: "⚛️", color: "#f72585" },
  { key: "korea_econ", label: "국내 경제", emoji: "🇰🇷", color: "#e63946" },
  { key: "us", label: "미국 뉴스", emoji: "🇺🇸", color: "#fb8500" },
  { key: "world", label: "세계 뉴스", emoji: "🌍", color: "#2a9d8f" },
  { key: "products", label: "신제품 / 테크 가젯", emoji: "🆕", color: "#06aed5" },
];
