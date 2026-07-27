import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSavetickerBody, savetickerTable } from "./saveticker.ts";

/**
 * 픽스처는 **실제 API 응답 원본**이다(2026-07-27 캡처, 앞 8건).
 * 합성 데이터로 파서를 검증하면 실제 응답의 필드명·타입·태그 표기를 놓친다 —
 * 이 저장소에는 그 방식으로 파서가 조용히 죽은 선례가 있다.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "__fixtures__/saveticker-top-stories.json"), "utf8")
);

/** 픽스처 최신 항목 시각(2026-07-27T16:56:45+09:00) 기준으로 '지금'을 고정한다. */
const NOW = Date.parse("2026-07-27T17:00:00+09:00");

test("실제 응답에서 제목·본문·매체·링크를 뽑는다", () => {
  const items = normalizeSavetickerBody(FIXTURE, { withinHours: 24, limit: 50, now: NOW });
  assert.ok(items.length > 0);
  const nvda = items.find((i) => i.tickers.includes("NVDA"));
  assert.ok(nvda, "$NVDA 태그 항목이 있어야 한다");
  assert.match(nvda.title, /엔비디아/);
  assert.equal(nvda.source, "월스트리트저널");
  assert.equal(nvda.link, `https://www.saveticker.com/news/${nvda.id}`);
});

test("'속보' 태그를 breaking 으로 표시한다", () => {
  const items = normalizeSavetickerBody(FIXTURE, { withinHours: 48, limit: 50, now: NOW });
  const breaking = items.filter((i) => i.breaking);
  assert.ok(breaking.length > 0, "픽스처에 속보 항목이 있다");
  for (const b of breaking) assert.ok(b.tags.includes("속보"));
});

test("'$NVDA' 형태 태그에서 티커를 뽑고 나머지 태그는 티커로 오인하지 않는다", () => {
  const items = normalizeSavetickerBody(FIXTURE, { withinHours: 48, limit: 50, now: NOW });
  const nvda = items.find((i) => i.tickers.includes("NVDA"));
  assert.deepEqual(nvda?.tickers, ["NVDA"]);
  // "정보"·"에너지"·"종합" 같은 분류 태그가 티커로 섞이면 안 된다.
  const energy = items.find((i) => i.tags.includes("에너지"));
  assert.deepEqual(energy?.tickers, []);
});

test("신선도 필터: 창을 좁히면 오래된 항목이 빠진다", () => {
  const wide = normalizeSavetickerBody(FIXTURE, { withinHours: 48, limit: 50, now: NOW });
  const narrow = normalizeSavetickerBody(FIXTURE, { withinHours: 2, limit: 50, now: NOW });
  assert.ok(narrow.length < wide.length, "2시간 창은 48시간 창보다 적어야 한다");
  // 2시간 창에는 16:56·15:44·15:36·15:30 중 15:00 이후만 남는다.
  for (const i of narrow) {
    assert.ok(Date.parse(i.createdAt) >= NOW - 2 * 3600_000);
  }
});

test("limit 을 넘지 않는다", () => {
  const items = normalizeSavetickerBody(FIXTURE, { withinHours: 999, limit: 3, now: NOW });
  assert.equal(items.length, 3);
});

test("news_list 가 없거나 배열이 아니면 빈 배열 (throw 하지 않는다)", () => {
  assert.deepEqual(normalizeSavetickerBody({}, { withinHours: 3, limit: 10 }), []);
  assert.deepEqual(normalizeSavetickerBody(null, { withinHours: 3, limit: 10 }), []);
  assert.deepEqual(
    normalizeSavetickerBody({ news_list: "없음" }, { withinHours: 3, limit: 10 }),
    []
  );
});

test("id·제목·시각이 없는 행은 버린다(링크도 신선도 판정도 불가능하다)", () => {
  const body = {
    news_list: [
      { id: "1", title: "", created_at: "2026-07-27T16:00:00+09:00" },
      { id: "", title: "제목", created_at: "2026-07-27T16:00:00+09:00" },
      { id: "3", title: "제목", created_at: "" },
      { id: "4", title: "정상", created_at: "2026-07-27T16:00:00+09:00" },
    ],
  };
  const items = normalizeSavetickerBody(body, { withinHours: 24, limit: 10, now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "4");
});

test("is_deleted 항목은 버린다", () => {
  const body = {
    news_list: [
      { id: "1", title: "삭제됨", created_at: "2026-07-27T16:00:00+09:00", is_deleted: true },
      { id: "2", title: "정상", created_at: "2026-07-27T16:00:00+09:00" },
    ],
  };
  const items = normalizeSavetickerBody(body, { withinHours: 24, limit: 10, now: NOW });
  assert.deepEqual(items.map((i) => i.id), ["2"]);
});

test("시각 파싱 실패 항목은 **남긴다** (포맷 변경 시 소스가 조용히 사라지면 안 된다)", () => {
  const body = {
    news_list: [{ id: "1", title: "형식이 바뀐 항목", created_at: "27/07/2026 16:00" }],
  };
  const items = normalizeSavetickerBody(body, { withinHours: 1, limit: 10, now: NOW });
  assert.equal(items.length, 1);
});

test("savetickerTable: 항목이 없으면 그 사실을 명시한다(빈 문자열이면 LLM 이 헷갈린다)", () => {
  assert.match(savetickerTable([]), /속보 없음/);
});

test("savetickerTable: 속보 표시·티커·링크가 표에 들어간다", () => {
  const items = normalizeSavetickerBody(FIXTURE, { withinHours: 48, limit: 50, now: NOW });
  const table = savetickerTable(items);
  assert.match(table, /🚨속보/);
  assert.match(table, /\$NVDA/);
  assert.match(table, /https:\/\/www\.saveticker\.com\/news\//);
});
