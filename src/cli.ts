import { config, validateConfig } from "./config.ts";

async function main() {
  const cmd = process.argv[2];

  switch (cmd) {
    case "config": {
      const { warnings } = validateConfig();
      console.log(`PORT=${config.port}`);
      console.log(`DB=${config.dbPath}`);
      console.log(`알림: email=${config.notify.email}`);
      warnings.forEach((w) => console.warn(`[경고] ${w}`));
      break;
    }

    default:
      // import / seed / collect / link 는 가격 탭과 함께 2026-08-01 제거했다
      // (네이버 쇼핑 검색 API 영구 종료 → 가격 수집 자체가 성립하지 않는다).
      console.log("사용법: tsx src/cli.ts <config>");
      process.exit(1);
  }
}

// 직접 실행(tsx src/cli.ts ...)일 때만 동작. 다른 모듈에서 import 시에는 실행하지 않음.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
