import type {
  ProductSummary,
  ProductHistory,
  CreateProductInput,
  CollectResult,
  PeriodDays,
  EventsSnapshot,
  NewsSnapshot,
  NewsCategoryDef,
  ProductSource,
  UpsertProductSourceInput,
  ResolveResult,
} from "@shared/types";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `요청 실패 (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export interface AppConfig {
  port: number;
  collectTime: string;
  notify: { email: boolean };
  warnings: string[];
}

export const api = {
  config: () => fetch("/api/config").then((r) => j<AppConfig>(r)),

  products: (all = false) =>
    fetch(`/api/products${all ? "?all=1" : ""}`).then((r) => j<ProductSummary[]>(r)),

  history: (id: number, days: PeriodDays) =>
    fetch(`/api/products/${id}/history?days=${days}`).then((r) => j<ProductHistory>(r)),

  runToday: () => fetch("/api/runs/today").then((r) => j<CollectResult | null>(r)),

  addProduct: (input: CreateProductInput) =>
    fetch("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<ProductSummary>(r)),

  softDelete: (id: number) =>
    fetch(`/api/products/${id}`, { method: "DELETE" }).then((r) => j(r)),

  hardDelete: (id: number, name: string) =>
    fetch(`/api/products/${id}?hard=1&confirm=${encodeURIComponent(name)}`, {
      method: "DELETE",
    }).then((r) => j(r)),

  reactivate: (id: number) =>
    fetch(`/api/products/${id}/reactivate`, { method: "POST" }).then((r) => j(r)),

  collectNow: () => fetch("/api/collect", { method: "POST" }).then((r) => j<CollectResult>(r)),

  // ── 상품 × 소스 ref (pcode 확정) ──
  listSources: (id: number) =>
    fetch(`/api/products/${id}/sources`).then((r) => j<ProductSource[]>(r)),

  /** pcode 확정/수정 (멱등). productId 는 경로에서 채워지므로 본문에서 생략. */
  upsertSource: (id: number, input: Omit<UpsertProductSourceInput, "productId">) =>
    fetch(`/api/products/${id}/sources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<ProductSource>(r)),

  deleteSource: (id: number, source: string) =>
    fetch(`/api/products/${id}/sources/${encodeURIComponent(source)}`, {
      method: "DELETE",
    }).then((r) => j<{ ok: boolean }>(r)),

  /** resolve 프록시: 사람이 고를 pcode 후보 목록. 실패/차단 시 candidates:[] + note. */
  resolveSource: (id: number, source = "danawa") =>
    fetch(`/api/products/${id}/resolve?source=${encodeURIComponent(source)}`).then((r) =>
      j<ResolveResult>(r)
    ),

  serviceStatus: () =>
    fetch("/api/service/status").then((r) => j<{ installed: boolean; label: string }>(r)),

  uninstallService: () =>
    fetch("/api/service/uninstall", { method: "POST" }).then((r) =>
      j<{ ok: boolean; message: string }>(r)
    ),

  events: () => fetch("/api/events").then((r) => j<EventsSnapshot | null>(r)),

  refreshEvents: () =>
    fetch("/api/events/refresh", { method: "POST" }).then((r) => j<EventsSnapshot>(r)),

  news: () => fetch("/api/news").then((r) => j<NewsSnapshot | null>(r)),

  refreshNews: () =>
    fetch("/api/news/refresh", { method: "POST" }).then((r) => j<NewsSnapshot>(r)),

  newsCategories: () =>
    fetch("/api/news/categories").then((r) => j<NewsCategoryDef[]>(r)),

  addNewsCategory: (input: { label: string; emoji?: string; color?: string; description?: string }) =>
    fetch("/api/news/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<NewsCategoryDef>(r)),

  updateNewsCategory: (
    key: string,
    patch: { label?: string; emoji?: string; color?: string; description?: string }
  ) =>
    fetch(`/api/news/categories/${encodeURIComponent(key)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => j<NewsCategoryDef>(r)),

  deleteNewsCategory: (key: string) =>
    fetch(`/api/news/categories/${encodeURIComponent(key)}`, { method: "DELETE" }).then((r) =>
      j<{ ok: boolean }>(r)
    ),

  reorderNewsCategories: (keys: string[]) =>
    fetch("/api/news/categories/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    }).then((r) => j<NewsCategoryDef[]>(r)),
};
