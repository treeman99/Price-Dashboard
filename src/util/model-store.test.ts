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
  clearCodexFallback,
  getAgentModel,
  getModelSettings,
  recordCodexFallback,
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
  // 대체 모델이 목록에 없으면 임시 대체 중 UI 가 실제 실행 모델을 표시하지 못한다.
  assert.ok(ids.includes(FALLBACK_AGENT_MODEL));
});

test("저장 전에는 기본값을 반환", () => {
  resetStore();
  assert.equal(getAgentModel(), DEFAULT_AGENT_MODEL);
  const s = getModelSettings();
  assert.deepEqual(s.options, AGENT_MODEL_OPTIONS);
  assert.equal(s.fallback, null);
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

test("사용 불가 기록은 사유를 남기되 **사용자 선택을 바꾸지 않는다**", () => {
  resetStore();
  saveAgentModel("gpt-5.6-sol");
  assert.equal(recordCodexFallback("gpt-5.6-sol", "You've hit your usage limit"), true);
  // 핵심 회귀: 예전에는 여기서 저장 모델이 Opus 로 덮어써졌고, 되돌리는 유일한 장치가
  // 주간 cron 이었다. 선택이 그대로여야 다음 실행이 다시 Codex 를 시도한다.
  assert.equal(getAgentModel(), "gpt-5.6-sol");
  const s = getModelSettings();
  assert.equal(s.fallback?.from, "gpt-5.6-sol");
  assert.match(s.fallback?.reason ?? "", /usage limit/);
});

test("대체가 이어지는 동안 최초 시각은 보존하고 사유만 갱신한다", () => {
  const first = getModelSettings().fallback?.at;
  assert.equal(recordCodexFallback("gpt-5.6-sol", "로그인이 확인되지 않습니다"), false);
  const s = getModelSettings();
  assert.equal(s.fallback?.at, first); // '언제부터 못 쓰나'가 밀리면 안 된다
  assert.match(s.fallback?.reason ?? "", /로그인/); // 최신 원인은 보여야 한다
});

test("Codex 가 다시 응답하면 대체 상태가 풀린다(달력 아닌 성공이 복귀 조건)", () => {
  assert.equal(clearCodexFallback(), true);
  assert.equal(getModelSettings().fallback, null);
  assert.equal(getAgentModel(), "gpt-5.6-sol");
  // 풀 게 없으면 조용히 false — 성공할 때마다 파일을 다시 쓰지 않기 위한 것이다.
  assert.equal(clearCodexFallback(), false);
});

test("다른 모델로 막히면 새 기록으로 취급한다(시각 재설정)", () => {
  resetStore();
  assert.equal(recordCodexFallback("gpt-5.6-sol", "한도"), true);
  assert.equal(recordCodexFallback("gpt-5.6-terra", "한도"), true);
  assert.equal(getModelSettings().fallback?.from, "gpt-5.6-terra");
});

test("수동 선택은 임시 대체 배지를 해제한다", () => {
  resetStore();
  recordCodexFallback("gpt-5.6-sol", "한도");
  saveAgentModel("claude-opus-5");
  const s = getModelSettings();
  assert.equal(s.model, "claude-opus-5");
  assert.equal(s.fallback, null);
});

test("옛 스키마({model}만 있는 파일)도 그대로 읽힌다", () => {
  fs.writeFileSync(storePath, JSON.stringify({ model: "gpt-5.6-terra" }), "utf8");
  assert.equal(getAgentModel(), "gpt-5.6-terra");
  assert.equal(getModelSettings().fallback, null);
});

test("이관: 옛 자동 전환이 덮어쓴 model 은 원래 선택으로 되돌린다", () => {
  // 주간 cron 이 사라졌으므로, 이관하지 않으면 고른 적 없는 Opus 5 에 영원히 눌러앉는다.
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      model: "claude-opus-5",
      fallback: { from: "gpt-5.6-sol", at: "2026-07-20T12:00:00.000Z", reason: "한도" },
      lastWeeklyResetAt: "2026-07-15T12:00:00.000Z", // 옛 필드가 남아 있어도 무시된다
    }),
    "utf8"
  );
  assert.equal(getAgentModel(), "gpt-5.6-sol");
  assert.equal(getModelSettings().fallback?.at, "2026-07-20T12:00:00.000Z");
});

test("이관: 사용자가 직접 고른 Opus 5(전환 기록 없음)는 건드리지 않는다", () => {
  fs.writeFileSync(
    storePath,
    JSON.stringify({ model: "claude-opus-5", fallback: null }),
    "utf8"
  );
  assert.equal(getAgentModel(), "claude-opus-5");
});
