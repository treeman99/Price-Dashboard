// 4-3 검증: 신규 컬럼(coupang_is_rocket/lowest_mall/source)이
// upsertPricePoint → getProductSummary().latest 까지 흐르는지 실제 DB로 확인.
// 임시 DB 파일을 DB_PATH 로 가리키고, config 가 그 값을 읽도록 "동적 import" 한다
// (정적 import 는 hoisting 때문에 env 설정보다 먼저 평가됨).

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

test("ProductSummary.latest 에 쿠팡가/로켓/판매처/소스가 흐른다", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-summary-test-"));
  process.env.DB_PATH = path.join(tmpDir, "test.db");

  const repo = await import("../db/repo.ts");
  const { closeDb } = await import("../db/index.ts");

  try {
    const product = repo.createProduct({
      name: "통합테스트 상품",
      mustInclude: [["X"]],
      mustExclude: [],
      minPrice: 0,
    });

    repo.upsertPricePoint(product.id, {
      date: "2026-06-27",
      naverLowest: 1600000,
      coupangLowest: 1571700,
      danawaLowest: 1571700,
      avgPrice: 1600000,
      overallLowest: 1571700,
      lowestSource: "danawa",
      coupangIsRocket: true,
      lowestMall: "쿠팡",
      source: "danawa",
    });

    const summary = repo.getProductSummary(product.id);
    assert.ok(summary, "summary 존재");
    const latest = summary!.latest;
    assert.ok(latest, "latest 존재");
    assert.equal(latest!.coupangLowest, 1571700);
    assert.equal(latest!.coupangIsRocket, true);
    assert.equal(latest!.lowestMall, "쿠팡");
    assert.equal(latest!.source, "danawa");

    // 미수집 케이스: 신규 필드 미지정 시 null 로 정상 노출(기존 행 호환)
    repo.upsertPricePoint(product.id, {
      date: "2026-06-26",
      naverLowest: 1599000,
      coupangLowest: null,
      danawaLowest: null,
      avgPrice: 1599000,
      overallLowest: 1599000,
      lowestSource: "naver",
    });
    const hist = repo.getHistory(product.id);
    const older = hist.find((p) => p.date === "2026-06-26")!;
    assert.equal(older.coupangIsRocket, null);
    assert.equal(older.lowestMall, null);
    assert.equal(older.source, null);
  } finally {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});
