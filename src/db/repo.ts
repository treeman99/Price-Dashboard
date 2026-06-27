import { db } from "./index.ts";
import { localDateDaysAgo } from "../util/date.ts";
import type {
  Product,
  PricePoint,
  Listing,
  Review,
  CreateProductInput,
  ProductSummary,
  ProductHistory,
  ChangeDirection,
  CollectResult,
  ProductSource,
  UpsertProductSourceInput,
} from "../../shared/types.ts";
import type { SourcePriceResult } from "../collector/sources/types.ts";

function nowIso(): string {
  return new Date().toISOString();
}

interface ProductRow {
  id: number;
  name: string;
  must_include: string;
  must_exclude: string;
  min_price: number;
  active: number;
  created_at: string;
}

function rowToProduct(r: ProductRow): Product {
  return {
    id: r.id,
    name: r.name,
    mustInclude: JSON.parse(r.must_include),
    mustExclude: JSON.parse(r.must_exclude),
    minPrice: r.min_price,
    active: r.active === 1,
    createdAt: r.created_at,
  };
}

interface PointRow {
  date: string;
  naver_lowest: number | null;
  coupang_lowest: number | null;
  danawa_lowest: number | null;
  avg_price: number | null;
  overall_lowest: number | null;
  lowest_source: string;
  // 신규 컬럼 (ALTER 로 추가, 기존 행은 null)
  coupang_is_rocket?: number | null;
  lowest_mall?: string | null;
  source?: string | null;
}

function rowToPoint(r: PointRow): PricePoint {
  return {
    date: r.date,
    naverLowest: r.naver_lowest,
    coupangLowest: r.coupang_lowest,
    danawaLowest: r.danawa_lowest,
    avgPrice: r.avg_price,
    overallLowest: r.overall_lowest,
    lowestSource: r.lowest_source ?? "",
    coupangIsRocket:
      r.coupang_is_rocket == null ? null : r.coupang_is_rocket === 1,
    lowestMall: r.lowest_mall ?? null,
    source: r.source ?? null,
  };
}

interface ProductSourceRow {
  product_id: number;
  source: string;
  ref_id: string | null;
  url: string;
  confirmed: number;
  created_at: string;
}

function rowToProductSource(r: ProductSourceRow): ProductSource {
  return {
    productId: r.product_id,
    source: r.source,
    refId: r.ref_id,
    url: r.url,
    confirmed: r.confirmed === 1,
    createdAt: r.created_at,
  };
}

// ── 상품 ────────────────────────────────────────────────

export function listProducts(activeOnly = false): Product[] {
  const sql = activeOnly
    ? "SELECT * FROM products WHERE active = 1 ORDER BY id"
    : "SELECT * FROM products ORDER BY id";
  return (db().prepare(sql).all() as unknown as ProductRow[]).map(rowToProduct);
}

export function getProduct(id: number): Product | null {
  const r = db().prepare("SELECT * FROM products WHERE id = ?").get(id) as
    | ProductRow
    | undefined;
  return r ? rowToProduct(r) : null;
}

export function getProductByName(name: string): Product | null {
  const r = db().prepare("SELECT * FROM products WHERE name = ?").get(name) as
    | ProductRow
    | undefined;
  return r ? rowToProduct(r) : null;
}

export function createProduct(input: CreateProductInput): Product {
  const created = nowIso();
  const info = db()
    .prepare(
      `INSERT INTO products (name, must_include, must_exclude, min_price, active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`
    )
    .run(
      input.name,
      JSON.stringify(input.mustInclude ?? []),
      JSON.stringify(input.mustExclude ?? []),
      Math.round(input.minPrice ?? 0),
      created
    );
  return getProduct(Number(info.lastInsertRowid))!;
}

/** 임포트/시드용: 이름 기준 멱등 upsert. 이미 있으면 매칭규칙만 보강(가격이력은 건드리지 않음). */
export function upsertProductByName(input: CreateProductInput): Product {
  const existing = getProductByName(input.name);
  if (existing) {
    db()
      .prepare(
        `UPDATE products SET must_include = ?, must_exclude = ?, min_price = ? WHERE id = ?`
      )
      .run(
        JSON.stringify(input.mustInclude ?? existing.mustInclude),
        JSON.stringify(input.mustExclude ?? existing.mustExclude),
        Math.round(input.minPrice ?? existing.minPrice),
        existing.id
      );
    return getProduct(existing.id)!;
  }
  return createProduct(input);
}

export function setProductActive(id: number, active: boolean): void {
  db()
    .prepare("UPDATE products SET active = ? WHERE id = ?")
    .run(active ? 1 : 0, id);
}

export function deleteProductHard(id: number): void {
  db().prepare("DELETE FROM products WHERE id = ?").run(id);
}

// ── 가격 포인트 (멱등 upsert) ───────────────────────────

export function upsertPricePoint(
  productId: number,
  p: PricePoint,
  collectedAt: string = nowIso()
): void {
  db()
    .prepare(
      `INSERT INTO price_points
         (product_id, date, naver_lowest, coupang_lowest, danawa_lowest, avg_price, overall_lowest, lowest_source, collected_at, coupang_is_rocket, lowest_mall, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(product_id, date) DO UPDATE SET
         naver_lowest=excluded.naver_lowest,
         coupang_lowest=excluded.coupang_lowest,
         danawa_lowest=excluded.danawa_lowest,
         avg_price=excluded.avg_price,
         overall_lowest=excluded.overall_lowest,
         lowest_source=excluded.lowest_source,
         collected_at=excluded.collected_at,
         coupang_is_rocket=excluded.coupang_is_rocket,
         lowest_mall=excluded.lowest_mall,
         source=excluded.source`
    )
    .run(
      productId,
      p.date,
      p.naverLowest,
      p.coupangLowest,
      p.danawaLowest,
      p.avgPrice,
      p.overallLowest,
      p.lowestSource ?? "",
      collectedAt,
      p.coupangIsRocket == null ? null : p.coupangIsRocket ? 1 : 0,
      p.lowestMall ?? null,
      p.source ?? null
    );
}

export function getHistory(productId: number, sinceDate?: string): PricePoint[] {
  const rows = sinceDate
    ? (db()
        .prepare(
          "SELECT * FROM price_points WHERE product_id = ? AND date >= ? ORDER BY date"
        )
        .all(productId, sinceDate) as unknown as PointRow[])
    : (db()
        .prepare("SELECT * FROM price_points WHERE product_id = ? ORDER BY date")
        .all(productId) as unknown as PointRow[]);
  return rows.map(rowToPoint);
}

export function getLatestPoint(productId: number): PricePoint | null {
  const r = db()
    .prepare(
      "SELECT * FROM price_points WHERE product_id = ? ORDER BY date DESC LIMIT 1"
    )
    .get(productId) as unknown as PointRow | undefined;
  return r ? rowToPoint(r) : null;
}

/** 최신 포인트 직전(다른 날짜)의 포인트 — 전일 대비 변동 계산용 */
function getPrevPoint(productId: number): PricePoint | null {
  const rows = db()
    .prepare(
      "SELECT * FROM price_points WHERE product_id = ? ORDER BY date DESC LIMIT 2"
    )
    .all(productId) as unknown as PointRow[];
  return rows.length >= 2 ? rowToPoint(rows[1]) : null;
}

// ── Top3 / 리뷰 (날짜별 덮어쓰기) ───────────────────────

export function replaceListings(
  productId: number,
  date: string,
  listings: Listing[]
): void {
  const conn = db();
  conn
    .prepare("DELETE FROM listings WHERE product_id = ? AND date = ?")
    .run(productId, date);
  const stmt = conn.prepare(
    "INSERT INTO listings (product_id, date, rank, mall, price, link) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const l of listings) {
    stmt.run(productId, date, l.rank, l.mall, Math.round(l.price), l.link ?? null);
  }
}

export function getListings(productId: number, date: string): Listing[] {
  const rows = db()
    .prepare(
      "SELECT rank, mall, price, link FROM listings WHERE product_id = ? AND date = ? ORDER BY rank"
    )
    .all(productId, date) as Array<{
    rank: number;
    mall: string;
    price: number;
    link: string | null;
  }>;
  return rows.map((r) => ({ rank: r.rank, mall: r.mall, price: r.price, link: r.link }));
}

export function replaceReviews(
  productId: number,
  date: string,
  reviews: Review[]
): void {
  const conn = db();
  conn
    .prepare("DELETE FROM reviews WHERE product_id = ? AND date = ?")
    .run(productId, date);
  const stmt = conn.prepare(
    "INSERT INTO reviews (product_id, date, idx, source, review_date, summary, rating, link) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  reviews.forEach((rv, i) => {
    stmt.run(
      productId,
      date,
      i,
      rv.source,
      rv.date ?? null,
      rv.summary,
      rv.rating ?? null,
      rv.link ?? null
    );
  });
}

export function getReviews(productId: number, date: string): Review[] {
  const rows = db()
    .prepare(
      "SELECT source, review_date, summary, rating, link FROM reviews WHERE product_id = ? AND date = ? ORDER BY idx"
    )
    .all(productId, date) as Array<{
    source: string;
    review_date: string | null;
    summary: string;
    rating: number | null;
    link: string | null;
  }>;
  return rows.map((r) => ({
    source: r.source,
    date: r.review_date,
    summary: r.summary,
    rating: r.rating,
    link: r.link,
  }));
}

/** 가장 최근 리뷰가 있는 날짜의 리뷰 (없으면 빈 배열) */
function getLatestReviews(productId: number): Review[] {
  const r = db()
    .prepare(
      "SELECT date FROM reviews WHERE product_id = ? ORDER BY date DESC LIMIT 1"
    )
    .get(productId) as { date: string } | undefined;
  return r ? getReviews(productId, r.date) : [];
}

function getLatestListings(productId: number): Listing[] {
  const r = db()
    .prepare(
      "SELECT date FROM listings WHERE product_id = ? ORDER BY date DESC LIMIT 1"
    )
    .get(productId) as { date: string } | undefined;
  return r ? getListings(productId, r.date) : [];
}

// ── 요약 / 히스토리 ─────────────────────────────────────

function changeOf(
  latest: PricePoint | null,
  prev: PricePoint | null
): ProductSummary["change"] {
  const a = latest?.overallLowest ?? null;
  const b = prev?.overallLowest ?? null;
  if (a == null || b == null) {
    return { direction: "flat" as ChangeDirection, amount: null, percent: null };
  }
  const amount = a - b;
  const percent = b !== 0 ? (amount / b) * 100 : null;
  const direction: ChangeDirection =
    amount > 0 ? "up" : amount < 0 ? "down" : "flat";
  return { direction, amount, percent };
}

export function getProductSummary(id: number): ProductSummary | null {
  const product = getProduct(id);
  if (!product) return null;
  const latest = getLatestPoint(id);
  const prev = getPrevPoint(id);
  return {
    product,
    latest,
    change: changeOf(latest, prev),
    topListings: getLatestListings(id),
    reviews: getLatestReviews(id),
    lastCollectedAt: latest
      ? ((db()
          .prepare(
            "SELECT collected_at FROM price_points WHERE product_id = ? AND date = ?"
          )
          .get(id, latest.date) as { collected_at: string | null } | undefined)
          ?.collected_at ?? null)
      : null,
  };
}

export function getProductHistory(id: number, sinceDate?: string): ProductHistory | null {
  const product = getProduct(id);
  if (!product) return null;
  return { product, points: getHistory(id, sinceDate) };
}

// ── 상품 × 소스 ref (watchlist) ─────────────────────────

/** 상품의 모든 소스 ref. 우선순위(danawa→enuri→llm-websearch)로 정렬해 반환. */
export function listProductSources(productId: number): ProductSource[] {
  const rows = db()
    .prepare("SELECT * FROM product_sources WHERE product_id = ?")
    .all(productId) as unknown as ProductSourceRow[];
  const order: Record<string, number> = { danawa: 0, enuri: 1, "llm-websearch": 2 };
  return rows
    .map(rowToProductSource)
    .sort((a, b) => (order[a.source] ?? 99) - (order[b.source] ?? 99));
}

/** 확정(confirmed=1)된 소스 ref만, 우선순위 정렬. 매일 수집은 이것만 재조회. */
export function listConfirmedSources(productId: number): ProductSource[] {
  return listProductSources(productId).filter((s) => s.confirmed);
}

export function getProductSource(productId: number, source: string): ProductSource | null {
  const r = db()
    .prepare("SELECT * FROM product_sources WHERE product_id = ? AND source = ?")
    .get(productId, source) as ProductSourceRow | undefined;
  return r ? rowToProductSource(r) : null;
}

/** (product_id, source) 기준 멱등 upsert. confirmed 미지정 시 기존값 유지(신규는 0). */
export function upsertProductSource(input: UpsertProductSourceInput): ProductSource {
  const existing = getProductSource(input.productId, input.source);
  const confirmed =
    input.confirmed != null ? (input.confirmed ? 1 : 0) : existing ? (existing.confirmed ? 1 : 0) : 0;
  db()
    .prepare(
      `INSERT INTO product_sources (product_id, source, ref_id, url, confirmed, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(product_id, source) DO UPDATE SET
         ref_id=excluded.ref_id,
         url=excluded.url,
         confirmed=excluded.confirmed`
    )
    .run(
      input.productId,
      input.source,
      input.refId,
      input.url,
      confirmed,
      existing?.createdAt ?? nowIso()
    );
  return getProductSource(input.productId, input.source)!;
}

export function deleteProductSource(productId: number, source: string): void {
  db()
    .prepare("DELETE FROM product_sources WHERE product_id = ? AND source = ?")
    .run(productId, source);
}

// ── 수집 실행 로그 ──────────────────────────────────────

export function recordRunStart(date: string): void {
  db()
    .prepare(
      `INSERT INTO collect_runs (date, started_at, ok) VALUES (?, ?, 0)
       ON CONFLICT(date) DO UPDATE SET started_at = excluded.started_at`
    )
    .run(date, nowIso());
}

export function recordRunFinish(result: CollectResult): void {
  db()
    .prepare(
      `INSERT INTO collect_runs (date, started_at, finished_at, ok, detail)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         finished_at = excluded.finished_at,
         ok = excluded.ok,
         detail = excluded.detail`
    )
    .run(
      result.date,
      result.startedAt,
      result.finishedAt,
      result.ok ? 1 : 0,
      JSON.stringify(result)
    );
}

/** 해당 날짜의 수집 결과(JSON) 조회 — 알림 멱등 판단용 */
export function getRunResult(date: string): CollectResult | null {
  const r = db()
    .prepare("SELECT detail FROM collect_runs WHERE date = ?")
    .get(date) as { detail: string | null } | undefined;
  if (!r?.detail) return null;
  try {
    return JSON.parse(r.detail) as CollectResult;
  } catch {
    return null;
  }
}

/** 해당 날짜에 성공한 수집이 있는지 (catch-up 판단용) */
export function hasSuccessfulRun(date: string): boolean {
  const r = db()
    .prepare("SELECT ok FROM collect_runs WHERE date = ?")
    .get(date) as { ok: number } | undefined;
  return r?.ok === 1;
}

// ── 소스 당일 fetch 캐시 (§11: 상품×소스×날짜 하루 1회) ──

/**
 * 당일 캐시 조회. 모든 터미널 상태(ok/blocked/not-listed/parse-error/empty)가 캐시됨.
 * hit이면 source.fetch를 호출하지 않고 이 결과를 그대로 사용한다.
 */
export function getSourceFetchCache(
  productId: number,
  source: string,
  date: string
): SourcePriceResult | null {
  const r = db()
    .prepare(
      "SELECT result_json FROM source_fetch_cache WHERE product_id = ? AND source = ? AND date = ?"
    )
    .get(productId, source, date) as { result_json: string } | undefined;
  if (!r) return null;
  try {
    return JSON.parse(r.result_json) as SourcePriceResult;
  } catch {
    return null;
  }
}

/** 소스 결과 캐시 기록. ON CONFLICT 시 덮어쓰기(같은 날 재실행 멱등). */
export function putSourceFetchCache(
  productId: number,
  source: string,
  date: string,
  result: SourcePriceResult
): void {
  db()
    .prepare(
      `INSERT INTO source_fetch_cache (product_id, source, date, status, result_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(product_id, source, date) DO UPDATE SET
         status=excluded.status,
         result_json=excluded.result_json,
         fetched_at=excluded.fetched_at`
    )
    .run(productId, source, date, result.status, JSON.stringify(result), result.fetchedAt);
}

// ── 보존 정책 ───────────────────────────────────────────

export function pruneOldData(retentionDays: number): number {
  const cutoffStr = localDateDaysAgo(retentionDays);
  const conn = db();
  const info = conn
    .prepare("DELETE FROM price_points WHERE date < ?")
    .run(cutoffStr);
  conn.prepare("DELETE FROM listings WHERE date < ?").run(cutoffStr);
  conn.prepare("DELETE FROM reviews WHERE date < ?").run(cutoffStr);
  conn.prepare("DELETE FROM source_fetch_cache WHERE date < ?").run(cutoffStr);
  return Number(info.changes);
}
