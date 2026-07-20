import type { StockMarket, StockSlotRole, StockSnapshot, StockWatchItem } from "./types.ts";

/**
 * 스냅샷의 **유효 역할**. role 이 없으면 'both'(현행 혼합본)로 접는다.
 *
 * ⚠️ 렌더 표면(이메일 제목·h1·서브라인·iMessage head·웹 헤더·배지·휴장 배너)은 s.role 을
 * 직접 읽지 말고 **반드시 이 함수만** 쓸 것. loadFromDisk 가 `as StockSnapshot` 캐스트라
 * 런타임 검증이 없어서, 한 곳이라도 직접 읽으면 구 디스크 스냅샷에서 undefined 가 샌다.
 * (이 저장소엔 분리 규칙을 채널마다 따로 구현했다가 표기가 갈라진 선례가 있다 —
 *  partitionWatchlist 주석 참고.)
 */
export function effectiveRole(s: Pick<StockSnapshot, "role">): StockSlotRole {
  return s.role ?? "both";
}

/**
 * 역할 라벨. 'both' 는 **null** 이다 — 라벨을 붙이지 않는 것이 현행 문구 보존이고,
 * 그래야 단일 슬롯 사용자와 한국장의 이메일 제목·검색 필터가 한 글자도 안 바뀐다.
 */
export function roleLabel(role: StockSlotRole): string | null {
  return role === "close" ? "마감결산" : role === "preview" ? "개장프리뷰" : null;
}

/**
 * 서울 기준 오늘 날짜("YYYY-MM-DD").
 *
 * 서버는 KST 로 돌지만 **브라우저는 아무 타임존이나 될 수 있다.** 프리뷰 스냅샷의 신선도를
 * 로컬 날짜로 판정하면 해외에서 열었을 때 라벨이 하루 어긋난다. sessionDate 는 언제나
 * 서울 기준으로 찍히므로 비교 축도 서울로 고정한다. en-CA 로케일이 정확히 ISO 형식을 준다.
 */
export function seoulToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * 프리뷰 스냅샷이 **아직 열리지 않은 세션**을 가리키는지.
 *
 * 프리뷰는 하루에 한 번(오후 슬롯)만 갱신되므로, 다음 오후 슬롯까지 약 9시간 동안 화면에는
 * **어제 밤 프리뷰**가 남아 있다. 그걸 '오늘 밤'이라고 단언하면 이미 지나간 세션을 미래형으로
 * 읽게 되어 두 브리핑을 혼동한다(사용자 제약 C). 렌더 표면은 이 술어로 시제를 갈라야 한다.
 */
export function isPreviewUpcoming(
  s: Pick<StockSnapshot, "role" | "sessionDate">,
  today: string = seoulToday()
): boolean {
  return effectiveRole(s) === "preview" && !!s.sessionDate && s.sessionDate >= today;
}

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

/**
 * 관심 종목 1건의 **실제 상장 시장**.
 *
 * market 태그가 없는 항목은 이 필드 도입 이전에 저장된 옛 스냅샷의 것이다. 폴백은
 * 스냅샷 시장이지만, **그 폴백이 정당한 것은 verified===true 인 옛 항목에 한한다**:
 * 옛 verifyWatchlist 는 `c.market === market` 로 후보를 거른 뒤에만 시세를 붙였으므로
 * 시세가 붙은(verified) 항목만 '스냅샷 시장 소속'이 보장된다. 반대로 옛 코드는 검증
 * 실패 항목을 verified=false 로 **그대로 통과**시켰고, 그 구멍으로 한국장 스냅샷에
 * NVDA(currency=KRW, close=null)가 들어앉았다 — 이 버그 자체가 '옛 항목은 전부 스냅샷
 * 시장 소속'이라는 전제의 반례다. 그래서 `market 태그 없음 && verified!==true` 는
 * '레거시 오염 의심' 마커로 쓰고, partitionWatchlist 가 렌더에서 제외한다.
 */
export function watchMarket(w: StockWatchItem, snapshotMarket: StockMarket): StockMarket {
  return w.market ?? snapshotMarket;
}

/**
 * market 태그가 없고 시세도 검증되지 않은 **레거시 오염 의심 항목**인지.
 *
 * 새 정책(verifyWatchlist)에서 watchlist 에 남는 항목은 항상 verified===true 다 —
 * 검증 실패는 전부 드롭된다. 따라서 verified!==true 인 watchlist 항목은 옛 정책이
 * 남긴 잔재이고, 그 시장 소속을 신뢰할 근거가 없다(NVDA 가 정확히 그 사례).
 * 디스크의 옛 스냅샷은 다음 수집이 통째로 교체할 때까지 남으므로, 그때까지
 * 렌더 계층이 이 항목을 걸러야 신고된 증상이 되살아나지 않는다.
 */
function isLegacySuspect(w: StockWatchItem): boolean {
  return w.market == null && w.verified !== true;
}

/**
 * watchlist 를 '이 시장 종목' / '해외 참고(타 시장)' 로 가른다. 원래 순서를 보존한다.
 * 레거시 오염 의심 항목(isLegacySuspect)은 어느 쪽에도 넣지 않고 `stale` 로 뺀다.
 *
 * ⚠️ 웹·이메일이 **반드시 이 함수 하나만** 써야 한다. 분리 규칙을 채널마다 따로 구현하면
 *    표기가 갈라진다(이 저장소엔 이미 관심 종목 이모지가 메일 💡 / 웹 🔍 로 갈라진 선례가 있다).
 * `?? []` 를 여기서 한 번 방어하므로 옛 스냅샷(watchlist 키 부재)도 안전하다.
 */
export function partitionWatchlist(s: StockSnapshot): {
  domestic: StockWatchItem[];
  foreign: StockWatchItem[];
  stale: StockWatchItem[];
} {
  const domestic: StockWatchItem[] = [];
  const foreign: StockWatchItem[] = [];
  const stale: StockWatchItem[] = [];
  for (const w of s.watchlist ?? []) {
    if (isLegacySuspect(w)) {
      stale.push(w);
      continue;
    }
    (watchMarket(w, s.market) === s.market ? domestic : foreign).push(w);
  }
  return { domestic, foreign, stale };
}

/**
 * '해외 참고' 섹션 제목. **라벨은 시장 대칭이 아니다** — 미국장 브리핑에 삼성전자가 라우팅됐을 때
 * 한국 사용자에게 그걸 '해외'라 부르면 틀린 말이다. 그래서 브리핑 시장 기준으로 뒤집는다.
 */
export function foreignSectionTitle(m: StockMarket): string {
  return m === "kr" ? "🌐 해외 참고" : "🌐 국내(한국) 참고";
}

/** 등락 방향. 0 과 null 은 모두 flat — 색을 입히지 않는다는 뜻이라 같게 취급해도 안전하다. */
export function changeTone(pct: number | null): "up" | "down" | "flat" {
  if (pct == null || !Number.isFinite(pct) || pct === 0) return "flat";
  return pct > 0 ? "up" : "down";
}
