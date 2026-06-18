import { config, validateConfig } from "./config.ts";
import { log } from "./util/log.ts";
import { db } from "./db/index.ts";
import { listProducts } from "./db/repo.ts";
import { importLegacyHistory, ensureSeeds } from "./importer/import.ts";
import { startServer } from "./api/server.ts";
import { startScheduler } from "./scheduler/scheduler.ts";

async function bootstrap() {
  // 설정 검증 — 서버 기동은 막지 않되 경고 출력
  try {
    const { warnings } = validateConfig({ forCollect: true });
    warnings.forEach((w) => log.warn(w));
  } catch (e) {
    // 네이버 키 등 필수값 누락: 명확히 안내하되 대시보드(과거 데이터 열람)는 띄운다
    log.error(`설정 경고: ${(e as Error).message}`);
    log.warn("수집은 비활성 상태로 시작합니다. .env 설정 후 재시작하세요.");
  }

  db(); // 스키마 마이그레이션

  // 최초 부팅 시 데이터 없으면 자동 임포트 → 그래도 없으면 시드
  if (listProducts().length === 0) {
    const r = importLegacyHistory();
    if (!r.skipped) {
      log.info(`기존 이력 자동 임포트: 상품 ${r.products} / 포인트 ${r.points}`);
    } else {
      const n = ensureSeeds();
      log.info(`임포트 대상 없음(${r.reason}) → 폴백 시드 ${n}종 등록`);
    }
  }

  startServer();
  startScheduler();

  log.info(`준비 완료. 대시보드: http://localhost:${config.port}`);
}

bootstrap().catch((e) => {
  log.error(e);
  process.exit(1);
});
