// 증시 알림 슬롯별 멱등 원장 회귀 테스트.
// 실제 버그: 하루 2슬롯(stockUs ["17:00","08:00"])에서 08:00 런이 notified=true 를 남기면
// 17:00 런 알림이 통째로 삼켜졌다. 아래 케이스가 그 회귀를 고정한다.
//
// ⚠️ DB 를 여는 테스트는 임시 DB 파일을 DB_PATH 로 가리키고 "동적 import" 해야 한다
// (정적 import 는 hoisting 때문에 env 설정보다 먼저 평가됨) — summary-fields.test.ts 와 동일 패턴.
// config 는 모듈 싱글턴이라 DB_PATH 를 테스트마다 바꿔도 첫 import 값이 고정된다.
// 그래서 파일 전체가 임시 DB 하나를 공유하고, 케이스는 수집일(date)로 분리한다.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-stock-ledger-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

after(async () => {
  const { closeDb } = await import("../db/index.ts");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** stock.ts 6단계 알림 블록의 발송 진입 조건을 그대로 옮긴 판정. */
function wouldSend(flags: { email: boolean; imessage: boolean }): boolean {
  return !flags.email || !flags.imessage;
}

test("슬롯별 알림 원장: 다른 슬롯은 발송, 같은 슬롯 재실행은 미발송", async () => {
  const repo = await import("../db/repo.ts");
  const ledger = await import("./notify-ledger.ts");
  const date = "2026-07-20";

  // 원장이 비어 있으면 어떤 슬롯이든 미발송 상태다.
  assert.deepEqual(ledger.loadNotifiedMap(date, "us"), {});
  assert.deepEqual(ledger.slotNotified({}, "08:00"), { email: false, imessage: false });

  // 08:00 런이 양 채널 발송 성공 → 그 슬롯만 기록.
  repo.startStockRun(date, "us");
  repo.finishStockRun(date, "us", true, {
    notifiedBySlot: ledger.mergeNotified(ledger.loadNotifiedMap(date, "us"), "08:00", {
      email: true,
      imessage: true,
    }),
  });

  // 같은 슬롯 재실행(catch-up/재시작) → 발송하지 않는다.
  const map1 = ledger.loadNotifiedMap(date, "us");
  assert.deepEqual(ledger.slotNotified(map1, "08:00"), { email: true, imessage: true });
  assert.equal(wouldSend(ledger.slotNotified(map1, "08:00")), false);

  // 다른 슬롯(17:00)은 아직 기록이 없으므로 발송한다 — 원래 버그의 회귀 지점.
  assert.equal(wouldSend(ledger.slotNotified(map1, "17:00")), true);

  // 17:00 발송 후에도 08:00 기록이 살아 있어야 한다(맵 병합 확인).
  repo.finishStockRun(date, "us", true, {
    notifiedBySlot: ledger.mergeNotified(map1, "17:00", { email: true, imessage: true }),
  });
  const map2 = ledger.loadNotifiedMap(date, "us");
  assert.deepEqual(Object.keys(map2).sort(), ["08:00", "17:00"]);
  assert.equal(map2["08:00"]?.email, true);

  // 시장이 다르면 원장도 분리된다(kr 은 같은 날 아무 기록이 없다).
  assert.deepEqual(ledger.loadNotifiedMap(date, "kr"), {});
});

test("채널 부분 실패: 같은 슬롯 재실행 시 실패한 채널만 재시도 대상", async () => {
  const repo = await import("../db/repo.ts");
  const ledger = await import("./notify-ledger.ts");
  const date = "2026-07-21";

  // 이메일만 성공, iMessage 실패.
  repo.finishStockRun(date, "us", true, {
    notifiedBySlot: { "17:00": { email: true, imessage: false } },
  });

  const flags = ledger.slotNotified(ledger.loadNotifiedMap(date, "us"), "17:00");
  assert.equal(wouldSend(flags), true); // 재실행 시 알림 블록에 진입하고
  assert.equal(flags.email, true); //      이메일은 if(!emailed) 가드로 스킵되며
  assert.equal(flags.imessage, false); //   iMessage 만 재시도된다.
});

test("휴장·수집 실패 경로가 앞선 슬롯의 발송 기록을 말소하지 않는다", async () => {
  const repo = await import("../db/repo.ts");
  const ledger = await import("./notify-ledger.ts");
  const date = "2026-07-22";

  repo.finishStockRun(date, "us", true, {
    notifiedBySlot: { "08:00": { email: true, imessage: true } },
  });

  // 휴장 경로: 맵을 통째로 되쓴다(과거엔 {false,false} 하드코딩이라 말소됐다).
  repo.finishStockRun(date, "us", true, {
    closed: true,
    reason: "주말",
    notifiedBySlot: ledger.loadNotifiedMap(date, "us"),
  });
  assert.deepEqual(ledger.slotNotified(ledger.loadNotifiedMap(date, "us"), "08:00"), {
    email: true,
    imessage: true,
  });

  // 수집 실패 경로도 동일하게 맵 전체를 보존한다.
  repo.finishStockRun(date, "us", false, {
    error: "수집 실패",
    notifiedBySlot: ledger.loadNotifiedMap(date, "us"),
  });
  assert.deepEqual(ledger.slotNotified(ledger.loadNotifiedMap(date, "us"), "08:00"), {
    email: true,
    imessage: true,
  });
});

test("레거시 top-level notified 는 무시한다(배포 당일 남은 슬롯이 삼켜지지 않게)", async () => {
  const repo = await import("../db/repo.ts");
  const ledger = await import("./notify-ledger.ts");
  const date = "2026-07-23";

  // 구 포맷 행(실측 DB 형태).
  repo.finishStockRun(date, "us", true, {
    sessionDate: "2026-07-17",
    source: "llm",
    notified: { email: true, imessage: true },
  });
  assert.deepEqual(ledger.loadNotifiedMap(date, "us"), {});
});

test("latestPastSlot: 정렬되지 않은 목록에서도 '가장 최근 지난 슬롯'을 고른다", async () => {
  const ledger = await import("./notify-ledger.ts");
  // 실제 data/schedule.json 은 ["17:00","08:00"] — getSchedule() 은 정렬을 보장하지 않는다.
  const times = ["17:00", "08:00"];
  const at = (h: number, m = 0) => new Date(2026, 6, 20, h, m, 0, 0);

  assert.equal(ledger.latestPastSlot(times, at(7, 59)), null); // 첫 슬롯 이전
  assert.equal(ledger.latestPastSlot(times, at(8, 0)), "08:00"); // 경계 포함
  assert.equal(ledger.latestPastSlot(times, at(16, 59)), "08:00");
  assert.equal(ledger.latestPastSlot(times, at(17, 30)), "17:00");
  // 미래 슬롯 선점 불가 — 07:59 수동 갱신이 08:00 을 소진시키면 정시 알림이 삼켜진다.
  assert.notEqual(ledger.latestPastSlot(times, at(7, 59)), "08:00");
  // 형식이 깨진 항목은 조용히 스킵(fail-open).
  assert.equal(ledger.latestPastSlot(["보름달", "09:00"], at(10)), "09:00");
});

// ── resolveSlot: 호출자 slot → 원장 키 로 이어지는 이 수정의 본체 ──
// getSchedule() 은 config.dbPath 옆의 schedule.json 을 매 호출 읽으므로(캐시 없음),
// 임시 DB 디렉터리에 파일을 써서 스케줄을 그대로 주입한다(모킹 불필요).
function writeSchedule(stockKr: string[], stockUs: string[]): void {
  fs.writeFileSync(
    path.join(tmpDir, "schedule.json"),
    JSON.stringify({ stockKr, stockUs }),
    "utf8"
  );
}

test("resolveSlot: 스케줄러가 넘긴 슬롯은 그대로 원장 키가 된다", async () => {
  const ledger = await import("./notify-ledger.ts");
  writeSchedule(["08:00"], ["17:00", "08:00"]);
  const at = (h: number, m = 0) => new Date(2026, 6, 20, h, m, 0, 0);

  // 정시/catch-up 은 확정 정보를 넘긴다 — 시각과 무관하게 역산하지 않는다.
  assert.equal(ledger.resolveSlot("us", "17:00", at(3)), "17:00");
  assert.equal(ledger.resolveSlot("us", "08:00", at(23, 59)), "08:00");
  // 스케줄에 없는 값이어도 그대로 통과시킨다(스케줄 변경 직후 발화한 cron).
  assert.equal(ledger.resolveSlot("kr", "12:34", at(20)), "12:34");
});

test("resolveSlot: 수동 갱신은 지난 슬롯에 귀속, 첫 슬롯 이전이면 MANUAL_SLOT", async () => {
  const ledger = await import("./notify-ledger.ts");
  writeSchedule(["08:00"], ["17:00", "08:00"]);
  const at = (h: number, m = 0) => new Date(2026, 6, 20, h, m, 0, 0);

  assert.equal(ledger.resolveSlot("us", undefined, at(7, 30)), ledger.MANUAL_SLOT);
  assert.equal(ledger.resolveSlot("us", undefined, at(8, 0)), "08:00");
  assert.equal(ledger.resolveSlot("us", undefined, at(16, 59)), "08:00");
  assert.equal(ledger.resolveSlot("us", undefined, at(17, 30)), "17:00");
  // 하루가 하나의 슬롯으로 뭉개지면 원래 버그(08:00 런이 17:00 브리핑을 삼킴)가 되살아난다.
  assert.notEqual(
    ledger.resolveSlot("us", undefined, at(17, 30)),
    ledger.resolveSlot("us", undefined, at(9, 0))
  );
});

test("resolveSlot: 시장별로 자기 스케줄 목록을 본다", async () => {
  const ledger = await import("./notify-ledger.ts");
  // 두 목록을 겹치지 않게 둬서 kr/us 를 뒤바꾸면 반드시 값이 달라지게 한다.
  writeSchedule(["09:00"], ["21:00"]);
  const at = (h: number, m = 0) => new Date(2026, 6, 20, h, m, 0, 0);

  assert.equal(ledger.resolveSlot("kr", undefined, at(22)), "09:00");
  assert.equal(ledger.resolveSlot("us", undefined, at(22)), "21:00");
  // 10:00 에는 kr 만 지난 슬롯이 있다 — 목록을 바꿔 읽으면 양쪽 다 어긋난다.
  assert.equal(ledger.resolveSlot("kr", undefined, at(10)), "09:00");
  assert.equal(ledger.resolveSlot("us", undefined, at(10)), ledger.MANUAL_SLOT);
});

// ── catch-up 원장 게이트 ──
test("slotNeedsCatchup: 원장이 근거가 될 때만 보충을 요구한다", async () => {
  const repo = await import("../db/repo.ts");
  const ledger = await import("./notify-ledger.ts");
  const date = "2026-07-24";

  // 그날 행 자체가 없으면 판단 근거가 없다 → 스냅샷 기반 게이트에 맡긴다.
  assert.equal(ledger.slotNeedsCatchup(date, "us", "17:00"), false);

  // 레거시 구 포맷 행도 근거가 아니다(배포 당일 재발송 방지).
  repo.finishStockRun(date, "us", true, { notified: { email: true, imessage: true } });
  assert.equal(ledger.slotNeedsCatchup(date, "us", "17:00"), false);

  // 원장이 생기면 미기록 슬롯은 보충 대상이다 — 슬롯 시각을 넘겨 끝난 런에 밀려
  // 정시 cron 이 통째로 스킵된 경우가 정확히 이 상태다(스냅샷은 신선하다).
  repo.finishStockRun(date, "us", true, {
    notifiedBySlot: { "08:00": { email: true, imessage: true } },
  });
  assert.equal(ledger.slotNeedsCatchup(date, "us", "17:00"), true);
  assert.equal(ledger.slotNeedsCatchup(date, "us", "08:00"), false);

  // 채널 부분 실패는 열린 상태 — 남은 채널을 보충한다.
  repo.finishStockRun(date, "us", true, {
    notifiedBySlot: { "17:00": { email: true, imessage: false } },
  });
  assert.equal(ledger.slotNeedsCatchup(date, "us", "17:00"), true);

  // 휴장·내용 0건은 SLOT_HANDLED 로 닫는다 → 30분마다 무한 재수집하지 않는다.
  repo.finishStockRun(date, "us", true, {
    closed: true,
    notifiedBySlot: { "17:00": ledger.SLOT_HANDLED },
  });
  assert.equal(ledger.slotNeedsCatchup(date, "us", "17:00"), false);

  // 시장이 다르면 원장도 분리된다.
  assert.equal(ledger.slotNeedsCatchup(date, "kr", "17:00"), false);
});

test("수집 실패(ok=false) 슬롯은 열린 채로 남아 catch-up 이 재시도한다", async () => {
  const repo = await import("../db/repo.ts");
  const ledger = await import("./notify-ledger.ts");
  const date = "2026-07-25";

  // 빈 스냅샷을 저장하며 updatedAt 을 밀어도(=스냅샷 기반 게이트는 닫힌다)
  // 원장이 열려 있으면 보충이 살아 있다.
  repo.finishStockRun(date, "kr", false, {
    error: "수집 실패",
    notifiedBySlot: ledger.mergeNotified(ledger.loadNotifiedMap(date, "kr"), "08:00", {
      email: false,
      imessage: false,
    }),
  });
  assert.equal(ledger.slotNeedsCatchup(date, "kr", "08:00"), true);
});

// ── 휴장일 무한 catch-up 핑퐁 방어 ──
//
// 휴장 스냅샷은 역할 파일 오염을 피하려고 **both 경로 한 곳**에만 저장되므로 slot 을 하나만
// 담는다. 슬롯이 2개인 휴장일에는 뒤 런이 앞 런의 slot 을 덮어써 어떤 상태에서도 두 슬롯이
// 동시에 커버되지 않는다 → 스냅샷만 보는 게이트는 자정까지 30분마다 두 슬롯을 번갈아
// 재수집한다. 원장은 슬롯별 맵이라 이 상황에서도 정확하고, 그래서 1차 게이트의 근거가 된다.
test("slotHandled: 휴장 런이 닫은 두 슬롯을 원장은 동시에 '처리됨'으로 안다", async () => {
  const repo = await import("../db/repo.ts");
  const ledger = await import("./notify-ledger.ts");
  const date = "2026-07-26"; // 일요일

  // 08:00 휴장 런 → 그 슬롯만 닫는다.
  repo.finishStockRun(date, "us", true, {
    closed: true,
    notifiedBySlot: ledger.mergeNotified(
      ledger.loadNotifiedMap(date, "us"),
      "08:00",
      ledger.SLOT_HANDLED
    ),
  });
  assert.equal(ledger.slotHandled(date, "us", "08:00"), true);
  assert.equal(ledger.slotHandled(date, "us", "17:00"), false, "아직 안 돈 슬롯이 닫혀 있다");

  // 17:00 휴장 런 → 앞 슬롯 기록을 보존한 채 자기 슬롯을 닫는다.
  repo.finishStockRun(date, "us", true, {
    closed: true,
    notifiedBySlot: ledger.mergeNotified(
      ledger.loadNotifiedMap(date, "us"),
      "17:00",
      ledger.SLOT_HANDLED
    ),
  });
  // ⚠️ 여기가 핵심이다. 스냅샷은 둘 중 하나만 커버할 수 있지만 원장은 **둘 다** 닫혀 있다.
  // 이 단언이 깨지면 주말·공휴일마다 30분 주기 무한 재수집이 되살아난다.
  assert.equal(ledger.slotHandled(date, "us", "08:00"), true);
  assert.equal(ledger.slotHandled(date, "us", "17:00"), true);
});

test("slotHandled 는 slotNeedsCatchup 의 부정이 아니다(원장 부재는 둘 다 false)", async () => {
  const ledger = await import("./notify-ledger.ts");
  const date = "2026-07-27"; // 이 날 원장 행 없음

  // 서버가 죽어 그날 런이 0건인 상태. '닫혔다는 근거'도 없고 '보충 근거'도 없다.
  // 두 함수가 같은 축이면(부정 관계면) 이 상태에서 catch-up 이 통째로 막히거나
  // 휴장일 재수집이 막히지 않거나, 둘 중 하나가 반드시 깨진다.
  assert.equal(ledger.slotHandled(date, "us", "08:00"), false, "닫히지 않은 슬롯이 닫힘으로 보였다");
  assert.equal(ledger.slotNeedsCatchup(date, "us", "08:00"), false);
});

test("slotHandled: 채널 하나라도 열려 있으면 닫힌 것이 아니다", async () => {
  const repo = await import("../db/repo.ts");
  const ledger = await import("./notify-ledger.ts");
  const date = "2026-07-28";
  repo.finishStockRun(date, "us", true, {
    notifiedBySlot: { "08:00": { email: true, imessage: false } },
  });
  assert.equal(ledger.slotHandled(date, "us", "08:00"), false);
  assert.equal(ledger.slotNeedsCatchup(date, "us", "08:00"), true);
});
