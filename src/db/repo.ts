import { db } from "./index.ts";
import { localDateDaysAgo } from "../util/date.ts";
import { normalizeSymbol } from "../../shared/stock.ts";
import type {
  StockMarket,
  StockTicker,
  StockSearchCandidate,
  StockPoint,
  StockHolding,
  StockHorizon,
  PulseAlertRecord,
  PulseImpact,
  PulseSeverity,
} from "../../shared/types.ts";
import { normalizeHorizon } from "../../shared/holdings.ts";

function nowIso(): string {
  return new Date().toISOString();
}


// ── 관심 종목 원장 ──────────────────────────────────────

interface StockRow {
  id: number;
  market: string;
  symbol: string;
  name: string;
  quote_code: string;
  exchange: string;
  pinned: number;
  active: number;
  sort_order: number;
  created_at: string;
}

/** StockTicker 에 active 가 없는 건 의도적이다 — 삭제된 종목은 조회 자체가 안 되므로 노출할 게 없다. */
function rowToStock(r: StockRow): StockTicker {
  return {
    id: r.id,
    market: r.market as StockMarket,
    symbol: r.symbol,
    name: r.name,
    quoteCode: r.quote_code,
    exchange: r.exchange,
    pinned: r.pinned === 1,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
  };
}

/** 자연키 조회 — 삭제된 행(active=0)도 본다. 재등록 시 UNIQUE(market,symbol) 충돌을 미리 잡기 위함. */
function findStockRowEver(market: StockMarket, symbol: string): StockRow | null {
  const r = db()
    .prepare("SELECT * FROM stocks WHERE market = ? AND symbol = ?")
    .get(market, symbol) as StockRow | undefined;
  return r ?? null;
}

/** 삭제 흔적(active=0) 포함 전체 행 수. ensureSeedTickers 의 '한 번이라도 등록한 적 있나' 판정용. */
export function countStocksEver(market: StockMarket): number {
  const r = db()
    .prepare("SELECT COUNT(*) AS n FROM stocks WHERE market = ?")
    .get(market) as { n: number };
  return Number(r.n);
}

/** 신규 종목은 해당 시장 목록의 맨 뒤로. sort_order 는 reorderStocks 와 마찬가지로 시장별로 독립이다. */
function nextStockOrder(market: StockMarket): number {
  const r = db()
    .prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM stocks WHERE market = ?")
    .get(market) as { m: number };
  return Number(r.m) + 1;
}

export function listStocks(market?: StockMarket): StockTicker[] {
  // products 와 같은 관례: sort_order 우선, 동률은 id 로 tie-break(안정 정렬).
  const rows = market
    ? (db()
        .prepare(
          "SELECT * FROM stocks WHERE active = 1 AND market = ? ORDER BY sort_order, id"
        )
        .all(market) as unknown as StockRow[])
    : (db()
        .prepare("SELECT * FROM stocks WHERE active = 1 ORDER BY sort_order, id")
        .all() as unknown as StockRow[]);
  return rows.map(rowToStock);
}

/** 삭제된 종목은 null. API 가 404 로 응답해 수정/삭제를 막을 수 있게 하려는 것. */
export function getStock(id: number): StockTicker | null {
  const r = db()
    .prepare("SELECT * FROM stocks WHERE id = ? AND active = 1")
    .get(id) as StockRow | undefined;
  return r ? rowToStock(r) : null;
}

export function getStockBySymbol(market: StockMarket, symbol: string): StockTicker | null {
  const r = db()
    .prepare("SELECT * FROM stocks WHERE market = ? AND symbol = ? AND active = 1")
    .get(market, normalizeSymbol(symbol, market)) as StockRow | undefined;
  return r ? rowToStock(r) : null;
}

/** 종목 추가 입력. 네이버 자동완성이 돌려준 후보(StockSearchCandidate)를 그대로 흘려보내는 형태다. */
export interface CreateStockInput extends StockSearchCandidate {
  pinned?: boolean;
}

export function createStock(input: CreateStockInput): StockTicker {
  const symbol = normalizeSymbol(input.symbol, input.market);
  if (!symbol) throw new Error("종목 코드를 인식할 수 없습니다.");
  const pinned = input.pinned ? 1 : 0;
  const existing = findStockRowEver(input.market, symbol);

  if (existing?.active === 1)
    throw new Error(`이미 등록된 종목입니다: ${existing.name} (${symbol})`);

  if (existing) {
    // 삭제 흔적이 남은 종목의 재등록. UNIQUE(market,symbol) 때문에 INSERT 가 막히므로 되살린다.
    // stock_points 가 그대로 남아 있어 과거 차트가 즉시 복구되는 건 덤이 아니라 soft delete 의 목적이다.
    db()
      .prepare(
        `UPDATE stocks SET name = ?, quote_code = ?, exchange = ?, pinned = ?, active = 1, sort_order = ?
         WHERE id = ?`
      )
      .run(
        input.name,
        input.quoteCode,
        input.exchange,
        pinned,
        nextStockOrder(input.market),
        existing.id
      );
    return getStock(existing.id)!;
  }

  const info = db()
    .prepare(
      `INSERT INTO stocks (market, symbol, name, quote_code, exchange, pinned, active, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(
      input.market,
      symbol,
      input.name,
      input.quoteCode,
      input.exchange,
      pinned,
      nextStockOrder(input.market),
      nowIso()
    );
  return getStock(Number(info.lastInsertRowid))!;
}

export interface UpdateStockInput {
  name?: string;
  pinned?: boolean;
}

/**
 * 부분 수정. symbol/quoteCode 는 바꿀 수 없다 — 그건 다른 종목이라는 뜻이고,
 * 바꿔버리면 기존 stock_points 시계열에 엉뚱한 종목의 종가가 이어 붙는다.
 */
export function updateStock(id: number, patch: UpdateStockInput): StockTicker | null {
  const existing = getStock(id);
  if (!existing) return null;
  const name = patch.name != null ? patch.name : existing.name;
  const pinned = patch.pinned != null ? patch.pinned : existing.pinned;
  db()
    .prepare("UPDATE stocks SET name = ?, pinned = ? WHERE id = ?")
    .run(name, pinned ? 1 : 0, id);
  return getStock(id)!;
}

/**
 * soft delete. hard delete 를 쓰지 않는 이유 두 가지:
 *  1) 시계열 보존 — 되돌리면(createStock) 20일 차트가 그대로 복구된다.
 *  2) 시드 재주입 방지 — 남은 tombstone 이 "한 번도 등록 안 함"과 "다 지웠음"을 구분해 준다.
 *     hard delete 면 시드 종목을 전부 지운 뒤 재시작할 때마다 되살아난다(ensureSeedTickers 주석 참고).
 * 이미 삭제됐거나 없는 id 면 false.
 */
export function deleteStock(id: number): boolean {
  const info = db()
    .prepare("UPDATE stocks SET active = 0 WHERE id = ? AND active = 1")
    .run(id);
  return Number(info.changes) > 0;
}

/**
 * 시장 내 표시 순서 변경. 해당 시장의 활성 종목 id 전부를 원하는 순서로 받아 sort_order 를 0..n-1 로 재할당.
 * 누락/미지/중복 id 는 throw → 부분 적용 방지(단일 트랜잭션). reorderProducts 와 동일한 검증 규칙.
 */
export function reorderStocks(market: StockMarket, ids: number[]): StockTicker[] {
  const current = listStocks(market);
  if (!Array.isArray(ids) || ids.length !== current.length)
    throw new Error("순서 목록이 현재 종목 수와 일치하지 않습니다.");
  const remaining = new Set(current.map((s) => s.id));
  for (const id of ids) {
    if (!remaining.has(id)) throw new Error(`알 수 없거나 중복된 종목 id: ${id}`);
    remaining.delete(id);
  }
  if (remaining.size) throw new Error("일부 종목이 순서 목록에서 누락되었습니다.");

  const conn = db();
  const update = conn.prepare("UPDATE stocks SET sort_order = ? WHERE id = ?");
  conn.exec("BEGIN");
  try {
    ids.forEach((id, i) => update.run(i, id));
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
  return listStocks(market);
}

// ── 주식 시계열 (거래일 기준 멱등 upsert) ───────────────

interface StockPointRow {
  date: string;
  close: number | null;
  prev_close: number | null;
  change_pct: number | null;
  volume: number | null;
  currency: string;
}

function rowToStockPoint(r: StockPointRow): StockPoint {
  return {
    date: r.date,
    close: r.close,
    prevClose: r.prev_close,
    changePct: r.change_pct,
    volume: r.volume,
    currency: r.currency,
  };
}

/**
 * 일별 종가 일괄 upsert. 키가 (stock_id, 거래일)이라 하루 2회 수집해도 충돌하지 않고,
 * 같은 거래일 재수집은 정정 종가 반영이 된다.
 * 전량 성공 아니면 전량 롤백 — 차트 중간에 구멍 뚫린 절반짜리 시계열을 남기지 않는다.
 */
export function upsertStockPoints(
  stockId: number,
  points: StockPoint[],
  source: string
): void {
  if (!points.length) return;
  const conn = db();
  const collectedAt = nowIso();
  const stmt = conn.prepare(
    `INSERT INTO stock_points
       (stock_id, date, close, prev_close, change_pct, volume, currency, source, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stock_id, date) DO UPDATE SET
       close=excluded.close,
       prev_close=excluded.prev_close,
       change_pct=excluded.change_pct,
       volume=excluded.volume,
       currency=excluded.currency,
       source=excluded.source,
       collected_at=excluded.collected_at`
  );
  conn.exec("BEGIN");
  try {
    for (const p of points) {
      stmt.run(
        stockId,
        p.date,
        p.close,
        p.prevClose,
        p.changePct,
        // volume 컬럼은 INTEGER — 네이버가 실수로 주는 경우가 있어 반올림해 넣는다.
        p.volume == null ? null : Math.round(p.volume),
        p.currency || "KRW",
        source,
        collectedAt
      );
    }
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

/**
 * 최근 N **거래일** 종가를 거래일 오름차순으로. days 는 달력일이 아니라 행 수다 —
 * stock_points 에는 휴장일 행이 아예 없으므로 "20일 차트" = 최근 20행이 맞다.
 * (달력일로 자르면 주말·공휴일이 깎여 20일 요청에 14개만 나온다.)
 */
export function getStockPoints(stockId: number, days: number): StockPoint[] {
  const limit = Math.max(0, Math.trunc(days));
  if (!limit) return [];
  const rows = db()
    .prepare(
      "SELECT * FROM stock_points WHERE stock_id = ? ORDER BY date DESC LIMIT ?"
    )
    .all(stockId, limit) as unknown as StockPointRow[];
  return rows.map(rowToStockPoint).reverse();
}

// ── 증시 수집 실행 로그 (알림 멱등) ─────────────────────
// ⚠️ 여기의 date 는 서버 로컬 수집일(KST). stock_points.date(거래소 거래일)와 의미가 다르다.

export function startStockRun(date: string, market: StockMarket): void {
  db()
    .prepare(
      `INSERT INTO stock_runs (date, market, started_at, ok) VALUES (?, ?, ?, 0)
       ON CONFLICT(date, market) DO UPDATE SET started_at = excluded.started_at`
    )
    .run(date, market, nowIso());
}

export function finishStockRun(
  date: string,
  market: StockMarket,
  ok: boolean,
  detail: unknown
): void {
  db()
    .prepare(
      `INSERT INTO stock_runs (date, market, started_at, finished_at, ok, detail)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(date, market) DO UPDATE SET
         finished_at = excluded.finished_at,
         ok = excluded.ok,
         detail = excluded.detail`
    )
    .run(date, market, nowIso(), nowIso(), ok ? 1 : 0, JSON.stringify(detail ?? null));
}

/** 해당 수집일·시장의 실행 결과. detail 파싱 실패는 null 로 흘려보낸다(알림 멱등 판단만 막으면 됨). */
export function getStockRun(
  date: string,
  market: StockMarket
): { ok: boolean; detail: unknown } | null {
  const r = db()
    .prepare("SELECT ok, detail FROM stock_runs WHERE date = ? AND market = ?")
    .get(date, market) as { ok: number; detail: string | null } | undefined;
  if (!r) return null;
  let detail: unknown = null;
  try {
    detail = r.detail ? JSON.parse(r.detail) : null;
  } catch {
    detail = null;
  }
  return { ok: r.ok === 1, detail };
}

// ── 보유 종목 ───────────────────────────────────────────

interface HoldingRow {
  id: number;
  market: string;
  symbol: string;
  name: string;
  quote_code: string;
  exchange: string;
  quantity: number;
  avg_price: number;
  target_price: number | null;
  stop_price: number | null;
  horizon: string;
  memo: string;
  active: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function rowToHolding(r: HoldingRow): StockHolding {
  return {
    id: r.id,
    market: r.market as StockMarket,
    symbol: r.symbol,
    name: r.name,
    quoteCode: r.quote_code,
    exchange: r.exchange,
    quantity: r.quantity,
    avgPrice: r.avg_price,
    targetPrice: r.target_price,
    stopPrice: r.stop_price,
    // 저장값이 깨졌어도(수기 편집·구버전) 조회가 죽지 않게 읽기 경로에서도 정규화한다.
    horizon: normalizeHorizon(r.horizon),
    memo: r.memo,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 활성 보유 종목. market 생략 시 전 시장(펄스는 시장 구분 없이 전체를 본다). */
export function listHoldings(market?: StockMarket): StockHolding[] {
  const rows = market
    ? (db()
        .prepare(
          "SELECT * FROM stock_holdings WHERE active = 1 AND market = ? ORDER BY sort_order, id"
        )
        .all(market) as unknown as HoldingRow[])
    : (db()
        .prepare("SELECT * FROM stock_holdings WHERE active = 1 ORDER BY market, sort_order, id")
        .all() as unknown as HoldingRow[]);
  return rows.map(rowToHolding);
}

export function getHolding(id: number): StockHolding | null {
  const r = db()
    .prepare("SELECT * FROM stock_holdings WHERE id = ? AND active = 1")
    .get(id) as HoldingRow | undefined;
  return r ? rowToHolding(r) : null;
}

/** 자연키 조회 — 삭제 흔적(active=0)도 본다. 재등록 시 UNIQUE 충돌을 미리 잡기 위함. */
function findHoldingRowEver(market: StockMarket, symbol: string): HoldingRow | null {
  const r = db()
    .prepare("SELECT * FROM stock_holdings WHERE market = ? AND symbol = ?")
    .get(market, symbol) as HoldingRow | undefined;
  return r ?? null;
}

function nextHoldingOrder(market: StockMarket): number {
  const r = db()
    .prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM stock_holdings WHERE market = ?")
    .get(market) as { m: number };
  return Number(r.m) + 1;
}

export interface CreateHoldingRow extends StockSearchCandidate {
  quantity: number;
  avgPrice: number;
  targetPrice?: number | null;
  stopPrice?: number | null;
  horizon?: StockHorizon;
  memo?: string;
}

/**
 * 보유 종목 등록. 이미 활성 상태면 throw(수정은 updateHolding).
 * 삭제 흔적이 남은 종목은 되살린다 — UNIQUE(market,symbol) 때문에 INSERT 가 막히기 때문이다
 * (createStock 과 같은 패턴).
 */
export function createHolding(input: CreateHoldingRow): StockHolding {
  const symbol = normalizeSymbol(input.symbol, input.market);
  if (!symbol) throw new Error("종목 코드를 인식할 수 없습니다.");
  const existing = findHoldingRowEver(input.market, symbol);
  if (existing?.active === 1)
    throw new Error(`이미 보유 종목으로 등록되어 있습니다: ${existing.name} (${symbol})`);

  const horizon = normalizeHorizon(input.horizon);
  const memo = input.memo ?? "";
  const now = nowIso();

  if (existing) {
    db()
      .prepare(
        `UPDATE stock_holdings SET name = ?, quote_code = ?, exchange = ?, quantity = ?,
           avg_price = ?, target_price = ?, stop_price = ?, horizon = ?, memo = ?,
           active = 1, sort_order = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.name,
        input.quoteCode,
        input.exchange,
        input.quantity,
        input.avgPrice,
        input.targetPrice ?? null,
        input.stopPrice ?? null,
        horizon,
        memo,
        nextHoldingOrder(input.market),
        now,
        existing.id
      );
    return getHolding(existing.id)!;
  }

  const info = db()
    .prepare(
      `INSERT INTO stock_holdings
         (market, symbol, name, quote_code, exchange, quantity, avg_price, target_price,
          stop_price, horizon, memo, active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    )
    .run(
      input.market,
      symbol,
      input.name,
      input.quoteCode,
      input.exchange,
      input.quantity,
      input.avgPrice,
      input.targetPrice ?? null,
      input.stopPrice ?? null,
      horizon,
      memo,
      nextHoldingOrder(input.market),
      now,
      now
    );
  return getHolding(Number(info.lastInsertRowid))!;
}

export interface UpdateHoldingRow {
  quantity?: number;
  avgPrice?: number;
  targetPrice?: number | null;
  stopPrice?: number | null;
  horizon?: StockHorizon;
  memo?: string;
}

/**
 * 부분 수정. market/symbol/quoteCode 는 바꿀 수 없다 — 그건 다른 종목이라는 뜻이다
 * (updateStock 과 같은 규칙).
 *
 * ⚠️ targetPrice/stopPrice 는 `undefined`(미지정, 유지)와 `null`(명시적 해제)을 구분한다.
 *    `patch.targetPrice ?? existing.targetPrice` 로 쓰면 null 이 undefined 와 같이 취급돼
 *    사용자가 목표가를 지울 수 없게 된다.
 */
export function updateHolding(id: number, patch: UpdateHoldingRow): StockHolding | null {
  const existing = getHolding(id);
  if (!existing) return null;
  const pick = <T>(v: T | undefined, fallback: T): T => (v === undefined ? fallback : v);
  db()
    .prepare(
      `UPDATE stock_holdings SET quantity = ?, avg_price = ?, target_price = ?, stop_price = ?,
         horizon = ?, memo = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      pick(patch.quantity, existing.quantity),
      pick(patch.avgPrice, existing.avgPrice),
      pick(patch.targetPrice, existing.targetPrice),
      pick(patch.stopPrice, existing.stopPrice),
      normalizeHorizon(pick(patch.horizon, existing.horizon)),
      pick(patch.memo, existing.memo),
      nowIso(),
      id
    );
  return getHolding(id)!;
}

/** soft delete. 되살릴 수 있게 tombstone 을 남긴다(createHolding 이 재활용). */
export function deleteHolding(id: number): boolean {
  const info = db()
    .prepare("UPDATE stock_holdings SET active = 0, updated_at = ? WHERE id = ? AND active = 1")
    .run(nowIso(), id);
  return Number(info.changes) > 0;
}

export function reorderHoldings(market: StockMarket, ids: number[]): StockHolding[] {
  const current = listHoldings(market);
  if (!Array.isArray(ids) || ids.length !== current.length)
    throw new Error("순서 목록이 현재 보유 종목 수와 일치하지 않습니다.");
  const remaining = new Set(current.map((h) => h.id));
  for (const id of ids) {
    if (!remaining.has(id)) throw new Error(`알 수 없거나 중복된 보유 종목 id: ${id}`);
    remaining.delete(id);
  }
  if (remaining.size) throw new Error("일부 보유 종목이 순서 목록에서 누락되었습니다.");

  const conn = db();
  const update = conn.prepare("UPDATE stock_holdings SET sort_order = ? WHERE id = ?");
  conn.exec("BEGIN");
  try {
    ids.forEach((id, i) => update.run(i, id));
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
  return listHoldings(market);
}

// ── 펄스 알림 원장 ──────────────────────────────────────

interface PulseRow {
  id: number;
  fingerprint: string;
  date: string;
  slot: string;
  symbol: string | null;
  market: string | null;
  severity: string;
  trigger: string;
  headline: string;
  impact_json: string;
  status: string;
  created_at: string;
  sent_at: string | null;
}

/**
 * impact_json 파싱 실패는 **행을 버리지 않고** 최소 정보로 복구한다.
 * 중복 억제·상한 집계는 컬럼(fingerprint/symbol/severity)만으로 성립하므로, JSON 하나가
 * 깨졌다고 그 행이 사라지면 이미 보낸 알림이 '안 보낸 것'이 되어 재발송된다.
 */
function rowToPulse(r: PulseRow): PulseAlertRecord {
  let impact: PulseImpact;
  try {
    impact = JSON.parse(r.impact_json) as PulseImpact;
  } catch {
    impact = {
      symbol: r.symbol,
      market: (r.market as StockMarket | null) ?? null,
      name: r.symbol ?? "",
      direction: "neutral",
      severity: r.severity as PulseSeverity,
      headline: r.headline,
      rationale: "",
      risks: "",
      sources: [],
      trigger: r.trigger as PulseImpact["trigger"],
    };
  }
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    date: r.date,
    slot: r.slot,
    impact,
    status: r.status as PulseAlertRecord["status"],
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}

export interface InsertPulseAlertInput {
  fingerprint: string;
  date: string;
  slot: string;
  impact: PulseImpact;
  status: PulseAlertRecord["status"];
  /** 'sent' 로 넣을 때만 채운다. queued→sent 승격은 markPulseAlertsSent 가 한다. */
  sentAt?: string | null;
}

export function insertPulseAlert(input: InsertPulseAlertInput): PulseAlertRecord {
  const i = input.impact;
  const info = db()
    .prepare(
      `INSERT INTO stock_pulse_alerts
         (fingerprint, date, slot, symbol, market, severity, trigger, headline,
          impact_json, status, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.fingerprint,
      input.date,
      input.slot,
      i.symbol,
      i.market,
      i.severity,
      i.trigger,
      i.headline,
      JSON.stringify(i),
      input.status,
      nowIso(),
      input.sentAt ?? null
    );
  const r = db()
    .prepare("SELECT * FROM stock_pulse_alerts WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as unknown as PulseRow;
  return rowToPulse(r);
}

/**
 * 최근 `hours` 시간 내에 **실제로 사용자에게 도달했거나 도달 예정인** 알림.
 *
 * ⚠️ status 를 'sent'|'queued' 로 좁히는 것이 핵심이다. 중복 판정의 기준은 "이 사건을 이미
 * 알렸는가"이지 "이 사건을 이미 봤는가"가 아니다. 상한에 걸려 잘린('capped') 건이나 문턱
 * 미달('below') 건까지 중복으로 세면, 한 번 잘린 이슈는 **강도가 올라가도 영원히 못 나간다**
 * — 상한은 그날의 소음을 줄이려는 장치이지 사건을 영구 차단하려는 장치가 아니다.
 */
export function recentPulseAlerts(hours: number): PulseAlertRecord[] {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = db()
    .prepare(
      `SELECT * FROM stock_pulse_alerts
       WHERE created_at >= ? AND status IN ('sent','queued')
       ORDER BY created_at DESC`
    )
    .all(since) as unknown as PulseRow[];
  return rows.map(rowToPulse);
}

/** 최근 `hours` 시간 전체(문턱 미달·상한 절삭 포함). 일일 브리핑의 24시간 요약이 쓴다. */
export function allRecentPulseAlerts(hours: number): PulseAlertRecord[] {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = db()
    .prepare("SELECT * FROM stock_pulse_alerts WHERE created_at >= ? ORDER BY created_at DESC")
    .all(since) as unknown as PulseRow[];
  return rows.map(rowToPulse);
}

/**
 * 그날 실제 발송된 건수. 상한 판정의 근거다.
 *
 * 'queued'(야간 보류)도 **센다** — 07:00 에 반드시 나가므로 발송 예정 물량이다. 빼고 세면
 * 새벽 내내 상한이 소진되지 않아 아침 묶음 문자에 20건이 실린다.
 */
export function countPulseSentToday(
  date: string
): { total: number; bySymbol: Record<string, number>; macro: number } {
  const rows = db()
    .prepare(
      `SELECT symbol, COUNT(*) AS n FROM stock_pulse_alerts
       WHERE date = ? AND status IN ('sent','queued')
       GROUP BY symbol`
    )
    .all(date) as unknown as Array<{ symbol: string | null; n: number }>;
  const bySymbol: Record<string, number> = {};
  let total = 0;
  let macro = 0;
  for (const r of rows) {
    const n = Number(r.n);
    total += n;
    if (r.symbol) bySymbol[r.symbol] = n;
    else macro += n;
  }
  return { total, bySymbol, macro };
}

/** 야간 보류 큐(오래된 것부터). 07:00 플러시가 읽는다. */
export function listQueuedPulseAlerts(): PulseAlertRecord[] {
  const rows = db()
    .prepare("SELECT * FROM stock_pulse_alerts WHERE status = 'queued' ORDER BY created_at")
    .all() as unknown as PulseRow[];
  return rows.map(rowToPulse);
}

/** 큐에서 꺼내 발송한 건들을 'sent' 로 승격. 빈 배열이면 아무것도 하지 않는다. */
export function markPulseAlertsSent(ids: number[]): void {
  if (!ids.length) return;
  const conn = db();
  const stmt = conn.prepare(
    "UPDATE stock_pulse_alerts SET status = 'sent', sent_at = ? WHERE id = ?"
  );
  const now = nowIso();
  conn.exec("BEGIN");
  try {
    for (const id of ids) stmt.run(now, id);
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

/** 발송 실패 표시. 큐에 영원히 남아 매 플러시마다 재시도하는 것을 막는다. */
export function markPulseAlertsFailed(ids: number[]): void {
  if (!ids.length) return;
  const conn = db();
  const stmt = conn.prepare("UPDATE stock_pulse_alerts SET status = 'failed' WHERE id = ?");
  conn.exec("BEGIN");
  try {
    for (const id of ids) stmt.run(id);
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

// ── 보존 정책 ───────────────────────────────────────────

/**
 * 오래된 시계열 정리. 반환값은 삭제한 stock_points 행 수.
 *
 * ⚠️ 예전에는 가격 수집이 끝날 때마다 이 함수를 불렀고 price_points/listings/reviews 도 같이
 * 지웠다. 가격 탭을 제거(2026-08-01)하면서 두 가지가 바뀌었다.
 * 1) **호출부가 사라졌다.** 가격 수집이 유일한 호출자였으므로 그대로 뒀다면 증시 시계열과
 *    펄스 원장이 영원히 누적된다 — 그래서 스케줄러에 독립 cron 을 달았다(scheduler.ts).
 * 2) **가격 표는 더 이상 지우지 않는다.** 새로 쓰이지 않는 보존 아카이브가 됐고, 여기서
 *    계속 잘라내면 남겨두기로 한 과거 이력이 보존 기간이 지나는 대로 조용히 증발한다.
 */
export function pruneOldData(retentionDays: number): number {
  const cutoffStr = localDateDaysAgo(retentionDays);
  const conn = db();
  // 주식 시계열. 빠뜨리면 종목만 무한 누적된다.
  // (stock_points.date 는 거래소 로컬 거래일, cutoff 는 서버 로컬 날짜라 최대 하루 어긋나지만
  //  보존 기간이 수십 일 단위라 무시해도 되는 오차다.)
  const info = conn.prepare("DELETE FROM stock_points WHERE date < ?").run(cutoffStr);
  // 펄스 원장도 같은 보존창. 하루 16회 × 판정 수라 가장 빨리 불어나는 표다.
  // ⚠️ 'queued'(야간 보류)는 남긴다 — 아직 사용자에게 도달하지 않은 알림을 보존 정책이
  //    지우면 그 밤의 문자가 통째로 증발한다. 큐는 07:00 플러시가 비운다.
  conn
    .prepare("DELETE FROM stock_pulse_alerts WHERE date < ? AND status != 'queued'")
    .run(cutoffStr);
  return Number(info.changes);
}
