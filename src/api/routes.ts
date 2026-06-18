import { Router } from "express";
import { config, validateConfig } from "../config.ts";
import {
  listProducts,
  getProductSummary,
  getProductHistory,
  createProduct,
  getProductByName,
  setProductActive,
  deleteProductHard,
  getProduct,
  getRunResult,
} from "../db/repo.ts";
import { runCollection } from "../collector/collect.ts";
import { log } from "../util/log.ts";
import { localDate, localDateDaysAgo } from "../util/date.ts";
import type { CreateProductInput, PeriodDays } from "../../shared/types.ts";

export const api = Router();

function today(): string {
  return localDate();
}

api.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

api.get("/config", (_req, res) => {
  const { warnings } = validateConfig();
  res.json({
    port: config.port,
    collectTime: config.collectTime,
    notify: { email: config.notify.email, kakao: config.notify.kakao },
    warnings,
  });
});

/** 오늘 수집 상태 (catch-up/배지 표시용) */
api.get("/runs/today", (_req, res) => {
  res.json(getRunResult(today()));
});

/** 상품 요약 목록 (대시보드 카드). ?all=1 이면 비활성 포함 */
api.get("/products", (req, res) => {
  const all = req.query.all === "1";
  // all=false → 활성만, all=true → 비활성 포함
  const products = listProducts(!all);
  const summaries = products
    .map((p) => getProductSummary(p.id))
    .filter((s) => s != null);
  res.json(summaries);
});

api.get("/products/:id", (req, res) => {
  const s = getProductSummary(Number(req.params.id));
  if (!s) return res.status(404).json({ error: "상품 없음" });
  res.json(s);
});

api.get("/products/:id/history", (req, res) => {
  const id = Number(req.params.id);
  const days = (Number(req.query.days) || 30) as PeriodDays;
  const h = getProductHistory(id, localDateDaysAgo(days));
  if (!h) return res.status(404).json({ error: "상품 없음" });
  res.json(h);
});

/** 상품 추가 → 즉시 1차 수집으로 추적 시작 (F4) */
api.post("/products", async (req, res) => {
  const body = req.body as Partial<CreateProductInput>;
  if (!body.name || typeof body.name !== "string") {
    return res.status(400).json({ error: "name 필수" });
  }
  if (getProductByName(body.name)) {
    return res.status(409).json({ error: "이미 존재하는 상품명" });
  }
  const input: CreateProductInput = {
    name: body.name.trim(),
    mustInclude: Array.isArray(body.mustInclude) ? body.mustInclude : [],
    mustExclude: Array.isArray(body.mustExclude) ? body.mustExclude : [],
    minPrice: Number(body.minPrice) || 0,
  };
  const product = createProduct(input);

  // 즉시 1차 수집 (알림 없이 해당 상품만)
  try {
    await runCollection({ date: today(), trigger: "manual", onlyProductId: product.id });
  } catch (e) {
    log.warn(`신규 상품 1차 수집 실패 [${product.name}]: ${(e as Error).message}`);
  }
  res.status(201).json(getProductSummary(product.id));
});

/** 삭제: 기본 soft delete(추적 중지). ?hard=1 + confirm=상품명 일 때만 영구 삭제 */
api.delete("/products/:id", (req, res) => {
  const id = Number(req.params.id);
  const product = getProduct(id);
  if (!product) return res.status(404).json({ error: "상품 없음" });

  if (req.query.hard === "1") {
    if (req.query.confirm !== product.name) {
      return res.status(400).json({
        error: "영구 삭제는 confirm 파라미터에 정확한 상품명이 필요합니다.",
      });
    }
    deleteProductHard(id);
    return res.json({ ok: true, mode: "hard" });
  }

  setProductActive(id, false);
  res.json({ ok: true, mode: "soft" });
});

/** 추적 재개 */
api.post("/products/:id/reactivate", (req, res) => {
  const id = Number(req.params.id);
  if (!getProduct(id)) return res.status(404).json({ error: "상품 없음" });
  setProductActive(id, true);
  res.json({ ok: true });
});

/** 지금 수집 (수동 트리거, 전체) */
api.post("/collect", async (_req, res) => {
  try {
    const result = await runCollection({ date: today(), trigger: "manual" });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
