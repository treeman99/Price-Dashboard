import { config } from "../config.ts";
import { log, withRetry } from "../util/log.ts";
import { cleanTitle, isValidCandidate } from "./filters.ts";
import type { Product, Listing } from "../../shared/types.ts";

const ENDPOINT = "https://openapi.naver.com/v1/search/shop.json";

interface NaverItem {
  title: string;
  link: string;
  lprice: string;
  hprice: string;
  mallName: string;
  productId: string;
}

interface NaverResponse {
  items?: NaverItem[];
}

export interface NaverResult {
  naverLowest: number | null;
  /** 필터 통과 후보(가격 오름차순), 대시보드 Top3 산출용 */
  candidates: Array<{ title: string; price: number; mall: string; link: string }>;
}

async function callOnce(query: string, sort: "sim" | "asc"): Promise<NaverItem[]> {
  const url = new URL(ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("display", "100");
  url.searchParams.set("sort", sort);
  url.searchParams.set("exclude", "used:cbshop");

  const res = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": config.naver.clientId,
      "X-Naver-Client-Secret": config.naver.clientSecret,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // body에는 키가 들어있지 않음(네이버 에러 메시지). 안전하게 일부만 노출.
    throw new Error(`네이버 API ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as NaverResponse;
  return json.items ?? [];
}

/**
 * 네이버 쇼핑 API로 1차 가격 수집 (결정적 코드).
 * sort=sim 기본, asc 병합으로 커버리지 향상. 필터/모델매칭/최소가 적용 후 최저가 산출.
 */
export async function fetchNaverPrice(product: Product): Promise<NaverResult> {
  const query = product.name;

  const items = await withRetry(
    async () => {
      const [sim, asc] = await Promise.all([
        callOnce(query, "sim"),
        callOnce(query, "asc").catch(() => [] as NaverItem[]),
      ]);
      return [...sim, ...asc];
    },
    { label: `네이버 검색(${query})`, tries: 3 }
  );

  // productId 기준 중복 제거
  const seen = new Set<string>();
  const candidates: NaverResult["candidates"] = [];
  for (const it of items) {
    const price = Number(it.lprice);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!isValidCandidate({ title: it.title, price, mallName: it.mallName }, product)) continue;
    const key = it.productId || it.link;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      title: cleanTitle(it.title),
      price,
      mall: it.mallName || "네이버",
      link: it.link,
    });
  }

  candidates.sort((a, b) => a.price - b.price);
  const naverLowest = candidates.length ? candidates[0].price : null;

  log.info(
    `네이버 [${product.name}] 후보 ${candidates.length}개${
      naverLowest ? `, 최저가 ${naverLowest.toLocaleString()}원` : " (유효 후보 없음)"
    }`
  );

  return { naverLowest, candidates };
}

/** 후보에서 Top3 listings 생성 */
export function topListings(candidates: NaverResult["candidates"]): Listing[] {
  return candidates.slice(0, 3).map((c, i) => ({
    rank: i + 1,
    mall: c.mall,
    price: c.price,
    link: c.link,
  }));
}
