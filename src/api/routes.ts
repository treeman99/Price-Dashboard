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
  updateProduct,
  getProductByName,
  deleteProductHard,
  reorderProducts,
  getProduct,
  getRunResult,
  listProductSources,
  upsertProductSource,
  deleteProductSource,
} from "../db/repo.ts";
import { parseSourceInput } from "./sources.ts";
import { resolveCandidates } from "./resolve.ts";
import { runCollection } from "../collector/collect.ts";
import { getEventsSnapshot, refreshEvents } from "../events/events.ts";
import { getNewsSnapshot, refreshNews } from "../news/news.ts";
import {
  loadCategories,
  addCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
} from "../news/categories.ts";
import { getYoutubeSnapshot, refreshYoutube, isYoutubeCollecting } from "../youtube/youtube.ts";
import {
  loadCategories as ytLoadCategories,
  addCategory as ytAddCategory,
  updateCategory as ytUpdateCategory,
  deleteCategory as ytDeleteCategory,
  reorderCategories as ytReorderCategories,
} from "../youtube/categories.ts";
import { loadBlocklist, addBlock, removeBlock, applyBlocklist } from "../youtube/blocklist.ts";
import { applyRegionFilter } from "../youtube/curate.ts";
import { getSchedule, saveSchedule } from "../scheduler/schedule-store.ts";
import { rescheduleAll } from "../scheduler/scheduler.ts";
import { log } from "../util/log.ts";
import { localDate, localDateDaysAgo } from "../util/date.ts";
import type {
  Product,
  CreateProductInput,
  UpdateProductInput,
  PeriodDays,
  ScheduleSettings,
} from "../../shared/types.ts";
import type { ResolveQuery } from "../collector/sources/types.ts";

export const api = Router();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LAUNCHD_LABEL = "com.daegun.dailyprice";
const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

function today(): string {
  return localDate();
}

// ── 상품 입력 정규화(신뢰 못 할 body 방어) ──
/** mustInclude 를 string[][] 형태로 얕게 정규화. 배열 아닌 원소/문자열 아닌 토큰 제거. */
function sanitizeInclude(v: unknown): string[][] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((g): g is unknown[] => Array.isArray(g))
    .map((g) => g.filter((t): t is string => typeof t === "string"));
}
/** mustExclude 를 string[] 로 얕게 정규화. */
function sanitizeExclude(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is string => typeof t === "string");
}
/** 최소가(원) 정규화: 유한 정수, 음수는 0으로 클램프. */
function sanitizeMinPrice(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
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

// ── 탭별 자동 수집 시각 (스케줄) ──

/** 현재 유효 스케줄(.env 기본값 + 사용자 변경 병합). */
api.get("/schedule", (_req, res) => {
  res.json(getSchedule());
});

/**
 * 스케줄 부분 수정. 전달된 탭(price/events/news/youtube)만 갱신하고 영구 저장한 뒤,
 * 재시작 없이 cron 을 즉시 재등록한다. HH:mm 형식 오류면 400.
 */
api.put("/schedule", (req, res) => {
  try {
    const body = (req.body ?? {}) as Partial<ScheduleSettings>;
    const patch: Partial<ScheduleSettings> = {};
    if (body.price !== undefined) patch.price = body.price;
    if (body.events !== undefined) patch.events = body.events;
    if (body.news !== undefined) patch.news = body.news;
    if (body.youtube !== undefined) patch.youtube = body.youtube;
    const updated = saveSchedule(patch);
    rescheduleAll();
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 상품 요약 목록 (대시보드 카드). 추적 중인 전체 상품. */
api.get("/products", (_req, res) => {
  const products = listProducts();
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
  const body = (req.body ?? {}) as Partial<CreateProductInput>;
  // dedup 검사 전에 trim: 저장은 trim된 name으로 하므로 raw name으로 검사하면 공백 차이로 우회된다.
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return res.status(400).json({ error: "name 필수" });
  }
  if (getProductByName(name)) {
    return res.status(409).json({ error: "이미 존재하는 상품명" });
  }
  const input: CreateProductInput = {
    name,
    mustInclude: sanitizeInclude(body.mustInclude),
    mustExclude: sanitizeExclude(body.mustExclude),
    minPrice: sanitizeMinPrice(body.minPrice),
  };
  // UNIQUE 충돌(동시 요청 등)이 나도 async 핸들러가 hang 하지 않도록 명시적으로 409 응답.
  let product: Product;
  try {
    product = createProduct(input);
  } catch {
    return res.status(409).json({ error: "이미 존재하는 상품명" });
  }

  // 즉시 1차 수집 (알림 없이 해당 상품만)
  try {
    await runCollection({ date: today(), trigger: "manual", onlyProductId: product.id });
  } catch (e) {
    log.warn(`신규 상품 1차 수집 실패 [${product.name}]: ${(e as Error).message}`);
  }
  res.status(201).json(getProductSummary(product.id));
});

/**
 * 대시보드 카드 표시 순서 변경. 전체 상품 id 를 원하는 순서대로 { ids: number[] } 로 전달.
 * 성공 시 재정렬된 상품 요약 목록(GET /products 와 동일 형태)을 반환.
 * 카테고리 순서 변경(PUT /news|youtube/categories/order)과 동일한 계약.
 * 라우트 등록 순서: GET/DELETE /products/:id 는 메서드가 달라 충돌하지 않는다.
 */
api.put("/products/order", (req, res) => {
  try {
    const ids = (req.body?.ids ?? []) as number[];
    const products = reorderProducts(ids); // 재정렬된 목록을 그대로 재사용(중복 조회 제거)
    const summaries = products
      .map((p) => getProductSummary(p.id))
      .filter((s) => s != null);
    res.json(summaries);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * 삭제: 영구 삭제(하드). 가격 이력·Top3·리뷰·소스 ref·당일 캐시까지 cascade 정리.
 * 오삭제 방지를 위해 confirm 파라미터에 정확한 상품명이 일치해야 한다.
 * 삭제된 상품은 더 이상 수집/이메일 대상이 아니다.
 */
api.delete("/products/:id", (req, res) => {
  const id = Number(req.params.id);
  const product = getProduct(id);
  if (!product) return res.status(404).json({ error: "상품 없음" });
  if (req.query.confirm !== product.name) {
    return res.status(400).json({
      error: "영구 삭제는 confirm 파라미터에 정확한 상품명이 필요합니다.",
    });
  }
  deleteProductHard(id);
  res.json({ ok: true, mode: "hard" });
});

/**
 * 상품 정보 수정 (검색어/포함·제외 규칙/최소가). 부분 수정 — 전달된 필드만 갱신.
 * 가격 이력·표시 순서·추적 여부는 유지한다. 매칭 규칙 변경은 다음 수집부터 반영.
 * name 을 바꾸는 경우 다른 상품과 중복이면 409.
 */
api.patch("/products/:id", (req, res) => {
  const id = Number(req.params.id);
  const product = getProduct(id);
  if (!product) return res.status(404).json({ error: "상품 없음" });

  const body = (req.body ?? {}) as Partial<UpdateProductInput>;
  const patch: UpdateProductInput = {};

  if (body.name != null) {
    const name = String(body.name).trim();
    if (!name) return res.status(400).json({ error: "상품명은 비울 수 없습니다." });
    const dup = getProductByName(name);
    if (dup && dup.id !== id) return res.status(409).json({ error: "이미 존재하는 상품명" });
    patch.name = name;
  }
  if (Array.isArray(body.mustInclude)) patch.mustInclude = sanitizeInclude(body.mustInclude);
  if (Array.isArray(body.mustExclude)) patch.mustExclude = sanitizeExclude(body.mustExclude);
  if (body.minPrice != null) patch.minPrice = sanitizeMinPrice(body.minPrice);

  updateProduct(id, patch);
  res.json(getProductSummary(id));
});

/**
 * 단일 상품만 즉시 재수집. 매칭 규칙(검색어/포함·제외/최소가)을 고친 뒤 오늘 가격을
 * 바로 정정할 때 사용. 이메일은 보내지 않고(onlyProductId 경로) 갱신된 요약을 반환.
 */
api.post("/products/:id/collect", async (req, res) => {
  const id = Number(req.params.id);
  const product = getProduct(id);
  if (!product) return res.status(404).json({ error: "상품 없음" });
  try {
    await runCollection({ date: today(), trigger: "manual", onlyProductId: id });
    res.json(getProductSummary(id));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── 상품 × 소스 ref (watchlist / pcode 확정) ──────────────

/** 상품의 소스 ref 목록 (danawa→enuri→llm 정렬). */
api.get("/products/:id/sources", (req, res) => {
  const id = Number(req.params.id);
  if (!getProduct(id)) return res.status(404).json({ error: "상품 없음" });
  res.json(listProductSources(id));
});

/**
 * 소스 ref upsert (pcode 확정/수정). (product_id, source) 멱등.
 * confirmed:true 로 보내면 그 소스를 사람이 확정한 것으로 표시(매일 고정 ref 재조회 대상).
 */
api.post("/products/:id/sources", (req, res) => {
  const id = Number(req.params.id);
  if (!getProduct(id)) return res.status(404).json({ error: "상품 없음" });
  const parsed = parseSourceInput(id, req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  res.json(upsertProductSource(parsed.value));
});

/** 소스 ref 삭제. */
api.delete("/products/:id/sources/:source", (req, res) => {
  const id = Number(req.params.id);
  if (!getProduct(id)) return res.status(404).json({ error: "상품 없음" });
  deleteProductSource(id, req.params.source);
  res.json({ ok: true });
});

/**
 * resolve 프록시: 상품의 name/mustInclude/mustExclude/minPrice 로 가격비교 검색 1회 호출,
 * 사람이 고를 pcode 후보(refId/title/url)를 반환. 사람이 하나 골라 POST(confirmed:true)로 확정한다.
 * 외부 호출 실패/차단 시에도 200 + { candidates: [], note } 로 안내(서버 죽이지 않음).
 */
api.get("/products/:id/resolve", async (req, res) => {
  const id = Number(req.params.id);
  const product = getProduct(id);
  if (!product) return res.status(404).json({ error: "상품 없음" });
  const source =
    typeof req.query.source === "string" && req.query.source.trim()
      ? req.query.source.trim()
      : "danawa";
  const q: ResolveQuery = {
    name: product.name,
    mustInclude: product.mustInclude,
    mustExclude: product.mustExclude,
    minPrice: product.minPrice,
  };
  try {
    res.json(await resolveCandidates(source, q));
  } catch (e) {
    // resolveCandidates 가 자체 try/catch 하지만 최종 안전망.
    res.json({ source, candidates: [], note: `resolve 실패: ${(e as Error).message}` });
  }
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

/** 지금 갱신 (수동). 수집한 내용을 이메일로도 발송(0건이면 생략). */
api.post("/news/refresh", async (_req, res) => {
  try {
    const snapshot = await refreshNews({ trigger: "manual", notify: true });
    res.json(snapshot);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** 뉴스 카테고리 목록 */
api.get("/news/categories", (_req, res) => {
  res.json(loadCategories());
});

/** 카테고리 추가 */
api.post("/news/categories", (req, res) => {
  try {
    const { label, emoji, color, description } = req.body ?? {};
    const cat = addCategory({ label, emoji, color, description });
    res.json(cat);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 카테고리 순서 변경 (전체 key 순서 전달) */
api.put("/news/categories/order", (req, res) => {
  try {
    const keys = (req.body?.keys ?? []) as string[];
    const cats = reorderCategories(keys);
    res.json(cats);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 카테고리 수정 */
api.patch("/news/categories/:key", (req, res) => {
  try {
    const { label, emoji, color, description } = req.body ?? {};
    const cat = updateCategory(req.params.key, { label, emoji, color, description });
    res.json(cat);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 카테고리 삭제 */
api.delete("/news/categories/:key", (req, res) => {
  try {
    const ok = deleteCategory(req.params.key);
    if (!ok) return res.status(404).json({ error: "카테고리를 찾을 수 없습니다." });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ── 유튜브 소식 ──

/**
 * 최신 유튜브 스냅샷. 읽기 시점 필터: 차단 채널 제외(해제 시 즉시 복원) +
 * kr 카테고리의 해외 영상 제외(카테고리 검색범위 반영 → 재수집 없이 즉시 정리).
 */
api.get("/youtube", (_req, res) => {
  const snap = applyBlocklist(getYoutubeSnapshot());
  res.json(applyRegionFilter(snap, ytLoadCategories()));
});

/**
 * 지금 갱신 (수동). 수집은 수 분~수십 분 걸리므로 **백그라운드로 시작**하고 즉시 202를 반환한다.
 * 프론트는 /youtube/status 를 폴링해 '수집 중'을 표시하고, 완료되면 /youtube 를 다시 불러온다.
 * 이미 수집 중이면 새로 시작하지 않고 409로 안내(중복 수집 방지).
 */
api.post("/youtube/refresh", (_req, res) => {
  if (isYoutubeCollecting()) {
    return res.status(409).json({ error: "이미 유튜브 수집이 진행 중입니다.", collecting: true });
  }
  // 응답을 막지 않도록 await 하지 않고 시작(내부에서 running 가드/이메일/저장 처리).
  void refreshYoutube({ trigger: "manual", notify: true }).catch((e) =>
    log.warn(`유튜브 수동 수집 예외: ${(e as Error).message}`)
  );
  res.status(202).json({ started: true, collecting: true });
});

/** 유튜브 수집 진행 상태(프론트 폴링용). */
api.get("/youtube/status", (_req, res) => {
  const snap = getYoutubeSnapshot();
  res.json({ collecting: isYoutubeCollecting(), updatedAt: snap?.updatedAt ?? null });
});

/** 유튜브 카테고리 목록 */
api.get("/youtube/categories", (_req, res) => {
  res.json(ytLoadCategories());
});

/** 카테고리 추가 */
api.post("/youtube/categories", (req, res) => {
  try {
    const { label, emoji, color, description, region, excludeKeywords } = req.body ?? {};
    const cat = ytAddCategory({ label, emoji, color, description, region, excludeKeywords });
    res.json(cat);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 카테고리 순서 변경 (전체 key 순서 전달) */
api.put("/youtube/categories/order", (req, res) => {
  try {
    const keys = (req.body?.keys ?? []) as string[];
    const cats = ytReorderCategories(keys);
    res.json(cats);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 카테고리 수정 */
api.patch("/youtube/categories/:key", (req, res) => {
  try {
    const { label, emoji, color, description, region, excludeKeywords } = req.body ?? {};
    const cat = ytUpdateCategory(req.params.key, { label, emoji, color, description, region, excludeKeywords });
    res.json(cat);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 카테고리 삭제 */
api.delete("/youtube/categories/:key", (req, res) => {
  try {
    const ok = ytDeleteCategory(req.params.key);
    if (!ok) return res.status(404).json({ error: "카테고리를 찾을 수 없습니다." });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ── 유튜브 채널 차단 목록(조사 제외) ──

/** 차단 채널 목록 (최근 차단 먼저) */
api.get("/youtube/blocklist", (_req, res) => {
  const list = [...loadBlocklist()].sort((a, b) => b.blockedAt.localeCompare(a.blockedAt));
  res.json(list);
});

/** 채널 차단(카드의 '이 채널 제외' 버튼). 멱등. */
api.post("/youtube/blocklist", (req, res) => {
  try {
    const { channel, handle } = req.body ?? {};
    const entry = addBlock({ channel: String(channel ?? ""), handle: handle ? String(handle) : null });
    res.json(entry);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 차단 해제(되돌리기). id는 channelKey. */
api.delete("/youtube/blocklist/:id", (req, res) => {
  const ok = removeBlock(req.params.id);
  if (!ok) return res.status(404).json({ error: "차단 목록에 없습니다." });
  res.json({ ok: true });
});
