import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSourceInput } from "./sources.ts";

test("parseSourceInput: 화이트리스트 밖 source 거부", () => {
  const r = parseSourceInput(1, { source: "11번가", url: "https://x" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /source/);
});

test("parseSourceInput: url 누락/공백 거부", () => {
  assert.equal(parseSourceInput(1, { source: "danawa" }).ok, false);
  assert.equal(parseSourceInput(1, { source: "danawa", url: "   " }).ok, false);
});

test("parseSourceInput: refId 타입 오류 거부", () => {
  const r = parseSourceInput(1, { source: "danawa", url: "https://x", refId: 123 });
  assert.equal(r.ok, false);
});

test("parseSourceInput: confirmed 타입 오류 거부", () => {
  const r = parseSourceInput(1, { source: "danawa", url: "https://x", confirmed: "yes" });
  assert.equal(r.ok, false);
});

test("parseSourceInput: 본문 누락 거부", () => {
  assert.equal(parseSourceInput(1, null).ok, false);
  assert.equal(parseSourceInput(1, "nope").ok, false);
});

test("parseSourceInput: 정상 입력 — productId 주입 + url trim + refId 기본 null", () => {
  const r = parseSourceInput(7, { source: "danawa", url: "  https://prod.danawa.com/info/?pcode=1  " });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.value, {
      productId: 7,
      source: "danawa",
      refId: null,
      url: "https://prod.danawa.com/info/?pcode=1",
    });
  }
});

test("parseSourceInput: confirmed:true + refId 보존", () => {
  const r = parseSourceInput(7, {
    source: "danawa",
    url: "https://prod.danawa.com/info/?pcode=106736861",
    refId: "106736861",
    confirmed: true,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.confirmed, true);
    assert.equal(r.value.refId, "106736861");
  }
});
