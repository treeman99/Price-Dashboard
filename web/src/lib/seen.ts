import { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * '지난번 본 뒤 새로 들어온 항목' 표시를 위한 읽음 기록.
 *
 * 탭마다 '본 항목 id' 목록을 이 브라우저의 localStorage 에 둔다. 사용자는 한 명이고 맥도 한 대라
 * 서버에 둘 이유가 없다(다른 브라우저에서 열면 따로 센다 — 브리프에서 수용한 한계).
 *
 * 규칙(1면 브리프 §5):
 *  - 탭을 열고 **화면이 보이는 채로 SEEN_DWELL_MS 머물러야** 그 탭의 지금 목록을 '본 것'으로 친다.
 *    실수로 스친 탭은 표시가 남는다.
 *  - '신규' 표시는 읽음 처리된 뒤에도 그 탭을 **다음에 다시 열 때까지** 남긴다. 방금 무엇이
 *    새것이었는지 보고 있는 도중에 표시가 사라지면 안 되기 때문이다.
 *  - 기록이 아예 없는 탭(첫 실행)은 지금 목록을 조용히 '본 것'으로 기준만 잡는다. 첫날 모든
 *    항목이 '신규'로 뒤덮이면 표시가 의미를 잃는다.
 *  - 1면은 미리 보기라 읽음 처리하지 않는다(첫 실행 기준 잡기만 예외).
 */

export type SeenTabId = "news" | "youtube" | "events";

/** 이 시간 동안 화면이 보이는 채로 탭에 머물면 읽음 처리한다. */
export const SEEN_DWELL_MS = 3000;

const STORAGE_KEY = "dd.seen.v1";
/**
 * 탭당 보관 상한. 뉴스가 많은 날 하루 2회 × 76건 수준이라, 며칠 치를 기억하면서도 저장소가
 * 끝없이 자라지 않을 만큼만 둔다. 상한을 넘겨 잊힌 옛 항목이 다시 수집되면 '신규'로 뜰 수 있다.
 */
const PER_TAB_CAP = 800;

type Store = Partial<Record<SeenTabId, string[]>>;

// 저장소 접근은 사생활 보호 모드·차단 설정에서 예외를 던질 수 있다. 그때는 '기록 없음'으로
// 동작한다 — 기준 잡기가 매번 다시 일어나므로 '신규'가 뜨지 않을 뿐 화면은 정상이다.
function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* 저장 실패는 다음 방문에 같은 항목이 다시 '신규'로 보일 뿐이다 */
  }
}

/** 그 탭에서 본 항목 id. 기록이 아예 없으면 null(첫 실행). */
export function readSeen(tab: SeenTabId): ReadonlySet<string> | null {
  const ids = readStore()[tab];
  return Array.isArray(ids) ? new Set(ids) : null;
}

/** 지금 목록을 '본 것'으로 기록한다. 최근 것이 앞에 오도록 쌓고 상한을 넘는 옛 id 는 버린다. */
export function markSeen(tab: SeenTabId, ids: readonly string[]): void {
  const store = readStore();
  const current = new Set(ids);
  const prev = (store[tab] ?? []).filter((id) => !current.has(id));
  store[tab] = [...current, ...prev].slice(0, PER_TAB_CAP);
  writeStore(store);
}

/** 기록이 없는 탭이면 지금 목록으로 기준을 잡고 true. 이미 기록이 있으면 아무것도 하지 않는다. */
export function ensureBaseline(tab: SeenTabId, ids: readonly string[]): boolean {
  if (readSeen(tab) !== null) return false;
  markSeen(tab, ids);
  return true;
}

/** 목록 중 아직 안 본 id(순서 유지). 기록이 없으면 빈 배열 — 첫 실행은 '신규'가 없다. */
export function unseenIds(tab: SeenTabId, ids: readonly string[]): string[] {
  const seen = readSeen(tab);
  return seen ? ids.filter((id) => !seen.has(id)) : [];
}

/**
 * 게시판용 훅. 지금 보이는 목록(ids)을 받아 '이번 방문의 신규' 판정 함수를 돌려준다.
 *
 * ids 가 null 이면 아직 불러오는 중이라 아무것도 하지 않는다. 게시판은 활성 탭일 때만 마운트되므로
 * '마운트돼 있다 = 그 탭을 보고 있다'로 본다.
 */
export function useNewMarks(tab: SeenTabId, ids: readonly string[] | null): (id: string) => boolean {
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  // 목록 내용이 같으면 다시 불러와도(폴링·저장 후 재조회) 같은 키라 효과가 다시 돌지 않는다.
  const listKey = ids ? ids.join("\n") : null;

  // 1) 목록이 바뀔 때마다 아직 안 본 것을 이번 방문의 '신규'에 더한다(빼지는 않는다).
  useEffect(() => {
    if (!ids) return;
    if (ensureBaseline(tab, ids)) return;
    const unseen = unseenIds(tab, ids);
    if (unseen.length) setFresh((prev) => new Set([...prev, ...unseen]));
    // 의존성에 ids 대신 listKey 를 둔다 — 배열은 매 렌더 새로 만들어지므로 내용으로 비교한다
  }, [tab, listKey]);

  // 2) 화면이 보이는 채로 머물면 지금 목록을 '본 것'으로 기록한다. 창을 가리거나 다른 앱으로
  //    가면(visibilityState=hidden) 시계를 멈추고, 돌아오면 처음부터 다시 잰다.
  useEffect(() => {
    if (!ids) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const arm = () => {
      stop();
      if (document.visibilityState === "visible") timer = setTimeout(() => markSeen(tab, ids), SEEN_DWELL_MS);
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", arm);
    };
    // 의존성에 ids 대신 listKey 를 둔다 — 배열은 매 렌더 새로 만들어지므로 내용으로 비교한다
  }, [tab, listKey]);

  return useCallback((id: string) => fresh.has(id), [fresh]);
}

/** 게시판 안 깊은 곳의 행이 '신규' 여부를 물어보는 통로. 게시판이 useNewMarks 결과를 넣어 준다. */
const NewMarksContext = createContext<(id: string) => boolean>(() => false);
export const NewMarksProvider = NewMarksContext.Provider;

export function useIsNew(id: string | null | undefined): boolean {
  const isNew = useContext(NewMarksContext);
  return id != null && isNew(id);
}
