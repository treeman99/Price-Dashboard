import cron from "node-cron";
import { config, parseCollectTime } from "../config.ts";
import { log } from "../util/log.ts";
import { runCollection } from "../collector/collect.ts";
import { hasSuccessfulRun } from "../db/repo.ts";
import { refreshEvents, hasTodaySnapshot } from "../events/events.ts";
import { refreshNews, hasTodayNewsSnapshot } from "../news/news.ts";
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
  if (pastTime(config.collectTime) && !hasSuccessfulRun(today())) {
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
  if (pastTime(config.eventsCollectTime) && !hasTodaySnapshot()) {
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

async function checkNewsCatchup() {
  if (newsRunning) return;
  if (pastTime(config.newsCollectTime) && !hasTodayNewsSnapshot()) {
    log.info(`오늘(${today()}) 뉴스 다이제스트 누락 감지 → catch-up 실행`);
    await safeRefreshNews("catchup", true);
  }
}

export function startScheduler() {
  // 가격 수집
  const price = parseCollectTime(config.collectTime);
  const priceExpr = `${price.minute} ${price.hour} * * *`;
  cron.schedule(priceExpr, () => {
    log.info(`정시 가격 수집 (${config.collectTime})`);
    void safeRun("schedule");
  });
  log.info(`스케줄러: 가격 매일 ${config.collectTime} (cron: ${priceExpr})`);

  // 팝업/전시 수집
  const ev = parseCollectTime(config.eventsCollectTime);
  const evExpr = `${ev.minute} ${ev.hour} * * *`;
  cron.schedule(evExpr, () => {
    log.info(`정시 팝업/전시 수집 (${config.eventsCollectTime})`);
    void safeRefreshEvents("schedule", true);
  });
  log.info(`스케줄러: 팝업/전시 매일 ${config.eventsCollectTime} (cron: ${evExpr})`);

  // 뉴스 다이제스트 수집
  const news = parseCollectTime(config.newsCollectTime);
  const newsExpr = `${news.minute} ${news.hour} * * *`;
  cron.schedule(newsExpr, () => {
    log.info(`정시 뉴스 다이제스트 수집 (${config.newsCollectTime})`);
    void safeRefreshNews("schedule", true);
  });
  log.info(`스케줄러: 뉴스 매일 ${config.newsCollectTime} (cron: ${newsExpr})`);

  // 기동 직후 1회 + 30분마다 누락 점검 (잠자기 복귀 대응)
  void checkCatchup();
  void checkEventsCatchup();
  void checkNewsCatchup();
  setInterval(() => {
    void checkCatchup();
    void checkEventsCatchup();
    void checkNewsCatchup();
  }, 30 * 60 * 1000);
}
