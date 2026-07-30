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
import { sendEmailReport, sendPriceIMessage } from "../notify/email.ts";
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

/** LLM 리서치 결과에서 리뷰만 꺼낸다(가격은 쓰지 않는다 — collectProduct 주석 참고). */
function reviewsFromResearch(res: SourcePriceResult | null): Review[] {
  if (res?.source !== "llm-websearch") return [];
  const raw = res.raw as ResearchResult | undefined;
  return Array.isArray(raw?.reviews) ? raw.reviews : [];
}

/**
 * 네이버 백본 + 채택된 스크래핑 소스 결과 → PricePoint(+신규필드)로 정규화.
 *
 * 종합 최저가는 값과 **그 값이 적힌 페이지 링크(lowestUrl)를 한 쌍으로** 정한다.
 * 네이버가 최저면 네이버 Top1 리스팅, 가격비교 소스가 최저면 그 소스가 조회한 URL.
 * (예전엔 링크를 무조건 네이버 Top1로 고정해 표시가와 착지 페이지가 어긋났다.)
 */
export function normalize(
  date: string,
  naver: NaverResult,
  chosen: SourcePriceResult | null
): Normalized {
  const prices = naver.candidates.map((c) => c.price);
  const avgPrice = prices.length
    ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)
    : null;

  const chosenOverall = chosen?.overallLowest ?? null;
  const listings = topListings(naver.candidates);

  // danawaLowest(레거시 컬럼): 실제 다나와 소스를 채택했을 때만 채운다.
  // (LLM research.danawaLowest 는 페이지와 대조되지 않는 추정값이라 더 이상 쓰지 않는다.)
  const danawaLowest = chosen?.source === "danawa" ? chosenOverall?.price ?? null : null;

  // 종합 최저가 = 네이버 백본 + 채택된 가격비교 소스 중 최저. 각 후보는 자기 링크를 들고 온다.
  const cands: Array<{ label: string; mall: string; value: number; url: string | null }> = [];
  if (naver.naverLowest != null)
    cands.push({
      label: "네이버",
      mall: "네이버",
      value: naver.naverLowest,
      // naverLowest 는 가격 오름차순 후보의 1위 = listings[0] 이므로 Top1 링크가 곧 그 가격의 페이지다.
      url: listings[0]?.link ?? null,
    });
  if (chosenOverall)
    cands.push({
      label: chosenOverall.mall || "가격비교",
      mall: chosenOverall.mall || "가격비교",
      value: chosenOverall.price,
      url: chosenOverall.url,
    });

  let overallLowest: number | null = null;
  let lowestSource = "";
  let lowestMall: string | null = null;
  let lowestUrl: string | null = null;
  for (const s of cands) {
    if (overallLowest == null || s.value < overallLowest) {
      overallLowest = s.value;
      lowestSource = s.label;
      lowestMall = s.mall;
      lowestUrl = s.url;
    }
  }

  return {
    point: {
      date,
      naverLowest: naver.naverLowest,
      danawaLowest,
      avgPrice,
      overallLowest,
      lowestSource,
      lowestMall,
      lowestUrl,
      source: chosen?.source ?? null,
    },
    listings,
  };
}

interface SourceBundle {
  danawa: PriceSource;
  enuri: PriceSource;
}

/**
 * 단일 상품 수집.
 * - 네이버 = 결정적 백본(실패 시 throw → 상위에서 per-product 격리).
 * - 가격비교 = 확정된 product_sources(danawa→enuri) 우선순위 폴백. **스크래핑 소스만** 가격을 낸다.
 * - LLM 웹검색 = 리뷰 전용. 가격은 절대 채택하지 않는다.
 *
 * ⚠️ 2026-07-29: LLM 웹검색을 가격 소스에서 뺐다. 라이브 실측(10개 상품)에서 LLM 이 보고한
 *    "전체 최저가"가 자기가 준 비교 페이지의 실제 최저가와 일치한 건 2/10 뿐이었다.
 *    나머지는 카드할인·적립 반영가나 근거 없는 값이라, 대시보드에 뜬 금액과 링크를 눌러
 *    도착한 페이지의 금액이 서로 달랐다(예: 벤큐 MA320UP 990,000 표시 / 페이지 1,040,000).
 *    다나와 info·에누리 detail 스크래퍼는 가격과 링크를 같은 페이지에서 뽑으므로 이 불일치가
 *    구조적으로 발생하지 않는다. 확정된 스크래핑 ref 가 없으면 네이버 단독으로 간다.
 */
async function collectProduct(
  product: Product,
  date: string,
  collectedAt: string,
  sources: SourceBundle
): Promise<PricePoint> {
  // 네이버 백본 (결정적) — 실패 시 throw
  const naver = await fetchNaverPrice(product);

  // 가격 ref = 확정된 스크래핑 소스만 (danawa → enuri)
  const confirmed = listConfirmedSources(product.id);
  const refs: SourceRef[] = confirmed
    .filter((s) => s.source === "danawa" || s.source === "enuri")
    .map((s) => ({ source: s.source as SourceId, refId: s.refId, url: s.url }));

  const getSource = (id: SourceId): PriceSource | null => {
    if (id === "danawa") return sources.danawa;
    if (id === "enuri") return sources.enuri;
    return null;
  };

  // §11 당일 캐시: (product_id, source, date) 기준. 모든 터미널 상태를 캐시.
  const cache: FetchCache = {
    get: (ref) => getSourceFetchCache(product.id, ref.source, date),
    set: (ref, result) => putSourceFetchCache(product.id, ref.source, date, result),
  };

  const { chosen } = refs.length
    ? await collectFromSources({
        refs,
        getSource,
        cache,
        label: product.name,
        onBlocked: (r) =>
          log.warn(`소스 차단 [${product.name}/${r.source}] → 당일 스킵 + 폴백`),
      })
    : { chosen: null };

  if (!refs.length) {
    log.info(`[${product.name}] 확정된 가격비교 ref 없음 → 네이버 단독 수집`);
  }

  const { point, listings } = normalize(date, naver, chosen);
  upsertPricePoint(product.id, point, collectedAt);
  replaceListings(product.id, date, listings);

  // 리뷰는 별도 경로(LLM 웹검색). 가격 채택과 완전히 분리돼 있고, 실패해도 가격 수집엔 영향 없다.
  const research = await fetchResearchReviews(product, cache);
  const reviews = reviewsFromResearch(research);
  if (reviews.length) replaceReviews(product.id, date, reviews);
  return point;
}

/**
 * 리뷰 전용 LLM 웹리서치 1회(당일 캐시 공유). 가격 필드는 호출자가 쓰지 않는다.
 * 어떤 실패도 삼킨다 — 리뷰는 부가정보라 가격 시계열을 끊으면 안 된다.
 */
async function fetchResearchReviews(
  product: Product,
  cache: FetchCache
): Promise<SourcePriceResult | null> {
  const ref: SourceRef = {
    source: "llm-websearch",
    refId: null,
    url: `llm-websearch:${product.id}`,
  };
  const cached = cache.get(ref);
  if (cached) return cached;
  try {
    const result = await createLlmWebsearchSource(product).fetch(ref);
    cache.set(ref, result);
    return result;
  } catch (e) {
    log.warn(`리뷰 리서치 실패 [${product.name}]: ${(e as Error).message}`);
    return null;
  }
}

let priceCollecting = false;

/**
 * 단일 상품 즉시수집(상품 추가 1차 수집 / 재수집)이 진행 중인 상품 id.
 * 이 수집은 백그라운드로 도는데(§API POST /products, /products/:id/collect 는 즉시 응답한다)
 * 진행 중임을 알 방법이 없으면 프론트는 '언제 끝나는지 모르는 빈 카드'를 보여줄 수밖에 없다.
 * 카드별 '수집 중' 배지와 중복 요청 차단(409)의 유일한 근거다.
 */
const collectingProductIds = new Set<number>();

/**
 * 현재 가격 '전체 수집'(수동/정시)이 진행 중인지. 프론트 '수집 중' 배너·상태 폴링에 사용.
 * 단일 상품 즉시수집(onlyProductId)은 대시보드 전역 배너 대상이 아니므로 제외한다.
 * 수동·정시 수집 모두 runCollection 을 거치므로 두 경우 다 반영된다.
 */
export function isPriceCollecting(): boolean {
  return priceCollecting;
}

/** 즉시수집이 진행 중인 상품 id 목록(프론트 카드별 '수집 중' 폴링용). */
export function collectingProducts(): number[] {
  return [...collectingProductIds];
}

/**
 * 그 상품의 즉시수집이 이미 진행 중인지.
 *
 * 중복 실행을 막아야 하는 이유: §11 당일 캐시는 **시작 시점에 조회하고 끝에 저장**하므로
 * 진행 중인 요청을 감지하지 못한다. 같은 상품을 겹쳐 돌리면 LLM 리뷰 리서치(90~120초)가
 * 그대로 두 번 나가고, 두 실행이 같은 (product_id,date) 행에 가격을 써서 나중에 끝난 쪽이
 * 이긴다 — 실측(2026-07-30): 아블러가 겹쳐 돌아 49,000 → 39,600 으로 덮였다.
 */
export function isProductCollecting(productId: number): boolean {
  return collectingProductIds.has(productId);
}

/**
 * 하루치 수집 실행. (product_id,date) upsert 라 같은 날 재실행해도 덮어쓰기(멱등).
 * 상품별 실패는 격리하고 나머지를 계속 진행한다.
 * 상품 간 순차 처리 + 2~5s 랜덤 지터(매너 §8).
 * 전체 수집은 전역 '수집 중' 플래그, 단일 상품 즉시수집은 상품별 집합으로 표시한다
 * (둘 다 예외가 나도 finally 로 반드시 해제).
 */
export async function runCollection(opts: CollectOptions): Promise<CollectResult> {
  const onlyId = opts.onlyProductId;
  if (onlyId != null) {
    collectingProductIds.add(onlyId);
    try {
      return await runCollectionInner(opts);
    } finally {
      collectingProductIds.delete(onlyId);
    }
  }
  priceCollecting = true;
  try {
    return await runCollectionInner(opts);
  } finally {
    priceCollecting = false;
  }
}

async function runCollectionInner(opts: CollectOptions): Promise<CollectResult> {
  const { date } = opts;
  const startedAt = new Date().toISOString();
  // 단일 상품 즉시수집(상품 추가/재수집)은 '오늘의 일일 실행'이 아니므로 collect_runs 를 건드리지 않는다.
  // (건드리면 hasSuccessfulRun/getRunResult 가 오염되어 catch-up·이메일 멱등이 깨진다.)
  const isDailyRun = !opts.onlyProductId;
  if (isDailyRun) recordRunStart(date);

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

  // ── 알림 (수집 성공 시 1회, 멱등) — 이메일·iMessage 각각 독립 추적 ──
  const prior = getRunResult(date);
  let emailed = prior?.notified.email ?? false;
  let imessaged = prior?.notified.imessage ?? false;

  // onlyProductId(단일 상품 즉시수집)일 때는 일일 리포트 알림을 보내지 않는다.
  if (anyOk && !opts.onlyProductId && (!emailed || !imessaged)) {
    const summaries = listProducts(true)
      .map((p) => getProductSummary(p.id))
      .filter((s): s is NonNullable<typeof s> => s != null);
    if (!emailed) {
      emailed = await sendEmailReport(summaries, date).catch((e) => {
        log.warn(`이메일 발송 예외: ${(e as Error).message}`);
        return false;
      });
    }
    if (!imessaged) imessaged = await sendPriceIMessage(summaries, date); // 자체 catch(throw 안 함)
  }

  const result: CollectResult = {
    date,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: anyOk,
    perProduct,
    notified: { email: emailed, imessage: imessaged },
    error: anyOk ? null : "모든 상품 수집 실패",
  };
  if (isDailyRun) recordRunFinish(result);
  log.info(
    `수집 종료 [${opts.trigger}] ${date} — 성공 ${perProduct.filter((r) => r.ok).length}/${perProduct.length}`
  );
  return result;
}
