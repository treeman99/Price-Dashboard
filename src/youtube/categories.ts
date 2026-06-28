import path from "node:path";
import { config } from "../config.ts";
import { DEFAULT_YOUTUBE_CATEGORIES } from "../../shared/youtube.ts";
import { createCategoryStore } from "../util/category-store.ts";

const CATEGORIES_PATH = path.join(path.dirname(config.dbPath), "youtube-categories.json");

const store = createCategoryStore(CATEGORIES_PATH, DEFAULT_YOUTUBE_CATEGORIES, "유튜브");

export const loadCategories = store.loadCategories;
export const addCategory = store.addCategory;
export const updateCategory = store.updateCategory;
export const reorderCategories = store.reorderCategories;
export const deleteCategory = store.deleteCategory;
