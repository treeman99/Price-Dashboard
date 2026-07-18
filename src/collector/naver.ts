import { config } from "../config.ts";
import { log, withRetry } from "../util/log.ts";
import { cleanTitle, isValidCandidate } from "./filters.ts";
import { isDeadListing } from "./linkcheck.ts";
import { delay, jitterMs } from "./sources/http.ts";
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

type Candidate = NaverResult["candidates"][number];

export interface NaverDeps {
  /** 링크 사망 검증 함수(테스트 주입용). 기본 isDeadListing(실제 네트워크). */
  checkDead?: (url: string) => Promise<boolean>;
}

/** 살아있음을 확보할 최소 후보 수(대시보드는 Top3 만 노출). */
const KEEP_ALIVE_TARGET = 3;
/** 1개 상품당 링크 프로브 상한(매너/부하 방지). 보통 3~4회에서 끝난다. */
const MAX_LINK_PROBES = 8;

/**
 * 가격 오름차순 후보에서 '죽은 링크'(판매중지/삭제)를 싼 쪽부터 걷어낸다.
 * - 싼 순으로 프로브 → 살아있는 후보 KEEP_ALIVE_TARGET 개를 확보하면 중단(나머지는 프로브 없이 유지).
 * - 프로브 상한(MAX_LINK_PROBES) 도달 시에도 중단 — 남은 후보는 그대로 둔다(보수적).
 * - 프로브 간 지터(매너 §8). 판정 불가/차단은 linkcheck 가 살아있음으로 흡수.
 */
export async function pruneDeadCandidates(
  candidates: Candidate[],
  product: Product,
  checkDead: (url: string) => Promise<boolean>,
  /** 프로브 간 대기(테스트에서 no-op 주입). 기본 600~1400ms 지터. */
  waitBetween: () => Promise<void> = () => delay(jitterMs(600, 1400))
): Promise<Candidate[]> {
  const kept: Candidate[] = [];
  let probes = 0;
  let firstProbe = true;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    // 살아있는 후보를 충분히 확보했거나 프로브 상한에 도달하면, 남은 후보는 프로브 없이 유지.
    if (kept.length >= KEEP_ALIVE_TARGET || probes >= MAX_LINK_PROBES) {
      kept.push(c);
      continue;
    }
    if (!firstProbe) await waitBetween();
    firstProbe = false;
    probes++;
    const dead = await checkDead(c.link);
    if (dead) {
      log.info(
        `죽은 링크 제외 [${product.name}] ${c.mall} ${c.price.toLocaleString()}원 — ${c.link}`
      );
      continue;
    }
    kept.push(c);
  }
  return kept;
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
export async function fetchNaverPrice(
  product: Product,
  deps: NaverDeps = {}
): Promise<NaverResult> {
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

  // 죽은 링크(판매중지/삭제)를 싼 쪽부터 걷어낸다 — 오염된 최저가/Top3 방지.
  const verified =
    config.verifyListingLinks && candidates.length
      ? await pruneDeadCandidates(candidates, product, deps.checkDead ?? isDeadListing)
      : candidates;

  const removed = candidates.length - verified.length;
  const naverLowest = verified.length ? verified[0].price : null;

  log.info(
    `네이버 [${product.name}] 후보 ${verified.length}개${
      removed > 0 ? `(죽은 링크 ${removed}개 제외)` : ""
    }${naverLowest ? `, 최저가 ${naverLowest.toLocaleString()}원` : " (유효 후보 없음)"}`
  );

  return { naverLowest, candidates: verified };
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
