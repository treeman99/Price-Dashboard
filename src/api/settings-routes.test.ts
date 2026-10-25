/**
 * `/api/settings`(탭별 운영 설정) 라우트 회귀 테스트.
 *
 * 1. GET — TabSettingsResponse 형태(settings·defaults·numberRules·channels·globalChannels).
 * 2. PUT — 부분 수정이 저장·병합되어 같은 형태로 돌아온다.
 * 3. PUT 검증 실패 — 400 `{error}`(한국어 사유), 저장분은 그대로.
 *
 * ★ 실제 `data/` 를 건드리지 않는다(config 가 import 시점에 DB_PATH 를 읽으므로 먼저 갈아끼운다).
 * ★ 조용 시간(quietStart/EndHour)은 PUT 하지 않는다 — rescheduleAll() 이 이 프로세스에 cron 을
 *   등록해 테스트 프로세스가 끝나지 않는다. 그 경로는 임시 서버 + curl 로 확인한다.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import type { TabSettingsResponse } from "../../shared/types.ts";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-routes-test-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");

const { settingsApi } = await import("./settings-routes.ts");

const app = express();
app.use(express.json());
app.use("/api", settingsApi);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const put = (body: unknown) =>
  fetch(`${base}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("GET /settings — TabSettingsResponse 형태", async () => {
  const res = await fetch(`${base}/settings`);
  assert.equal(res.status, 200);
  const r = (await res.json()) as TabSettingsResponse;
  assert.deepEqual(r.settings, r.defaults);
  assert.deepEqual(r.numberRules["youtube.freshDays"], { min: 1, max: 30, unit: "일" });
  assert.deepEqual(r.channels.stockPulse, ["imessage"]);
  assert.equal(typeof r.globalChannels.email, "boolean");
  assert.equal(typeof r.globalChannels.imessage, "boolean");
});

test("PUT /settings — 부분 수정 저장·병합", async () => {
  const res = await put({ youtube: { freshDays: 6 }, notify: { news: { email: false } } });
  assert.equal(res.status, 200);
  const r = (await res.json()) as TabSettingsResponse;
  assert.equal(r.settings.youtube.freshDays, 6);
  assert.equal(r.settings.notify.news.email, false);
  assert.equal(r.settings.youtube.watchedExcludeDays, r.defaults.youtube.watchedExcludeDays);

  const again = (await (await fetch(`${base}/settings`)).json()) as TabSettingsResponse;
  assert.equal(again.settings.youtube.freshDays, 6, "GET 에서도 유지");
});

test("PUT /settings — 범위 밖·타입 오류는 400 {error}, 저장분은 그대로", async () => {
  for (const body of [{ youtube: { freshDays: 0 } }, { stockPulse: { threshold: "high" } }, { nope: {} }, [1]]) {
    const res = await put(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const j = (await res.json()) as { error: string };
    assert.equal(typeof j.error, "string");
    assert.ok(j.error.length > 0);
  }
  const r = (await (await fetch(`${base}/settings`)).json()) as TabSettingsResponse;
  assert.equal(r.settings.youtube.freshDays, 6);
});
