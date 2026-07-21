import test from "node:test";
import assert from "node:assert/strict";
import { isSeoulPopup, splitPopupsByRegion } from "./events.ts";

test("isSeoulPopup: 광역 접두어로 판별한다", () => {
  assert.equal(isSeoulPopup("서울 성수"), true);
  assert.equal(isSeoulPopup("서울특별시 마포구"), true);
  assert.equal(isSeoulPopup("경기 수원(스타필드 수원)"), false);
  assert.equal(isSeoulPopup("경기 화성"), false);
  assert.equal(isSeoulPopup("인천 송도"), false);
});

test("isSeoulPopup: 구 단독 값은 키워드 폴백으로 서울 처리", () => {
  assert.equal(isSeoulPopup("성수"), true);
  assert.equal(isSeoulPopup("여의도"), true);
  assert.equal(isSeoulPopup("수원"), false);
  assert.equal(isSeoulPopup(""), false);
});

test("isSeoulPopup: 경기 접두어는 서울 구 이름을 포함해도 서울 외", () => {
  // "경기 강남대로" 같은 값이 키워드 폴백에 걸려 서울로 새지 않아야 한다.
  assert.equal(isSeoulPopup("경기 성남 강남"), false);
});

test("splitPopupsByRegion: 두 그룹으로 가르고 각 그룹 안에서 순서를 유지한다", () => {
  const items = [
    { region: "서울 성수" },
    { region: "경기 수원" },
    { region: "서울 강남" },
    { region: "경기 화성" },
  ];
  const { seoul, outer } = splitPopupsByRegion(items);
  assert.deepEqual(seoul.map((p) => p.region), ["서울 성수", "서울 강남"]);
  assert.deepEqual(outer.map((p) => p.region), ["경기 수원", "경기 화성"]);
});
