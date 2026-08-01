import { config, validateConfig } from "./config.ts";
import { log } from "./util/log.ts";
import { db } from "./db/index.ts";
import { startServer } from "./api/server.ts";
import { startScheduler } from "./scheduler/scheduler.ts";

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
  startScheduler();

  log.info(`준비 완료. 대시보드: http://localhost:${config.port}`);
}

bootstrap().catch((e) => {
  log.error(e);
  process.exit(1);
});
