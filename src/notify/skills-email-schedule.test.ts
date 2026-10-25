import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 스킬 랭킹 메일 머리줄의 갱신 주기 문구가 **스케줄(getSchedule().skills)** 을 따르는지.
 * 예전엔 상수 "매주 월요일 09:00" 이라 대시보드에서 회차를 바꾸면 메일이 거짓말을 했다.
 *
 * 파일을 skills-email.test.ts 와 나눈 이유: 스케줄 저장 파일을 써야 하는데 그 파일은 DB_PATH 를
 * 격리하지 않는다. config 가 import 시점에 DB_PATH 를 읽으므로 env 를 먼저 심고 동적 import 한다.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-skills-email-schedule-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");

const { saveSchedule, getSchedule } = await import("../scheduler/schedule-store.ts");
const { buildSkillsEmailHtml, skillsCycleLabel } = await import("./skills-email.ts");

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const SNAP = {
  date: "2026-10-26",
  byStars: [],
  byGrowth: [],
  window: null,
  trackedCount: 0,
  notes: null,
} as never;

test("기본 스케줄이면 예전 문구와 같다(매주 월요일 09:00 갱신)", () => {
  assert.equal(skillsCycleLabel(), "매주 월요일 09:00 갱신");
  assert.match(buildSkillsEmailHtml(SNAP), /2026-10-26 \| 매주 월요일 09:00 갱신 \|/);
});

test("대시보드에서 바꾼 회차(매월·격주·꺼짐)를 저장 즉시 그대로 적는다", () => {
  saveSchedule({ skills: { enabled: true, repeat: { kind: "monthly", dates: [1] }, times: ["09:30"] } });
  assert.match(buildSkillsEmailHtml(SNAP), /\| 매월 1일 09:30 갱신 \|/);

  saveSchedule({
    skills: { enabled: true, repeat: { kind: "weekly", days: [3], intervalWeeks: 2, anchorDate: "2026-10-26" }, times: ["10:00"] },
  });
  assert.equal(skillsCycleLabel(), "격주 수요일 10:00 갱신");

  saveSchedule({ skills: { ...getSchedule().skills, enabled: false } });
  assert.match(buildSkillsEmailHtml(SNAP), /\| 자동 갱신 꺼짐 \|/);
  assert.doesNotMatch(buildSkillsEmailHtml(SNAP), /매주 월요일/);
});
