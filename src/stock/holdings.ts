import { log } from "../util/log.ts";
import { normalizeSymbol } from "../../shared/stock.ts";
import { summarizeHolding, normalizeHorizon, optionalNumber, requirePositive } from "../../shared/holdings.ts";
import {
  createHolding as createHoldingRow,
  deleteHolding,
  getHolding,
  listHoldings,
  reorderHoldings,
  updateHolding as updateHoldingRow,
  createStock,
  getStockBySymbol,
} from "../db/repo.ts";
import { searchTicker, fetchHistory } from "./quote.ts";
import { pickWatchCandidate } from "./stock.ts";
import type {
  CreateStockHoldingInput,
  StockHolding,
  StockHoldingSummary,
  StockMarket,
  StockPoint,
  StockSearchCandidate,
  UpdateStockHoldingInput,
} from "../../shared/types.ts";

export { deleteHolding, getHolding, listHoldings, reorderHoldings };

/** 손익 계산에 쓸 시계열 길이. 등록 종목 차트(HISTORY_DAYS)와 같은 20거래일. */
const HISTORY_DAYS = 20;

/**
 * 보유 종목 등록 시 **해당 시장의 등록 종목(stocks)에도 자동으로 넣는다.**
 *
 * 인터뷰에서 사용자가 고른 정책이다. 두 목록을 따로 관리하면 반드시 어긋나고, 어긋난 결과가
 * "내가 실제로 들고 있는 종목이 일일 브리핑에서 빠지는 것"이라 침묵하는 실패가 된다.
 * 자동 등록해 두면 브리핑의 등록 종목 분석·시세 조회·시계열 저장이 전부 공짜로 딸려온다.
 *
 * 실패는 **삼킨다.** 등록 종목 추가가 안 됐다고 보유 등록 자체를 막으면, 사용자 입장에서는
 * 아무 관련 없어 보이는 이유로 포지션 입력이 거부되는 것이다. 경고만 남기고 진행한다
 * (다음 브리핑에서 등록 종목에 없을 뿐, 보유 원장·펄스 판정은 정상 동작한다).
 */
function mirrorToTickers(c: StockSearchCandidate): void {
  try {
    if (getStockBySymbol(c.market, c.symbol)) return; // 이미 등록됨
    createStock({ ...c, pinned: true });
    log.info(`보유 종목 → 등록 종목 자동 추가: ${c.name}(${c.symbol}) [${c.market}]`);
  } catch (e) {
    log.warn(
      `보유 종목의 등록 종목 자동 추가 실패 (보유 등록은 계속 진행) ` +
        `${c.name}(${c.symbol}): ${(e as Error).message}`
    );
  }
}

/**
 * 사용자가 입력한 자유 문자열(종목코드·티커·종목명)을 실제 종목으로 해석한다.
 *
 * `pickWatchCandidate` 를 재사용하는 이유: 심볼 정규화·이름 완전일치·시장 우선순위 규칙이
 * 이미 거기 있고, 검증된 그 규칙을 여기서 다시 쓰면 두 경로의 판정이 갈라지지 않는다.
 * 다만 여기서는 **사용자가 시장을 명시**했으므로 타 시장 폴백을 허용하지 않는다 —
 * "미국장 탭에서 삼성전자를 넣었다"는 오타이지 라우팅 대상이 아니다.
 */
async function resolveCandidate(
  market: StockMarket,
  query: string
): Promise<StockSearchCandidate> {
  const q = (query ?? "").trim();
  if (!q) throw new Error("종목명 또는 종목코드를 입력해 주세요.");

  const candidates = await searchTicker(q);
  const sameMarket = candidates.filter((c) => c.market === market);
  const hit =
    pickWatchCandidate(sameMarket, market, q, q) ??
    // 심볼·이름 정확일치가 없고 후보가 딱 하나면 그것으로 확정한다. 사용자가 직접 고른
    // 시장 안에서 유일 후보라면 오식별 위험이 낮고, 여기서 막으면 정상 입력이 거부된다.
    (sameMarket.length === 1 ? sameMarket[0] : null);

  if (!hit) {
    const hint = sameMarket.length
      ? ` 후보: ${sameMarket.slice(0, 5).map((c) => `${c.name}(${c.symbol})`).join(", ")}`
      : "";
    throw new Error(`"${q}" 에 해당하는 종목을 찾지 못했습니다.${hint}`);
  }
  return hit;
}

export async function createHolding(input: CreateStockHoldingInput): Promise<StockHolding> {
  const market = input.market;
  if (market !== "kr" && market !== "us") throw new Error("시장은 kr 또는 us 여야 합니다.");

  const quantity = requirePositive(input.quantity, "보유 수량");
  const avgPrice = requirePositive(input.avgPrice, "평균 매입 단가");
  const candidate = await resolveCandidate(market, input.query);

  const holding = createHoldingRow({
    ...candidate,
    quantity,
    avgPrice,
    targetPrice: optionalNumber(input.targetPrice),
    stopPrice: optionalNumber(input.stopPrice),
    horizon: normalizeHorizon(input.horizon),
    memo: (input.memo ?? "").trim().slice(0, 1000),
  });

  mirrorToTickers(candidate);
  log.info(
    `보유 종목 등록: ${holding.name}(${holding.symbol}) ${holding.quantity}주 @ ${holding.avgPrice} ` +
      `[${holding.market}/${holding.horizon}]`
  );
  return holding;
}

/**
 * 부분 수정. `undefined`(미지정)와 `null`(해제)의 구분은 repo 계층이 지킨다.
 * 여기서는 **값의 유효성**만 본다 — 수량·평단가를 0 이나 음수로 바꾸는 것은 거부한다
 * (0주 보유는 '삭제'이지 '수정'이 아니고, 평단가 0 은 손익률을 Infinity 로 만든다).
 */
export function updateHolding(
  id: number,
  patch: UpdateStockHoldingInput
): StockHolding | null {
  const next: Parameters<typeof updateHoldingRow>[1] = {};
  if (patch.quantity !== undefined) next.quantity = requirePositive(patch.quantity, "보유 수량");
  if (patch.avgPrice !== undefined)
    next.avgPrice = requirePositive(patch.avgPrice, "평균 매입 단가");
  if (patch.targetPrice !== undefined) next.targetPrice = optionalNumber(patch.targetPrice);
  if (patch.stopPrice !== undefined) next.stopPrice = optionalNumber(patch.stopPrice);
  if (patch.horizon !== undefined) next.horizon = normalizeHorizon(patch.horizon);
  if (patch.memo !== undefined) next.memo = String(patch.memo).trim().slice(0, 1000);
  return updateHoldingRow(id, next);
}

/**
 * 보유 종목 + 현재 시세. **종목별 try/catch 로 실패를 격리한다** —
 * 한 종목의 조회 실패가 포트폴리오 전체를 날리면 안 된다(gather() 와 같은 원칙).
 *
 * 조회에 실패한 종목도 목록에는 남는다(close=null). 보유 사실은 시세와 무관하게 유효하고,
 * 여기서 드롭하면 사용자는 자기 포지션이 사라진 것으로 오해한다.
 */
export async function summarizeHoldings(market?: StockMarket): Promise<StockHoldingSummary[]> {
  const holdings = listHoldings(market);
  const out: StockHoldingSummary[] = [];
  for (const h of holdings) {
    let points: StockPoint[] = [];
    try {
      points = await fetchHistory(h.quoteCode, h.market, HISTORY_DAYS);
    } catch (e) {
      log.warn(`보유 종목 시세 조회 실패 ${h.name}(${h.symbol}): ${(e as Error).message}`);
    }
    const last = points.length ? points[points.length - 1] : null;
    out.push(
      summarizeHolding(
        h,
        {
          close: last?.close ?? null,
          changePct: last?.changePct ?? null,
          currency: last?.currency ?? (h.market === "kr" ? "KRW" : "USD"),
        },
        points
      )
    );
  }
  return out;
}

/** 심볼로 보유 종목 찾기(펄스 판정이 LLM 이 낸 심볼을 되짚을 때 쓴다). */
export function findHoldingBySymbol(symbol: string): StockHolding | null {
  const wanted = (symbol ?? "").trim();
  if (!wanted) return null;
  for (const h of listHoldings()) {
    if (normalizeSymbol(wanted, h.market) === h.symbol) return h;
    // 시장을 모르는 상태로 온 심볼도 있다(LLM 출력). 대문자 원문 비교로 한 번 더 건진다.
    if (h.symbol.toUpperCase() === wanted.toUpperCase()) return h;
  }
  return null;
}
