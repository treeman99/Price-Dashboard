import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { DEFAULT_NEWS_CATEGORIES } from "../../shared/news.ts";
import type { NewsCategoryDef } from "../../shared/types.ts";

const CATEGORIES_PATH = path.join(path.dirname(config.dbPath), "news-categories.json");

// 새 카테고리 색상 자동 배정용 팔레트(기본 7색 + 추가분).
const PALETTE = [
  "#4361ee", "#7209b7", "#f72585", "#e63946", "#fb8500", "#2a9d8f", "#06aed5",
  "#8338ec", "#ff006e", "#3a86ff", "#fb5607", "#43aa8b", "#9d4edd", "#ef476f",
];

// 이모지 자동 추론: 카테고리 이름/설명의 키워드 → 이모지. 위에서부터 먼저 매칭되는 것 사용.
const EMOJI_RULES: { kws: string[]; emoji: string }[] = [
  { kws: ["축구", "football", "soccer"], emoji: "⚽" },
  { kws: ["야구", "baseball", "kbo", "mlb"], emoji: "⚾" },
  { kws: ["농구", "basketball", "nba"], emoji: "🏀" },
  { kws: ["스포츠", "sport", "올림픽", "olympic"], emoji: "🏅" },
  { kws: ["게임", "game", "gaming", "e스포츠", "esports"], emoji: "🎮" },
  { kws: ["영화", "movie", "film", "드라마", "drama", "ott", "넷플릭스", "netflix"], emoji: "🎬" },
  { kws: ["음악", "music", "케이팝", "k-pop", "kpop", "아이돌"], emoji: "🎵" },
  { kws: ["엔터", "연예", "celebrity", "entertain"], emoji: "🎭" },
  { kws: ["코인", "암호화폐", "비트코인", "crypto", "bitcoin", "블록체인", "blockchain", "web3"], emoji: "🪙" },
  { kws: ["주식", "증시", "stock", "투자", "invest", "금융", "finance", "경제", "econom"], emoji: "💰" },
  { kws: ["부동산", "real estate", "property", "아파트", "주택"], emoji: "🏠" },
  { kws: ["바이오", "의료", "헬스", "건강", "health", "medical", "bio", "제약", "pharma"], emoji: "🏥" },
  { kws: ["과학", "science", "연구", "research"], emoji: "🔬" },
  { kws: ["우주", "space", "항공", "로켓", "rocket", "nasa", "위성"], emoji: "🚀" },
  { kws: ["환경", "기후", "climate", "environment", "친환경", "에너지", "energy"], emoji: "🌱" },
  { kws: ["교육", "education", "학교", "입시", "대학"], emoji: "📚" },
  { kws: ["여행", "travel", "관광", "항공권", "호텔"], emoji: "✈️" },
  { kws: ["음식", "요리", "food", "맛집", "레시피", "외식"], emoji: "🍴" },
  { kws: ["패션", "fashion", "뷰티", "beauty", "화장품"], emoji: "👗" },
  { kws: ["자동차", "차량", "car", "auto", "ev", "전기차", "모빌리티", "mobility"], emoji: "🚗" },
  { kws: ["정치", "politic", "국회", "선거", "election"], emoji: "🏛️" },
  { kws: ["군사", "국방", "military", "defense", "무기", "weapon"], emoji: "🛡️" },
  { kws: ["날씨", "weather", "기상"], emoji: "🌤️" },
  { kws: ["책", "도서", "문학", "book", "literature", "출판"], emoji: "📖" },
  { kws: ["반려", "동물", "펫", "pet", "animal"], emoji: "🐾" },
  { kws: ["ai", "인공지능", "머신러닝", "ml", "llm"], emoji: "🤖" },
  { kws: ["로봇", "robot", "휴머노이드"], emoji: "🦾" },
  { kws: ["양자", "quantum"], emoji: "⚛️" },
  { kws: ["신제품", "가젯", "gadget", "디바이스", "device", "출시", "launch"], emoji: "🆕" },
  { kws: ["보안", "해킹", "security", "hacking", "사이버"], emoji: "🔒" },
  { kws: ["스타트업", "startup", "벤처", "창업"], emoji: "🚀" },
];

// 매칭되는 키워드가 없을 때 쓰는 일반 이모지 풀(이름 기반으로 안정적 선택).
const GENERIC_EMOJIS = ["📰", "🗞️", "📌", "🔖", "📋", "🧭", "💡", "🌐"];

/** 카테고리 이름/설명에서 이모지를 추론한다. 없으면 이름 기반으로 일반 풀에서 고른다. */
export function autoEmoji(label: string, description?: string): string {
  const hay = `${label} ${description ?? ""}`.toLowerCase();
  for (const rule of EMOJI_RULES) {
    if (rule.kws.some((k) => hay.includes(k.toLowerCase()))) return rule.emoji;
  }
  // 키워드 미매칭: 이름 글자 합으로 결정(같은 이름 → 항상 같은 이모지)
  let sum = 0;
  for (const ch of label) sum += ch.codePointAt(0) ?? 0;
  return GENERIC_EMOJIS[sum % GENERIC_EMOJIS.length];
}

let memo: NewsCategoryDef[] | null = null;

function save(cats: NewsCategoryDef[]): void {
  try {
    fs.mkdirSync(path.dirname(CATEGORIES_PATH), { recursive: true });
    fs.writeFileSync(CATEGORIES_PATH, JSON.stringify(cats, null, 2));
  } catch (e) {
    log.warn(`뉴스 카테고리 저장 실패: ${(e as Error).message}`);
  }
}

/** 카테고리 목록 (없으면 기본 시드를 저장 후 반환). */
export function loadCategories(): NewsCategoryDef[] {
  if (memo) return memo;
  try {
    if (fs.existsSync(CATEGORIES_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CATEGORIES_PATH, "utf8"));
      if (Array.isArray(parsed) && parsed.length) {
        memo = parsed as NewsCategoryDef[];
        return memo;
      }
    }
  } catch (e) {
    log.warn(`뉴스 카테고리 로드 실패 → 기본값 사용: ${(e as Error).message}`);
  }
  memo = DEFAULT_NEWS_CATEGORIES.map((c) => ({ ...c }));
  save(memo);
  return memo;
}

function nextColor(cats: NewsCategoryDef[]): string {
  const used = new Set(cats.map((c) => c.color.toLowerCase()));
  const free = PALETTE.find((c) => !used.has(c.toLowerCase()));
  return free ?? PALETTE[cats.length % PALETTE.length];
}

export interface AddCategoryInput {
  label: string;
  emoji?: string;
  color?: string;
  description?: string;
}

/** 카테고리 추가. label 필수, 나머지는 기본값 자동 배정. */
export function addCategory(input: AddCategoryInput): NewsCategoryDef {
  const label = (input.label || "").trim();
  if (!label) throw new Error("카테고리 이름(label)을 입력하세요.");
  const cats = loadCategories();
  if (cats.some((c) => c.label === label)) throw new Error(`이미 같은 이름의 카테고리가 있습니다: ${label}`);

  const description = (input.description || "").trim() || undefined;
  const cat: NewsCategoryDef = {
    key: `c_${randomUUID().slice(0, 8)}`,
    label,
    // 이모지 미입력 시 이름/설명 기반으로 자동 배정
    emoji: (input.emoji || "").trim() || autoEmoji(label, description),
    color: (input.color || "").trim() || nextColor(cats),
    description,
  };
  cats.push(cat);
  save(cats);
  memo = cats;
  log.info(`뉴스 카테고리 추가: ${cat.emoji} ${cat.label} (${cat.key})`);
  return cat;
}

export interface UpdateCategoryInput {
  label?: string;
  emoji?: string;
  color?: string;
  description?: string;
}

/** 카테고리 수정. 전달된 필드만 갱신. 이모지를 비우면 이름/설명 기반으로 자동 재배정. */
export function updateCategory(key: string, patch: UpdateCategoryInput): NewsCategoryDef {
  const cats = loadCategories();
  const cat = cats.find((c) => c.key === key);
  if (!cat) throw new Error("카테고리를 찾을 수 없습니다.");

  if (patch.label !== undefined) {
    const label = patch.label.trim();
    if (!label) throw new Error("카테고리 이름(label)은 비울 수 없습니다.");
    if (cats.some((c) => c.key !== key && c.label === label))
      throw new Error(`이미 같은 이름의 카테고리가 있습니다: ${label}`);
    cat.label = label;
  }
  if (patch.description !== undefined) {
    cat.description = patch.description.trim() || undefined;
  }
  if (patch.color !== undefined && patch.color.trim()) {
    cat.color = patch.color.trim();
  }
  if (patch.emoji !== undefined) {
    cat.emoji = patch.emoji.trim() || autoEmoji(cat.label, cat.description);
  }

  save(cats);
  memo = cats;
  log.info(`뉴스 카테고리 수정: ${cat.emoji} ${cat.label} (${cat.key})`);
  return cat;
}

/** 카테고리 순서 재정렬. keys는 현재 전체 카테고리 키를 빠짐없이 포함해야 한다. */
export function reorderCategories(keys: string[]): NewsCategoryDef[] {
  const cats = loadCategories();
  if (!Array.isArray(keys) || keys.length !== cats.length)
    throw new Error("순서 목록이 현재 카테고리 수와 일치하지 않습니다.");
  const byKey = new Map(cats.map((c) => [c.key, c]));
  const reordered: NewsCategoryDef[] = [];
  for (const k of keys) {
    const c = byKey.get(k);
    if (!c) throw new Error(`알 수 없거나 중복된 카테고리 키: ${k}`);
    reordered.push(c);
    byKey.delete(k);
  }
  if (byKey.size) throw new Error("일부 카테고리가 순서 목록에서 누락되었습니다.");
  save(reordered);
  memo = reordered;
  return reordered;
}

/** 카테고리 삭제. 마지막 1개는 삭제 금지. */
export function deleteCategory(key: string): boolean {
  const cats = loadCategories();
  if (cats.length <= 1) throw new Error("최소 1개의 카테고리는 유지해야 합니다.");
  const idx = cats.findIndex((c) => c.key === key);
  if (idx < 0) return false;
  const [removed] = cats.splice(idx, 1);
  save(cats);
  memo = cats;
  log.info(`뉴스 카테고리 삭제: ${removed.emoji} ${removed.label} (${key})`);
  return true;
}
