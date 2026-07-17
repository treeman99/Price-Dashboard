import { test } from "node:test";
import assert from "node:assert/strict";
import { safeHref } from "./url.ts";

test("safeHref: http/https 는 원본 그대로 통과", () => {
  assert.equal(safeHref("https://example.com/a?b=1#c"), "https://example.com/a?b=1#c");
  assert.equal(safeHref("http://example.com"), "http://example.com");
});

test("safeHref: javascript: 스킴은 null", () => {
  // eslint-disable-next-line no-script-url
  assert.equal(safeHref("javascript:alert(1)"), null);
  // 대소문자 혼합·선행 공백으로 우회 시도해도 null (URL 파서가 정규화)
  // eslint-disable-next-line no-script-url
  assert.equal(safeHref("  JaVaScRiPt:alert(1)"), null);
});

test("safeHref: data: 스킴은 null", () => {
  assert.equal(safeHref("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="), null);
});

test("safeHref: 그 밖의 비-http 스킴도 null", () => {
  assert.equal(safeHref("vbscript:msgbox(1)"), null);
  assert.equal(safeHref("file:///etc/passwd"), null);
  assert.equal(safeHref("mailto:a@b.com"), null);
});

test("safeHref: 빈값/null/undefined 는 null", () => {
  assert.equal(safeHref(null), null);
  assert.equal(safeHref(undefined), null);
  assert.equal(safeHref(""), null);
});

test("safeHref: 파싱 불가(상대경로 등)는 null — throw 하지 않는다", () => {
  assert.equal(safeHref("not a url"), null);
  assert.equal(safeHref("/relative/path"), null);
  assert.equal(safeHref("example.com"), null); // 스킴 없음
});
