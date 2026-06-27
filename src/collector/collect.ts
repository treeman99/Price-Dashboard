import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { fetchNaverPrice, topListings, type NaverResult } from "./naver.ts";
import type { ResearchResult } from "./research.ts";
import { createDanawaSource } from "./sources/danawa.ts";
import { createEnuriSource } from "./sources/enuri.ts";
import { createLlmWebsearchSource } from "./sources/llm-websearch.ts";
import { collectFromSources, type FetchCache } from "./sources/orchestrator.ts";
import { delay, jitterMs } from "./sources/http.ts";
import type { PriceSource, SourceId, SourceRef, SourcePriceResult } from "./sources/types.ts";
import {
  listProducts,
  listConfirmedSources,
  upsertPricePoint,
  replaceListings,
  replaceReviews,
  recordRunStart,
  recordRunFinish,
  getRunResult,
  getProductSummary,
  pruneOldData,
  getSourceFetchCache,
  putSourceFetchCache,
} from "../db/repo.ts";
import { sendEmailReport } from "../notify/email.ts";
import type { CollectResult, PricePoint, Product, Review } from "../../shared/types.ts";

export interface CollectOptions {
  date: string; // YYYY-MM-DD
  trigger: "manual" | "schedule" | "catchup";
  /** 특정 상품만 즉시 수집 (상품 추가 직후 1차 수집용) */
  onlyProductId?: number;
}

interface Normalized {
  point: PricePoint;
  listings: ReturnType<typeof topListings>;
}

/** 채택 결과가 llm-websearch면 raw(ResearchResult)에서 리뷰를 꺼낸다. 다른 소스는 리뷰 없음. */
function reviewsFromChosen(chosen: SourcePriceResult | null): Review[] {
  if (chosen?.source !== "llm-websearch") return [];
  const raw = chosen.raw as ResearchResult | undefined;
  return Array.isArray(raw?.reviews) ? raw.reviews : [];
}

/** 네이버 백본 + 폴백으로 채택된 소스 결과 → PricePoint(+신규필드)로 정규화. */
function normalize(
  date: string,
  naver: NaverResult,
  chosen: SourcePriceResult | null
): Normalized {
  const prices = naver.candidates.map((c) => c.price);
  const avgPrice = prices.length
    ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)
    : null;

  const coupang = chosen?.coupang ?? null;
  const chosenOverall = chosen?.overallLowest ?? null;
  const llmRaw =
    chosen?.source === "llm-websearch" ? (chosen.raw as ResearchResult | undefined) : undefined;

  // danawaLowest(레거시 컬럼): 다나와 채택이면 그 전체최저가, LLM이면 research.danawaLowest.
  const danawaLowest =
    chosen?.source === "danawa"
      ? chosenOverall?.price ?? null
      : llmRaw
        ? llmRaw.danawaLowest ?? null
        : null;

  // 종합 최저가 = 네이버 백본 + 채택 소스(쿠팡/전체최저가) 중 최저
  const cands: Array<{ label: string; mall: string; value: number }> = [];
  if (naver.naverLowest != null)
    cands.push({ label: "네이버", mall: "네이버", value: naver.naverLowest });
  if (coupang) cands.push({ label: "쿠팡", mall: "쿠팡", value: coupang.price });
  if (chosenOverall)
    cands.push({
      label: chosenOverall.mall || "가격비교",
      mall: chosenOverall.mall || "가격비교",
      value: chosenOverall.price,
    });

  let overallLowest: number | null = null;
  let lowestSource = "";
  let lowestMall: string | null = null;
  for (const s of cands) {
    if (overallLowest == null || s.value < overallLowest) {
      overallLowest = s.value;
      lowestSource = s.label;
      lowestMall = s.mall;
    }
  }

  return {
    point: {
      date,
      naverLowest: naver.naverLowest,
      coupangLowest: coupang?.price ?? null,
      danawaLowest,
      avgPrice,
      overallLowest,
      lowestSource,
      coupangIsRocket: coupang ? coupang.isRocket : null,
      lowestMall,
      source: chosen?.source ?? null,
    },
    listings: topListings(naver.candidates),
  };
}

interface SourceBundle {
  danawa: PriceSource;
  enuri: PriceSource;
}

/**
 * 단일 상품 수집.
 * - 네이버 = 결정적 백본(실패 시 throw → 상위에서 per-product 격리).
 * - 가격비교 = 확정된 product_sources(danawa→enuri) 우선순위 폴백 + 최종 LLM 폴백.
 *   확정 스크래핑 소스가 없으면(§7-3 degrade) 네이버 백본 + LLM 폴백만으로 수집.
 */
async function collectProduct(
  product: Product,
  date: string,
  collectedAt: string,
  sources: SourceBundle
): Promise<PricePoint> {
  // 네이버 백본 (결정적) — 실패 시 throw
  const naver = await fetchNaverPrice(product);

  // 폴백 ref 구성
  const confirmed = listConfirmedSources(product.id);
  const scrapeRefs: SourceRef[] = confirmed
    .filter((s) => s.source === "danawa" || s.source === "enuri")
    .map((s) => ({ source: s.source as SourceId, refId: s.refId, url: s.url }));
  const llmRef: SourceRef = {
    source: "llm-websearch",
    refId: null,
    url: `llm-websearch:${product.id}`,
  };
  const refs: SourceRef[] = scrapeRefs.length > 0 ? [...scrapeRefs, llmRef] : [llmRef];

  const llmSource = createLlmWebsearchSource(product);
  const getSource = (id: SourceId): PriceSource | null => {
    if (id === "danawa") return sources.danawa;
    if (id === "enuri") return sources.enuri;
    if (id === "llm-websearch") return llmSource;
    return null;
  };

  // §11 당일 캐시: (product_id, source, date) 기준. 모든 터미널 상태를 캐시.
  const cache: FetchCache = {
    get: (ref) => getSourceFetchCache(product.id, ref.source, date),
    set: (ref, result) => putSourceFetchCache(product.id, ref.source, date, result),
  };

  const { chosen } = await collectFromSources({
    refs,
    getSource,
    cache,
    label: product.name,
    onBlocked: (r) =>
      log.warn(`소스 차단 [${product.name}/${r.source}] → 당일 스킵 + 폴백`),
  });

  const { point, listings } = normalize(date, naver, chosen);
  upsertPricePoint(product.id, point, collectedAt);
  replaceListings(product.id, date, listings);
  const reviews = reviewsFromChosen(chosen);
  if (reviews.length) replaceReviews(product.id, date, reviews);
  return point;
}

/**
 * 하루치 수집 실행. (product_id,date) upsert 라 같은 날 재실행해도 덮어쓰기(멱등).
 * 상품별 실패는 격리하고 나머지를 계속 진행한다.
 * 상품 간 순차 처리 + 2~5s 랜덤 지터(매너 §8).
 */
export async function runCollection(opts: CollectOptions): Promise<CollectResult> {
  const { date } = opts;
  const startedAt = new Date().toISOString();
  recordRunStart(date);

  const all = listProducts(true);
  const products = opts.onlyProductId
    ? all.filter((p) => p.id === opts.onlyProductId)
    : all;

  log.info(`수집 시작 [${opts.trigger}] ${date} — 대상 ${products.length}개 상품`);

  // 소스 인스턴스는 실행당 1회 생성(로컬 가드 경고 1회, 당일 백오프 상태 공유).
  const sources: SourceBundle = {
    danawa: createDanawaSource(),
    enuri: createEnuriSource(),
  };

  const perProduct: CollectResult["perProduct"] = [];
  let first = true;
  for (const p of products) {
    // 상품 간 지터 (첫 상품 제외)
    if (!first) await delay(jitterMs(2000, 5000));
    first = false;
    try {
      const point = await collectProduct(p, date, new Date().toISOString(), sources);
      perProduct.push({
        productId: p.id,
        name: p.name,
        ok: true,
        naverLowest: point.naverLowest,
        overallLowest: point.overallLowest,
        error: null,
      });
    } catch (e) {
      log.error(`상품 수집 실패 [${p.name}]: ${(e as Error).message}`);
      perProduct.push({
        productId: p.id,
        name: p.name,
        ok: false,
        naverLowest: null,
        overallLowest: null,
        error: (e as Error).message,
      });
    }
  }

  // 보존 정책
  const pruned = pruneOldData(config.historyRetentionDays);
  if (pruned > 0) log.info(`보존 정책: 오래된 가격포인트 ${pruned}개 삭제`);

  const anyOk = perProduct.some((r) => r.ok);

  // ── 알림 (수집 성공 시 1회, 멱등) ──
  const prior = getRunResult(date);
  let emailed = prior?.notified.email ?? false;

  // onlyProductId(단일 상품 즉시수집)일 때는 일일 리포트 알림을 보내지 않는다.
  if (anyOk && !opts.onlyProductId && !emailed) {
    const summaries = listProducts(true)
      .map((p) => getProductSummary(p.id))
      .filter((s): s is NonNullable<typeof s> => s != null);
    emailed = await sendEmailReport(summaries, date).catch((e) => {
      log.warn(`이메일 발송 예외: ${(e as Error).message}`);
      return false;
    });
  }

  const result: CollectResult = {
    date,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: anyOk,
    perProduct,
    notified: { email: emailed },
    error: anyOk ? null : "모든 상품 수집 실패",
  };
  recordRunFinish(result);
  log.info(
    `수집 종료 [${opts.trigger}] ${date} — 성공 ${perProduct.filter((r) => r.ok).length}/${perProduct.length}`
  );
  return result;
}
