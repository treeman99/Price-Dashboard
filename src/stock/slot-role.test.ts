import { test } from "node:test";
import assert from "node:assert/strict";
import { stockSlotRole, isRoleSplitActive, describeSlotRoles } from "./slot-role.ts";
import { MANUAL_SLOT } from "./notify-ledger.ts";

// 실제 저장값(data/schedule.json)과 같은 구성. 배열 순서가 시각순이 아닌 것도 그대로 재현한다.
const SPLIT: string[] = ["17:00", "08:00"];

// ── 밴드 경계 (서머타임 안전대) ────────────────────────────────
//
// 이 경계값들이 이 설계의 핵심 가드다. EDT/EST 두 체제가 동시에 성립하는 구간만 역할을
// 확정하고, 그 밖은 'both'(현행 혼합)로 떨어뜨린다. 상수를 건드리면 여기서 걸린다.

test("밴드 경계 — 결산 밴드는 06:00 이상 13:00 미만", () => {
  const at = (t: string) => stockSlotRole("us", t, [...SPLIT, t]);
  assert.equal(at("05:59"), "both", "05:59 는 안전대 밖(EST 기준 16:00 ET 마감 전)");
  assert.equal(at("06:00"), "close");
  assert.equal(at("08:00"), "close");
  assert.equal(at("12:59"), "close");
  // 13:00 정각을 배제하는 이유: EDT 에서 KST 13:00 = 당일 00:00 ET 라 뉴욕 날짜가
  // KST 날짜와 같아진다(전일이 아니다). EST 에서만 전일이라 계절마다 뒤집힌다.
  assert.equal(at("13:00"), "both");
  assert.equal(at("13:59"), "both");
});

test("밴드 경계 — 프리뷰 밴드는 14:00 이상 22:30 미만", () => {
  const at = (t: string) => stockSlotRole("us", t, [...SPLIT, t]);
  assert.equal(at("14:00"), "preview");
  assert.equal(at("17:00"), "preview");
  assert.equal(at("22:29"), "preview");
  // 22:30 이상을 배제하는 이유: EDT 에서 KST 22:30 = 09:30 ET = **개장 시각**이다.
  // 그 이후 슬롯을 '개장 프리뷰'로 판정하면 이미 열린 세션을 개장 전인 양 브리핑한다.
  assert.equal(at("22:30"), "both");
  assert.equal(at("23:00"), "both");
  assert.equal(at("23:59"), "both");
});

test("밴드 밖 — 자정~새벽 슬롯은 역할을 확정할 수 없어 both 로 폴백", () => {
  const at = (t: string) => stockSlotRole("us", t, [...SPLIT, t]);
  assert.equal(at("00:00"), "both");
  assert.equal(at("03:30"), "both");
});

// ── 2단계 분리 활성 게이트 (하위호환의 급소) ──────────────────

test("분리 활성 — 결산 밴드와 프리뷰 밴드 슬롯이 둘 다 있어야 한다", () => {
  assert.equal(isRoleSplitActive("us", SPLIT), true);
  assert.equal(isRoleSplitActive("us", ["08:00", "17:00"]), true);
});

test("슬롯 1개(현행 기본값 18:00)면 분리가 꺼지고 현행 혼합 브리핑이 유지된다", () => {
  assert.equal(isRoleSplitActive("us", ["18:00"]), false);
  assert.equal(stockSlotRole("us", "18:00", ["18:00"]), "both");
  assert.equal(stockSlotRole("us", "08:00", ["08:00"]), "both");
});

test("같은 밴드 슬롯 2개면 both — 반대 역할 내용이 소실되는 것을 막는다", () => {
  // ["08:00","10:00"] 은 둘 다 결산 밴드다. 그대로 분리하면 결산이 2회 나가고
  // '오늘 밤 프리뷰' 내용이 영구 소실된다 — 지금은 혼합 브리핑으로 받고 있으므로 회귀다.
  assert.equal(isRoleSplitActive("us", ["08:00", "10:00"]), false);
  assert.equal(stockSlotRole("us", "08:00", ["08:00", "10:00"]), "both");
  assert.equal(stockSlotRole("us", "10:00", ["08:00", "10:00"]), "both");
  // 프리뷰 밴드끼리도 마찬가지.
  assert.equal(isRoleSplitActive("us", ["17:00", "20:00"]), false);
});

test("안전대 밖 슬롯만 있으면 분리가 활성되지 않는다", () => {
  assert.equal(isRoleSplitActive("us", ["13:30", "23:00"]), false);
  assert.equal(stockSlotRole("us", "13:30", ["13:30", "23:00"]), "both");
});

// ── 시장 축 (kr 은 구조적으로 잠근다) ─────────────────────────

test("한국장은 슬롯이 무엇이든 항상 both — 밴드는 뉴욕 기준이라 kr 에 적용하면 안 된다", () => {
  assert.equal(stockSlotRole("kr", "08:00", ["08:00"]), "both");
  // ⚠️ 회귀 방지의 핵심: 사용자가 kr 슬롯을 프리뷰 밴드에 추가해도 kr 은 both 를 유지해야 한다.
  // '기본 슬롯이 08:00 하나뿐이라 우연히 both 가 된다'에 기대면 여기서 조용히 깨진다.
  assert.equal(stockSlotRole("kr", "15:00", ["08:00", "15:00"]), "both");
  assert.equal(stockSlotRole("kr", "08:00", ["08:00", "15:00"]), "both");
  assert.equal(isRoleSplitActive("kr", ["08:00", "17:00"]), false);
});

// ── MANUAL_SLOT ──────────────────────────────────────────────

test("수동 갱신(MANUAL_SLOT)은 예외 없이 both 로 떨어진다", () => {
  // parseCollectTime("manual") 은 throw 한다. 무처리면 수동 갱신이 통째로 깨진다.
  assert.doesNotThrow(() => stockSlotRole("us", MANUAL_SLOT, SPLIT));
  assert.equal(stockSlotRole("us", MANUAL_SLOT, SPLIT), "both");
});

test("형식이 깨진 슬롯 문자열도 throw 하지 않고 both 로 폴백한다", () => {
  assert.equal(stockSlotRole("us", "잘못된값", SPLIT), "both");
  assert.equal(stockSlotRole("us", "25:99", SPLIT), "both");
});

// ── 기동 로그 (분리가 조용히 꺼지는 것을 가시화하는 유일한 수단) ──

test("describeSlotRoles — 활성/비활성과 그 이유를 문장으로 남긴다", () => {
  const on = describeSlotRoles("us", SPLIT);
  assert.match(on, /활성/);
  assert.match(on, /08:00=마감결산/);
  assert.match(on, /17:00=개장프리뷰/);

  const off = describeSlotRoles("us", ["08:00"]);
  assert.match(off, /비활성/);
  assert.match(off, /프리뷰 밴드/);

  const offClose = describeSlotRoles("us", ["17:00"]);
  assert.match(offClose, /비활성/);
  assert.match(offClose, /결산 밴드/);
});
