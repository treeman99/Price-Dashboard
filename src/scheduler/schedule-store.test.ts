// 스케줄 v2 저장소 회귀 테스트.
//
// ⚠️ 실제 data/ 를 건드리지 않기 위해 DB_PATH 를 임시 디렉터리로 돌린 뒤 **동적 import** 한다.
// config.ts 가 import 시점에 DB_PATH 를 한 번 읽으므로 정적 import 로는 늦다(notify-ledger.test.ts 와 같은 패턴).

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-store-test-"));
process.env.DB_PATH = path.join(TMP_DIR, "price.db");
const FILE = path.join(TMP_DIR, "schedule.json");

const { getSchedule, saveSchedule, getScheduleResponse } = await import("./schedule-store.ts");
const { config } = await import("../config.ts");
const { SCHEDULE_RULES } = await import("../../shared/schedule.ts");

after(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
});

const writeRaw = (v: unknown) => fs.writeFileSync(FILE, JSON.stringify(v), "utf8");
const readRaw = () => JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, unknown>;
const daily = (times: string[]) => ({ enabled: true, repeat: { kind: "daily" }, times });
/** .env 시각 목록이 정규화되면 어떻게 되는지(zero-pad·정렬). 기본값 비교용. */
const norm = (times: string[]) =>
  [...new Set(times.map((t) => t.trim().padStart(5, "0")))].sort();

test("파일이 없으면 .env 기본값: 일반 탭은 매일, 스킬은 매주 월 09:00, 로또는 매주 일 10:00", () => {
  const s = getSchedule();
  assert.deepEqual(s.news, daily(norm(config.newsCollectTimes)));
  assert.deepEqual(s.events, daily(norm([config.eventsCollectTime])));
  assert.deepEqual(s.stockPulse.repeat, { kind: "daily" });
  assert.deepEqual(s.skills, {
    enabled: true,
    repeat: { kind: "weekly", days: [1], intervalWeeks: 1 },
    times: ["09:00"],
  });
  assert.deepEqual(s.lotto, {
    enabled: true,
    repeat: { kind: "weekly", days: [0], intervalWeeks: 1 },
    times: ["10:00"],
  });
});

test("v1 schedule.json(실제 운영 파일 형식)을 '매일'로 읽는다", () => {
  // 2026-10-25 실제 data/schedule.json 내용 그대로 — stockUs 가 시각 역순인 것까지 재현한다.
  writeRaw({ youtube: ["09:00", "19:00"], stockUs: ["17:00", "08:00"], stockKr: ["08:00", "17:00"] });
  const s = getSchedule();
  assert.deepEqual(s.youtube, daily(["09:00", "19:00"]));
  assert.deepEqual(s.stockUs, daily(["08:00", "17:00"]), "v2 는 시각을 오름차순으로 정규화한다");
  assert.deepEqual(s.stockKr, daily(["08:00", "17:00"]));
  // 파일에 없는 잡은 계속 .env 를 따른다
  assert.deepEqual(s.news, daily(norm(config.newsCollectTimes)));
});

test("읽기는 관대하다 — 깨진 시각만 거르고, 구제가 안 되면 그 잡만 기본값", () => {
  writeRaw({
    events: ["25:00", "9:30"], // 깨진 항목 하나 + 정상 하나 → 정상만
    news: "garbage", // 형식 자체가 틀림 → 기본값
    youtube: [], // 빈 배열 → 기본값(v1 lenientMulti 와 같다)
    lotto: daily(["10:00"]), // 로또에 '매일'은 허용 안 됨 → 기본값
    skills: {
      enabled: true,
      repeat: { kind: "weekly", days: [6], intervalWeeks: 1 },
      times: ["21:00", "bad"],
    },
  });
  const s = getSchedule();
  assert.deepEqual(s.events, daily(["09:30"]));
  assert.deepEqual(s.news, daily(norm(config.newsCollectTimes)));
  assert.deepEqual(s.youtube, daily(norm(config.youtubeCollectTimes)));
  assert.equal(s.lotto.repeat.kind, "weekly");
  assert.deepEqual(s.skills.times, ["21:00"]);
});

test("읽기도 금지 구간을 지킨다 — 손으로 고친 파일이 로또를 토요일 21시에 돌게 하지 못한다", () => {
  writeRaw({
    lotto: { enabled: true, repeat: { kind: "weekly", days: [6], intervalWeeks: 1 }, times: ["21:00"] },
  });
  assert.deepEqual(getSchedule().lotto.repeat, { kind: "weekly", days: [0], intervalWeeks: 1 });
});

test("읽기 경로는 격주 기준일을 '오늘'로 채우지 않는다(날마다 위상이 뒤집히면 안 된다)", () => {
  writeRaw({
    news: { enabled: true, repeat: { kind: "weekly", days: [1], intervalWeeks: 2 }, times: ["08:00"] },
  });
  const a = getSchedule().news.repeat;
  assert.equal(a.kind, "weekly");
  // 고정 기준(2026-01-05)으로 채워져, 언제 읽어도 같은 값이다.
  assert.equal(a.kind === "weekly" ? a.anchorDate : null, "2026-01-05");
});

test("쓰기는 엄격하다 — 하나라도 틀리면 아무것도 저장하지 않고 throw", () => {
  writeRaw({ youtube: ["09:00", "19:00"] });
  const before = fs.readFileSync(FILE, "utf8");
  assert.throws(
    () => saveSchedule({ news: daily(["08:00"]) as never, events: daily(["8시"]) as never }),
    /팝업·전시: 시각 형식 오류/
  );
  assert.equal(fs.readFileSync(FILE, "utf8"), before, "첫 잡(news)도 저장되면 안 된다");

  assert.throws(() => saveSchedule({ price: ["08:00"] } as never), /알 수 없는 스케줄 항목: price/);
  assert.throws(() => saveSchedule([] as never), /객체여야/);
  assert.throws(
    () =>
      saveSchedule({
        lotto: { enabled: true, repeat: { kind: "weekly", days: [6], intervalWeeks: 1 }, times: ["20:30"] },
      }),
    /로또: 토요일 20:00~24:00에는 실행할 수 없습니다/
  );
});

test("쓰기는 sparse — 보낸 잡만 v2 로 기록하고, v1 으로 남은 다른 잡은 손대지 않는다", () => {
  writeRaw({ youtube: ["09:00", "19:00"], stockUs: ["17:00", "08:00"] });
  const now = new Date(2026, 9, 25, 12, 0); // 2026-10-25(일)
  const r = saveSchedule(
    { news: { enabled: true, repeat: { kind: "weekly", days: [1, 3], intervalWeeks: 2 }, times: ["7:00"] } },
    now
  );
  assert.deepEqual(r.news, {
    enabled: true,
    repeat: { kind: "weekly", days: [1, 3], intervalWeeks: 2, anchorDate: "2026-10-25" },
    times: ["07:00"],
  });
  const raw = readRaw();
  assert.deepEqual(Object.keys(raw).sort(), ["news", "stockUs", "youtube"]);
  assert.deepEqual(raw.youtube, ["09:00", "19:00"], "v1 항목은 그대로 남는다");
  assert.deepEqual(raw.news, r.news);

  // v1 배열 PUT 도 받아 준다(매일)
  const r2 = saveSchedule({ youtube: ["21:00", "8:00"] } as never);
  assert.deepEqual(r2.youtube, daily(["08:00", "21:00"]));
});

test("기본값과 같은 값을 저장하면 override 를 지워 다시 .env 를 따른다('기본값으로 되돌리기')", () => {
  saveSchedule({ lotto: { enabled: false, repeat: { kind: "weekly", days: [0], intervalWeeks: 1 }, times: ["10:00"] } });
  assert.ok("lotto" in readRaw());
  assert.equal(getSchedule().lotto.enabled, false);
  saveSchedule({ lotto: { enabled: true, repeat: { kind: "weekly", days: [0], intervalWeeks: 1 }, times: ["10:00"] } });
  assert.ok(!("lotto" in readRaw()), "기본값과 같아졌으니 저장분에서 빠져야 한다");
});

test("getScheduleResponse — schedule·defaults·rules·next(꺼짐은 null, 로컬 오프셋 ISO)", () => {
  saveSchedule({ skills: { enabled: false, repeat: { kind: "weekly", days: [1], intervalWeeks: 1 }, times: ["09:00"] } });
  const now = new Date(2026, 9, 25, 12, 0); // 일요일 정오
  const r = getScheduleResponse(now);
  assert.equal(r.schedule.skills.enabled, false);
  assert.equal(r.defaults.skills.enabled, true);
  assert.equal(r.next.skills, null, "꺼진 잡은 다음 실행이 없다");
  // 로또 기본(일 10:00) — 정오 기준 다음은 11/1(일) 10:00
  assert.match(r.next.lotto ?? "", /^2026-11-01T10:00:00[+-]\d{2}:\d{2}$/);
  assert.deepEqual(r.rules, SCHEDULE_RULES);
  assert.deepEqual(Object.keys(r.next).sort(), Object.keys(r.schedule).sort());
});
