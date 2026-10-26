// 팝업 지역 분류(대시보드 화면 + 이메일 공용).
// 화면과 메일이 같은 기준으로 서울/서울 외를 갈라야 하므로 판별식을 여기 한 곳에 둔다.

import type { EventsSnapshot, PopupItem } from "./types.ts";

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

/**
 * 출처(보기) 링크가 없는 항목을 걷어낸 스냅샷. 확인할 수 없는 항목은 보여주지 않는다.
 * 링크 '존재' 여부만 본다 — 스킴 안전성은 렌더 단계(safeHref)가 따로 거른다.
 * 전시장 그룹은 항목이 0건이 되어도 남긴다(화면이 '이번 주 확인된 행사가 없습니다'를 표시).
 */
export function withLinkedItemsOnly(s: EventsSnapshot): EventsSnapshot {
  return {
    ...s,
    popups: s.popups.filter((p) => p.link),
    exhibitions: {
      ...s.exhibitions,
      venues: s.exhibitions.venues.map((v) => ({ ...v, items: v.items.filter((e) => e.link) })),
    },
    festivals: (s.festivals ?? []).filter((f) => f.link),
  };
}

/** 하위 그룹 표시용 라벨/색 — 화면과 메일이 같은 문구·색을 쓰도록 공유한다. */
export const POPUP_GROUPS = {
  seoul: { label: "서울", sub: "", accent: "#7C3AED" },
  outer: { label: "수원 · 화성 등", sub: "(경기 등 서울 외)", accent: "#059669" },
} as const;

// ── 행사 식별키 (서버 '신규' 판정 + 화면 '지난번 본 뒤 신규' 표시 공용) ──────────────
// 같은 행사를 같은 행사로 알아보는 기준이 둘로 갈리면, 서버가 '이미 본 행사'라 한 것을 화면이
// 새 행사로 띄우는 식으로 어긋난다. 그래서 정규화 규칙을 여기 한 곳에 둔다.

/** 제목 정규화: 공백/괄호/특수문자 제거 후 비교용 키 */
export function titleKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\[\]()·,~!?.“”"'`\-_/]/g, "")
    .replace(/(전시회|전시|展|팝업스토어|팝업|박람회|페어|expo|fair)/g, "");
}

/**
 * 행사명 정규화 키: titleKey(공백/기호/행사어 제거) 위에 **연도 토큰(19xx/20xx) 제거**.
 * LLM이 같은 행사를 어제는 '서울국제도서전', 오늘은 '2026 서울국제도서전'으로 적어도
 * 같은 key가 되도록 하여 연도 표기 흔들림에 의한 '신규' 오탐을 줄인다.
 */
function nameKey(s: string): string {
  return titleKey(s).replace(/(?:19|20)\d{2}/g, "");
}

/** 행사 식별키: 종류 접두어 + 정규화 제목(+전시는 전시장). */
export function popupKey(name: string): string {
  return `p:${nameKey(name)}`;
}
export function exhibitionKey(venue: string, title: string): string {
  return `e:${nameKey(venue)}:${nameKey(title)}`;
}
export function festivalKey(name: string): string {
  return `f:${nameKey(name)}`;
}
