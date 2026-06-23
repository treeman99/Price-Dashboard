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

  const cat: NewsCategoryDef = {
    key: `c_${randomUUID().slice(0, 8)}`,
    label,
    emoji: (input.emoji || "📰").trim() || "📰",
    color: (input.color || "").trim() || nextColor(cats),
    description: (input.description || "").trim() || undefined,
  };
  cats.push(cat);
  save(cats);
  memo = cats;
  log.info(`뉴스 카테고리 추가: ${cat.emoji} ${cat.label} (${cat.key})`);
  return cat;
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
