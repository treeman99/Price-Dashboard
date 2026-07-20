// 증시 알림 발송 원장(stock_runs.detail).
//
// ⚠️ 왜 별도 모듈인가: stock.ts 는 최상단에서 curate.ts(Agent SDK)·quote.ts·stock-email.ts 를
// 물고 있어서, 원장 로직을 그 안에 두면 회귀 테스트가 LLM·발송기를 통째로 끌고 온다.
// 순수 함수 + DB 접근만 여기로 분리해 단위 테스트가 가능하게 한다.
//
// ── 멱등 키 설계 ──
// 키는 (수집일 date, market, **슬롯 시각 slot**) 3튜플이다. 예전에는 (date, market) 뿐이라
// 하루 2회 스케줄(예: stockUs ["17:00","08:00"])에서 첫 슬롯이 notified=true 를 남기면
// 두 번째 슬롯 알림이 통째로 삼켜졌다.
//
// 저장은 스키마를 건드리지 않고 자유형 JSON 인 stock_runs.detail 안에
//   notifiedBySlot: { "08:00": { email, imessage }, "17:00": {...} }
// 맵으로 둔다. PK 에 slot 을 넣으려면 SQLite 특성상 테이블 재작성이 필요한데,
// db/index.ts 의 migrate() 는 ADD COLUMN 멱등 패턴만 지원하고 재작성 전례가 없다.
//
// ⚠️ finishStockRun 은 `detail = excluded.detail` 로 detail 을 **통째로 덮어쓴다**.
// 따라서 원장을 기록하는 모든 경로(정상/휴장 2곳/수집 실패)는 반드시 맵 '전체'를 재기록해야
// 한다. 한 곳이라도 빠뜨리면 그 경로가 다른 슬롯의 발송 기록을 조용히 지워 중복 발송이 난다.
//
// 가정: **슬롯은 같은 로컬 날짜(KST) 안에서 완결된다.** date 는 런 시작 시점의 localDate 이고
// 슬롯 키는 스케줄 문자열이라, 자정을 걸치는 슬롯(예: 23:55)을 넣으면 원장 날짜와
// catch-up 의 당일 판정이 어긋난다. 현재 설정(08:00/17:00)에서는 무관하다.
//
// 알려진 대가: 같은 날 스케줄 시각을 바꾸면(08:00 발송 후 09:00 으로 수정) 키가 달라져
// 그날 1회 추가 발송될 수 있다. 슬롯 문자열을 키로 쓰는 설계의 구조적 대가이며,
// 스케줄 변경이 드물고 결과가 '알림 1회 중복'이라 허용한다.

import { parseCollectTime } from "../config.ts";
import { getStockRun } from "../db/repo.ts";
// schedule-store 는 config/log/types 만 의존해 순환이 없다.
// ⚠️ scheduler.ts 는 절대 import 하지 말 것 — scheduler.ts 가 stock.ts 를 물고 있어 사이클이 된다.
import { getSchedule } from "../scheduler/schedule-store.ts";
import type { StockMarket } from "../../shared/types.ts";

/** 채널별 발송 성공 여부. 슬롯 안의 채널 세분성(부분 실패 재시도)을 유지하기 위한 단위. */
export interface NotifiedFlags {
  email: boolean;
  imessage: boolean;
}

/** 슬롯 시각("HH:mm") → 채널별 발송 여부. */
export type NotifiedBySlot = Record<string, NotifiedFlags>;

/** 슬롯을 특정할 수 없는 호출(첫 슬롯 이전의 수동 갱신)이 쓰는 의사 슬롯. */
export const MANUAL_SLOT = "manual";

/**
 * "이 슬롯은 처리가 끝났고 더 보낼 것이 없다"를 뜻하는 플래그.
 *
 * 원장 플래그의 의미는 '발송 성공'이 아니라 **'이 채널로 더 보낼 것이 없음'** 이다.
 * 휴장·내용 0건처럼 애초에 보낼 게 없는 경로도 이 값으로 슬롯을 닫아야 한다.
 * 닫지 않으면 slotNeedsCatchup 이 그 슬롯을 영원히 '미발송'으로 보고
 * 30분마다 catch-up 을 재발화시킨다(휴장일 무한 재수집).
 */
export const SLOT_HANDLED: NotifiedFlags = { email: true, imessage: true };

/**
 * 원장에서 슬롯별 발송 맵을 통째로 읽는다. 없으면 빈 맵.
 *
 * ⚠️ 레거시 top-level `detail.notified` 는 **의도적으로 무시한다.**
 * 승계하면 배포 당일 남은 슬롯이 또 삼켜져 이 수정의 목적 자체가 하루 유예된다.
 * 무시해도 안전한 근거: catch-up(scheduler.ts checkStockCatchup)은
 * `snapshotTime < scheduled` 일 때만 발화하는데, 알림이 이미 나갔다면 그 런이
 * snapshot.updatedAt 을 해당 슬롯 시각 이후로 밀어놓았으므로 게이트가 거짓이다.
 * 즉 레거시를 무시해도 배포 직후 재발송 경로가 구조적으로 없다.
 * (이 주석 없이 '레거시 승계 누락 버그'로 오인해 되돌리지 말 것.)
 */
export function loadNotifiedMap(date: string, market: StockMarket): NotifiedBySlot {
  return readRawMap(date, market) ?? {};
}

/** 원장 원본. 그날 행이 없거나 구 포맷이면 null(= '판단 근거 없음'), 있으면 정규화된 맵. */
function readRawMap(date: string, market: StockMarket): NotifiedBySlot | null {
  const d = getStockRun(date, market)?.detail as
    | { notifiedBySlot?: Record<string, { email?: boolean; imessage?: boolean }> }
    | null
    | undefined;
  const raw = d?.notifiedBySlot;
  if (!raw || typeof raw !== "object") return null;
  const out: NotifiedBySlot = {};
  for (const [slot, v] of Object.entries(raw)) {
    out[slot] = { email: v?.email === true, imessage: v?.imessage === true };
  }
  return out;
}

/** 해당 슬롯의 발송 여부. 기록이 없으면 '아직 안 보냄'. */
export function slotNotified(map: NotifiedBySlot, slot: string): NotifiedFlags {
  const v = map[slot];
  return { email: v?.email === true, imessage: v?.imessage === true };
}

/** 맵을 복사해 해당 슬롯 엔트리만 교체(다른 슬롯 기록 보존). */
export function mergeNotified(
  map: NotifiedBySlot,
  slot: string,
  flags: NotifiedFlags
): NotifiedBySlot {
  return { ...map, [slot]: { email: flags.email, imessage: flags.imessage } };
}

/**
 * catch-up 이 이 슬롯을 보충해야 하는지 — **원장을 1차 근거로** 판정한다.
 *
 * 왜 필요한가: scheduler 의 기존 게이트는 snapshot.updatedAt 만 봤다. 그래서 슬롯 시각을
 * 넘겨서 끝난 런(실측 6~8분)이 그 슬롯의 알림을 영구히 삼켰다. 예:
 * 16:55 에 시작한 08:00 보충 런이 17:03 에 끝나면 → 17:00 정시 cron 은 running 가드에
 * 막혀 통째로 스킵되고, 이후 catch-up 은 snapshotTime(17:03) >= 17:00 이라 발화하지 않는다.
 * 스냅샷은 신선하니 화면상 이상도 없다 — 이 수정이 없애려던 증상 그대로다.
 * '보냈는지'는 스냅샷 시각이 아니라 원장만이 안다.
 *
 * 반환 false 의 의미는 '보냈다'가 아니라 **'보충할 근거가 없다'** 이다:
 * - 그날 원장 자체가 없으면(행 없음/레거시 구 포맷) false → 기존 스냅샷 기반 게이트에 맡긴다.
 *   배포 당일 구 포맷 행을 '미발송'으로 오독해 그날 브리핑을 재발송하는 것을 막는다.
 * - 채널 하나라도 열려 있으면 true — 부분 실패 재시도는 알림 블록이 채널별로 처리한다.
 */
export function slotNeedsCatchup(date: string, market: StockMarket, slot: string): boolean {
  const map = readRawMap(date, market);
  if (!map) return false;
  const f = slotNotified(map, slot);
  return !f.email || !f.imessage;
}

/**
 * 이 슬롯이 원장에 **명시적으로 '처리 완료'로 닫혀 있는지.**
 *
 * slotNeedsCatchup 의 부정이 아니다. 두 함수는 '원장 자체가 없음'(그날 행이 없거나 구 포맷)을
 * **둘 다 false** 로 답한다 — 전자는 "보충할 근거가 없다", 후자는 "닫혔다는 근거가 없다".
 * 이 비대칭이 의도된 것이고, 두 게이트가 서로를 상쇄하지 않게 하는 핵심이다:
 *   · 서버가 08:00 에 죽어 그날 행이 아예 없다 → slotHandled=false → catch-up 이 발화해야 한다.
 *   · 휴장 런이 SLOT_HANDLED 로 닫았다 → slotHandled=true → 스냅샷이 어떻든 재수집 금지.
 *
 * 왜 필요한가(휴장일 무한 catch-up 핑퐁): 휴장 스냅샷은 역할 파일을 오염시키지 않으려고
 * **항상 both 경로 한 곳**에 저장된다(stock.ts HOLIDAY_STORAGE_ROLE). 파일이 하나라 slot
 * 필드도 하나만 담기므로, 슬롯이 2개인 날은 나중 런이 앞선 런의 slot 을 덮어써 앞선 슬롯이
 * '커버 안 됨'으로 보인다. 스냅샷만 보는 게이트는 이때 두 슬롯을 30분마다 번갈아 재발화시킨다.
 * 원장은 슬롯별 맵이라 이 상황에서도 정확하므로, 스냅샷 부재를 원장으로 한 번 더 거른다.
 */
export function slotHandled(date: string, market: StockMarket, slot: string): boolean {
  const map = readRawMap(date, market);
  if (!map) return false;
  const f = slotNotified(map, slot);
  return f.email && f.imessage;
}

/**
 * 시각 목록 중 now 기준으로 **가장 최근에 지난 슬롯**. 없으면 null.
 *
 * ⚠️ getSchedule() 은 정렬을 보장하지 않는다(실제 data/schedule.json 이 ["17:00","08:00"]).
 * 그래서 인덱싱이 아니라 조건 만족 항목의 max 스캔으로 구한다.
 * 항목별 try/catch 로 fail-open — 깨진 항목 하나가 귀속 전체를 막으면 안 된다.
 *
 * 경계 여유(grace)를 일부러 두지 않았다. 여유를 주면 07:59 수동 갱신이 08:00 슬롯을
 * 선점해 정작 08:00 정시 런의 알림이 삼켜진다. '지난 슬롯만 후보'라는 불변식이
 * 미래 슬롯 선점을 구조적으로 막아주는 것이 이 함수의 존재 이유다.
 */
export function latestPastSlot(times: string[], now: Date): string | null {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let best: string | null = null;
  let bestMin = -1;
  for (const t of times) {
    let min: number;
    try {
      const { hour, minute } = parseCollectTime(t);
      min = hour * 60 + minute;
    } catch {
      continue; // 형식 오류 항목은 조용히 스킵
    }
    if (min <= nowMin && min > bestMin) {
      bestMin = min;
      best = t;
    }
  }
  return best;
}

/**
 * 이번 런이 어느 슬롯에 귀속되는지 확정한다.
 *
 * - 정시/catch-up: 스케줄러가 **이미 알고 있는** 슬롯 문자열(cron 클로저의 t,
 *   catch-up 루프 변수 t)을 그대로 받는다. 역산이 아니라 인과적으로 정확한 값이다.
 * - 수동 갱신(routes.ts): 대응 슬롯이 없으므로 런 시작 시각 기준 '가장 최근 지난 슬롯'에
 *   귀속시킨다. 그 슬롯이 이미 발송됐으면 조용히 스킵(현행 동작 보존), 미발송이면 보충 발송한다.
 * - 첫 슬롯 이전(오늘 지난 슬롯이 아예 없음)이면 MANUAL_SLOT. 이 경우 **알림을 보내지 않는다**
 *   (stock.ts 6단계). 보충할 슬롯이 없는데 보내면, 곧 이어질 첫 정시 슬롯이 같은 브리핑을
 *   한 번 더 보내 중복이 된다(07:30 수동 → 08:00 정시 = 23분 간격 2회).
 *   미래 슬롯에 귀속시키는 대안은 정시 알림을 삼키므로 더 나쁘다. 결과적으로 수동 갱신의
 *   규칙은 '지난 슬롯의 누락을 메울 뿐, 새 알림을 만들지 않는다'로 일관된다.
 *
 * ⚠️ now 는 반드시 **런 시작 시점**의 시각이어야 한다. 실측상 증시 런은 6~8분 걸려서
 * (로그 08:00:00.383 시작 → 08:06:02.511 종료) 알림 블록 도달 시점에 다시 구하면
 * 촘촘한 슬롯 설정에서 다음 슬롯을 선점해 조용한 누락을 만든다.
 */
export function resolveSlot(market: StockMarket, slot: string | undefined, now: Date): string {
  if (slot) return slot;
  const s = getSchedule();
  const times = market === "kr" ? s.stockKr : s.stockUs;
  return latestPastSlot(times, now) ?? MANUAL_SLOT;
}
