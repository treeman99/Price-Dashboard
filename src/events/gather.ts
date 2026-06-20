import { naverSearch, type NaverSearchItem } from "./naver-search.ts";
import { log } from "../util/log.ts";

export const MANDATORY_VENUES = ["코엑스", "세텍", "킨텍스", "수원컨벤션센터", "수원메쎄"] as const;

export interface RawGroup {
  label: string;
  items: NaverSearchItem[];
}
export interface VenueRaw {
  venue: string;
  groups: RawGroup[];
}
export interface RawCorpus {
  month: string; // "2026년 6월"
  popupGroups: RawGroup[];
  venues: VenueRaw[];
  generalGroups: RawGroup[];
}

function monthLabel(): string {
  const d = new Date();
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function group(label: string, query: string, endpoint: "webkr" | "blog"): Promise<RawGroup> {
  try {
    const items = await naverSearch(query, endpoint, 15);
    return { label, items };
  } catch (e) {
    log.warn(`이벤트 검색 실패 [${label}]: ${(e as Error).message}`);
    return { label, items: [] };
  }
}

/** 네이버 QPS 제한 회피: 순차 실행 + 소폭 지연 */
async function runSeq(tasks: (() => Promise<RawGroup>)[]): Promise<RawGroup[]> {
  const out: RawGroup[] = [];
  for (const t of tasks) {
    out.push(await t());
    await sleep(120);
  }
  return out;
}

/** 팝업/전시 원본 검색 코퍼스 수집 (네이버 검색 API). */
export async function gatherCorpus(): Promise<RawCorpus> {
  const month = monthLabel();
  log.info(`이벤트 수집 시작 — 기준 ${month}`);

  // 팝업: 서울/경기 지역 + 카테고리 (webkr+blog 혼합)
  const popupGroups = await runSeq([
    () => group("팝업 일반(웹)", `팝업스토어 ${month}`, "webkr"),
    () => group("서울 팝업", `서울 팝업스토어 추천 ${month}`, "blog"),
    () => group("성수 팝업", `성수 팝업스토어 ${month}`, "blog"),
    // 경기 지역
    () => group("경기 팝업", `경기 팝업스토어 ${month}`, "blog"),
    () => group("판교/분당 팝업", `판교 분당 팝업스토어 ${month}`, "blog"),
    () => group("수원 팝업", `수원 팝업스토어 ${month}`, "blog"),
    () => group("스타필드 팝업", `스타필드 팝업스토어 ${month}`, "blog"),
    // 카테고리
    () => group("캐릭터 팝업", `캐릭터 팝업스토어 ${month}`, "blog"),
    () => group("패션 팝업", `패션 팝업스토어 ${month}`, "blog"),
    () => group("뷰티 팝업", `뷰티 팝업스토어 ${month}`, "blog"),
    () => group("F&B 팝업", `F&B 팝업스토어 ${month}`, "blog"),
  ]);

  // 전시: 필수 4개 전시장별 (webkr+blog)
  const venues: VenueRaw[] = [];
  for (const venue of MANDATORY_VENUES) {
    const groups = await runSeq([
      () => group(`${venue}(웹)`, `${venue} 전시회 일정 ${month}`, "webkr"),
      () => group(`${venue}(블로그)`, `${venue} 박람회 ${month}`, "blog"),
    ]);
    venues.push({ venue, groups });
  }

  // 일반 전시(서울/경기)
  const generalGroups = await runSeq([
    () => group("서울 전시", `서울 전시회 추천 ${month}`, "webkr"),
    () => group("경기 전시", `경기 전시회 추천 ${month}`, "webkr"),
  ]);

  const total =
    popupGroups.reduce((a, g) => a + g.items.length, 0) +
    venues.reduce((a, v) => a + v.groups.reduce((b, g) => b + g.items.length, 0), 0) +
    generalGroups.reduce((a, g) => a + g.items.length, 0);
  log.info(`이벤트 원본 수집 완료 — 총 ${total}건`);

  return { month, popupGroups, venues, generalGroups };
}
