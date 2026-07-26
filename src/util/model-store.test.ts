import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// config 는 import 시점에 DB_PATH 를 읽는다. model-store 를 불러오기 전에 임시 경로로 격리해
// 실제 data/model.json(=사용자 설정)을 건드리지 않게 한다. dotenv 는 이미 설정된 env 를 덮어쓰지 않으므로 안전.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-store-test-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");

const { AGENT_MODEL_OPTIONS, DEFAULT_AGENT_MODEL, getAgentModel, getModelSettings, saveAgentModel } =
  await import("./model-store.ts");

test("기본 모델은 목록 첫 항목(Opus 5)", () => {
  assert.equal(DEFAULT_AGENT_MODEL, "claude-opus-5");
  assert.equal(AGENT_MODEL_OPTIONS[0].id, DEFAULT_AGENT_MODEL);
});

test("선택지에는 Opus 5와 Codex 5.6 Terra만 있다", () => {
  const ids = AGENT_MODEL_OPTIONS.map((o) => o.id);
  assert.deepEqual(ids, ["claude-opus-5", "gpt-5.6-terra"]);
  assert.equal(ids.includes("claude-fable-5"), false);
});

test("저장 전에는 기본값을 반환", () => {
  assert.equal(getAgentModel(), DEFAULT_AGENT_MODEL);
  assert.deepEqual(getModelSettings().options, AGENT_MODEL_OPTIONS);
});

test("허용된 모델 저장 후 그 값을 반환", () => {
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
