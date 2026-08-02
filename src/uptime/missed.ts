/**
 * 가동 공백에 걸려 **제 시각에 돌지 못한 수집 슬롯**을 골라낸다 (명세 §8).
 *
 * ## 이 모듈이 이 기능의 신뢰도를 결정한다
 * 사후 보고의 severity(§3.5)는 오직 이 목록의 `evaluated:true` 건수로 정해진다. 원인 판정이
 * 틀려도 손실이 0이면 사용자를 방해하지 않고, 반대로 **여기서 한 번이라도 거짓 손실을 적으면
 * 사용자는 다시 읽지 않는다.**
 *
 * 실제로 초안 설계 하나가 이렇게 틀렸다 —
 *   "2026-08-02 08:00 증시(한국장) 못 돌았습니다"
 * 2026-08-02 는 **일요일**이라 한국장은 애초에 휴장이었다. `config` 의 HH:mm 만 보고 판정한
 * 대가다. 그래서 이 모듈은 시각 목록을 그대로 믿지 않고,
 *   (1) 스케줄러가 **이미 쓰고 있는 커버 술어**를 그대로 import 해 쓰고,
 *   (2) 증시는 `isMarketClosed` 로 휴장을 먼저 걷어내고,
 *   (3) 증시 펄스는 아예 후보로 만들지 않는다.
 *
 * ## ★ 부작용 절대 금지
 * DB 쓰기 0 · 파일 쓰기 0 · **수집 트리거 0**. 특히 마지막이 중요하다: 스케줄러의
 * `checkEventsCatchup()` 은 누락을 발견하는 즉시 20분짜리 LLM 작업을 발사한다. 그 함수를
 * 재사용하면 **사후 보고서를 읽는 것만으로 수집이 시작된다.** 그래서 명세 §8.1 은 catch-up
 * 함수가 아니라 그 안에서 쓰는 **술어만** 공유하기로 확정했다(scheduler.ts 는 `export`
 * 키워드 5개만 추가됐고 로직 변화는 0이다).
 *
 * 여기서 나가는 유일한 출력은 예외 경로의 `log.warn` 한 줄뿐이다.
 *
 * ## 테스트 가능성 — 왜 `deps` 인자가 있는가
 * 커버 술어들은 전부 "지금"과 "실제 data/" 를 본다. 그대로 두면 이 모듈의 테스트가
 *   · 실행한 **요일에 따라 결과가 달라지고**(일요일에 돌리면 평일 케이스가 죽는다)
 *   · 실제 `data/price.db` 와 스냅샷 파일을 열어야 한다(명시적 금지 사항).
 * 그래서 마지막 인자로 의존성 묶음을 받되 **기본값이 진짜 모듈**이라, 운영 호출부
 * (`describeMissedSlots(gapStart, gapEnd)`)는 명세 §8.2 시그니처 그대로다. 부분 교체를
 * 허용(`Partial`)해서, 테스트가 바꾸고 싶은 술어 하나만 갈아끼우고 나머지는 **진짜 구현을
 * 그대로 통과시킬 수 있게** 했다(예: 휴장 판정은 진짜 `isMarketClosed` 로 검증한다).
 *
 * ## store.ts 와의 계약 (§8.5 복구 추적)
 * 이 함수는 `recovered` 를 **언제나 false**, `recoveredAt` 을 **언제나 null** 로 돌려준다.
 * 복구 판정은 여기서 하지 않는다 — 재평가(+5·+15·+45분) 때 같은 gap 창으로 다시 호출하면
 * **보충이 끝난 슬롯은 목록에서 사라진다**(커버 술어가 true 로 바뀌므로). 즉 store.ts 는
 * `1차 목록 − N차 목록` 차집합을 복구된 슬롯으로 읽으면 된다. 이 규칙이 뒤집히면 복구율이
 * 조용히 틀려지므로 여기 못박아 둔다.
 */

import { parseCollectTime } from "../config.ts";
import { log } from "../util/log.ts";
import { localDate } from "../util/date.ts";
import { getSchedule } from "../scheduler/schedule-store.ts";
// ★ 명세 §8.1 — 스케줄러가 catch-up 판정에 쓰는 바로 그 술어들. 이중화 금지.
//   여기서 규칙을 다시 구현하면 "화면에는 놓쳤다고 나오는데 스케줄러는 보충하지 않는"
//   (또는 그 반대) 상태가 조용히 생긴다. 두 판정이 **같은 함수**를 보게 묶어 둔다.
import {
  pastTime,
  scheduledToday,
  eventsCoveredToday,
  newsCoveredAt,
  youtubeCoveredAt,
} from "../scheduler/scheduler.ts";
import { hasSnapshotForSlot } from "../stock/stock.ts";
import { slotHandled } from "../stock/notify-ledger.ts";
import { isMarketClosed } from "../stock/calendar.ts";
import { getLottoState } from "../lotto/store.ts";
import { LOTTO_CYCLE_HOUR, LOTTO_CYCLE_LABEL, LOTTO_CYCLE_WEEKDAY } from "../lotto/cycle.ts";
import { MISSED_TAB_LABEL, type MissedSlot, type MissedTab } from "../../shared/uptime.ts";
import type { ScheduleSettings, StockMarket } from "../../shared/types.ts";

// ────────────────────────────────────────────────────────────────────────────
// 상수
// ────────────────────────────────────────────────────────────────────────────

/**
 * 공백에서 훑는 로컬 날짜 수 상한 (오늘 포함, 최신 쪽부터).
 *
 * 명세에 없는 방어선이라 근거를 남긴다. 두 가지를 막는다:
 *
 * 1. **비컨 손상 시의 폭주.** 공백 시작은 `uptime-beacon.json` 의 `atMs` 에서 온다. 그 파일이
 *    깨져 `atMs=0` 으로 읽히면 1970년부터 오늘까지 ≈2만 일을 훑고, 하루 8슬롯이면 16만 건이
 *    사건 원장 JSON 에 들어간다. 진단 기능이 디스크와 기동을 잡아먹는 최악의 실패다.
 * 2. **읽을 수 없는 보고서.** 일지의 "놓친 것:" 한 줄은 사람이 읽는 문장이다. 2주 꺼져 있던
 *    맥에서 100건을 나열하면 그 줄은 정보가 아니라 소음이 된다.
 *
 * 잘라내는 쪽(오래된 날)은 전부 `evaluated:false` 라 **severity 계산에 애초에 안 들어간다**
 * (§8.4). 즉 이 상한은 등급 판정을 바꾸지 않고 나열 길이만 제한한다.
 */
export const MAX_SCAN_DAYS = 8;

/**
 * `isMarketClosed` 한 번에 허용하는 시간(ms).
 *
 * 이 함수는 네트워크를 쓰지 않지만(주말 컷 → 계산 공휴일 → 원장 파일) 원장 파일을 읽고,
 * 파일 잠금·NFS·디스크 이상 같은 것에 걸려 늘어질 수 있다. 이 기능이 멎어서 사후 보고가
 * 기동 예산(§9.3 10초)을 다 써버리면 본말전도다. 초과하면 **휴장으로 간주해 제외**한다
 * (§8.3 의 fail-open 방향 그대로 — 거짓 손실 보고를 내느니 조용한 편이 낫다).
 */
const MARKET_CLOSED_TIMEOUT_MS = 2_000;

/** 과거 날짜 슬롯에 붙는 문구(§8.4). */
const PAST_DAY_NOTE = "지난 날짜라 보충 대상이 아닙니다";

// ────────────────────────────────────────────────────────────────────────────
// 의존성 묶음
// ────────────────────────────────────────────────────────────────────────────

/**
 * 이 모듈이 바깥 세계를 보는 **유일한 창**. 기본 구현은 전부 진짜 모듈이고, 테스트만
 * 부분 교체한다.
 *
 * ⚠️ 여기에 "쓰기"에 해당하는 함수는 하나도 없다 — 그것이 §8.2 "부작용 절대 금지"를
 * 타입 차원에서 지키는 방법이다.
 */
export interface MissedSlotDeps {
  /** "오늘"의 기준 시각. 커버 술어가 오늘 슬롯에만 적용되는 이유는 §8.4. */
  now(): Date;
  schedule(): ScheduleSettings;
  pastTime(hhmm: string): boolean;
  scheduledToday(hhmm: string): Date;
  eventsCoveredToday(): boolean;
  newsCoveredAt(scheduled: Date): boolean;
  youtubeCoveredAt(scheduled: Date): boolean;
  /** `stock.ts` 의 `snapshotForSlot(...) !== null`. 슬롯 기준(역할 기준 아님)이다. */
  hasStockSnapshotForSlot(market: StockMarket, date: string, slot: string): boolean;
  /** 원장에 '이 슬롯은 처리 완료'로 닫혀 있는지. 휴장 런도 여기서 닫힌다. */
  slotHandled(date: string, market: StockMarket, slot: string): boolean;
  isMarketClosed(
    market: StockMarket,
    date: string
  ): Promise<{ closed: boolean; reason: string | null }>;
  /** 마지막 주간 사이클 시각(ISO) 또는 null. */
  lottoLastCycleAt(): string | null;
}

/** 운영 기본값. 전부 기존 모듈을 그대로 물린다(술어 이중화 0). */
const REAL_DEPS: MissedSlotDeps = {
  now: () => new Date(),
  schedule: getSchedule,
  pastTime,
  scheduledToday,
  eventsCoveredToday,
  newsCoveredAt,
  youtubeCoveredAt,
  hasStockSnapshotForSlot: hasSnapshotForSlot,
  slotHandled,
  isMarketClosed,
  lottoLastCycleAt: () => getLottoState().lastCycleAt,
};

/**
 * 기본값 위에 교체분을 얹는다.
 *
 * `{...REAL_DEPS, ...overrides}` 를 쓰지 않는 이유: 스프레드는 **명시적 `undefined` 도
 * 덮어쓴다.** 테스트가 "이 술어만 진짜 구현으로 두고 싶다"며 `newsCoveredAt: undefined` 를
 * 넘기면 진짜 함수가 지워져 호출부에서 TypeError 가 나고, 그건 catch 에 삼켜져 **손실 0건**
 * 으로 조용히 둔갑한다. `undefined` 는 "기본값을 쓰라"로 읽는다.
 */
function withDefaults(overrides: Partial<MissedSlotDeps>): MissedSlotDeps {
  const merged: Record<string, unknown> = { ...REAL_DEPS };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as unknown as MissedSlotDeps;
}

// ────────────────────────────────────────────────────────────────────────────
// 시간 유틸 (로컬 기준 — 저장소 관례상 "오늘"은 UTC 가 아니다)
// ────────────────────────────────────────────────────────────────────────────

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * 로컬 오프셋을 붙인 ISO 문자열(`2026-08-02T08:00:00+09:00`).
 *
 * `Date#toISOString()` 을 쓰지 않는 이유: 그건 UTC(`...T23:00:00.000Z`)라 사용자가 사건을
 * 되짚을 때 날짜가 하루 어긋나 보인다. 명세 §5.4 도 `scheduledAt: ISO(+09:00)` 라고 못박았다.
 * 오프셋을 "+09:00" 으로 하드코딩하지 않고 실제 타임존에서 계산한다 — 이 맥이 여행지에서
 * 타임존을 바꿔도 기록이 거짓말하지 않게.
 */
function toLocalIso(d: Date): string {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * 공백이 걸친 로컬 날짜 목록(오름차순). **최신 날짜부터 세어** `maxDays` 개까지만 남긴다.
 *
 * 날짜를 문자열 산술이 아니라 `setDate(-1)` 로 물리는 이유는 DST·월말 처리다. 한국은 DST가
 * 없지만, 이 코드가 타임존 가정을 갖지 않는 편이 나중에 덜 아프다.
 */
function localDaysInGap(startMs: number, endMs: number, maxDays: number): string[] {
  const firstDay = new Date(startMs);
  firstDay.setHours(0, 0, 0, 0);
  const cursor = new Date(endMs);
  cursor.setHours(0, 0, 0, 0);

  const days: string[] = [];
  while (cursor.getTime() >= firstDay.getTime() && days.length < maxDays) {
    days.push(localDate(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  return days.reverse();
}

/** `YYYY-MM-DD` + `HH:mm` → 그 날 그 시각의 로컬 Date. 형식이 깨졌으면 null. */
function scheduledOn(day: string, hhmm: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  let hour: number;
  let minute: number;
  try {
    ({ hour, minute } = parseCollectTime(hhmm));
  } catch {
    // 형식이 깨진 시각 항목 하나가 목록 전체를 죽이면 안 된다(schedule-store 와 같은 관용도).
    return null;
  }
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ────────────────────────────────────────────────────────────────────────────
// 휴장 게이트
// ────────────────────────────────────────────────────────────────────────────

/**
 * 그 날짜에 그 시장이 **휴장이었는가**. 실패·지연은 전부 `true`(휴장 = 슬롯 제외)로 접는다.
 *
 * ★ 명세 §8.3 의 fail-open 방향을 그대로 따른다. 여기서 반대로(개장으로) 접으면 휴장일마다
 *   "증시(한국장) 08:00 못 돌았습니다"가 뜨고, 그게 정확히 초안 설계가 저지른 오보다.
 */
async function marketClosedSafe(
  deps: MissedSlotDeps,
  market: StockMarket,
  date: string
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // reject 도 여기서 흡수한다. Promise.race 뒤에 남은 rejection 은 unhandled 로 새어나가
    // 프로세스를 죽일 수 있다(Node 기본 동작).
    const probe = Promise.resolve()
      .then(() => deps.isMarketClosed(market, date))
      .then(
        (r) => r?.closed === true,
        (e: unknown) => {
          log.warn(`휴장 판정 실패(${market} ${date}) → 휴장으로 간주: ${(e as Error).message}`);
          return true;
        }
      );
    const guard = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        log.warn(`휴장 판정 지연(${market} ${date}) → 휴장으로 간주`);
        resolve(true);
      }, MARKET_CLOSED_TIMEOUT_MS);
      // 이 타이머 하나 때문에 프로세스 종료가 밀리지 않게 한다.
      timer.unref?.();
    });
    return await Promise.race([probe, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 후보 규칙
// ────────────────────────────────────────────────────────────────────────────

/**
 * 후보 슬롯 하나 + 그 슬롯을 검증하는 두 술어.
 *
 * 두 술어를 나눈 이유가 §8.4 의 핵심이다:
 * - `coveredToday` : "오늘" 상태를 보는 술어. 어제 날짜에는 쓸 수 없다(스냅샷은 덮어써진다).
 * - `provenRan`    : 날짜를 인자로 받아 **과거도 답할 수 있는** 증거(증시 알림 원장, 로또
 *                    lastCycleAt). 과거 날짜 슬롯이라도 "확실히 돌았다"가 증명되면 목록에서
 *                    아예 지운다. 이 판정은 항목을 **추가하지 않고 지우기만** 하므로 §8.4 의
 *                    `evaluated:false` 원칙과 충돌하지 않는다.
 */
interface SlotRule {
  tab: MissedTab;
  /** 커버 판정에 쓰는 원본 시각 문자열. */
  hhmm: string;
  /** 사용자에게 보이는 예정 시각 표기(`"08:00"` / `"일요일 10:00"`). */
  slotLabel: string;
  coveredToday: (scheduled: Date) => boolean;
  provenRan: (scheduled: Date) => boolean;
}

const never = (): boolean => false;

/**
 * 하루치 후보 규칙을 만든다. 증시는 휴장 판정이 async 라 여기서만 await 이 필요하다.
 *
 * `schedule` 을 인자로 받는 이유: `getSchedule()` 은 호출마다 `data/schedule.json` 을 읽는다.
 * 날짜별로 다시 읽을 이유가 없고, 훑는 도중 사용자가 시각을 바꾸면 같은 사건 안에서 날짜별로
 * 다른 스케줄이 섞여 재현 불가능한 목록이 나온다. 공백 하나당 **한 번 읽은 값**으로 고정한다.
 */
async function rulesForDay(
  day: string,
  schedule: ScheduleSettings,
  deps: MissedSlotDeps
): Promise<SlotRule[]> {
  const rules: SlotRule[] = [];

  // ── 팝업·전시: 하루 1회 판정(시각별 스냅샷이 없다) ──
  for (const t of schedule.events) {
    rules.push({
      tab: "events",
      hhmm: t,
      slotLabel: t,
      coveredToday: () => deps.eventsCoveredToday(),
      provenRan: never, // 어제 커버 여부를 남기는 기록이 없다
    });
  }

  // ── 뉴스 / 유튜브: 스냅샷 updatedAt 이 예정 시각을 넘겼는지로 판정 ──
  //   두 술어 모두 `source !== "llm"` 인 폴백/빈 스냅샷을 커버로 치지 않는다. 그래서
  //   "LLM 이 실패해 빈 스냅샷만 남은 날"이 손실로 정확히 잡힌다(테스트 4번의 계약).
  for (const t of schedule.news) {
    rules.push({
      tab: "news",
      hhmm: t,
      slotLabel: t,
      coveredToday: (scheduled) => deps.newsCoveredAt(scheduled),
      provenRan: never,
    });
  }
  for (const t of schedule.youtube) {
    rules.push({
      tab: "youtube",
      hhmm: t,
      slotLabel: t,
      coveredToday: (scheduled) => deps.youtubeCoveredAt(scheduled),
      provenRan: never,
    });
  }

  // ── 증시(한국장/미국장): 휴장이면 그 날 그 시장 슬롯 전부 제외 ──
  const markets: Array<{ tab: MissedTab; market: StockMarket; times: string[] }> = [
    { tab: "stockKr", market: "kr", times: schedule.stockKr },
    { tab: "stockUs", market: "us", times: schedule.stockUs },
  ];
  for (const { tab, market, times } of markets) {
    if (times.length === 0) continue;
    if (await marketClosedSafe(deps, market, day)) continue; // ★ 일요일 KR 08:00 이 여기서 죽는다
    for (const t of times) {
      rules.push({
        tab,
        hhmm: t,
        slotLabel: t,
        // 스냅샷(1차) → 원장(2차). scheduler.checkStockCatchup 과 같은 순서·같은 함수다.
        coveredToday: () =>
          deps.hasStockSnapshotForSlot(market, day, t) || deps.slotHandled(day, market, t),
        // 원장은 날짜별 행이라 과거도 정확히 답한다. 휴장 런도 여기서 닫히므로,
        // 원장이 닫혀 있으면 그 슬롯은 확실히 처리가 끝난 것이다.
        provenRan: () => deps.slotHandled(day, market, t),
      });
    }
  }

  // ── 로또: 주 1회. 그 날이 사이클 요일이 아니면 후보 자체가 없다 ──
  const dayDate = scheduledOn(day, "00:00");
  if (dayDate && dayDate.getDay() === LOTTO_CYCLE_WEEKDAY) {
    const lottoRan = (scheduled: Date): boolean => {
      const last = deps.lottoLastCycleAt();
      if (!last) return false;
      const at = new Date(last).getTime();
      // 파싱 실패는 '모름'이다. 모름을 '안 돌았다'로 읽어 거짓 손실을 만들지 않는다.
      if (Number.isNaN(at)) return true;
      return at >= scheduled.getTime();
    };
    rules.push({
      tab: "lotto",
      hhmm: `${pad(LOTTO_CYCLE_HOUR)}:00`,
      slotLabel: LOTTO_CYCLE_LABEL, // "일요일 10:00"
      coveredToday: lottoRan,
      // lastCycleAt 은 단일 타임스탬프라 과거 일요일도 그대로 답한다.
      provenRan: lottoRan,
    });
  }

  // ── ★ 증시 펄스(stockPulse): 영구 제외 ──
  //   `scheduler.ts` 주석: "펄스에는 catch-up 이 없다 … 서버가 4시간 꺼져 있었다면 그 4개
  //   슬롯은 그냥 없던 일이다." 보고하면 1시간 절전마다 4건씩 **거짓 손실**이 생기고,
  //   severity 가 매번 "사고"로 올라가 알림이 폭발한다. `MissedTab` 유니온에 아예 없으므로
  //   타입 차원에서도 막혀 있다 — 이 주석은 "빠뜨린 게 아니라 뺀 것"임을 남기려고 둔다.

  return rules;
}

// ────────────────────────────────────────────────────────────────────────────
// 본체
// ────────────────────────────────────────────────────────────────────────────

/**
 * 공백 `[gapStart, gapEnd]` 에 걸려 제 시각에 돌지 못한 슬롯 목록(예정 시각 오름차순).
 *
 * @param gapStart  마지막 생존 시각(비컨 `atMs`).
 * @param gapEnd    공백 감지 시각.
 * @param overrides 테스트 전용 의존성 부분 교체. 운영에서는 넘기지 않는다.
 */
export async function describeMissedSlots(
  gapStart: Date,
  gapEnd: Date,
  overrides: Partial<MissedSlotDeps> = {}
): Promise<MissedSlot[]> {
  const deps = withDefaults(overrides);
  try {
    return await collect(gapStart, gapEnd, deps);
  } catch (e) {
    // ★ 절대 throw 하지 않는다. 이 목록을 못 만드는 것보다 나쁜 것은 사후 보고가 통째로
    //   실패해 사용자가 "왜 안 돌았는지"를 영영 모르게 되는 것이다. 손실 0건으로 접으면
    //   severity 가 "기록만"/"무시" 로 내려갈 뿐, 사건 자체는 남는다.
    log.warn(`놓친 슬롯 조회 실패 → 손실 0건으로 보고합니다: ${(e as Error).message}`);
    return [];
  }
}

async function collect(
  gapStart: Date,
  gapEnd: Date,
  deps: MissedSlotDeps
): Promise<MissedSlot[]> {
  const startMs = gapStart.getTime();
  const endMs = gapEnd.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];

  const today = localDate(deps.now());
  const days = localDaysInGap(startMs, endMs, MAX_SCAN_DAYS);
  const schedule = deps.schedule(); // 공백 하나당 1회만 읽는다(위 rulesForDay 주석)
  const out: MissedSlot[] = [];

  for (const day of days) {
    const isToday = day === today;
    for (const rule of await rulesForDay(day, schedule, deps)) {
      // 오늘 슬롯의 예정 시각은 스케줄러의 `scheduledToday` 로 얻는다(술어 이중화 금지).
      // 과거 날짜는 그 함수가 답할 수 없으므로 같은 규칙의 일반형을 쓴다.
      const scheduled = isToday ? deps.scheduledToday(rule.hhmm) : scheduledOn(day, rule.hhmm);
      if (!scheduled || Number.isNaN(scheduled.getTime())) continue;

      // 공백 안에 있는가.
      //   시작은 열린 구간(`>`)이다 — gapStart 는 **마지막으로 살아 있었음이 확인된 시각**이라
      //   정확히 그 시각의 슬롯은 돌았다고 보는 편이 거짓 손실을 만들지 않는다.
      //   끝은 닫힌 구간(`<=`) — 깨어난 그 순간의 슬롯은 아직 안 돈 상태일 수 있고, 이미
      //   돌았다면 아래 커버 술어가 걸러 준다.
      const at = scheduled.getTime();
      if (at <= startMs || at > endMs) continue;

      if (isToday) {
        // ★ `pastTime` 방어선: 정상 경로에서는 `at <= endMs <= now` 라 항상 참이므로 중복이다.
        //   하지만 시계가 뒤로 점프하면(`clockSuspect`, §4.5) gapEnd 가 미래가 되어 **아직
        //   오지도 않은 슬롯이 손실로 잡힌다.** 그때 이 한 줄이 막는다.
        if (!deps.pastTime(rule.hhmm)) continue;
        if (rule.coveredToday(scheduled)) continue;
        out.push(makeSlot(rule, day, scheduled, true, null));
      } else {
        // §8.4 — 어제 이전 슬롯은 커버 여부를 검증할 수 없다. 목록에는 남기되(그 시각이 공백
        // 안에 있었다는 사실은 참이다) `evaluated:false` 라 severity 계산에서 빠진다.
        // 다만 날짜별 기록으로 "확실히 돌았다"가 증명되면 조용히 지운다.
        if (rule.provenRan(scheduled)) continue;
        out.push(makeSlot(rule, day, scheduled, false, PAST_DAY_NOTE));
      }
    }
  }

  out.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  return out;
}

function makeSlot(
  rule: SlotRule,
  day: string,
  scheduled: Date,
  evaluated: boolean,
  note: string | null
): MissedSlot {
  return {
    tab: rule.tab,
    // 프론트가 매번 매핑하지 않도록 라벨을 값으로 굳혀 내려보낸다(shared/uptime.ts 주석).
    label: MISSED_TAB_LABEL[rule.tab],
    slot: rule.slotLabel,
    date: day,
    scheduledAt: toLocalIso(scheduled),
    evaluated,
    // ★ 계약: 복구 판정은 store.ts 가 재호출 결과의 **차집합**으로 한다(파일 상단 주석).
    recovered: false,
    recoveredAt: null,
    note,
  };
}
