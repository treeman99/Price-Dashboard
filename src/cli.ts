import { config, validateConfig } from "./config.ts";
import { listProducts } from "./db/repo.ts";
import { importLegacyHistory, ensureSeeds } from "./importer/import.ts";

async function main() {
  const cmd = process.argv[2];

  switch (cmd) {
    case "import": {
      const r = importLegacyHistory();
      if (r.skipped) {
        console.log(`[import] 건너뜀 (${r.reason}). 파일: ${r.file}`);
        const seeded = ensureSeeds();
        if (seeded) console.log(`[import] 폴백 시드 ${seeded}종 등록`);
      } else {
        console.log(
          `[import] 완료: 상품 ${r.products}개 / 가격포인트 ${r.points}개 (파일: ${r.file})`
        );
      }
      const products = listProducts();
      console.log(`[import] 현재 상품 ${products.length}개: ${products.map((p) => p.name).join(", ")}`);
      break;
    }

    case "seed": {
      const n = ensureSeeds();
      console.log(n ? `[seed] ${n}종 등록` : "[seed] 이미 상품이 있어 건너뜀");
      break;
    }

    case "collect": {
      const { runCollection } = await import("./collector/collect.ts");
      const { warnings } = validateConfig({ forCollect: true });
      warnings.forEach((w) => console.warn(`[경고] ${w}`));
      const { localDate } = await import("./util/date.ts");
      const result = await runCollection({ date: localDate(), trigger: "manual" });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "config": {
      const { warnings } = validateConfig();
      console.log(`PORT=${config.port}  COLLECT_TIME=${config.collectTime}`);
      console.log(`DB=${config.dbPath}`);
      console.log(`알림: email=${config.notify.email}`);
      warnings.forEach((w) => console.warn(`[경고] ${w}`));
      break;
    }

    default:
      console.log("사용법: tsx src/cli.ts <import|seed|collect|config>");
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
