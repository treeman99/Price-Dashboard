import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { fetchNaverPrice, topListings, type NaverResult } from "./naver.ts";
import { researchProduct, type ResearchResult } from "./research.ts";
import {
  listProducts,
  upsertPricePoint,
  replaceListings,
  replaceReviews,
  recordRunStart,
  recordRunFinish,
  getRunResult,
  getProductSummary,
  pruneOldData,
} from "../db/repo.ts";
import { sendEmailReport } from "../notify/email.ts";
import { sendKakaoNotice } from "../notify/kakao.ts";
import type { CollectResult, PricePoint, Product } from "../../shared/types.ts";

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

function normalize(
  date: string,
  naver: NaverResult,
  research: ResearchResult
): Normalized {
  const prices = naver.candidates.map((c) => c.price);
  const avgPrice = prices.length
    ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)
    : null;

  const sources: Array<{ label: string; value: number }> = [];
  if (naver.naverLowest != null) sources.push({ label: "네이버", value: naver.naverLowest });
  if (research.coupangLowest != null) sources.push({ label: "쿠팡", value: research.coupangLowest });
  if (research.danawaLowest != null) sources.push({ label: "다나와", value: research.danawaLowest });
  if (research.overallLowest != null)
    sources.push({ label: research.lowestSource || "가격비교", value: research.overallLowest });

  let overallLowest: number | null = null;
  let lowestSource = "";
  for (const s of sources) {
    if (overallLowest == null || s.value < overallLowest) {
      overallLowest = s.value;
      lowestSource = s.label;
    }
  }

  return {
    point: {
      date,
      naverLowest: naver.naverLowest,
      coupangLowest: research.coupangLowest,
      danawaLowest: research.danawaLowest,
      avgPrice,
      overallLowest,
      lowestSource,
    },
    listings: topListings(naver.candidates),
  };
}

/** 단일 상품 수집 (네이버=결정적, 리서치=Agent SDK) */
async function collectProduct(product: Product, date: string, collectedAt: string) {
  // 네이버는 결정적 수집 — 실패 시 throw (상위에서 per-product 에러 기록)
  const naver = await fetchNaverPrice(product);
  // 리서치는 실패해도 EMPTY로 degrade
  const research = await researchProduct(product);

  const { point, listings } = normalize(date, naver, research);
  upsertPricePoint(product.id, point, collectedAt);
  replaceListings(product.id, date, listings);
  if (research.reviews.length) {
    replaceReviews(product.id, date, research.reviews);
  }
  return point;
}

/**
 * 하루치 수집 실행. (product_id,date) upsert 라 같은 날 재실행해도 덮어쓰기(멱등).
 * 상품별 실패는 격리하고 나머지를 계속 진행한다.
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

  const perProduct: CollectResult["perProduct"] = [];
  for (const p of products) {
    try {
      const point = await collectProduct(p, date, new Date().toISOString());
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
  let kakaoed = prior?.notified.kakao ?? false;

  // onlyProductId(단일 상품 즉시수집)일 때는 일일 리포트 알림을 보내지 않는다.
  if (anyOk && !opts.onlyProductId) {
    const summaries = listProducts(true)
      .map((p) => getProductSummary(p.id))
      .filter((s): s is NonNullable<typeof s> => s != null);
    if (!emailed) emailed = await sendEmailReport(summaries, date).catch((e) => {
      log.warn(`이메일 발송 예외: ${(e as Error).message}`);
      return false;
    });
    if (!kakaoed) kakaoed = await sendKakaoNotice(date, summaries.length);
  }

  const result: CollectResult = {
    date,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: anyOk,
    perProduct,
    notified: { email: emailed, kakao: kakaoed },
    error: anyOk ? null : "모든 상품 수집 실패",
  };
  recordRunFinish(result);
  log.info(
    `수집 종료 [${opts.trigger}] ${date} — 성공 ${perProduct.filter((r) => r.ok).length}/${perProduct.length}`
  );
  return result;
}
