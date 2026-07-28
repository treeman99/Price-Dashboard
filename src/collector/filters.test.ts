import { test } from "node:test";
import assert from "node:assert/strict";
import { isExcludedMall, isValidCandidate } from "./filters.ts";
import type { Product } from "../../shared/types.ts";

const product: Product = {
  id: 1,
  name: "닌텐도 스위치2",
  mustInclude: [["스위치2", "스위치 2"]],
  mustExclude: [],
  minPrice: 400_000,
  active: true,
  sortOrder: 0,
  createdAt: "2026-07-28T00:00:00.000Z",
};

// 쿠팡 수집 제거(2026-07-28): 네이버 검색 결과로 쿠팡이 우회 유입되지 않아야 한다.

test("isExcludedMall: 상호가 쿠팡이면 제외(표기 변형 포함)", () => {
  assert.equal(isExcludedMall("쿠팡"), true);
  assert.equal(isExcludedMall("쿠팡 로켓배송"), true);
  assert.equal(isExcludedMall("Coupang"), true);
  assert.equal(isExcludedMall("G마켓"), false);
  assert.equal(isExcludedMall(""), false);
  assert.equal(isExcludedMall(undefined), false);
});

test("isExcludedMall: 상호가 비어도 링크 호스트로 판정(서브도메인 포함)", () => {
  assert.equal(isExcludedMall("", "https://www.coupang.com/vp/products/123"), true);
  assert.equal(isExcludedMall("", "https://link.coupang.com/re/abc"), true);
  assert.equal(isExcludedMall("", "https://smartstore.naver.com/x/products/1"), false);
});

test("isExcludedMall: 호스트 부분일치는 제외하지 않는다(오탐 방지)", () => {
  // 'coupang.com' 이 문자열로 포함되지만 실제 호스트는 다른 도메인
  assert.equal(isExcludedMall("", "https://notcoupang.com/x"), false);
  assert.equal(isExcludedMall("", "https://example.com/?ref=coupang.com"), false);
});

test("isExcludedMall: 잘못된 URL 은 판정 불가 → 통과(보수적)", () => {
  assert.equal(isExcludedMall("", "not a url"), false);
});

test("isValidCandidate: 다른 조건을 다 만족해도 쿠팡 판매처면 후보에서 제외", () => {
  const item = { title: "닌텐도 스위치2 본체", price: 620_000, mallName: "쿠팡" };
  assert.equal(isValidCandidate(item, product), false);
  // 상호가 비어 있어도 링크로 걸린다
  assert.equal(
    isValidCandidate({ ...item, mallName: "", link: "https://www.coupang.com/vp/products/1" }, product),
    false
  );
  // 쿠팡이 아니면 통과
  assert.equal(isValidCandidate({ ...item, mallName: "G마켓" }, product), true);
});
