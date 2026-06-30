import type {
  ProductSummary,
  ProductHistory,
  CreateProductInput,
  CollectResult,
  PeriodDays,
  EventsSnapshot,
  NewsSnapshot,
  NewsCategoryDef,
  YoutubeSnapshot,
  YoutubeCategoryDef,
  BlockedChannel,
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

  products: () => fetch("/api/products").then((r) => j<ProductSummary[]>(r)),

  history: (id: number, days: PeriodDays) =>
    fetch(`/api/products/${id}/history?days=${days}`).then((r) => j<ProductHistory>(r)),

  runToday: () => fetch("/api/runs/today").then((r) => j<CollectResult | null>(r)),

  addProduct: (input: CreateProductInput) =>
    fetch("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<ProductSummary>(r)),

  /** 영구 삭제(가격 이력 포함). 오삭제 방지로 상품명을 confirm 으로 전달. */
  deleteProduct: (id: number, name: string) =>
    fetch(`/api/products/${id}?confirm=${encodeURIComponent(name)}`, {
      method: "DELETE",
    }).then((r) => j(r)),

  /** 대시보드 카드 표시 순서 변경(전체 상품 id 순서 전달). 재정렬된 요약 목록 반환. */
  reorderProducts: (ids: number[]) =>
    fetch("/api/products/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).then((r) => j<ProductSummary[]>(r)),

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

  addNewsCategory: (input: {
    label: string;
    emoji?: string;
    color?: string;
    description?: string;
    region?: "kr" | "global";
    excludeKeywords?: string[];
  }) =>
    fetch("/api/news/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<NewsCategoryDef>(r)),

  updateNewsCategory: (
    key: string,
    patch: {
      label?: string;
      emoji?: string;
      color?: string;
      description?: string;
      region?: "kr" | "global";
      excludeKeywords?: string[];
    }
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

  // ── 유튜브 소식 ──
  youtube: () => fetch("/api/youtube").then((r) => j<YoutubeSnapshot | null>(r)),

  /**
   * 수집을 백그라운드로 시작(202)하고 즉시 반환. 이미 수집 중이면 409 → { busy: true }.
   * 완료 여부는 youtubeStatus() 폴링으로 확인한다.
   */
  refreshYoutube: async (): Promise<{ started: boolean; busy: boolean }> => {
    const res = await fetch("/api/youtube/refresh", { method: "POST" });
    if (res.status === 409) return { started: false, busy: true };
    await j<{ started: boolean }>(res); // 202; 비정상(5xx)이면 throw
    return { started: true, busy: false };
  },

  youtubeStatus: () =>
    fetch("/api/youtube/status").then((r) =>
      j<{ collecting: boolean; updatedAt: string | null }>(r)
    ),

  youtubeCategories: () =>
    fetch("/api/youtube/categories").then((r) => j<YoutubeCategoryDef[]>(r)),

  addYoutubeCategory: (input: {
    label: string;
    emoji?: string;
    color?: string;
    description?: string;
    region?: "kr" | "global";
    excludeKeywords?: string[];
  }) =>
    fetch("/api/youtube/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<YoutubeCategoryDef>(r)),

  updateYoutubeCategory: (
    key: string,
    patch: {
      label?: string;
      emoji?: string;
      color?: string;
      description?: string;
      region?: "kr" | "global";
      excludeKeywords?: string[];
    }
  ) =>
    fetch(`/api/youtube/categories/${encodeURIComponent(key)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => j<YoutubeCategoryDef>(r)),

  deleteYoutubeCategory: (key: string) =>
    fetch(`/api/youtube/categories/${encodeURIComponent(key)}`, { method: "DELETE" }).then((r) =>
      j<{ ok: boolean }>(r)
    ),

  reorderYoutubeCategories: (keys: string[]) =>
    fetch("/api/youtube/categories/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    }).then((r) => j<YoutubeCategoryDef[]>(r)),

  // ── 유튜브 채널 차단(조사 제외) ──
  youtubeBlocklist: () =>
    fetch("/api/youtube/blocklist").then((r) => j<BlockedChannel[]>(r)),

  blockYoutubeChannel: (input: { channel: string; handle?: string | null }) =>
    fetch("/api/youtube/blocklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<BlockedChannel>(r)),

  unblockYoutubeChannel: (id: string) =>
    fetch(`/api/youtube/blocklist/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) =>
      j<{ ok: boolean }>(r)
    ),
};
