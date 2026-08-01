import cron from "node-cron";
import { parseCollectTime } from "../config.ts";
import { getSchedule } from "./schedule-store.ts";
import { log } from "../util/log.ts";
import { runCollection } from "../collector/collect.ts";
import { hasSuccessfulRun } from "../db/repo.ts";
import { refreshEvents, hasTodaySnapshot } from "../events/events.ts";
import { refreshNews, getNewsSnapshot } from "../news/news.ts";
import { refreshYoutube, getYoutubeSnapshot, getYoutubeLastAttempt } from "../youtube/youtube.ts";
import { refreshStock, snapshotForSlot } from "../stock/stock.ts";
import { runPulse, flushPulseQueue } from "../stock/pulse.ts";
import { isQuietHour } from "../stock/pulse-gate.ts";
import { config } from "../config.ts";
import { describeSlotRoles } from "../stock/slot-role.ts";
import { slotHandled, slotNeedsCatchup } from "../stock/notify-ledger.ts";
import { localDate } from "../util/date.ts";
import {
  LOTTO_CYCLE_CRON,
  LOTTO_CYCLE_LABEL,
  catchUpWeeklyCycle,
  runWeeklyCycle,
} from "../lotto/cycle.ts";
import {
  PRIMARY_AGENT_MODEL,
  WEEKLY_RESET_CRON,
  WEEKLY_RESET_LABEL,
  checkWeeklyResetCatchup,
  restoreWeeklyPrimary,
} from "../util/model-store.ts";
import type { StockMarket } from "../../shared/types.ts";

function today(): string {
  return localDate();
}

let running = false;

/** 동시 실행 방지 래퍼 */
async function safeRun(trigger: "schedule" | "catchup") {
  if (running) {
    log.warn(`수집이 이미 진행 중 → ${trigger} 건너뜀`);
    return;
  }
  running = true;
  try {
    await runCollection({ date: today(), trigger });
  } catch (e) {
    log.error(`수집 실행 오류 [${trigger}]: ${(e as Error).message}`);
  } finally {
    running = false;
  }
}

/** 지금 시각이 주어진 예정 시각(HH:mm)을 지났는지 */
function pastTime(hhmm: string): boolean {
  const { hour, minute } = parseCollectTime(hhmm);
  const now = new Date();
  return now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
}

/**
 * catch-up: 잠자기/재시작으로 정시를 놓쳤어도, 예정 시각이 지났고
 * 오늘 성공 수집이 없으면 1회 보충한다.
 */
async function checkCatchup() {
  if (running) return;
  if (hasSuccessfulRun(today())) return;
  if (getSchedule().price.some((t) => pastTime(t))) {
    log.info(`오늘(${today()}) 가격 수집 누락 감지 → catch-up 실행`);
    await safeRun("catchup");
  }
}

// ── 팝업/전시 이벤트 스케줄 ──
let eventsRunning = false;
async function safeRefreshEvents(trigger: string, notify: boolean) {
  if (eventsRunning) {
    log.warn(`이벤트 수집 진행 중 → ${trigger} 건너뜀`);
    return;
  }
  eventsRunning = true;
  try {
    await refreshEvents({ trigger, notify });
  } catch (e) {
    log.error(`이벤트 수집 오류 [${trigger}]: ${(e as Error).message}`);
  } finally {
    eventsRunning = false;
  }
}

async function checkEventsCatchup() {
  if (eventsRunning) return;
  if (hasTodaySnapshot()) return;
  if (getSchedule().events.some((t) => pastTime(t))) {
    log.info(`오늘(${today()}) 팝업/전시 갱신 누락 감지 → catch-up 실행`);
    await safeRefreshEvents("catchup", true);
  }
}

// ── 데일리 뉴스 다이제스트 스케줄 ──
let newsRunning = false;
async function safeRefreshNews(trigger: string, notify: boolean) {
  if (newsRunning) {
    log.warn(`뉴스 수집 진행 중 → ${trigger} 건너뜀`);
    return;
  }
  newsRunning = true;
  try {
    await refreshNews({ trigger, notify });
  } catch (e) {
    log.error(`뉴스 수집 오류 [${trigger}]: ${(e as Error).message}`);
  } finally {
    newsRunning = false;
  }
}

/**
 * 뉴스 catch-up: 오늘 예정된 시간 중 하나라도 지났고 스냅샷이 없거나
 * 마지막 갱신 이후 새로운 예정 시간이 지났으면 보충한다.
 */
async function checkNewsCatchup() {
  if (newsRunning) return;
  const snapshot = getNewsSnapshot();
  const snapshotDate = snapshot?.date;
  const snapshotTime = snapshot?.updatedAt ? new Date(snapshot.updatedAt) : null;

  for (const t of getSchedule().news) {
    if (!pastTime(t)) continue;

    // 오늘자 스냅샷이 없으면 catch-up
    if (snapshotDate !== today()) {
      log.info(`오늘(${today()}) 뉴스 다이제스트 누락 감지 → catch-up 실행 (${t})`);
      await safeRefreshNews("catchup", true);
      return;
    }

    // 오늘 스냅샷이 있지만 이 예정 시간 이전에 갱신된 경우 catch-up
    if (snapshotTime) {
      const { hour, minute } = parseCollectTime(t);
      const scheduled = new Date();
      scheduled.setHours(hour, minute, 0, 0);
      if (snapshotTime < scheduled) {
        log.info(`오늘(${today()}) ${t} 뉴스 갱신 누락 감지 → catch-up 실행`);
        await safeRefreshNews("catchup", true);
        return;
      }
    }
  }
}

// ── 유튜브 소식 스케줄 ──
let youtubeRunning = false;

/**
 * catch-up 재시도 백오프.
 *
 * 수집이 실패하면 오늘자 스냅샷이 생기지 않으므로 catch-up 조건은 계속 참이고, 30분마다 무한
 * 재시도가 돈다. 큐레이션 1회가 최대 30분짜리 LLM 작업이라 실패가 이어지면 하루 종일 같은 실패를
 * 반복하며 시간·비용만 태운다(실측: 반나절 동안 8회). 연속 실패마다 다음 catch-up 을 미뤄
 * 재시도 간격을 벌린다. 정시 cron 과 수동 '지금 갱신'은 이 게이트를 타지 않는다 — 사용자가
 * 직접 누른 갱신까지 막으면 그게 진짜 먹통이다.
 */
let youtubeFailStreak = 0;
let youtubeRetryAfter = 0; // epoch ms. 이 시각 전에는 catch-up 을 건너뛴다.
const YOUTUBE_BACKOFF_BASE_MS = 30 * 60 * 1000;
const YOUTUBE_BACKOFF_MAX_MS = 4 * 60 * 60 * 1000;

async function safeRefreshYoutube(trigger: string, notify: boolean) {
  if (youtubeRunning) {
    log.warn(`유튜브 수집 진행 중 → ${trigger} 건너뜀`);
    return;
  }
  youtubeRunning = true;
  try {
    await refreshYoutube({ trigger, notify });
  } catch (e) {
    log.error(`유튜브 수집 오류 [${trigger}]: ${(e as Error).message}`);
  } finally {
    youtubeRunning = false;
    noteYoutubeOutcome();
  }
}

/** 이번 시도의 성패로 백오프를 갱신한다(성공하면 즉시 해제). */
function noteYoutubeOutcome() {
  const attempt = getYoutubeLastAttempt();
  if (attempt?.ok) {
    if (youtubeFailStreak > 0) log.info(`유튜브 수집 정상화 — catch-up 백오프 해제`);
    youtubeFailStreak = 0;
    youtubeRetryAfter = 0;
    return;
  }
  youtubeFailStreak += 1;
  const wait = Math.min(
    YOUTUBE_BACKOFF_BASE_MS * 2 ** (youtubeFailStreak - 1),
    YOUTUBE_BACKOFF_MAX_MS
  );
  youtubeRetryAfter = Date.now() + wait;
  log.warn(
    `유튜브 수집 연속 실패 ${youtubeFailStreak}회 → catch-up 재시도를 ${Math.round(wait / 60000)}분 뒤로 미룸`
  );
}

/**
 * 유튜브 catch-up: 오늘 예정된 시간 중 하나라도 지났고 스냅샷이 없거나
 * 마지막 갱신 이후 새로운 예정 시간이 지났으면 보충한다. (뉴스와 동일 패턴)
 */
async function checkYoutubeCatchup() {
  if (youtubeRunning) return;
  if (Date.now() < youtubeRetryAfter) return; // 연속 실패 백오프 중
  const snapshot = getYoutubeSnapshot();
  const snapshotDate = snapshot?.date;
  const snapshotTime = snapshot?.updatedAt ? new Date(snapshot.updatedAt) : null;

  for (const t of getSchedule().youtube) {
    if (!pastTime(t)) continue;

    if (snapshotDate !== today()) {
      log.info(`오늘(${today()}) 유튜브 소식 누락 감지 → catch-up 실행 (${t})`);
      await safeRefreshYoutube("catchup", true);
      return;
    }

    if (snapshotTime) {
      const { hour, minute } = parseCollectTime(t);
      const scheduled = new Date();
      scheduled.setHours(hour, minute, 0, 0);
      if (snapshotTime < scheduled) {
        log.info(`오늘(${today()}) ${t} 유튜브 갱신 누락 감지 → catch-up 실행`);
        await safeRefreshYoutube("catchup", true);
        return;
      }
    }
  }
}

// ── 증시 브리핑 스케줄 (한국장 08:00 / 미국장 18:00) ──
// 시장별 독립 플래그. 한쪽이 도는 중에도 다른 쪽은 돌 수 있다(수집 시각이 10시간 떨어져 있어
// 실제로 겹치진 않지만, 수동 갱신이 겹칠 수 있으므로 시장별로 잠근다).
const stockRunning: Record<StockMarket, boolean> = { kr: false, us: false };

// slot 은 알림 멱등 키의 일부다(notify-ledger 참고). 정시 런은 cron 클로저의 시각,
// catch-up 런은 '어느 슬롯을 보충하는지'를 그대로 넘긴다 — 역산이 아니라 확정 정보다.
async function safeRefreshStock(
  market: StockMarket,
  trigger: string,
  notify: boolean,
  slot?: string
) {
  if (stockRunning[market]) {
    log.warn(`증시(${market}) 수집 진행 중 → ${trigger} 건너뜀`);
    return;
  }
  stockRunning[market] = true;
  try {
    await refreshStock({ market, trigger, notify, slot });
  } catch (e) {
    log.error(`증시(${market}) 수집 오류 [${trigger}]: ${(e as Error).message}`);
  } finally {
    stockRunning[market] = false;
  }
}

/**
 * 증시 catch-up. 뉴스/유튜브와 동일 패턴.
 *
 * 휴장일 안전성의 **1차 근거는 원장**이다: refreshStock 이 휴장 런마다 그 슬롯을 SLOT_HANDLED 로
 * 닫고(mergeNotified 로 다른 슬롯 기록은 보존), 아래 두 게이트가 그 기록을 존중한다.
 * 스냅샷은 근거가 되지 못한다 — 휴장 스냅샷은 both 경로 한 곳에만 쓰이므로 슬롯이 2개인 날은
 * 두 슬롯이 동시에 커버될 수 없다(아래 slotHandled 주석).
 */
async function checkStockCatchup(market: StockMarket) {
  if (stockRunning[market]) return;
  const times = market === "kr" ? getSchedule().stockKr : getSchedule().stockUs;
  // ⚠️ 순회는 **시각 오름차순**으로 한다(저장 순서는 건드리지 않는다).
  // schedule-store 어디에도 정렬이 없고 실제 저장값이 ["17:00","08:00"] 이라, 두 슬롯이
  // 동시에 밀린 날(서비스 재시작 등)에 배열 순서대로 돌면 오후 프리뷰가 먼저 나가고
  // 아침 결산이 30분 뒤에 온다 — 역할이 생긴 뒤로는 사용자에게 시간 역순으로 보인다.
  const ordered = [...times].sort((a, b) => {
    const min = (t: string) => {
      try {
        const { hour, minute } = parseCollectTime(t);
        return hour * 60 + minute;
      } catch {
        return Number.MAX_SAFE_INTEGER; // 형식 오류 항목은 뒤로
      }
    };
    return min(a) - min(b);
  });

  for (const t of ordered) {
    if (!pastTime(t)) continue;

    // ⚠️ 1차 게이트는 **슬롯 기준**이다(hasSnapshotForSlot). 예전처럼 시장당 스냅샷 1개를
    // 전제로 `snapshotDate !== today()` 를 쓰면, 역할별 파일로 쪼갠 뒤에는 아침 결산만
    // 성공한 날 오후 프리뷰 슬롯이 '오늘 스냅샷 있음'으로 걸러져 **영구 누락**된다.
    // 반대로 파일만 나누고 게이트를 그대로 두면 30분마다 무한 catch-up 이 돈다.
    // 두 실패 모두 조용하므로 단위 테스트로 못박아 두었다.
    const slotSnapshot = snapshotForSlot(market, today(), t);
    if (!slotSnapshot) {
      // ⚠️ 스냅샷 부재만으로 발화하면 **휴장일에 30분마다 무한 핑퐁**이 돈다.
      // 휴장 스냅샷은 역할 파일 오염을 피하려고 항상 both 경로 한 곳에 저장되므로(stock.ts
      // HOLIDAY_STORAGE_ROLE) slot 필드를 하나만 담는다 → 슬롯이 2개인 날은 나중 런이 앞선
      // 런의 slot 을 덮어써, 어떤 상태에서도 두 슬롯이 동시에 커버되지 못한다. 그러면
      // 08:00 발화 → both.slot=08:00 → 다음 틱에 17:00 이 미커버 → 발화 → … 가 자정까지 반복된다.
      // 원장은 슬롯별 맵이라 이 상황에서도 정확하다. 명시적으로 닫힌 슬롯이면 보충할 것이 없다.
      // (원장이 아예 없는 날 — 서버가 죽어 그날 런이 0건 — 은 slotHandled 가 false 라 그대로 발화한다.)
      if (slotHandled(today(), market, t)) continue;
      log.info(`오늘(${today()}) ${t} 증시(${market}) 브리핑 누락 감지 → catch-up 실행`);
      await safeRefreshStock(market, "catchup", true, t);
      return;
    }
    // 신선도 비교도 **이 슬롯을 커버하는 스냅샷** 기준이어야 한다. 세 파일 중 '가장 최신'을
    // 쓰면 오후 프리뷰의 updatedAt 이 아침 결산 슬롯의 누락을 가려버린다.
    const snapshotTime = slotSnapshot.updatedAt ? new Date(slotSnapshot.updatedAt) : null;

    // 원장이 1차 근거다. 스냅샷이 신선해도(=아래 시각 비교가 거짓이어도) 그 슬롯의 알림이
    // 나가지 않았을 수 있다 — 슬롯 시각을 넘겨서 끝난 런이 정시 cron 을 running 가드로
    // 밀어낸 경우, 실패해서 빈 스냅샷만 저장하고 updatedAt 을 밀어놓은 경우.
    // 두 경우 모두 예전 게이트로는 영구 누락이었다(slotNeedsCatchup 주석 참고).
    if (slotNeedsCatchup(today(), market, t)) {
      log.info(`오늘(${today()}) ${t} 증시(${market}) 알림 원장 미기록 → catch-up 실행`);
      await safeRefreshStock(market, "catchup", true, t);
      return;
    }

    if (snapshotTime) {
      const { hour, minute } = parseCollectTime(t);
      const scheduled = new Date();
      scheduled.setHours(hour, minute, 0, 0);
      if (snapshotTime < scheduled) {
        log.info(`오늘(${today()}) ${t} 증시(${market}) 갱신 누락 감지 → catch-up 실행`);
        await safeRefreshStock(market, "catchup", true, t);
        return;
      }
    }
  }
}

// ── 시간당 펄스 (실시간 취합 → 문자) ──
//
// ⚠️ 펄스에는 **catch-up 이 없다.** 다른 탭과 다른 유일한 항목이라 여기 이유를 남긴다:
// 나머지 탭은 '그날의 결과물'이라 놓치면 보충해야 하지만, 펄스는 '그 시각의 감시'다.
// 세 시간 전 시장 상황을 지금 문자로 받는 것은 가치가 없을 뿐 아니라 해롭다(이미 지나간
// 재료에 반응하게 만든다). 서버가 4시간 꺼져 있었다면 그 4개 슬롯은 그냥 없던 일이다.
// 동시 실행 방지·백오프는 runPulse 안에 있으므로 여기서는 래핑만 한다.
async function safeRunPulse(slot: string, trigger: string) {
  try {
    await runPulse({ slot, trigger, notify: true });
  } catch (e) {
    // runPulse 는 throw 하지 않도록 만들었지만, 계약이 깨져도 스케줄러는 죽지 않아야 한다.
    log.error(`펄스 실행 오류 [${trigger}] ${slot}: ${(e as Error).message}`);
  }
}

/**
 * 야간 보류분 묶음 발송. 조용 시간 종료 시각(기본 07:00) 정각 1회.
 *
 * 펄스 정시와 **분리된 별도 cron** 인 이유: 07:00 은 기본 펄스 시각 목록에 없다
 * (06~08시는 비워 둔 구간이다). 펄스 실행에 얹으면 사용자가 시간대를 바꿨을 때
 * 보류분이 영영 안 나가는 조합이 생긴다.
 */
async function safeFlushPulseQueue(trigger: string) {
  try {
    await flushPulseQueue(trigger);
  } catch (e) {
    log.error(`펄스 보류 플러시 오류 [${trigger}]: ${(e as Error).message}`);
  }
}

// ── 로또 주간 사이클 ──
//
// 다른 탭과 다른 점은 **주 1회**라는 것뿐이다 — 추첨이 토요일 20:45경 한 번뿐이라 매일 도는 건
// 무의미한 요청이다. 사이클 하나가 수집·채점·전략 갱신·다음 회차 번호 확정을 전부 한다
// (`src/lotto/cycle.ts`). 시각(일요일 10:00)은 사용자 지시이고, cron 식은 cycle.ts 가 소유한다 —
// 경계 계산(놓친 실행 판정)이 같은 상수를 봐야 하기 때문이다.

async function safeRunLottoCycle(trigger: string) {
  try {
    await runWeeklyCycle(trigger);
  } catch (e) {
    // runWeeklyCycle 은 스스로 예외를 삼키지만, 그 약속이 깨져도 스케줄러가 죽지 않게 한 겹 더.
    log.error(`로또 주간 사이클 오류 [${trigger}]: ${(e as Error).message}`);
  }
}

/**
 * 놓친 사이클 보충. 일요일 10:00 에 맥이 자고 있었으면 cron 이 통째로 사라지므로, 다른 탭과
 * 같은 catch-up 을 붙인다(기동 직후 + 30분마다). 실패해 예약된 재시도도 여기서 걸린다.
 */
async function safeCatchUpLottoCycle() {
  try {
    await catchUpWeeklyCycle();
  } catch (e) {
    log.error(`로또 사이클 보충 점검 오류: ${(e as Error).message}`);
  }
}

/** HH:mm → 매일 실행 cron 식. */
function cronExpr(hhmm: string): string {
  const { hour, minute } = parseCollectTime(hhmm);
  return `${minute} ${hour} * * *`;
}

// 등록된 cron 작업들(재등록 시 중지 대상). 모듈 싱글턴이라 startScheduler/rescheduleAll 이 공유.
let tasks: ReturnType<typeof cron.schedule>[] = [];

/**
 * 한 탭의 여러 시각을 cron 으로 등록. name 을 (kind,index)로 고정해, 재등록 시
 * node-cron 전역 레지스트리 항목이 무한 누적되지 않고 같은 키로 덮어써지게 한다(누수 방지).
 */
// run 은 슬롯 시각 t 를 받는다. 증시만 이 값을 알림 멱등 키로 쓰고(notify-ledger),
// 나머지 탭은 `() => ...` 그대로 두면 TS 함수 타입 호환으로 인자를 무시한다(동작 불변).
function scheduleGroup(kind: string, times: string[], label: string, run: (t: string) => void): void {
  times.forEach((t, i) => {
    tasks.push(
      cron.schedule(
        cronExpr(t),
        () => {
          log.info(`정시 ${label} 수집 (${t})`);
          run(t);
        },
        { name: `dp-${kind}-${i}` }
      )
    );
    log.info(`스케줄러: ${label} 매일 ${t}`);
  });
}

/** 현재 스케줄 설정으로 모든 정시 cron 을 등록(전 탭 복수 시각). */
function registerCrons() {
  const s = getSchedule();
  scheduleGroup("price", s.price, "가격", () => void safeRun("schedule"));
  scheduleGroup("events", s.events, "팝업/전시", () => void safeRefreshEvents("schedule", true));
  scheduleGroup("news", s.news, "뉴스 다이제스트", () => void safeRefreshNews("schedule", true));
  scheduleGroup("youtube", s.youtube, "유튜브 소식", () => void safeRefreshYoutube("schedule", true));
  scheduleGroup("stock-kr", s.stockKr, "증시(한국장)", (t) => void safeRefreshStock("kr", "schedule", true, t));
  scheduleGroup("stock-us", s.stockUs, "증시(미국장)", (t) => void safeRefreshStock("us", "schedule", true, t));
  // 역할 분리 구성을 남긴다. '슬롯을 하나로 줄이거나 같은 밴드에 몰아넣으면 분리가 조용히
  // 꺼진다'는 비자명 동작의 유일한 가시화 수단이라 옵션이 아니다(slot-role.ts 참고).
  log.info(describeSlotRoles("us", s.stockUs));

  // 펄스는 시각이 16개라 scheduleGroup 의 시각별 로그가 로그를 뒤덮는다 → 한 줄로 요약한다.
  s.stockPulse.forEach((t, i) => {
    tasks.push(
      cron.schedule(cronExpr(t), () => void safeRunPulse(t, "schedule"), {
        name: `dp-stock-pulse-${i}`,
      })
    );
  });
  log.info(`스케줄러: 증시 펄스 매일 ${s.stockPulse.length}회 (${s.stockPulse.join(", ")})`);

  // 야간 보류분 묶음 발송(조용 시간 종료 정각).
  const flushAt = `${String(config.stockPulse.quietEndHour).padStart(2, "0")}:00`;
  tasks.push(
    cron.schedule(cronExpr(flushAt), () => void safeFlushPulseQueue("schedule"), {
      name: "dp-stock-pulse-flush",
    })
  );
  log.info(`스케줄러: 증시 펄스 야간 보류 묶음 발송 매일 ${flushAt}`);

  // 수집·큐레이션 모델 주간 복귀. 다른 항목과 달리 **주 1회**라 cronExpr(매일)을 쓰지 않는다.
  // 한도 소진으로 Opus 5 에 눌러앉은 상태를 매주 기본 모델로 되돌리는 유일한 장치다.
  tasks.push(
    cron.schedule(WEEKLY_RESET_CRON, () => restoreWeeklyPrimary("schedule"), {
      name: "dp-model-weekly-reset",
    })
  );
  log.info(`스케줄러: 수집 모델 주간 복귀 매주 ${WEEKLY_RESET_LABEL} → ${PRIMARY_AGENT_MODEL}`);

  // 로또 주간 사이클(주 1회). 채점 → 전략 갱신 → 다음 회차 번호 확정까지 한 번에 한다.
  tasks.push(
    cron.schedule(LOTTO_CYCLE_CRON, () => void safeRunLottoCycle("schedule"), {
      name: "dp-lotto-cycle",
    })
  );
  log.info(`스케줄러: 로또 주간 사이클 매주 ${LOTTO_CYCLE_LABEL}`);
}

/** 주간 복귀 catch-up. 파일 판정이라 실패해도 스케줄러가 죽지 않게 감싼다. */
function safeCheckWeeklyModelReset() {
  try {
    checkWeeklyResetCatchup();
  } catch (e) {
    log.error(`모델 주간 복귀 점검 오류: ${(e as Error).message}`);
  }
}

/**
 * 스케줄 설정 변경 후 즉시 cron 을 갈아끼운다(재시작 없이 반영).
 * 기존 작업을 모두 중지하고 최신 설정으로 재등록한다.
 */
export function rescheduleAll() {
  for (const t of tasks) {
    try {
      t.stop();
    } catch {
      /* 이미 중지된 작업 무시 */
    }
  }
  tasks = [];
  registerCrons();
  log.info("스케줄러: 설정 변경으로 cron 재등록 완료");
}

export function startScheduler() {
  registerCrons();

  // 기동 직후 1회 + 30분마다 누락 점검 (잠자기 복귀 대응)
  void checkCatchup();
  void checkEventsCatchup();
  void checkNewsCatchup();
  void checkYoutubeCatchup();
  void checkStockCatchup("kr");
  void checkStockCatchup("us");
  // 주간 복귀 예정 시각(WEEKLY_RESET_LABEL)에 맥이 꺼져 있거나 자고 있었으면 복귀가 통째로
  // 사라진다 — 그러면 한도 소진 전환이 영구화되므로 다른 탭과 같은 catch-up 을 붙인다.
  safeCheckWeeklyModelReset();
  // 로또: 놓친 일요일 사이클(맥이 자고 있었던 경우)과 예약된 재시도를 기동 즉시 확인한다.
  // 다음 회차 추천 번호가 아직 없는 상태(배포 직후)도 여기서 채워진다.
  void safeCatchUpLottoCycle();
  // 펄스 자체는 catch-up 하지 않지만(위 주석) **보류 큐는 다르다.** 큐에 있는 건 이미 판정이
  // 끝나 "아침에 보내겠다"고 약속한 알림이라, 07:00 에 서버가 꺼져 있었다면 반드시 보충해야
  // 한다. 그러지 않으면 밤사이 판정이 디스크에 영원히 갇힌다.
  // 조용 시간 중이면 건너뛴다 — 지금 보내면 그게 바로 새벽 문자다.
  if (
    !isQuietHour(
      new Date().getHours(),
      config.stockPulse.quietStartHour,
      config.stockPulse.quietEndHour
    )
  ) {
    void safeFlushPulseQueue("startup");
  }
  setInterval(() => {
    void checkCatchup();
    void checkEventsCatchup();
    void checkNewsCatchup();
    void checkYoutubeCatchup();
    void checkStockCatchup("kr");
    void checkStockCatchup("us");
    safeCheckWeeklyModelReset();
    void safeCatchUpLottoCycle();
  }, 30 * 60 * 1000);
}
