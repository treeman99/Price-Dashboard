import { DEFAULT_STOCK_TICKERS, marketLabel } from "../../shared/stock.ts";
import { log } from "../util/log.ts";
import {
  countStocksEver,
  createStock,
  deleteStock,
  getStock,
  getStockBySymbol,
  listStocks,
  reorderStocks,
  updateStock,
} from "../db/repo.ts";
import type { StockMarket } from "../../shared/types.ts";

// 원장 CRUD 는 repo 가 전부 한다. 수집기·API 는 여기만 import 하면 되도록 재노출한다.
export {
  createStock,
  deleteStock,
  getStock,
  getStockBySymbol,
  listStocks,
  reorderStocks,
  updateStock,
};
export type { CreateStockInput, UpdateStockInput } from "../db/repo.ts";

const MARKETS: StockMarket[] = ["kr", "us"];

/**
 * 최초 1회 시드. 시장별로 독립 판정한다(한국장만 지워도 미국장 시드는 그대로).
 *
 * ⚠️ 판정 기준이 listStocks() 가 아니라 countStocksEver() 인 이유:
 * listStocks() 는 활성 종목만 세므로, 사용자가 시드 종목을 전부 지운 상태에서 서버를 재시작하면
 * "비어 있음" → 재시드 → 지운 종목이 되살아난다. 매 재시작마다 반복되는 악질 버그다.
 * deleteStock 이 soft delete(active=0) 라 tombstone 이 남고, countStocksEver 가 그걸 세므로
 * "한 번도 등록한 적 없음"(=0)과 "등록했다가 다 지웠음"(>0)을 별도 플래그 파일 없이 구분할 수 있다.
 * → 시드는 정말 처음 한 번만 들어간다.
 */
export function ensureSeedTickers(): void {
  for (const market of MARKETS) {
    if (countStocksEver(market) > 0) continue;
    const seeds = DEFAULT_STOCK_TICKERS[market];
    for (const seed of seeds) {
      createStock({ market, ...seed, pinned: true });
    }
    log.info(`관심 종목 시드: ${marketLabel(market)} ${seeds.length}개`);
  }
}
