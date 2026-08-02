import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSleepWindows,
  sleepWindowCoversGap,
  sleepWindowsCoverGap,
  type PmsetLine,
} from "./uptime.ts";

/**
 * 2026-08-02 사고 구간의 **실제 형태**를 옮긴 픽스처.
 *
 * 핵심은 "긴 Clamshell Sleep 안에 Maintenance Sleep 이 여러 번 끼어 있다"는 것이다
 * (DarkWake 로 2~20초 깨었다 다시 자는 사이클이 10시간 45분 동안 69회 반복됐다).
 * Sleep/Wake 두 줄짜리 합성 픽스처로는 이 모양이 재현되지 않아, 검증 전까지
 * `narrate` 쪽 조립 규칙이 갈라져 있는 것을 아무도 잡지 못했다.
 * MEMORY 의 "파서는 합성 픽스처 말고 실제 데이터로 검증" 이 그대로 재현된 사례다.
 */
const 사고구간: PmsetLine[] = [
  { at: 1000, kind: "Sleep", reason: "Clamshell Sleep", power: "Batt", charge: 80 },
  { at: 1379, kind: "DarkWake", reason: "Deep Idle", power: "Batt", charge: 80 },
  { at: 1388, kind: "Sleep", reason: "Maintenance Sleep", power: "Batt", charge: 80 },
  { at: 1622, kind: "DarkWake", reason: "Deep Idle", power: "Batt", charge: 79 },
  { at: 1629, kind: "Sleep", reason: "Maintenance Sleep", power: "Batt", charge: 79 },
  { at: 38700, kind: "Wake", reason: "lid open", power: "Batt", charge: 48 },
];

test("절전 윈도: 열린 윈도가 있으면 새 Sleep 이 윈도를 새로 열지 않는다", () => {
  const w = buildSleepWindows(사고구간);
  // 조각나면 3개가 된다. 하나로 합쳐져야 한다.
  assert.equal(w.length, 1, `조각남: ${JSON.stringify(w)}`);
  // ★ 시작은 가장 이른 Sleep — 사용자가 알고 싶은 것은 "언제부터 자기 시작했나" 다.
  assert.equal(w[0].startSec, 1000);
  assert.equal(w[0].endSec, 38700);
  // ★ 사유와 배터리가 문구 재료다. 조각나면 'Maintenance Sleep' 과 79% 가 나와 사용자에게
  //   "덮개 닫힘" 이라는 진짜 원인이 전달되지 않는다.
  assert.equal(w[0].reason, "Clamshell Sleep");
  assert.equal(w[0].chargeStart, 80);
  assert.equal(w[0].chargeEnd, 48);
});

test("절전 윈도: 중첩 Sleep 이 있어도 공백을 덮는 것으로 판정된다", () => {
  const w = buildSleepWindows(사고구간);
  // 이게 깨지면 헤드라인은 '절전/확실' 인데 판정근거에 "덮는 절전 없음" 이 찍히는
  // 자기모순이 난다(2026-08-02 검증에서 실제로 발생).
  assert.ok(sleepWindowsCoverGap(w, 1010, 38690), "공백을 덮지 못함");
  assert.ok(sleepWindowCoversGap(w[0], 1010, 38690));
});

test("절전 윈도: DarkWake 는 윈도를 닫지 않는다", () => {
  const w = buildSleepWindows([
    { at: 100, kind: "Sleep", reason: "Clamshell Sleep", power: "AC", charge: 90 },
    { at: 200, kind: "DarkWake", reason: "Deep Idle", power: "AC", charge: 90 },
    { at: 300, kind: "Wake", reason: "lid open", power: "AC", charge: 88 },
  ]);
  assert.equal(w.length, 1);
  assert.equal(w[0].endSec, 300);
});

test("절전 윈도: 순서가 뒤섞여 들어와도 시간순으로 조립한다", () => {
  const w = buildSleepWindows([
    { at: 300, kind: "Wake", reason: "lid open", power: "Batt", charge: 48 },
    { at: 100, kind: "Sleep", reason: "Clamshell Sleep", power: "Batt", charge: 80 },
  ]);
  assert.equal(w.length, 1);
  assert.equal(w[0].startSec, 100);
  assert.equal(w[0].endSec, 300);
});

test("절전 윈도: 닫히지 않은 윈도는 공백을 덮지 않는다(모르는 것을 안다고 하지 않는다)", () => {
  const w = buildSleepWindows([
    { at: 100, kind: "Sleep", reason: "Clamshell Sleep", power: "Batt", charge: 80 },
  ]);
  assert.equal(w.length, 1);
  assert.equal(w[0].endSec, null);
  assert.equal(sleepWindowsCoverGap(w, 110, 200), false);
});

test("절전 윈도: 입력이 비면 빈 배열", () => {
  assert.deepEqual(buildSleepWindows([]), []);
});
