// 팝업 지역 분류(대시보드 화면 + 이메일 공용).
// 화면과 메일이 같은 기준으로 서울/서울 외를 갈라야 하므로 판별식을 여기 한 곳에 둔다.

import type { PopupItem } from "./types.ts";

// region 문자열은 "서울 성수", "경기 수원(스타필드 수원)"처럼 광역 접두어로 오거나,
// 네이버 폴백 경로에선 "성수"/"수원" 같은 구·시 단독 값으로 온다. 두 형태 모두 처리한다.
const SEOUL_DISTRICTS = [
  "성수", "홍대", "여의도", "강남", "잠실", "명동", "한남", "이태원",
  "연남", "압구정", "삼성동", "성동", "송파", "마포", "용산", "종로",
  "을지로", "서초", "광진", "영등포", "성북", "노원", "건대",
];

/** region이 서울 권역이면 true. 경기/인천 접두어는 명시적으로 '서울 외'로 분류한다. */
export function isSeoulPopup(region: string): boolean {
  const r = (region || "").trim();
  if (r.startsWith("서울")) return true;
  if (r.startsWith("경기") || r.startsWith("인천")) return false;
  return SEOUL_DISTRICTS.some((d) => r.includes(d));
}

/** 팝업을 서울 / 서울 외(수원·화성 등) 두 그룹으로 가른다. 입력 순서는 각 그룹 안에서 유지. */
export function splitPopupsByRegion<T extends Pick<PopupItem, "region">>(
  popups: T[]
): { seoul: T[]; outer: T[] } {
  return {
    seoul: popups.filter((p) => isSeoulPopup(p.region)),
    outer: popups.filter((p) => !isSeoulPopup(p.region)),
  };
}

/** 하위 그룹 표시용 라벨/색 — 화면과 메일이 같은 문구·색을 쓰도록 공유한다. */
export const POPUP_GROUPS = {
  seoul: { label: "서울", sub: "", accent: "#7C3AED" },
  outer: { label: "수원 · 화성 등", sub: "(경기 등 서울 외)", accent: "#059669" },
} as const;
