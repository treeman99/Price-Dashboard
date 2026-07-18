import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneDeadCandidates } from "./naver.ts";
import type { Product } from "../../shared/types.ts";

const PRODUCT: Product = {
  id: 9,
  name: "로보락 S10 MaxV Slim",
  mustInclude: [],
  mustExclude: [],
  minPrice: 0,
  active: true,
  sortOrder: 0,
  createdAt: "2026-07-01T00:00:00.000Z",
};

type Cand = { title: string; price: number; mall: string; link: string };
const cand = (price: number, link: string): Cand => ({ title: `t${price}`, price, mall: "m", link });

test("pruneDeadCandidates: 싼 죽은 링크 2개 제거 → 최저가가 정상 링크로 올라간다", async () => {
  const candidates = [
    cand(1094400, "dead://1"),
    cand(1208400, "dead://2"),
    cand(1540000, "alive://3"),
    cand(1590000, "alive://4"),
  ];
  const dead = new Set(["dead://1", "dead://2"]);
  const out = await pruneDeadCandidates(
    candidates,
    PRODUCT,
    async (u) => dead.has(u),
    () => Promise.resolve()
  );
  assert.deepEqual(
    out.map((c) => c.price),
    [1540000, 1590000]
  );
});

test("pruneDeadCandidates: 살아있는 후보 3개 확보되면 이후는 프로브하지 않는다", async () => {
  const probed: string[] = [];
  const candidates = [
    cand(100, "a"),
    cand(200, "b"),
    cand(300, "c"),
    cand(400, "d"), // 프로브 대상 아님(이미 3개 확보)
    cand(500, "e"),
  ];
  const out = await pruneDeadCandidates(candidates, PRODUCT, async (u) => {
    probed.push(u);
    return false;
  }, () => Promise.resolve());
  assert.deepEqual(probed, ["a", "b", "c"]); // d,e 는 프로브 없이 유지
  assert.equal(out.length, 5);
});

test("pruneDeadCandidates: 프로브 상한(8) 초과분은 프로브 없이 유지", async () => {
  // 앞 8개가 전부 죽어도 프로브는 최대 8회, 나머지는 그대로 유지.
  const candidates = Array.from({ length: 12 }, (_, i) => cand(1000 + i, `u${i}`));
  let calls = 0;
  const out = await pruneDeadCandidates(candidates, PRODUCT, async () => {
    calls++;
    return true; // 전부 죽음
  }, () => Promise.resolve());
  assert.equal(calls, 8); // 상한
  assert.equal(out.length, 4); // 프로브 안 된 뒤쪽 4개는 유지
  assert.deepEqual(
    out.map((c) => c.link),
    ["u8", "u9", "u10", "u11"]
  );
});

test("pruneDeadCandidates: 죽은 링크 없으면 원본 순서/개수 보존", async () => {
  const candidates = [cand(100, "a"), cand(200, "b"), cand(300, "c"), cand(400, "d")];
  const out = await pruneDeadCandidates(candidates, PRODUCT, async () => false, () => Promise.resolve());
  assert.deepEqual(out, candidates);
});
