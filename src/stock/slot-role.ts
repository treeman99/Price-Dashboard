// 증시 브리핑 슬롯의 **역할**(간밤 마감결산 / 오늘 밤 개장프리뷰) 판정.
//
// ── 왜 이 모듈이 필요한가 ──
// 미국장은 하루 2회(기본 08:00 / 17:00 KST) 브리핑이 나가는데, 예전에는 두 런이 같은 성격
// (결산+프리뷰 혼합)을 다뤄 같은 내용이 두 번 나갔다. 이제 슬롯마다 성격을 나눈다:
//   · 아침 슬롯 = 간밤에 마감된 뉴욕 세션의 **결산**
//   · 오후 슬롯 = 오늘 밤 열릴 뉴욕 세션의 **프리뷰**
//
// ── 왜 별도 모듈인가 ──
// notify-ledger.ts 와 같은 이유다. stock.ts 는 최상단에서 curate.ts(Agent SDK)·quote.ts·
// stock-email.ts 를 물고 있어, 판정 로직을 그 안에 두면 회귀 테스트가 LLM·발송기를 통째로
// 끌고 온다. 의존은 config(parseCollectTime)·log 뿐이라 순환이 없다.
//
// ── 왜 '슬롯 문자열' 기준인가 (now 기준이면 안 되는 이유) ──
// catch-up 런은 실행 시각과 슬롯 시각이 최대 9시간까지 벌어진다. 16:55 에 "08:00" 슬롯을
// 보충하는 런을 now(16:55) 기준으로 판정하면 프리뷰가 되고, 곧 17:00 정시가 프리뷰를 또
// 내보내 그날은 **프리뷰 2회 + 결산 0회**가 된다. 슬롯 문자열은 스케줄러가 인과적으로
// 아는 확정 정보다(notify-ledger.ts resolveSlot 주석과 동일한 독법).
//
// ── 왜 리터럴("08:00"/"17:00") 매칭이 아닌가 ──
// PUT /schedule → rescheduleAll(routes.ts, scheduler.ts) 이 **재시작 없이** 슬롯 문자열을
// 갈아끼운다. 리터럴 상수는 사용자가 08:00 → 06:00 으로 옮기는 순간 조용히 깨진다.
// 정렬 후 서수(첫째/둘째) 방식도 배제했다 — config 의 기본값이 단일 "18:00" 이라 무너진다.

import { parseCollectTime } from "../config.ts";
import { log } from "../util/log.ts";
import { MANUAL_SLOT } from "./notify-ledger.ts";
import type { StockMarket, StockSlotRole } from "../../shared/types.ts";

// ── 서머타임 안전대 (이 상수들이 이 설계의 핵심 가드다) ──────────────────
//
// 역할 판정이 실제로 전제하는 것은 "KST 시각 ↔ 뉴욕 날짜" 대응이고, 이 대응은 EDT(KST=ET+13)
// 와 EST(KST=ET+14) 에서 1시간 어긋난다. 두 체제가 **동시에** 성립하는 구간만 밴드로 쓴다.
//
//   결산 전제 = "뉴욕 날짜 == KST 날짜 − 1" 且 "16:00 ET 마감 경과"
//     → EDT 는 KST 05:00~13:00, EST 는 KST 06:00~14:00 → 교집합 **06:00 ~ 13:00**
//     ⚠️ 13:00 정각은 배제한다. EDT 에서 KST 13:00 = 당일 00:00 ET 라 뉴욕 날짜가 KST 날짜와
//        같아진다(전일이 아니다). 13:00~13:59 는 계절마다 뒤집히는 구간이다.
//
//   프리뷰 전제 = "뉴욕 날짜 == KST 날짜" 且 "09:30 ET 개장 전"
//     → 하한: EDT 13:00 / EST 14:00 → 교집합 **14:00**
//     → 상한: EDT 22:30 / EST 23:30 → 교집합 **22:30**
//     ⚠️ 상한을 24:00 으로 두면 EDT 기간의 KST 23:00 슬롯(=10:00 ET, **이미 개장 후**)이
//        '개장 프리뷰'로 판정되어 이미 열린 세션을 개장 전인 양 브리핑한다.
//
// 밴드 밖(00:00~05:59, 13:00~13:59, 22:30~23:59)은 역할을 확정할 수 없으므로 "both"(현행
// 혼합 브리핑)로 떨어뜨리고 warn 을 남긴다 — 조용히 오판하는 것보다 낫다.
//
// 부수 한계: NYSE_CLOSE_HOUR(calendar.ts)가 16 단일 상수라, 조기폐장일(추수감사절 다음날·
// 크리스마스 이브 13:00 ET)에도 16:00 ET 를 기준으로 '마감됨'을 판정한다. 현행 밴드
// (KST 06:00 이후 = EST 기준 16:00 ET 이후)에서는 무해하지만, 슬롯을 KST 05:00 이전으로
// 옮기면 그날 결산이 하루 밀린다.
const CLOSE_BAND_START = 6 * 60; // 06:00 (포함)
const CLOSE_BAND_END = 13 * 60; // 13:00 (배제)
const PREVIEW_BAND_START = 14 * 60; // 14:00 (포함)
const PREVIEW_BAND_END = 22 * 60 + 30; // 22:30 (배제)

/** 슬롯 시각이 속한 밴드. 파싱 실패·밴드 밖이면 null. */
function bandOf(slot: string): "close" | "preview" | null {
  let min: number;
  try {
    const { hour, minute } = parseCollectTime(slot);
    min = hour * 60 + minute;
  } catch {
    // MANUAL_SLOT("manual") 이 여기로 온다. throw 를 흘리면 수동 갱신이 통째로 깨진다.
    return null;
  }
  if (min >= CLOSE_BAND_START && min < CLOSE_BAND_END) return "close";
  if (min >= PREVIEW_BAND_START && min < PREVIEW_BAND_END) return "preview";
  return null;
}

/**
 * 이 시장의 슬롯 구성에서 역할 분리가 활성인지.
 *
 * **결산 밴드 슬롯과 프리뷰 밴드 슬롯이 둘 다 있을 때만** 분리한다. 이것이 하위호환의 급소다:
 * - 슬롯이 1개면(config 기본값 단일 "18:00") 분리할 수 없다 → 현행 혼합 브리핑 유지.
 * - 슬롯이 2개여도 같은 밴드에 몰려 있으면(예: ["08:00","10:00"]) 결산만 2회 나가고
 *   **오늘 밤 프리뷰 내용이 영구 소실**된다. 지금은 혼합 브리핑이라 프리뷰를 받고 있으므로
 *   그건 명백한 회귀다 → 이 경우도 both 로 되돌린다.
 *
 * ⚠️ market 축을 명시적으로 잠근다. 한국장은 resolveSession 의 kr 분기(nextKrSessionDate)가
 * 이미 '개장 전 프리뷰' 판정 그 자체이고 밴드는 **뉴욕 기준**이라, kr 에 밴드를 적용하면
 * 판정이 어긋난다. 기본 슬롯이 08:00 하나뿐이라 우연히 both 가 되는 것에 기대면 안 된다 —
 * 사용자가 kr 슬롯을 15:00 에 추가하는 순간 조용히 깨진다.
 */
export function isRoleSplitActive(market: StockMarket, times: readonly string[]): boolean {
  if (market !== "us") return false;
  const bands = times.map(bandOf);
  return bands.includes("close") && bands.includes("preview");
}

/** 역할 판정 결과 + **왜 그렇게 판정됐는지**(로그·스냅샷·화면 툴팁에 그대로 실린다). */
export interface StockSlotRoleDecision {
  role: StockSlotRole;
  reason: string;
}

/**
 * 이 런의 역할을 확정한다. 반드시 **런 시작 시점에 확정된 슬롯 문자열**을 넘길 것.
 *
 * @param times 해당 시장의 전체 슬롯 목록(getSchedule()). 분리 활성 게이트 판정에 쓴다.
 */
export function stockSlotRoleDetail(
  market: StockMarket,
  slot: string,
  times: readonly string[]
): StockSlotRoleDecision {
  if (market !== "us") {
    return { role: "both", reason: `market=${market} — 역할 분리는 미국장 전용` };
  }
  if (!isRoleSplitActive(market, times)) {
    return {
      role: "both",
      reason:
        `분리 비활성 — 슬롯 [${times.join(",")}] 에 결산 밴드(06:00~13:00)와 ` +
        `프리뷰 밴드(14:00~22:30) 슬롯이 둘 다 있어야 한다`,
    };
  }
  if (slot === MANUAL_SLOT) {
    // 첫 슬롯 이전의 수동 갱신. 발송은 sendable 가드(stock.ts)가 이미 막으므로 화면 표시용일
    // 뿐이고, 두 역할의 상위집합인 both(현행 혼합)가 정보 손실이 없어 가장 안전하다.
    return { role: "both", reason: `slot=${MANUAL_SLOT} — 귀속 슬롯 없음, 혼합 브리핑으로 표시` };
  }
  const band = bandOf(slot);
  if (!band) {
    log.warn(
      `증시 역할 판정: 슬롯 ${slot} 은 서머타임 안전대 밖이다(결산 06:00~13:00 / 프리뷰 14:00~22:30). ` +
        `EDT·EST 에서 뉴욕 날짜 대응이 뒤집히거나 이미 개장한 뒤라 역할을 확정할 수 없어 혼합 브리핑으로 처리한다.`
    );
    return { role: "both", reason: `slot=${slot} 안전대 밖 — 혼합 브리핑으로 폴백` };
  }
  return { role: band, reason: `slot=${slot} ${band} 밴드 / 분리 활성` };
}

/** stockSlotRoleDetail 의 role 만. */
export function stockSlotRole(
  market: StockMarket,
  slot: string,
  times: readonly string[]
): StockSlotRole {
  return stockSlotRoleDetail(market, slot, times).role;
}

/**
 * 서버 기동 시 1회 남기는 구성 요약.
 *
 * 이 로그가 없으면 '슬롯을 하나로 줄이면 역할 분리가 조용히 꺼진다'는 비자명 동작을
 * 사용자가 알아챌 방법이 없다. 이 설계의 유일한 가시화 수단이라 옵션이 아니다.
 */
export function describeSlotRoles(market: StockMarket, times: readonly string[]): string {
  const label = market === "kr" ? "한국장" : "미국장";
  if (!isRoleSplitActive(market, times)) {
    const bands = times.map(bandOf);
    const why =
      market !== "us"
        ? "미국장 전용 기능"
        : !bands.includes("close")
          ? "결산 밴드(06:00~13:00) 슬롯 없음"
          : !bands.includes("preview")
            ? "프리뷰 밴드(14:00~22:30) 슬롯 없음"
            : "슬롯 없음";
    return `증시 역할 분리 비활성 [${label}] (${why}) — 혼합 브리핑 유지 (슬롯 ${times.join(",") || "없음"})`;
  }
  const parts = times.map((t) => {
    const b = bandOf(t);
    return `${t}=${b === "close" ? "마감결산" : b === "preview" ? "개장프리뷰" : "혼합(안전대 밖)"}`;
  });
  return `증시 역할 분리 활성 [${label}]: ${parts.join(", ")}`;
}
