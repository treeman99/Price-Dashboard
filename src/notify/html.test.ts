import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, escapeAttr } from "./html.ts";

// ── escapeHtml ─────────────────────────────────────────────────

test("escapeHtml: <>&\" 를 엔티티로 바꾼다", () => {
  assert.equal(escapeHtml(`<script>alert("x") & 'y'</script>`), `&lt;script&gt;alert(&quot;x&quot;) &amp; 'y'&lt;/script&gt;`);
});

test("escapeHtml: null/undefined/빈값은 빈 문자열 (throw 금지)", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(""), "");
});

test("escapeHtml: & 를 먼저 치환해 이중 이스케이프가 없다", () => {
  assert.equal(escapeHtml("&lt;"), "&amp;lt;");
});

// ── escapeAttr ─────────────────────────────────────────────────

test("escapeAttr: 작은따옴표까지 막는다 (속성 탈출 차단)", () => {
  assert.equal(escapeAttr(`' onmouseover='alert(1)`), `&#39; onmouseover=&#39;alert(1)`);
});

test("escapeAttr: 큰따옴표도 여전히 막는다", () => {
  assert.ok(!escapeAttr(`" onload="x`).includes(`"`));
});
