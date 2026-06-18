import fs from "node:fs";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { upsertProductByName, upsertPricePoint, listProducts } from "../db/repo.ts";
import { findSeedByName, SEED_PRODUCTS } from "../collector/seeds.ts";
import type { CreateProductInput, PricePoint } from "../../shared/types.ts";

/** products 테이블이 비어 있을 때만 폴백 시드 8종 등록 */
export function ensureSeeds(): number {
  if (listProducts().length > 0) return 0;
  let n = 0;
  for (const s of SEED_PRODUCTS) {
    upsertProductByName(s);
    n++;
  }
  return n;
}

interface LegacyRecord {
  naver_lowest?: number | null;
  coupang_lowest?: number | null;
  danawa_lowest?: number | null;
  avg_price?: number | null;
  overall_lowest?: number | null;
  lowest_source?: string | null;
}
type LegacyHistory = Record<string, Record<string, LegacyRecord>>;

export interface ImportSummary {
  file: string;
  products: number;
  points: number;
  skipped: boolean;
  reason?: string;
}

/**
 * price_history.json → SQLite 멱등 임포트.
 * 같은 파일을 여러 번 실행해도 (product_id,date) upsert 라 중복이 생기지 않는다.
 */
export function importLegacyHistory(filePath = config.legacyHistoryJson): ImportSummary {
  if (!fs.existsSync(filePath)) {
    return { file: filePath, products: 0, points: 0, skipped: true, reason: "파일 없음" };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  let data: LegacyHistory;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return {
      file: filePath,
      products: 0,
      points: 0,
      skipped: true,
      reason: `JSON 파싱 실패: ${(e as Error).message}`,
    };
  }

  let productCount = 0;
  let pointCount = 0;
  const conn = db();

  // 한 번의 트랜잭션으로 멱등 적용
  conn.exec("BEGIN");
  try {
    for (const [name, byDate] of Object.entries(data)) {
      const seed = findSeedByName(name);
      const input: CreateProductInput = seed ?? {
        name,
        mustInclude: [],
        mustExclude: [],
        minPrice: 0,
      };
      const product = upsertProductByName(input);
      productCount++;

      for (const [date, rec] of Object.entries(byDate)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const point: PricePoint = {
          date,
          naverLowest: numOrNull(rec.naver_lowest),
          coupangLowest: numOrNull(rec.coupang_lowest),
          danawaLowest: numOrNull(rec.danawa_lowest),
          avgPrice: numOrNull(rec.avg_price),
          overallLowest: numOrNull(rec.overall_lowest),
          lowestSource: rec.lowest_source ?? "",
        };
        // collected_at은 과거 데이터이므로 해당 날짜 정오로 기록
        upsertPricePoint(product.id, point, `${date}T12:00:00.000Z`);
        pointCount++;
      }
    }
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }

  return { file: filePath, products: productCount, points: pointCount, skipped: false };
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
