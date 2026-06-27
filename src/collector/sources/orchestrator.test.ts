import { test } from "node:test";
import assert from "node:assert/strict";
import { collectFromSources, type FetchCache } from "./orchestrator.ts";
import type { PriceSource, SourceId, SourcePriceResult, SourceRef } from "./types.ts";

function fakeSource(id: SourceId, result: Partial<SourcePriceResult>): PriceSource {
  return {
    id,
    async resolve() {
      return [];
    },
    async fetch(): Promise<SourcePriceResult> {
      return {
        source: id,
        status: "empty",
        fetchedAt: "2026-06-27T00:00:00.000Z",
        productName: null,
        modelName: null,
        coupang: null,
        overallLowest: null,
        ...result,
      };
    },
  };
}

const refs: SourceRef[] = [
  { source: "danawa", refId: "1", url: "u1" },
  { source: "enuri", refId: "2", url: "u2" },
  { source: "llm-websearch", refId: null, url: "u3" },
];

test("orchestrator: 첫 소스 ok+가격이면 즉시 채택, 이후 소스 호출 안 함", async () => {
  let enuriCalled = false;
  const out = await collectFromSources({
    refs,
    getSource: (id) => {
      if (id === "danawa")
        return fakeSource("danawa", { status: "ok", coupang: { price: 1000, isRocket: true, url: null } });
      if (id === "enuri") {
        return {
          id: "enuri",
          async resolve() {
            return [];
          },
          async fetch() {
            enuriCalled = true;
            return fakeSource("enuri", {}).fetch({ source: "enuri", refId: null, url: "" });
          },
        };
      }
      return null;
    },
  });
  assert.equal(out.chosen?.source, "danawa");
  assert.equal(out.chosen?.coupang?.price, 1000);
  assert.equal(enuriCalled, false);
  assert.equal(out.attempts.length, 1);
});

test("orchestrator: blocked → onBlocked 콜백 + 다음 소스 폴백", async () => {
  const blocked: SourceId[] = [];
  const out = await collectFromSources({
    refs,
    onBlocked: (r) => blocked.push(r.source),
    getSource: (id) => {
      if (id === "danawa") return fakeSource("danawa", { status: "blocked" });
      if (id === "enuri")
        return fakeSource("enuri", { status: "ok", overallLowest: { price: 900, mall: "네이버", url: null } });
      return null;
    },
  });
  assert.deepEqual(blocked, ["danawa"]);
  assert.equal(out.chosen?.source, "enuri");
  assert.equal(out.attempts.length, 2);
});

test("orchestrator: 모두 not-listed면 chosen=null (쿠팡가 null 정상 저장 경로)", async () => {
  const out = await collectFromSources({
    refs,
    getSource: (id) => fakeSource(id, { status: "not-listed" }),
  });
  assert.equal(out.chosen, null);
  assert.equal(out.attempts.length, 3);
});

test("orchestrator: 소스 fetch 예외는 parse-error로 격리하고 폴백 계속", async () => {
  const out = await collectFromSources({
    refs,
    getSource: (id) => {
      if (id === "danawa")
        return {
          id: "danawa",
          async resolve() {
            return [];
          },
          async fetch(): Promise<SourcePriceResult> {
            throw new Error("네트워크 폭발");
          },
        };
      if (id === "llm-websearch")
        return fakeSource("llm-websearch", { status: "ok", coupang: { price: 500, isRocket: false, url: null } });
      return fakeSource(id, { status: "not-listed" });
    },
  });
  assert.equal(out.attempts[0].status, "parse-error");
  assert.equal(out.chosen?.source, "llm-websearch");
});

// ── §11 당일 캐시 동작 테스트 ───────────────────────────

/** 인메모리 FetchCache 구현 (테스트용). 네트워크 호출 카운터와 별도로 제어. */
function makeMemCache(): { cache: FetchCache; store: Map<string, SourcePriceResult> } {
  const store = new Map<string, SourcePriceResult>();
  const cache: FetchCache = {
    get: (ref) => store.get(ref.source) ?? null,
    set: (ref, result) => store.set(ref.source, result),
  };
  return { cache, store };
}

/** 네트워크 호출 횟수를 추적하는 fakeSource. */
function countingSource(id: SourceId, result: Partial<SourcePriceResult>, counter: { n: number }): PriceSource {
  return {
    id,
    async resolve() {
      return [];
    },
    async fetch(): Promise<SourcePriceResult> {
      counter.n++;
      return {
        source: id,
        status: "empty",
        fetchedAt: "2026-06-27T00:00:00.000Z",
        productName: null,
        modelName: null,
        coupang: null,
        overallLowest: null,
        ...result,
      };
    },
  };
}

test("캐시: 같은 날 2번째 수집 — 네트워크 호출 0 + 캐시값 반환 (§11)", async () => {
  const counter = { n: 0 };
  const { cache } = makeMemCache();
  const src = countingSource("danawa", { status: "ok", coupang: { price: 1571700, isRocket: true, url: null } }, counter);
  const testRefs = [{ source: "danawa" as SourceId, refId: "1", url: "u1" }];

  // 1회차: 캐시 miss → fetch 호출됨
  const out1 = await collectFromSources({
    refs: testRefs,
    cache,
    getSource: () => src,
  });
  assert.equal(counter.n, 1, "1회차 fetch 호출 수");
  assert.equal(out1.chosen?.status, "ok");
  assert.equal(out1.chosen?.coupang?.price, 1571700);

  // 2회차: 캐시 hit → source.fetch 호출 없음
  const out2 = await collectFromSources({
    refs: testRefs,
    cache,
    getSource: () => src,
  });
  assert.equal(counter.n, 1, "2회차는 캐시 hit → 네트워크 0 추가");
  assert.equal(out2.chosen?.status, "ok");
  assert.equal(out2.chosen?.coupang?.price, 1571700);
  assert.equal(out2.attempts[0].status, "ok", "캐시 결과가 attempts에 포함");
});

test("캐시: 차단 결과도 캐시 — 재호출 시 네트워크 0 + blocked 반환 (§11)", async () => {
  const counter = { n: 0 };
  const { cache } = makeMemCache();
  const src = countingSource("danawa", { status: "blocked" }, counter);
  const testRefs = [{ source: "danawa" as SourceId, refId: "1", url: "u1" }];

  // 1회차: fetch → blocked 캐시
  const blocked1: SourceId[] = [];
  await collectFromSources({
    refs: testRefs,
    cache,
    getSource: () => src,
    onBlocked: (r) => blocked1.push(r.source),
  });
  assert.equal(counter.n, 1);
  assert.deepEqual(blocked1, ["danawa"]);

  // 2회차: 캐시 hit → 네트워크 0, onBlocked 여전히 호출
  const blocked2: SourceId[] = [];
  await collectFromSources({
    refs: testRefs,
    cache,
    getSource: () => src,
    onBlocked: (r) => blocked2.push(r.source),
  });
  assert.equal(counter.n, 1, "차단 결과 캐시 후 재호출 네트워크 0");
  assert.deepEqual(blocked2, ["danawa"], "캐시된 blocked도 onBlocked 콜백 호출");
});

test("캐시: 날짜가 다른 key — 캐시 miss → 네트워크 재호출 (§11)", async () => {
  const counter = { n: 0 };
  const src = countingSource("danawa", { status: "ok", overallLowest: { price: 1000, mall: "테스트", url: null } }, counter);
  const testRefs = [{ source: "danawa" as SourceId, refId: "1", url: "u1" }];

  // 날짜1 캐시
  const storeDay1 = new Map<string, SourcePriceResult>();
  const cacheDay1: FetchCache = {
    get: (ref) => storeDay1.get(ref.source) ?? null,
    set: (ref, r) => storeDay1.set(ref.source, r),
  };
  await collectFromSources({ refs: testRefs, cache: cacheDay1, getSource: () => src });
  assert.equal(counter.n, 1, "날짜1 fetch");

  // 날짜2 — 별개 캐시 스토어(날짜가 달라 miss)
  const storeDay2 = new Map<string, SourcePriceResult>();
  const cacheDay2: FetchCache = {
    get: (ref) => storeDay2.get(ref.source) ?? null,
    set: (ref, r) => storeDay2.set(ref.source, r),
  };
  await collectFromSources({ refs: testRefs, cache: cacheDay2, getSource: () => src });
  assert.equal(counter.n, 2, "날짜2는 다른 캐시 → 네트워크 재호출");
});

test("캐시: 캐시 미주입 시 매번 fetch (하위 호환)", async () => {
  const counter = { n: 0 };
  const src = countingSource("danawa", { status: "ok", overallLowest: { price: 999, mall: "x", url: null } }, counter);
  const testRefs = [{ source: "danawa" as SourceId, refId: "1", url: "u1" }];
  // cache 없이 2회 호출
  await collectFromSources({ refs: testRefs, getSource: () => src });
  await collectFromSources({ refs: testRefs, getSource: () => src });
  assert.equal(counter.n, 2, "캐시 없으면 매번 fetch");
});
