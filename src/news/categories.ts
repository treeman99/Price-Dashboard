import path from "node:path";
import { config } from "../config.ts";
import { DEFAULT_NEWS_CATEGORIES } from "../../shared/news.ts";
import {
  autoEmoji,
  createCategoryStore,
  type AddCategoryInput,
  type UpdateCategoryInput,
} from "../util/category-store.ts";

const CATEGORIES_PATH = path.join(path.dirname(config.dbPath), "news-categories.json");

const store = createCategoryStore(CATEGORIES_PATH, DEFAULT_NEWS_CATEGORIES, "뉴스");

export const loadCategories = store.loadCategories;
export const addCategory = store.addCategory;
export const updateCategory = store.updateCategory;
export const reorderCategories = store.reorderCategories;
export const deleteCategory = store.deleteCategory;

export { autoEmoji };
export type { AddCategoryInput, UpdateCategoryInput };
