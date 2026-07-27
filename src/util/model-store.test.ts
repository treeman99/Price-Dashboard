import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// config 는 import 시점에 DB_PATH 를 읽는다. model-store 를 불러오기 전에 임시 경로로 격리해
// 실제 data/model.json(=사용자 설정)을 건드리지 않게 한다. dotenv 는 이미 설정된 env 를 덮어쓰지 않으므로 안전.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-store-test-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");
const storePath = path.join(tmpDir, "model.json");

const {
  AGENT_MODEL_OPTIONS,
  DEFAULT_AGENT_MODEL,
  FALLBACK_AGENT_MODEL,
  PRIMARY_AGENT_MODEL,
  WEEKLY_RESET_CRON,
  checkWeeklyResetCatchup,
  getAgentModel,
  getModelSettings,
  previousWeeklyResetAt,
  recordUsageLimitFallback,
  restoreWeeklyPrimary,
  saveAgentModel,
} = await import("./model-store.ts");

/** 각 테스트가 앞 테스트의 저장 상태에 오염되지 않도록 초기화한다. */
function resetStore() {
  fs.rmSync(storePath, { force: true });
}

test("기본 모델은 목록 첫 항목(Codex 5.6 Sol)", () => {
  assert.equal(DEFAULT_AGENT_MODEL, "gpt-5.6-sol");
  assert.equal(AGENT_MODEL_OPTIONS[0].id, DEFAULT_AGENT_MODEL);
  assert.equal(PRIMARY_AGENT_MODEL, "gpt-5.6-sol");
  assert.equal(FALLBACK_AGENT_MODEL, "claude-opus-5");
});

test("선택지는 Sol(기본) · Opus 5(대체) · Terra", () => {
  const ids = AGENT_MODEL_OPTIONS.map((o) => o.id);
  assert.deepEqual(ids, ["gpt-5.6-sol", "claude-opus-5", "gpt-5.6-terra"]);
  // 대체 모델이 목록에 없으면 자동 전환 뒤 UI 가 현재 모델을 표시하지 못한다.
  assert.ok(ids.includes(FALLBACK_AGENT_MODEL));
});

test("저장 전에는 기본값을 반환", () => {
  resetStore();
  assert.equal(getAgentModel(), DEFAULT_AGENT_MODEL);
  const s = getModelSettings();
  assert.deepEqual(s.options, AGENT_MODEL_OPTIONS);
  assert.equal(s.fallback, null);
  assert.equal(s.weeklyResetLabel, "일요일 21:00");
});

test("허용된 모델 저장 후 그 값을 반환", () => {
  resetStore();
  const updated = saveAgentModel("gpt-5.6-terra");
  assert.equal(updated.model, "gpt-5.6-terra");
  assert.equal(getAgentModel(), "gpt-5.6-terra");
});

test("허용 목록 밖 모델은 거부(throw)하고 저장값은 불변", () => {
  assert.throws(() => saveAgentModel("gpt-4o"), /허용되지 않은/);
  assert.throws(() => saveAgentModel(""), /허용되지 않은/);
  assert.throws(() => saveAgentModel(123), /허용되지 않은/);
  assert.equal(getAgentModel(), "gpt-5.6-terra"); // 직전 유효 저장 유지
});

test("한도 소진 → 대체 모델로 전환하고 사유를 남긴다", () => {
  resetStore();
  assert.equal(recordUsageLimitFallback("gpt-5.6-sol", "You've hit your usage limit"), true);
  assert.equal(getAgentModel(), FALLBACK_AGENT_MODEL);
  const s = getModelSettings();
  assert.equal(s.fallback?.from, "gpt-5.6-sol");
  assert.match(s.fallback?.reason ?? "", /usage limit/);
});

test("이미 대체 모델이면 재전환하지 않는다(최초 전환 시각 보존)", () => {
  const first = getModelSettings().fallback?.at;
  assert.equal(recordUsageLimitFallback("gpt-5.6-sol", "또 한도"), false);
  assert.equal(getModelSettings().fallback?.at, first);
});

test("수동 선택은 자동 전환 배지를 해제한다", () => {
  saveAgentModel("gpt-5.6-sol");
  assert.equal(getModelSettings().fallback, null);
});

test("주간 복귀는 기본 모델로 되돌리고 전환 상태를 지운다", () => {
  resetStore();
  recordUsageLimitFallback("gpt-5.6-sol", "한도");
  assert.equal(restoreWeeklyPrimary("test"), true);
  assert.equal(getAgentModel(), PRIMARY_AGENT_MODEL);
  assert.equal(getModelSettings().fallback, null);
  // 이미 기본 모델이면 '바꾼 것 없음'이지만 복귀 시각은 갱신된다.
  assert.equal(restoreWeeklyPrimary("test"), false);
});

test("주간 복귀 cron 식은 일요일 21:00", () => {
  assert.equal(WEEKLY_RESET_CRON, "0 21 * * 0");
});

test("previousWeeklyResetAt — 가장 최근 지난 일요일 21:00", () => {
  const at = (iso: string) => previousWeeklyResetAt(new Date(iso));
  // 월요일 저녁 → 하루 전 일요일 21:00
  assert.equal(at("2026-07-27T22:00:00").toISOString(), new Date("2026-07-26T21:00:00").toISOString());
  // 일요일 20:59 → 아직 이번 주 복귀 전이므로 **지난주** 일요일
  assert.equal(at("2026-07-26T20:59:00").toISOString(), new Date("2026-07-19T21:00:00").toISOString());
  // 일요일 21:00 정각 → 이번 주
  assert.equal(at("2026-07-26T21:00:00").toISOString(), new Date("2026-07-26T21:00:00").toISOString());
  // 토요일 → 6일 전 일요일
  assert.equal(at("2026-08-01T09:00:00").toISOString(), new Date("2026-07-26T21:00:00").toISOString());
});

test("catch-up: 기준선이 없으면 되돌리지 않고 심기만 한다", () => {
  resetStore();
  saveAgentModel("claude-opus-5"); // 사용자가 방금 고른 값
  assert.equal(checkWeeklyResetCatchup(new Date("2026-07-27T10:00:00")), false);
  assert.equal(getAgentModel(), "claude-opus-5"); // 첫 기동에서 수동 선택을 덮어쓰지 않는다
});

test("catch-up: 예정 시각을 놓친 뒤 첫 점검에서 1회만 복귀한다", () => {
  // 기준선을 예정(2026-07-26 21:00)보다 앞선 시각으로 심는다 = 일요일에 서버가 꺼져 있었던 상황.
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      model: "claude-opus-5",
      fallback: { from: "gpt-5.6-sol", at: "2026-07-24T12:00:00.000Z", reason: "한도" },
      lastWeeklyResetAt: new Date("2026-07-19T21:00:00").toISOString(),
    }),
    "utf8"
  );
  const now = new Date("2026-07-27T10:00:00");
  assert.equal(checkWeeklyResetCatchup(now), true);
  assert.equal(getAgentModel(), PRIMARY_AGENT_MODEL);
  assert.equal(getModelSettings().fallback, null);
  // 두 번째 점검은 조용해야 한다(30분마다 도는 루프에서 무한 복귀가 되면 안 된다).
  assert.equal(checkWeeklyResetCatchup(now), false);
});

test("옛 스키마({model}만 있는 파일)도 그대로 읽힌다", () => {
  fs.writeFileSync(storePath, JSON.stringify({ model: "gpt-5.6-terra" }), "utf8");
  assert.equal(getAgentModel(), "gpt-5.6-terra");
  assert.equal(getModelSettings().fallback, null);
});
