import cron from "node-cron";
import { parseCollectTime } from "../config.ts";
import { getSchedule } from "./schedule-store.ts";
import { log } from "../util/log.ts";
import { runCollection } from "../collector/collect.ts";
import { hasSuccessfulRun } from "../db/repo.ts";
import { refreshEvents, hasTodaySnapshot } from "../events/events.ts";
import { refreshNews, getNewsSnapshot } from "../news/news.ts";
import { refreshYoutube, getYoutubeSnapshot } from "../youtube/youtube.ts";
import { localDate } from "../util/date.ts";

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
  }
}

/**
 * 유튜브 catch-up: 오늘 예정된 시간 중 하나라도 지났고 스냅샷이 없거나
 * 마지막 갱신 이후 새로운 예정 시간이 지났으면 보충한다. (뉴스와 동일 패턴)
 */
async function checkYoutubeCatchup() {
  if (youtubeRunning) return;
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
function scheduleGroup(kind: string, times: string[], label: string, run: () => void): void {
  times.forEach((t, i) => {
    tasks.push(
      cron.schedule(
        cronExpr(t),
        () => {
          log.info(`정시 ${label} 수집 (${t})`);
          run();
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
  setInterval(() => {
    void checkCatchup();
    void checkEventsCatchup();
    void checkNewsCatchup();
    void checkYoutubeCatchup();
  }, 30 * 60 * 1000);
}
