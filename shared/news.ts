import type { NewsCategoryDef } from "./types";

/** 뉴스 기본 카테고리 시드(최초 1회 저장됨, 이후 사용자가 추가/삭제 가능). 색상/이모지는 지침과 동일. */
export const DEFAULT_NEWS_CATEGORIES: NewsCategoryDef[] = [
  { key: "ai", label: "AI / LLM", emoji: "🤖", color: "#4361ee", description: "AI·머신러닝·LLM·생성형 AI 모델 및 도구, 주요 AI 기업(OpenAI/Anthropic/Google 등) 소식" },
  { key: "robotics", label: "로봇 / 자동화", emoji: "🦾", color: "#7209b7", description: "로봇·휴머노이드·자율주행·드론·산업 자동화" },
  { key: "quantum", label: "양자컴퓨터", emoji: "⚛️", color: "#f72585", description: "양자컴퓨터·큐비트·양자 알고리즘·오류정정·관련 투자" },
  { key: "korea_econ", label: "국내 경제", emoji: "🇰🇷", color: "#e63946", description: "한국 경제·코스피/코스닥·부동산·금리/환율·반도체 수출·기업 실적" },
  { key: "us", label: "미국 뉴스", emoji: "🇺🇸", color: "#fb8500", description: "미국 정치/경제·연준·월스트리트·빅테크·미중 무역" },
  { key: "world", label: "세계 뉴스", emoji: "🌍", color: "#2a9d8f", description: "국제 정세·유럽/중국/중동·글로벌 시장·외교·지정학" },
  { key: "products", label: "신제품 / 테크 가젯", emoji: "🆕", color: "#06aed5", description: "신제품 출시·스마트폰/노트북/가전·테크 가젯" },
];
