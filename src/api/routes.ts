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
  getStockPoints,
  upsertStockPoints,
} from "../db/repo.ts";
import { parseSourceInput } from "./sources.ts";
import { resolveCandidates } from "./resolve.ts";
import { runCollection, isPriceCollecting } from "../collector/collect.ts";
import { getEventsSnapshot, refreshEvents, isEventsCollecting } from "../events/events.ts";
import { getNewsSnapshot, refreshNews, isNewsCollecting } from "../news/news.ts";
import {
  loadCategories,
  addCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
} from "../news/categories.ts";
import {
  getYoutubeSnapshot,
  refreshYoutube,
  isYoutubeCollecting,
  getYoutubeLastAttempt,
  moveYoutubeVideo,
} from "../youtube/youtube.ts";
import {
  loadCategories as ytLoadCategories,
  addCategory as ytAddCategory,
  updateCategory as ytUpdateCategory,
  deleteCategory as ytDeleteCategory,
  reorderCategories as ytReorderCategories,
} from "../youtube/categories.ts";
import {
  loadBlocklist,
  addBlock,
  removeBlock,
  removeBlocksForCategory,
  applyBlocklist,
} from "../youtube/blocklist.ts";
import { addRecommendedChannel, removeRecommendedChannel } from "../../shared/youtube.ts";
import { markWatched, unmarkWatched, activeWatched, annotateWatched } from "../youtube/watched.ts";
import {
  loadDismissed,
  addDismiss,
  setDismissReason,
  removeDismiss,
  applyDismissed,
} from "../youtube/dismissed.ts";
import { applyRegionFilter, applyYoutubeDedup } from "../youtube/curate.ts";
import { getStockSnapshot, refreshStock, isStockCollecting } from "../stock/stock.ts";
import {
  listStocks,
  getStock,
  createStock,
  updateStock,
  deleteStock,
  reorderStocks,
} from "../stock/tickers.ts";
import { searchTicker, fetchHistory } from "../stock/quote.ts";
import {
  createHolding,
  deleteHolding,
  getHolding,
  listHoldings,
  reorderHoldings,
  summarizeHoldings,
  updateHolding,
} from "../stock/holdings.ts";
import { runPulse, isPulseRunning, getLastPulseRun } from "../stock/pulse.ts";
import { isPulseNotifyEnabled } from "../notify/pulse-imessage.ts";
import { allRecentPulseAlerts } from "../db/repo.ts";
import { getSchedule, saveSchedule } from "../scheduler/schedule-store.ts";
import { getModelSettings, saveAgentModel } from "../util/model-store.ts";
import { rescheduleAll } from "../scheduler/scheduler.ts";
import { generateCategoryDescription, shouldAutoDescribe } from "../util/category-describe.ts";
import { sendIMessage, isIMessageConfigured } from "../notify/imessage.ts";
import { log } from "../util/log.ts";
import { localDate, localDateDaysAgo } from "../util/date.ts";
import type {
  Product,
  CreateProductInput,
  UpdateProductInput,
  PeriodDays,
  ScheduleSettings,
  StockMarket,
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
    notify: { email: config.notify.email, imessage: isIMessageConfigured() },
    warnings,
  });
});

/**
 * [PoC] iMessage 테스트 발송 — 실행 중인 launchd 서비스가 osascript 로 본인에게 1건 보낸다.
 * 이 경로의 목적은 '백그라운드 서비스의 TCC(자동화) 권한이 실제로 뚫리는지' 확인이다.
 * (내 셸에서 보내면 책임 프로세스가 달라 위양성 — 반드시 서비스 프로세스가 보내야 유효한 검증)
 * 최초 호출 시 macOS '…이(가) Messages를 제어하려고 합니다' 승인 프롬프트가 뜰 수 있다.
 */
api.post("/notify/imessage/test", async (_req, res) => {
  if (!config.notify.imessage)
    return res.status(400).json({ error: "NOTIFY_IMESSAGE 가 꺼져 있습니다 (.env 에서 켜고 서비스 재시작)." });
  if (!config.notify.imessageTo)
    return res.status(400).json({ error: "IMESSAGE_TO(수신자) 미설정 (.env)." });
  const now = new Date().toLocaleString("ko-KR");
  try {
    await sendIMessage(`[Daily Dashboard] iMessage 연동 테스트 — ${now}\n이 메시지가 보이면 자동 알림 연동이 가능합니다. 📈`);
    log.info("iMessage 테스트 발송 성공");
    res.json({ ok: true, sentTo: config.notify.imessageTo });
  } catch (e) {
    log.warn(`iMessage 테스트 발송 실패: ${(e as Error).message}`);
    // stderr(-1743 미승인 등)를 그대로 내려 진단 가능하게.
    res.status(500).json({ error: (e as Error).message });
  }
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
 * 스케줄 부분 수정. 전달된 탭(price/events/news/youtube/stockKr/stockUs)만 갱신하고
 * 영구 저장한 뒤, 재시작 없이 cron 을 즉시 재등록한다. HH:mm 형식 오류면 400.
 *
 * ⚠️ 탭을 늘리면 이 화이트리스트에도 반드시 추가할 것. 빠뜨리면 UI 저장이
 *    에러 없이 조용히 무시된다(saveSchedule 이 모르는 필드를 그냥 버림).
 */
api.put("/schedule", (req, res) => {
  try {
    const body = (req.body ?? {}) as Partial<ScheduleSettings>;
    const patch: Partial<ScheduleSettings> = {};
    if (body.price !== undefined) patch.price = body.price;
    if (body.events !== undefined) patch.events = body.events;
    if (body.news !== undefined) patch.news = body.news;
    if (body.youtube !== undefined) patch.youtube = body.youtube;
    if (body.stockKr !== undefined) patch.stockKr = body.stockKr;
    if (body.stockUs !== undefined) patch.stockUs = body.stockUs;
    if (body.stockPulse !== undefined) patch.stockPulse = body.stockPulse;
    const updated = saveSchedule(patch);
    rescheduleAll();
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ── 수집·큐레이션 AI 모델 (Agent SDK) ──

/** 현재 선택된 수집·큐레이션 에이전트 + 선택 가능 목록. */
api.get("/model", (_req, res) => {
  res.json(getModelSettings());
});

/**
 * 모델 선택 변경. body: { model: string }. 허용 목록 밖이면 400.
 * 저장 즉시 반영되며(파일에서 매 수집마다 새로 읽음) 서버 재시작 없이 다음 수집/큐레이션부터 적용된다.
 */
api.put("/model", (req, res) => {
  try {
    const model = (req.body ?? {}).model;
    res.json(saveAgentModel(model));
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

/**
 * 지금 수집 (수동 트리거, 전체). 수집은 수 분 걸릴 수 있어 **백그라운드로 시작**하고 즉시 202를 반환한다.
 * 프론트는 /collect/status 를 폴링해 '수집 중'을 표시하고, 완료되면 /products 를 다시 불러온다.
 * 이미 수집 중이면(수동/정시 무관) 새로 시작하지 않고 409로 안내(중복 수집 방지).
 */
api.post("/collect", (_req, res) => {
  if (isPriceCollecting()) {
    return res.status(409).json({ error: "이미 가격 수집이 진행 중입니다.", collecting: true });
  }
  void runCollection({ date: today(), trigger: "manual" }).catch((e) =>
    log.warn(`가격 수동 수집 예외: ${(e as Error).message}`)
  );
  res.status(202).json({ started: true, collecting: true });
});

/** 가격 수집 진행 상태(프론트 폴링용). */
api.get("/collect/status", (_req, res) => {
  res.json({ collecting: isPriceCollecting() });
});

// ── 팝업 · 전시 게시판 ──

/** 최신 팝업/전시 스냅샷 */
api.get("/events", (_req, res) => {
  res.json(getEventsSnapshot());
});

/**
 * 지금 갱신 (수동). 수집은 수 분 걸릴 수 있어 **백그라운드로 시작**하고 즉시 202를 반환한다.
 * 프론트는 /events/status 를 폴링해 '수집 중'을 표시하고, 완료되면 /events 를 다시 불러온다.
 * 이미 수집 중이면(수동/정시 무관) 409로 안내. 수동 갱신은 이메일을 보내지 않음(중복 방지).
 */
api.post("/events/refresh", (_req, res) => {
  if (isEventsCollecting()) {
    return res.status(409).json({ error: "이미 팝업/전시 수집이 진행 중입니다.", collecting: true });
  }
  void refreshEvents({ trigger: "manual", notify: false }).catch((e) =>
    log.warn(`팝업/전시 수동 수집 예외: ${(e as Error).message}`)
  );
  res.status(202).json({ started: true, collecting: true });
});

/** 팝업/전시 수집 진행 상태(프론트 폴링용). */
api.get("/events/status", (_req, res) => {
  const snap = getEventsSnapshot();
  res.json({ collecting: isEventsCollecting(), updatedAt: snap?.updatedAt ?? null });
});

// ── 데일리 뉴스 다이제스트 ──

/** 최신 뉴스 스냅샷 */
api.get("/news", (_req, res) => {
  res.json(getNewsSnapshot());
});

/**
 * 지금 갱신 (수동). 수집은 1~3분 걸릴 수 있어 **백그라운드로 시작**하고 즉시 202를 반환한다.
 * 프론트는 /news/status 를 폴링해 '수집 중'을 표시하고, 완료되면 /news 를 다시 불러온다.
 * 이미 수집 중이면(수동/정시 무관) 409로 안내. 수집한 내용은 이메일로도 발송(0건이면 생략).
 */
api.post("/news/refresh", (_req, res) => {
  if (isNewsCollecting()) {
    return res.status(409).json({ error: "이미 뉴스 수집이 진행 중입니다.", collecting: true });
  }
  void refreshNews({ trigger: "manual", notify: true }).catch((e) =>
    log.warn(`뉴스 수동 수집 예외: ${(e as Error).message}`)
  );
  res.status(202).json({ started: true, collecting: true });
});

/** 뉴스 수집 진행 상태(프론트 폴링용). */
api.get("/news/status", (_req, res) => {
  const snap = getNewsSnapshot();
  res.json({ collecting: isNewsCollecting(), updatedAt: snap?.updatedAt ?? null });
});

/** 뉴스 카테고리 목록 */
api.get("/news/categories", (_req, res) => {
  res.json(loadCategories());
});

/** 카테고리 추가 — 설명이 없거나 짧으면 LLM이 수집 지침을 대신 작성(실패 시 입력값 유지) */
api.post("/news/categories", async (req, res) => {
  try {
    const { label, emoji, color, description } = req.body ?? {};
    let cat = addCategory({ label, emoji, color, description });
    if (shouldAutoDescribe(description)) {
      const generated = await generateCategoryDescription({
        kind: "news",
        label: cat.label,
        hint: typeof description === "string" ? description : undefined,
      });
      if (generated) cat = updateCategory(cat.key, { description: generated });
    }
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
 * 제외한 개별 영상 제외(카드의 [제외] 버튼, 해제 시 즉시 복원) +
 * kr 카테고리의 해외 영상 제외(카테고리 검색범위 반영 → 재수집 없이 즉시 정리).
 */
api.get("/youtube", (_req, res) => {
  const snap = applyDismissed(applyBlocklist(getYoutubeSnapshot()));
  res.json(annotateWatched(applyYoutubeDedup(applyRegionFilter(snap, ytLoadCategories()))));
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

/**
 * 유튜브 수집 진행 상태(프론트 폴링용).
 * lastAttempt 는 '갱신을 눌러도 화면이 그대로'인 상황을 설명하기 위한 것 — 수집이 실패하면
 * 기존 스냅샷을 유지하므로 updatedAt 만으로는 실패를 구분할 수 없다.
 */
api.get("/youtube/status", (_req, res) => {
  const snap = getYoutubeSnapshot();
  res.json({
    collecting: isYoutubeCollecting(),
    updatedAt: snap?.updatedAt ?? null,
    lastAttempt: getYoutubeLastAttempt(),
  });
});

/**
 * 카드(영상)를 다른 카테고리로 이동. 스냅샷을 즉시 갱신하고, 이동 사례를 재분류 기록에 남겨
 * 다음 수집 프롬프트가 학습하게 한다. 응답은 읽기 필터(차단/제외 영상/지역)를 적용한 최신 스냅샷.
 */
api.post("/youtube/move", (req, res) => {
  try {
    const { videoId, fromKey, toKey } = req.body ?? {};
    if (!videoId || !fromKey || !toKey) {
      return res.status(400).json({ error: "videoId, fromKey, toKey 가 모두 필요합니다." });
    }
    // 수집 중 이동은 완료 시점 스냅샷 덮어쓰기로 유실되므로 거부(재분류 기록도 남기지 않음).
    if (isYoutubeCollecting()) {
      return res
        .status(409)
        .json({ error: "수집이 진행 중입니다. 완료된 뒤 카드를 이동해 주세요.", collecting: true });
    }
    const snap = moveYoutubeVideo(String(videoId), String(fromKey), String(toKey));
    res.json(
      annotateWatched(
        applyYoutubeDedup(
          applyRegionFilter(applyDismissed(applyBlocklist(snap)), ytLoadCategories())
        )
      )
    );
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 유튜브 카테고리 목록 */
api.get("/youtube/categories", (_req, res) => {
  res.json(ytLoadCategories());
});

/** 카테고리 추가 — 설명이 없거나 짧으면 LLM이 수집 지침을 대신 작성(실패 시 입력값 유지) */
api.post("/youtube/categories", async (req, res) => {
  try {
    const { label, emoji, color, description, region, excludeKeywords, recommendedChannels } =
      req.body ?? {};
    let cat = ytAddCategory({
      label,
      emoji,
      color,
      description,
      region,
      excludeKeywords,
      recommendedChannels,
    });
    if (shouldAutoDescribe(description)) {
      const generated = await generateCategoryDescription({
        kind: "youtube",
        label: cat.label,
        hint: typeof description === "string" ? description : undefined,
        region: cat.region,
        excludeKeywords: cat.excludeKeywords,
        recommendedChannels: cat.recommendedChannels,
      });
      if (generated) cat = ytUpdateCategory(cat.key, { description: generated });
    }
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
    const { label, emoji, color, description, region, excludeKeywords, recommendedChannels } =
      req.body ?? {};
    const cat = ytUpdateCategory(req.params.key, {
      label,
      emoji,
      color,
      description,
      region,
      excludeKeywords,
      recommendedChannels,
    });
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
    removeBlocksForCategory(req.params.key); // 그 카테고리 전용 제외 채널도 함께 정리(고아 방지)
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ── 카테고리 추천 채널(카드 ⭐ 버튼) ──
// 다음 수집부터 큐레이션 프롬프트의 '[추천 채널(먼저 확인)]'에 주입되어 우선 조사된다.

/** 추천 채널 추가 — 이미 있으면 그대로(멱등, 저장 생략). 갱신된 카테고리 반환. */
api.post("/youtube/categories/:key/recommended-channels", (req, res) => {
  try {
    const { channel, handle } = req.body ?? {};
    const cat = ytLoadCategories().find((c) => c.key === req.params.key);
    if (!cat) return res.status(404).json({ error: "카테고리를 찾을 수 없습니다." });
    const next = addRecommendedChannel(
      cat.recommendedChannels,
      typeof channel === "string" ? channel : null,
      typeof handle === "string" ? handle : null
    );
    if (!next) return res.status(400).json({ error: "채널 정보가 없어 추천 채널로 추가할 수 없습니다." });
    if (next.length === (cat.recommendedChannels ?? []).length) return res.json(cat); // 이미 있음 → 저장 생략
    res.json(ytUpdateCategory(cat.key, { recommendedChannels: next }));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 추천 채널 해제 — 쿼리 channel/handle 과 매칭되는 항목 제거(멱등, 변화 없으면 저장 생략). */
api.delete("/youtube/categories/:key/recommended-channels", (req, res) => {
  try {
    const channel = typeof req.query.channel === "string" ? req.query.channel : null;
    const handle = typeof req.query.handle === "string" ? req.query.handle : null;
    if (!channel?.trim() && !handle?.trim())
      return res.status(400).json({ error: "해제할 채널 정보(channel 또는 handle)를 지정하세요." });
    const cat = ytLoadCategories().find((c) => c.key === req.params.key);
    if (!cat) return res.status(404).json({ error: "카테고리를 찾을 수 없습니다." });
    const next = removeRecommendedChannel(cat.recommendedChannels, channel, handle);
    if (next.length === (cat.recommendedChannels ?? []).length) return res.json(cat); // 변화 없음 → 저장 생략
    res.json(ytUpdateCategory(cat.key, { recommendedChannels: next }));
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

/** 채널 차단(카드의 '이 채널 제외' 버튼). categoryKey 지정 시 그 카테고리에서만 제외. 멱등. */
api.post("/youtube/blocklist", (req, res) => {
  try {
    const { channel, handle, categoryKey } = req.body ?? {};
    const entry = addBlock({
      channel: String(channel ?? ""),
      handle: handle ? String(handle) : null,
      categoryKey: categoryKey ? String(categoryKey) : null,
    });
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

// ── 유튜브 '본영상' 목록(수집 제외, 일정 기간 후 만료) ──

/** 현재 제외 활성인 본영상 목록(만료 제외, 최근 체크 먼저). */
api.get("/youtube/watched", (_req, res) => {
  const list = [...activeWatched()].sort((a, b) => b.watchedAt.localeCompare(a.watchedAt));
  res.json(list);
});

/** 본영상 체크(카드의 '본영상' 토글 ON). videoId 기준 멱등 — 재체크 시 제외 기간 연장. */
api.post("/youtube/watched", (req, res) => {
  try {
    const { videoId, title, channel } = req.body ?? {};
    const entry = markWatched({
      videoId: String(videoId ?? ""),
      title: title != null ? String(title) : null,
      channel: channel != null ? String(channel) : null,
    });
    res.json(entry);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 본영상 해제(토글 OFF). 다시 검색에 노출될 수 있다. */
api.delete("/youtube/watched/:videoId", (req, res) => {
  const ok = unmarkWatched(req.params.videoId);
  if (!ok) return res.status(404).json({ error: "본영상 목록에 없습니다." });
  res.json({ ok: true });
});

// ── 유튜브 영상 제외 목록(영구) ──
// 본영상(위)은 "이미 봤으니 당분간 빼줘"라 기간이 지나면 만료되지만, 이쪽은 "이런 영상은 원치 않는다"는
// 취향 신호라 만료가 없다. 해제는 관리 다이얼로그의 DELETE 로만 한다.

/** 제외 영상 목록 (최근 제외 먼저) */
api.get("/youtube/dismissed", (_req, res) => {
  const list = [...loadDismissed()].sort((a, b) => b.dismissedAt.localeCompare(a.dismissedAt));
  res.json(list);
});

/** 영상 제외(카드의 '제외' 버튼). 사유는 선택 — 원클릭 제외면 비워 둔다. videoId 기준 멱등. */
api.post("/youtube/dismissed", (req, res) => {
  try {
    const { videoId, title, channel, url, categoryKey, reason } = req.body ?? {};
    const entry = addDismiss({
      videoId: String(videoId ?? ""),
      title: title != null ? String(title) : null,
      channel: channel != null ? String(channel) : null,
      url: url != null ? String(url) : null,
      categoryKey: categoryKey != null ? String(categoryKey) : null,
      reason: reason != null ? String(reason) : null,
    });
    res.json(entry);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * 사유 붙이기/지우기(관리 다이얼로그). 빈 문자열이나 null 을 주면 사유가 지워진다.
 * addDismiss 는 기존 값을 보강만 하므로 삭제는 반드시 이 경로로 와야 한다.
 */
api.patch("/youtube/dismissed/:videoId", (req, res) => {
  const { reason } = req.body ?? {};
  const entry = setDismissReason(req.params.videoId, reason != null ? String(reason) : null);
  if (!entry) return res.status(404).json({ error: "제외 목록에 없습니다." });
  res.json(entry);
});

/** 제외 해제(되돌리기). 다음 조회부터 다시 카드로 보인다. */
api.delete("/youtube/dismissed/:videoId", (req, res) => {
  const ok = removeDismiss(req.params.videoId);
  if (!ok) return res.status(404).json({ error: "제외 목록에 없습니다." });
  res.json({ ok: true });
});

// ── 증시 ──
// 시장(kr/us)이 경로에 박히는 라우트가 많다. :market 은 신뢰 못 할 입력이므로
// 핸들러마다 parseMarket 으로 좁힌 뒤 StockMarket 으로 쓴다.
//
// ⚠️ 등록 순서 주의: GET /stock/search 는 GET /stock/:market 보다 **먼저** 와야 한다.
//    뒤에 두면 market="search" 로 먹혀 검색이 400 만 뱉는다.
//    반면 /stock/tickers/... 계열은 세그먼트 수/리터럴이 달라 :market 과 충돌하지 않는다.

const HISTORY_DAYS = 20;

/** :market 검증. kr|us 가 아니면 null → 호출부가 400. */
function parseMarket(v: unknown): StockMarket | null {
  return v === "kr" || v === "us" ? v : null;
}

/** 종목 검색(네이버 자동완성 프록시). market 쿼리로 시장을 좁힐 수 있다. */
api.get("/stock/search", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) return res.status(400).json({ error: "검색어(q)가 필요합니다." });
  try {
    const candidates = await searchTicker(q);
    // market 쿼리는 선택 — 값이 kr|us 가 아니면 필터하지 않고 전 시장을 돌려준다.
    const market = parseMarket(req.query.market);
    res.json(market ? candidates.filter((c) => c.market === market) : candidates);
  } catch (e) {
    res.status(502).json({ error: `종목 검색에 실패했습니다: ${(e as Error).message}` });
  }
});

// ── 보유 종목 (별도 탭) ────────────────────────────────
//
// ⚠️ 라우트 등록 순서: `/stock/holdings...` 는 `/stock/:market` 보다 **먼저** 와야 한다.
//    Express 는 먼저 등록된 것을 쓰므로 뒤에 두면 "holdings" 가 :market 으로 잡혀
//    "시장은 kr 또는 us" 400 이 난다. (파일 상단 /stock/search 와 같은 함정이다.)
//    → 이 블록은 반드시 `api.get("/stock/:market")` 위쪽에 등록되어야 하는데, 현재 이 파일은
//    선언 순서가 곧 등록 순서라 아래 registerHoldingRoutes() 를 상단에서 호출한다.

/** 보유 종목 + 현재가·손익. 시세 조회를 하므로 다른 목록 API 보다 느리다(수백 ms~수 초). */
api.get("/stock/holdings", async (req, res) => {
  const market = req.query.market ? parseMarket(String(req.query.market)) : undefined;
  if (req.query.market && !market)
    return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  try {
    res.json(await summarizeHoldings(market ?? undefined));
  } catch (e) {
    res.status(500).json({ error: `보유 종목 조회 실패: ${(e as Error).message}` });
  }
});

/** 시세 없이 원장만(입력 폼 초기값·순서 변경용). 빠르다. */
api.get("/stock/holdings/raw", (req, res) => {
  const market = req.query.market ? parseMarket(String(req.query.market)) : undefined;
  if (req.query.market && !market)
    return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  res.json(listHoldings(market ?? undefined));
});

/**
 * 보유 종목 추가. body: { market, query, quantity, avgPrice, targetPrice?, stopPrice?, horizon?, memo? }
 *
 * 등록 종목(stocks)에도 자동으로 들어간다(holdings.ts mirrorToTickers) — 인터뷰에서 확정한
 * 정책이다. 그래서 이 API 하나로 "보유 등록 + 일일 브리핑 대상 편입"이 함께 끝난다.
 */
api.post("/stock/holdings", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const market = parseMarket(String(b.market ?? ""));
  if (!market) return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  try {
    const holding = await createHolding({
      market,
      query: String(b.query ?? ""),
      quantity: Number(b.quantity),
      avgPrice: Number(b.avgPrice),
      targetPrice: b.targetPrice as number | null | undefined,
      stopPrice: b.stopPrice as number | null | undefined,
      horizon: b.horizon as never,
      memo: typeof b.memo === "string" ? b.memo : undefined,
    });
    res.status(201).json(holding);
  } catch (e) {
    const msg = (e as Error).message;
    // 중복 등록은 409, 나머지 입력 오류는 400. 사용자 입력 문제라 500 이 아니다.
    res.status(/이미 보유/.test(msg) ? 409 : 400).json({ error: msg });
  }
});

/** 보유 종목 수정. market/symbol 은 못 바꾼다(= 다른 종목이라는 뜻). */
api.patch("/stock/holdings/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!getHolding(id)) return res.status(404).json({ error: "보유 종목 없음" });
  const b = (req.body ?? {}) as Record<string, unknown>;
  const patch: Parameters<typeof updateHolding>[1] = {};
  // `undefined`(미지정)와 `null`(해제)의 구분을 여기서 잃으면 목표가를 지울 수 없게 된다.
  if (b.quantity !== undefined) patch.quantity = Number(b.quantity);
  if (b.avgPrice !== undefined) patch.avgPrice = Number(b.avgPrice);
  if (b.targetPrice !== undefined) patch.targetPrice = b.targetPrice as number | null;
  if (b.stopPrice !== undefined) patch.stopPrice = b.stopPrice as number | null;
  if (b.horizon !== undefined) patch.horizon = b.horizon as never;
  if (b.memo !== undefined) patch.memo = String(b.memo);
  try {
    res.json(updateHolding(id, patch));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * 보유 종목 삭제(soft). confirm 에 정확한 심볼이 필요하다 — 종목 삭제와 같은 규칙이다.
 * 등록 종목(stocks)은 **그대로 둔다**: 다 팔았어도 계속 지켜보고 싶을 수 있고,
 * 여기서 함께 지우면 그 종목의 시계열이 끊긴다.
 */
api.delete("/stock/holdings/:id", (req, res) => {
  const id = Number(req.params.id);
  const h = getHolding(id);
  if (!h) return res.status(404).json({ error: "보유 종목 없음" });
  if (req.query.confirm !== h.symbol) {
    return res
      .status(400)
      .json({ error: "삭제는 confirm 파라미터에 정확한 종목 심볼이 필요합니다." });
  }
  deleteHolding(id);
  res.json({ ok: true, keptTicker: true });
});

/** 표시 순서 변경. body: { market, ids } */
api.put("/stock/holdings/order", (req, res) => {
  const b = (req.body ?? {}) as { market?: unknown; ids?: unknown };
  const market = parseMarket(String(b.market ?? ""));
  if (!market) return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  try {
    res.json(reorderHoldings(market, (b.ids as number[]) ?? []));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ── 펄스(시간당 실시간 취합) ──────────────────────────

/**
 * 펄스 상태 — 마지막 실행 결과 + 최근 24시간 판정 목록.
 *
 * 화면에 피드를 만들지 않기로 했지만(인터뷰 결정) **상태 확인 창구는 필요하다.**
 * 이게 없으면 "펄스가 도는지, 왜 문자가 안 오는지"를 로그 파일로만 알 수 있다.
 */
api.get("/stock/pulse/status", (_req, res) => {
  res.json({
    running: isPulseRunning(),
    lastRun: getLastPulseRun(),
    notifyEnabled: isPulseNotifyEnabled(),
    schedule: getSchedule().stockPulse,
    recent: allRecentPulseAlerts(24).map((r) => ({
      id: r.id,
      at: r.createdAt,
      slot: r.slot,
      status: r.status,
      severity: r.impact.severity,
      direction: r.impact.direction,
      symbol: r.impact.symbol,
      name: r.impact.name,
      headline: r.impact.headline,
    })),
  });
});

/**
 * 펄스 지금 실행. 백오프를 무시한다(사용자가 직접 누른 것이므로).
 * 실행이 수 분 걸리므로 202 로 먼저 응답하고 백그라운드에서 돌린다(증시 수동 갱신과 같은 패턴).
 */
api.post("/stock/pulse/run", (req, res) => {
  if (isPulseRunning()) {
    return res.status(409).json({ error: "펄스가 이미 실행 중입니다.", running: true });
  }
  const notify = req.body?.notify !== false;
  const slot = new Date().toTimeString().slice(0, 5);
  void runPulse({ slot, trigger: "manual", notify, force: true }).catch((e) =>
    log.warn(`펄스 수동 실행 예외: ${(e as Error).message}`)
  );
  res.status(202).json({ started: true });
});

/**
 * 최신 증시 브리핑 스냅샷 (아직 수집 전이면 null).
 *
 * 미국장은 슬롯마다 성격이 다른 스냅샷이 최대 3개 공존한다(마감결산/개장프리뷰/혼합).
 * 응답 shape 을 깨지 않기 위해 **본문은 여전히 '가장 최신' 스냅샷 하나**이고,
 * 역할별 스냅샷은 `variants` 필드로 **덧붙인다**(기존 프론트는 이 필드를 무시하면 그만이다).
 * `?role=close|preview|both` 로 단건 조회도 가능하다.
 */
api.get("/stock/:market", (req, res) => {
  const market = parseMarket(req.params.market);
  if (!market) return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  const q = req.query.role;
  if (q === "close" || q === "preview" || q === "both") return res.json(getStockSnapshot(market, q));
  const latest = getStockSnapshot(market);
  if (!latest) return res.json(null);
  res.json({
    ...latest,
    variants: {
      close: getStockSnapshot(market, "close"),
      preview: getStockSnapshot(market, "preview"),
      both: getStockSnapshot(market, "both"),
    },
  });
});

/** 증시 수집 진행 상태(프론트 폴링용). */
api.get("/stock/:market/status", (req, res) => {
  const market = parseMarket(req.params.market);
  if (!market) return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  const snap = getStockSnapshot(market);
  res.json({ collecting: isStockCollecting(market), updatedAt: snap?.updatedAt ?? null });
});

/**
 * 지금 갱신 (수동). LLM 브리핑이라 수 분 걸리므로 **백그라운드로 시작**하고 즉시 202를 반환한다.
 * 프론트는 /stock/:market/status 를 폴링해 '수집 중'을 표시하고, 완료되면 /stock/:market 을 다시 불러온다.
 * 이미 수집 중이면 새로 시작하지 않고 409로 안내(중복 수집 방지).
 */
api.post("/stock/:market/refresh", (req, res) => {
  const market = parseMarket(req.params.market);
  if (!market) return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  if (isStockCollecting(market)) {
    return res.status(409).json({ error: "이미 증시 수집이 진행 중입니다.", collecting: true });
  }
  // slot 미지정 → refreshStock 이 런 시작 시각 기준 '가장 최근 지난 슬롯'에 귀속시킨다.
  // 그 슬롯이 이미 발송됐으면 조용히 스킵, 미발송이면 여기서 보충 발송된다.
  // 오늘 지난 슬롯이 아직 없으면(첫 슬롯 이전) 알림 없이 화면만 갱신한다 — 보내면 곧 오는
  // 첫 정시 슬롯이 같은 브리핑을 한 번 더 보낸다. '지난 슬롯만 후보'라 미래 슬롯 선점도 없다.
  void refreshStock({ market, trigger: "manual", notify: true }).catch((e) =>
    log.warn(`증시 수동 수집 예외 [${market}]: ${(e as Error).message}`)
  );
  res.status(202).json({ started: true, collecting: true });
});

/** 시장별 관심 종목 목록(표시 순서). */
api.get("/stock/:market/tickers", (req, res) => {
  const market = parseMarket(req.params.market);
  if (!market) return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  res.json(listStocks(market));
});

/**
 * 관심 종목 추가. body: { query, pinned? } — 종목코드·티커·종목명 아무거나 받는다.
 *
 * ⚠️ 사용자 입력을 quoteCode 로 그대로 쓰면 안 된다. 반드시 자동완성이 돌려준 quoteCode(reutersCode)를 쓴다.
 *    틀린 quoteCode 는 원장에 멀쩡히 등록된 것처럼 보이면서 시세 조회만 통째로 실패해 발견이 늦다.
 *
 * 등록 직후 카드가 비지 않도록 시세를 1차로 채우되(prime), **refreshStock 은 부르지 않는다** —
 * LLM 브리핑이라 수 분 걸려 요청이 타임아웃난다. fetchHistory + upsertStockPoints 만 한다.
 * prime 실패는 201 을 막지 않는다(다음 정시 수집이 채운다).
 */
api.post("/stock/:market/tickers", async (req, res) => {
  const market = parseMarket(req.params.market);
  if (!market) return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  // 수집 중 종목 변경은 진행 중인 브리핑이 쓰는 목록과 어긋나 결과가 뒤섞인다 → 거부.
  if (isStockCollecting(market)) {
    return res
      .status(409)
      .json({ error: "수집이 진행 중입니다. 완료된 뒤 종목을 추가해 주세요.", collecting: true });
  }
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) return res.status(400).json({ error: "종목명 또는 종목코드(query)가 필요합니다." });

  let candidates;
  try {
    candidates = await searchTicker(query);
  } catch (e) {
    return res.status(502).json({ error: `종목 검색에 실패했습니다: ${(e as Error).message}` });
  }
  const hit = candidates.find((c) => c.market === market);
  if (!hit) return res.status(404).json({ error: `종목을 찾지 못했습니다: ${query}` });

  let ticker;
  try {
    ticker = createStock({ ...hit, pinned: req.body?.pinned === true });
  } catch {
    return res.status(409).json({ error: "이미 등록된 종목입니다." });
  }

  try {
    const points = await fetchHistory(hit.quoteCode, market, HISTORY_DAYS);
    if (points.length) upsertStockPoints(ticker.id, points, "naver");
  } catch (e) {
    log.warn(`신규 종목 시세 1차 조회 실패 [${ticker.name}]: ${(e as Error).message}`);
  }
  res.status(201).json(ticker);
});

/**
 * 종목 수정 (표시명/고정 여부). symbol·quoteCode 는 못 바꾼다 — 그건 다른 종목이라는 뜻이고,
 * 바꾸면 기존 시계열에 엉뚱한 종가가 이어 붙는다(repo.updateStock 주석 참고).
 */
api.patch("/stock/tickers/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!getStock(id)) return res.status(404).json({ error: "종목 없음" });
  const body = (req.body ?? {}) as { name?: unknown; pinned?: unknown };
  const patch: { name?: string; pinned?: boolean } = {};
  if (body.name != null) {
    const name = String(body.name).trim();
    if (!name) return res.status(400).json({ error: "종목명은 비울 수 없습니다." });
    patch.name = name;
  }
  if (body.pinned != null) patch.pinned = body.pinned === true;
  const updated = updateStock(id, patch);
  if (!updated) return res.status(404).json({ error: "종목 없음" });
  res.json(updated);
});

/**
 * 시장 내 표시 순서 변경. 해당 시장의 활성 종목 id 전부를 원하는 순서로 { ids: number[] } 로 전달.
 * PUT /products/order · PUT /news|youtube/categories/order 와 동일한 계약.
 * 라우트 등록 순서: POST /stock/:market/tickers 와 메서드·세그먼트가 달라 충돌하지 않는다.
 */
api.put("/stock/:market/tickers/order", (req, res) => {
  const market = parseMarket(req.params.market);
  if (!market) return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  try {
    res.json(reorderStocks(market, (req.body?.ids ?? []) as number[]));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * 종목 삭제(soft delete — 시계열은 남는다). 오삭제 방지를 위해 confirm 파라미터에
 * 정확한 심볼이 일치해야 한다. DELETE /products/:id 와 동일한 계약.
 */
api.delete("/stock/tickers/:id", (req, res) => {
  const id = Number(req.params.id);
  const stock = getStock(id);
  if (!stock) return res.status(404).json({ error: "종목 없음" });
  // 추가와 같은 이유로 수집 중에는 목록을 건드리지 않는다.
  if (isStockCollecting(stock.market)) {
    return res
      .status(409)
      .json({ error: "수집이 진행 중입니다. 완료된 뒤 종목을 삭제해 주세요.", collecting: true });
  }
  if (req.query.confirm !== stock.symbol) {
    return res.status(400).json({ error: "삭제는 confirm 파라미터에 정확한 종목 심볼이 필요합니다." });
  }
  deleteStock(id);
  res.json({ ok: true });
});

/** 종목 시계열(차트용). days 는 달력일이 아니라 **거래일 행 수**다. 오름차순. */
api.get("/stock/tickers/:id/history", (req, res) => {
  const id = Number(req.params.id);
  if (!getStock(id)) return res.status(404).json({ error: "종목 없음" });
  const days = Number(req.query.days) || HISTORY_DAYS;
  res.json(getStockPoints(id, days));
});
