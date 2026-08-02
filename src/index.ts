import { config, validateConfig } from "./config.ts";
import { log } from "./util/log.ts";
import { db } from "./db/index.ts";
import { startServer } from "./api/server.ts";
import { startScheduler } from "./scheduler/scheduler.ts";
import { startUptimeWatch } from "./uptime/index.ts";

async function bootstrap() {
  // 설정 검증 — 서버 기동은 막지 않되 경고 출력
  try {
    const { warnings } = validateConfig();
    warnings.forEach((w) => log.warn(w));
  } catch (e) {
    // 네이버 키 등 필수값 누락: 명확히 안내하되 대시보드는 띄운다
    log.error(`설정 경고: ${(e as Error).message}`);
    log.warn("일부 수집이 비활성 상태로 시작합니다. .env 설정 후 재시작하세요.");
  }

  db(); // 스키마 마이그레이션

  startServer();

  /**
   * 가동 중단 사후 보고(§9.3). ★ 이 두 줄 사이가 유일하게 맞는 자리다.
   * - `startServer()` **뒤**: 부검이 `pmset` 에서 멎어도 대시보드는 뜬다.
   * - `startScheduler()` **앞**: 스케줄러가 기동 즉시 catch-up 스윕을 던져(`scheduler.ts:784`)
   *   놓친 슬롯을 보충해 버리면, "무엇이 안 돌았는지"를 영영 물어볼 수 없게 된다.
   * 내부에서 전부 try/catch 하고 10초 예산을 두므로 여기서 던지거나 늘어지지 않는다.
   */
  await startUptimeWatch();

  startScheduler();

  log.info(`준비 완료. 대시보드: http://localhost:${config.port}`);
}

bootstrap().catch((e) => {
  log.error(e);
  process.exit(1);
});
