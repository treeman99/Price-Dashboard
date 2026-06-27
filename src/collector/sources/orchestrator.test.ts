import { test } from "node:test";
import assert from "node:assert/strict";
import { collectFromSources } from "./orchestrator.ts";
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
