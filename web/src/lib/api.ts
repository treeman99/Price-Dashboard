import type {
  ProductSummary,
  ProductHistory,
  CreateProductInput,
  CollectResult,
  PeriodDays,
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
  notify: { email: boolean; kakao: boolean };
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

  serviceStatus: () =>
    fetch("/api/service/status").then((r) => j<{ installed: boolean; label: string }>(r)),

  uninstallService: () =>
    fetch("/api/service/uninstall", { method: "POST" }).then((r) =>
      j<{ ok: boolean; message: string }>(r)
    ),
};
