import { Router } from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { getEventsSnapshot, refreshEvents } from "../events/events.ts";
import { getNewsSnapshot, refreshNews } from "../news/news.ts";
import { log } from "../util/log.ts";
import { localDate, localDateDaysAgo } from "../util/date.ts";
import type { CreateProductInput, PeriodDays } from "../../shared/types.ts";

export const api = Router();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LAUNCHD_LABEL = "com.daegun.dailyprice";
const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

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
    notify: { email: config.notify.email },
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

/** launchd 서비스 설치 여부 */
api.get("/service/status", (_req, res) => {
  res.json({ installed: fs.existsSync(plistPath), label: LAUNCHD_LABEL });
});

/**
 * launchd 서비스 제거. 이 서버 자신이 그 서비스이므로,
 * uninstall.sh 를 detached로 띄워 부모(=이 프로세스)가 bootout 되어도 스크립트가 끝까지 실행되게 한다.
 */
api.post("/service/uninstall", (_req, res) => {
  if (!fs.existsSync(plistPath)) {
    return res.status(409).json({ error: "등록된 서비스가 없습니다." });
  }
  const script = path.join(repoRoot, "service", "uninstall.sh");
  // 먼저 응답을 보내 flush 한 뒤(자기 자신 종료 대비) 분리 실행
  res.json({
    ok: true,
    message: "백그라운드 서비스를 제거합니다. 잠시 후 이 서버가 종료됩니다.",
  });
  setTimeout(() => {
    const child = spawn("/bin/bash", [script], { detached: true, stdio: "ignore" });
    child.unref();
  }, 600);
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

// ── 팝업 · 전시 게시판 ──

/** 최신 팝업/전시 스냅샷 */
api.get("/events", (_req, res) => {
  res.json(getEventsSnapshot());
});

/** 지금 갱신 (수동). 이메일은 보내지 않음(중복 방지) */
api.post("/events/refresh", async (_req, res) => {
  try {
    const snapshot = await refreshEvents({ trigger: "manual", notify: false });
    res.json(snapshot);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── 데일리 뉴스 다이제스트 ──

/** 최신 뉴스 스냅샷 */
api.get("/news", (_req, res) => {
  res.json(getNewsSnapshot());
});

/** 지금 갱신 (수동). 이메일은 보내지 않음(중복 방지) */
api.post("/news/refresh", async (_req, res) => {
  try {
    const snapshot = await refreshNews({ trigger: "manual", notify: false });
    res.json(snapshot);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
