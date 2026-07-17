import type { StockMarket } from "./types.ts";

/**
 * 심볼 정규화. 원장의 자연키가 (market, symbol) 이라 입력 표기가 흔들리면 같은 종목이
 * 두 행으로 갈라진다. 저장·조회 양쪽에서 이 함수를 반드시 거치게 해서 한 행으로 모은다.
 *
 * KR: 사용자가 "5930" / "005930" / "A005930" 중 무엇을 넣든 6자리 코드 하나로 수렴시킨다.
 *     식별 가능한 숫자가 하나도 없으면 ""를 돌려준다 — 빈 문자열을 zero-pad 하면
 *     "000000" 이라는 그럴듯한 가짜 코드가 생겨 조회 실패 원인을 숨긴다.
 * US: 티커 표준 표기는 대문자. "aapl " → "AAPL". 점(BRK.B)은 티커의 일부라 보존한다.
 */
export function normalizeSymbol(raw: string, market: StockMarket): string {
  const s = (raw ?? "").trim();
  if (market === "kr") {
    const digits = s.replace(/\D/g, "");
    return digits ? digits.padStart(6, "0") : "";
  }
  return s.toUpperCase();
}

/**
 * 관심 종목 최초 시드 — 출발점일 뿐 고정 목록이 아니다.
 * 사용자가 UI 에서 자유롭게 교체·삭제·추가할 수 있고, 한 번 시드된 뒤에는 다시 주입되지 않는다.
 * (재주입 방지 규칙은 src/stock/tickers.ts 의 ensureSeedTickers 주석 참고)
 *
 * quoteCode 는 네이버 시세 조회 경로에 그대로 박히는 값이다.
 * KR 은 종목코드가 곧 조회코드라 symbol 과 같고, US 는 로이터 코드(나스닥=".O")를 쓴다.
 */
export const DEFAULT_STOCK_TICKERS: Record<
  StockMarket,
  Array<{ symbol: string; name: string; quoteCode: string; exchange: string }>
> = {
  kr: [
    { symbol: "005930", name: "삼성전자", quoteCode: "005930", exchange: "코스피" },
    { symbol: "000660", name: "SK하이닉스", quoteCode: "000660", exchange: "코스피" },
    { symbol: "005380", name: "현대차", quoteCode: "005380", exchange: "코스피" },
    { symbol: "035420", name: "NAVER", quoteCode: "035420", exchange: "코스피" },
  ],
  // 미국 종목 지침을 아직 받지 못해 널리 알려진 대형주로 채워둔 자리표시용 시드다.
  // 사용자가 UI 에서 교체 가능하므로 이 목록 자체에 의미를 두지 말 것.
  us: [
    { symbol: "AAPL", name: "애플", quoteCode: "AAPL.O", exchange: "나스닥" },
    { symbol: "NVDA", name: "엔비디아", quoteCode: "NVDA.O", exchange: "나스닥" },
    { symbol: "MSFT", name: "마이크로소프트", quoteCode: "MSFT.O", exchange: "나스닥" },
    { symbol: "TSLA", name: "테슬라", quoteCode: "TSLA.O", exchange: "나스닥" },
  ],
};

export function marketLabel(m: StockMarket): string {
  return m === "kr" ? "한국장" : "미국장";
}

/**
 * 시세 표기. 통화마다 소수 자릿수 관습이 달라서 currency 로 분기한다.
 * KRW 는 소수점을 쓰지 않지만 stock_points.close 가 REAL 이라 346500.0 같은 값이 들어온다 → 반올림.
 * 값 없음은 "-" (web/src/lib/utils.ts formatWon 과 같은 표기).
 */
export function formatPrice(v: number | null, currency: string): string {
  if (v == null || !Number.isFinite(v)) return "-";
  if (currency === "KRW") return `${Math.round(v).toLocaleString("ko-KR")}원`;
  if (currency === "USD")
    return `$${v.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  // 미지원 통화도 숫자를 잃지 않게 코드를 덧붙여 표기한다.
  return `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency}`;
}

/** 등락 방향. 0 과 null 은 모두 flat — 색을 입히지 않는다는 뜻이라 같게 취급해도 안전하다. */
export function changeTone(pct: number | null): "up" | "down" | "flat" {
  if (pct == null || !Number.isFinite(pct) || pct === 0) return "flat";
  return pct > 0 ? "up" : "down";
}
