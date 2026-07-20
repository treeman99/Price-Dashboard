// 역할별 스냅샷 저장 계층(snapshotPath / memoKey / getStockSnapshot 폴백 / snapshotForSlot)의
// **실제 구현**에 대한 회귀 테스트.
//
// ⚠️ 왜 별도 파일인가: 이 계층은 디스크 I/O 를 탄다. 경로가 config.dbPath 에서 파생되므로
// 실제 data/ 디렉터리를 그대로 쓰면 사용자의 진짜 스냅샷을 읽거나 덮어쓴다. config 는 모듈
// 로드 시점에 env 를 굳히므로 **import 전에** DB_PATH 를 임시 디렉터리로 돌려야 하는데,
// 정적 import 는 호이스팅돼 그럴 수 없다 → 동적 import 여야 한다. stock.test.ts 는 이미
// stock.ts 를 정적으로 물고 있어 이 파일에 합칠 수 없다(그래서 파일이 갈렸다).
//
// ⚠️ 이 테스트들이 왜 '사본'이 아니라 실제 함수를 불러야 하는가: 이전 버전은 판정부를
// 테스트 안에 재구현했다. 그 상태에서 실제 술어를 통째로 망가뜨려도(예: 슬롯 검사 삭제,
// 역할 접미사 삭제) 스위트가 전부 초록이었다 — 즉 회귀를 하나도 못 막았다.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StockMarket, StockSlotRole, StockSnapshot } from "../../shared/types.ts";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stock-snap-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");

/**
 * 메모 캐시가 빈 **새 모듈 인스턴스**를 얻는다.
 *
 * stock.ts 의 memo 는 모듈 싱글턴이라, 한 번 읽은 (market, role) 은 이후 디스크를 바꿔도
 * 캐시가 이긴다 — 케이스끼리 상태가 샌다. 스펙 문자열에 쿼리를 붙이면 ESM 이 별개 모듈로
 * 평가해 memo 가 새로 생긴다(config·db 등 하위 모듈은 스펙이 같아 그대로 공유되므로
 * DB_PATH 는 유지된다). 프로덕션 코드에 테스트 전용 리셋 훅을 뚫지 않기 위한 선택이다.
 */
let instance = 0;
async function freshStore() {
  for (const m of ["us", "kr"] as StockMarket[]) {
    for (const r of ["both", "close", "preview"] as StockSlotRole[]) {
      fs.rmSync(snapFile(m, r), { force: true });
    }
  }
  return import(`./stock.ts?snapshot-store-test=${++instance}`) as Promise<
    typeof import("./stock.ts")
  >;
}

/**
 * 구현이 읽을 파일 경로. **구현의 snapshotPath 와 같은 규칙을 의도적으로 여기 한 번 더 적는다** —
 * 이 파일은 "디스크 레이아웃 계약"을 고정하는 쪽이고, 구현이 그 계약을 지키는지 검사한다.
 * (판정 로직을 베끼는 것과 다르다. 여기서 베끼는 것은 검사 대상이 아니라 입력 배치다.)
 * both 가 접미사 없는 레거시 파일명을 재사용한다는 사실 자체가 마이그레이션 불필요의 근거다.
 */
function snapFile(market: StockMarket, role: StockSlotRole): string {
  const suffix = role === "both" ? "" : `-${role}`;
  return path.join(tmpDir, `stock-${market}${suffix}-latest.json`);
}

function write(
  market: StockMarket,
  role: StockSlotRole,
  fields: { date: string; slot?: string; updatedAt: string; notes?: string }
): StockSnapshot {
  const snap: StockSnapshot = {
    market,
    date: fields.date,
    sessionDate: fields.date,
    role,
    slot: fields.slot,
    updatedAt: fields.updatedAt,
    source: "llm",
    closed: false,
    closedReason: null,
    indices: [],
    news: [],
    analyses: [],
    watchlist: [],
    disclaimer: "",
    notes: fields.notes ?? null,
  };
  fs.writeFileSync(snapFile(market, role), JSON.stringify(snap, null, 2));
  return snap;
}

// ── snapshotPath: 역할별 파일 분리 ────────────────────────────────────
//
// 접미사가 붕괴하면(세 역할이 한 파일) 오후 프리뷰가 아침 결산을 덮어쓴다 — 이 설계가
// 존재하는 이유인 바로 그 데이터 손실이다. 아래 단언이 그 붕괴를 직접 잡는다.

test("역할별 스냅샷은 서로 다른 파일에 저장되고 섞이지 않는다", async () => {
  const store = await freshStore();
  write("us", "close", { date: "2026-07-20", slot: "08:00", updatedAt: "2026-07-20T08:06:00Z", notes: "결산" });
  write("us", "preview", { date: "2026-07-20", slot: "17:00", updatedAt: "2026-07-20T17:06:00Z", notes: "프리뷰" });
  write("us", "both", { date: "2026-07-19", slot: "08:00", updatedAt: "2026-07-19T08:06:00Z", notes: "혼합" });

  // 세 역할이 한 파일로 붕괴하면 여기서 셋 다 같은 notes 가 되어 실패한다.
  assert.equal(store.getStockSnapshot("us", "close")?.notes, "결산");
  assert.equal(store.getStockSnapshot("us", "preview")?.notes, "프리뷰");
  assert.equal(store.getStockSnapshot("us", "both")?.notes, "혼합");
});

test("both 는 접미사 없는 레거시 파일명을 그대로 쓴다(마이그레이션 불필요)", async () => {
  const store = await freshStore();
  write("kr", "both", { date: "2026-07-20", updatedAt: "2026-07-20T08:06:00Z", notes: "레거시 자리" });
  // 파일명이 바뀌면 기존 배포의 스냅샷이 화면에서 사라진다.
  assert.ok(fs.existsSync(path.join(tmpDir, "stock-kr-latest.json")));
  assert.equal(store.getStockSnapshot("kr", "both")?.notes, "레거시 자리");
});

// ── memoKey: 역할 축이 살아 있어야 한다 ──────────────────────────────
//
// memoKey 에서 role 을 빼면 먼저 읽은 역할이 캐시를 선점해 다른 역할 조회가 그 값을 돌려준다.
// 디스크는 멀쩡한데 화면만 틀리는 형태라 눈으로 잡기 가장 어려운 종류의 회귀다.

test("메모 캐시는 역할별로 분리된다(먼저 읽은 역할이 다른 역할을 오염시키지 않는다)", async () => {
  const store = await freshStore();
  write("us", "close", { date: "2026-07-20", slot: "08:00", updatedAt: "2026-07-20T08:06:00Z", notes: "결산" });
  write("us", "preview", { date: "2026-07-20", slot: "17:00", updatedAt: "2026-07-20T17:06:00Z", notes: "프리뷰" });

  // 순서가 중요하다 — close 를 먼저 읽어 캐시를 채운 뒤 preview 를 묻는다.
  assert.equal(store.getStockSnapshot("us", "close")?.notes, "결산");
  assert.equal(store.getStockSnapshot("us", "preview")?.notes, "프리뷰", "메모 키에 역할이 빠져 close 가 재사용됐다");
});

// ── getStockSnapshot 폴백: '가장 최신' 이지 '처음 찾은 것' 이 아니다 ──

test("역할 미지정 조회는 updatedAt 이 가장 최신인 스냅샷을 돌려준다", async () => {
  const store = await freshStore();
  // 순회 순서는 both → close → preview 다. 가장 오래된 것을 맨 앞에 둬서
  // '처음 찾은 것을 반환'하는 구현이면 반드시 실패하게 만든다.
  write("us", "both", { date: "2026-07-18", updatedAt: "2026-07-18T08:00:00Z", notes: "가장 오래됨" });
  write("us", "close", { date: "2026-07-20", slot: "08:00", updatedAt: "2026-07-20T08:06:00Z", notes: "결산" });
  write("us", "preview", { date: "2026-07-20", slot: "17:00", updatedAt: "2026-07-20T17:06:00Z", notes: "가장 최신" });

  assert.equal(store.getStockSnapshot("us")?.notes, "가장 최신");
});

test("역할 파일이 하나도 없고 레거시 both 만 있어도 조회된다(배포 직후 하위호환)", async () => {
  const store = await freshStore();
  write("us", "both", { date: "2026-07-20", updatedAt: "2026-07-20T08:06:00Z", notes: "구 배포" });
  assert.equal(store.getStockSnapshot("us")?.notes, "구 배포");
});

test("스냅샷이 하나도 없으면 null", async () => {
  const store = await freshStore();
  assert.equal(store.getStockSnapshot("us"), null);
});

// ── snapshotForSlot: catch-up 1차 게이트의 실제 술어 ─────────────────
//
// 이 게이트가 틀리면 두 방향 모두 **조용히** 실패한다:
//   · 너무 관대 → 슬롯이 영구 누락(그날 결산 또는 프리뷰가 아예 안 나감)
//   · 너무 엄격 → 30분마다 무한 catch-up

test("슬롯 게이트 — 아침 결산만 끝난 날 오후 프리뷰 슬롯은 '누락'으로 잡힌다", async () => {
  const store = await freshStore();
  write("us", "close", { date: "2026-07-20", slot: "08:00", updatedAt: "2026-07-20T08:06:00Z" });
  assert.equal(store.hasSnapshotForSlot("us", "2026-07-20", "08:00"), true);
  // ⚠️ 역할이 아니라 슬롯 기준이라야 여기가 false 다. 옛 게이트(`snapshotDate !== today()`)
  // 였다면 '오늘 스냅샷 있음'으로 걸러져 프리뷰가 **영구 누락**됐다.
  assert.equal(store.hasSnapshotForSlot("us", "2026-07-20", "17:00"), false);
});

test("슬롯 게이트 — 두 슬롯이 모두 끝나면 재발화하지 않는다", async () => {
  const store = await freshStore();
  write("us", "close", { date: "2026-07-20", slot: "08:00", updatedAt: "2026-07-20T08:06:00Z" });
  write("us", "preview", { date: "2026-07-20", slot: "17:00", updatedAt: "2026-07-20T17:06:00Z" });
  assert.equal(store.hasSnapshotForSlot("us", "2026-07-20", "08:00"), true);
  assert.equal(store.hasSnapshotForSlot("us", "2026-07-20", "17:00"), true);
});

test("슬롯 게이트 — slot 필드 없는 구 스냅샷은 오늘자면 모든 슬롯을 커버한다(배포일 하위호환)", async () => {
  const store = await freshStore();
  write("us", "both", { date: "2026-07-20", updatedAt: "2026-07-20T08:06:00Z" });
  assert.equal(store.hasSnapshotForSlot("us", "2026-07-20", "08:00"), true);
  assert.equal(store.hasSnapshotForSlot("us", "2026-07-20", "17:00"), true);
  // 어제 것이면 커버하지 않는다.
  assert.equal(store.hasSnapshotForSlot("us", "2026-07-21", "08:00"), false);
});

test("슬롯 게이트 — 커버하는 스냅샷을 그대로 돌려준다(신선도 비교가 이 값을 쓴다)", async () => {
  const store = await freshStore();
  write("us", "preview", { date: "2026-07-20", slot: "17:00", updatedAt: "2026-07-20T17:06:00Z", notes: "프리뷰" });
  const hit = store.snapshotForSlot("us", "2026-07-20", "17:00");
  assert.equal(hit?.notes, "프리뷰");
  // 신선도 비교가 '세 파일 중 가장 최신'이 아니라 '이 슬롯을 커버하는 것' 기준이어야 한다.
  assert.equal(store.snapshotForSlot("us", "2026-07-20", "08:00"), null);
});

test("슬롯 게이트 — 휴장일 both 파일은 한 슬롯만 담는다(원장이 필요한 이유)", async () => {
  const store = await freshStore();
  // 휴장 스냅샷은 항상 both 경로 한 곳에 저장된다. 슬롯이 2개면 뒤 런이 앞 런의 slot 을 덮어쓴다.
  write("us", "both", { date: "2026-07-25", slot: "17:00", updatedAt: "2026-07-25T17:00:10Z" });
  assert.equal(store.hasSnapshotForSlot("us", "2026-07-25", "17:00"), true);
  // ⚠️ 이 false 가 구조적으로 불가피하다는 것이 요점이다. 그래서 catch-up 1차 게이트는
  // 스냅샷 부재만으로 발화하면 안 되고 원장(slotHandled)을 반드시 함께 본다
  // — scheduler.checkStockCatchup / notify-ledger.slotHandled 참고.
  assert.equal(store.hasSnapshotForSlot("us", "2026-07-25", "08:00"), false);
});
