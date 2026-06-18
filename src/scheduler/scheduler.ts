import cron from "node-cron";
import { config, parseCollectTime } from "../config.ts";
import { log } from "../util/log.ts";
import { runCollection } from "../collector/collect.ts";
import { hasSuccessfulRun } from "../db/repo.ts";
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

/** 지금 시각이 오늘 수집 예정 시각을 지났는지 */
function pastCollectTime(): boolean {
  const { hour, minute } = parseCollectTime(config.collectTime);
  const now = new Date();
  return now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
}

/**
 * catch-up: 잠자기/재시작으로 정시를 놓쳤어도, 예정 시각이 지났고
 * 오늘 성공 수집이 없으면 1회 보충한다.
 */
async function checkCatchup() {
  if (running) return;
  if (pastCollectTime() && !hasSuccessfulRun(today())) {
    log.info(`오늘(${today()}) 수집 누락 감지 → catch-up 수집 실행`);
    await safeRun("catchup");
  }
}

export function startScheduler() {
  const { hour, minute } = parseCollectTime(config.collectTime);
  const expr = `${minute} ${hour} * * *`;

  cron.schedule(expr, () => {
    log.info(`정시 수집 트리거 (${config.collectTime})`);
    void safeRun("schedule");
  });
  log.info(`스케줄러 등록: 매일 ${config.collectTime} (cron: ${expr})`);

  // 기동 직후 1회 + 30분마다 누락 점검 (잠자기 복귀 대응)
  void checkCatchup();
  setInterval(() => void checkCatchup(), 30 * 60 * 1000);
}
