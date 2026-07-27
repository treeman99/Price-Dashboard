import type {
  StockHolding,
  StockHoldingSummary,
  StockHorizon,
  StockPoint,
} from "./types.ts";

/**
 * 보유 종목 계산·표기의 단일 출처. 서버(브리핑·펄스 프롬프트·이메일)와 웹이 **같은 함수**를 쓴다.
 *
 * 이 저장소에는 분리·표기 규칙을 채널마다 따로 구현했다가 갈라진 선례가 두 번 있다
 * (관심 종목 이모지 메일 💡 / 웹 🔍, partitionWatchlist 주석 참고). 손익률은 그보다 위험하다 —
 * 화면과 문자의 손익률이 다르면 어느 쪽을 믿어야 하는지 알 수 없고, 둘 다 못 믿게 된다.
 */

export const HORIZONS: StockHorizon[] = ["short", "mid", "long"];

export function horizonLabel(h: StockHorizon): string {
  return h === "short" ? "단기" : h === "mid" ? "중기" : "장기";
}

/** 프롬프트에 주입할 기간 설명. 라벨만으로는 LLM 이 기준을 모른다. */
export function horizonDescription(h: StockHorizon): string {
  return h === "short"
    ? "단기(수일~수주) — 뉴스·수급·모멘텀 변화에 민감하게 반응한다"
    : h === "mid"
      ? "중기(수개월) — 실적 사이클·업황 턴·정책 변화가 기준이고 데일리 노이즈는 무시한다"
      : "장기(1년+) — 구조적 경쟁력 훼손·지배구조 변화급만 유의미하고 나머지는 노이즈다";
}

/** 허용 목록 밖이면 'mid'. 저장·조회 양쪽에서 반드시 거친다. */
export function normalizeHorizon(v: unknown): StockHorizon {
  return typeof v === "string" && (HORIZONS as string[]).includes(v)
    ? (v as StockHorizon)
    : "mid";
}

/**
 * 숫자 입력 정규화. 빈 문자열·null·NaN·Infinity 는 전부 null 이다.
 *
 * ⚠️ `Number("")` 은 **0** 이다. 목표가를 비워 둔 것과 0원으로 지정한 것을 구분하지 못하면
 * '목표가 0원까지 -100%' 같은 값이 브리핑에 뜬다. 빈 문자열을 먼저 걸러야 한다.
 */
export function optionalNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 필수 양수(수량·평단가). 0 이하·비수치는 사유와 함께 throw. */
export function requirePositive(v: unknown, label: string): number {
  const n = optionalNumber(v);
  if (n == null) throw new Error(`${label}을(를) 숫자로 입력해 주세요.`);
  if (n <= 0) throw new Error(`${label}은(는) 0보다 커야 합니다.`);
  return n;
}

/** 두 값의 변화율 %. base 가 0·null 이면 null(0 나눗셈으로 Infinity 를 만들지 않는다). */
function pctChange(from: number | null, to: number | null): number | null {
  if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (from === 0) return null;
  return ((to - from) / from) * 100;
}

/**
 * 보유 원장 + 시세 → 파생값이 채워진 요약.
 *
 * `close` 가 null 이면(조회 실패) 파생값도 전부 null 이다. **항목을 감추지는 않는다** —
 * 보유하고 있다는 사실 자체는 시세와 무관하게 유효하고, 조회 실패로 포지션이 화면에서
 * 사라지면 사용자는 자기가 뭘 들고 있는지 확인할 방법을 잃는다.
 */
export function summarizeHolding(
  h: StockHolding,
  quote: { close: number | null; changePct: number | null; currency: string },
  history: StockPoint[] = []
): StockHoldingSummary {
  const close = quote.close;
  return {
    ...h,
    close,
    changePct: quote.changePct,
    currency: quote.currency,
    pnlPct: pctChange(h.avgPrice, close),
    pnlAmount: close == null ? null : (close - h.avgPrice) * h.quantity,
    marketValue: close == null ? null : close * h.quantity,
    // 부호 규약: '목표가까지 얼마나 더 올라야 하는가'(+면 아직 못 미침).
    toTargetPct: pctChange(close, h.targetPrice),
    // '손절가까지 얼마나 더 떨어질 여유가 있는가'(-면 이미 이탈).
    toStopPct: pctChange(close, h.stopPrice),
    history,
  };
}

/** 손익률 표기. null 은 "-"(shared/stock.ts formatPrice 와 같은 관례). */
export function formatPnlPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

/** 손익 부호. 0 과 null 은 flat(색을 입히지 않는다는 뜻이라 같게 취급해도 안전하다). */
export function pnlTone(v: number | null): "up" | "down" | "flat" {
  if (v == null || !Number.isFinite(v) || v === 0) return "flat";
  return v > 0 ? "up" : "down";
}
