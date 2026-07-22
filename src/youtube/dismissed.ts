import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import type { DismissedVideo, YoutubeSnapshot, YoutubeVideo } from "../../shared/types.ts";

/**
 * '영상 제외' 원장 — 사용자가 카드의 [제외] 버튼으로 걷어낸 영상을 videoId 기준으로 기록한다.
 * 채널 차단(blocklist.ts)이 "이 채널은 통째로 싫다"라면, 이쪽은 "채널은 괜찮은데 이 영상은 아니다"를 표현한다.
 * 본영상(watched.ts)과 달리 **만료가 없다** — 취향 신호는 시간이 지나도 유효하므로 영구 보존하고,
 * 되돌리기는 관리 다이얼로그의 [해제](removeDismiss)로만 한다.
 * 원장 구조(memo 캐시 / 저장 실패 경고 / 로드 실패 시 빈 배열 폴백)는 watched.ts 를 그대로 따른다.
 */

const DISMISSED_PATH = path.join(path.dirname(config.dbPath), "youtube-dismissed.json");

/** 수집 프롬프트에 주입할 기본 상한 — 너무 많이 넣으면 프롬프트가 폭주하므로 방어적으로 자른다. */
const DEFAULT_HINT_LIMIT = 40;

let memo: DismissedVideo[] | null = null;

function save(list: DismissedVideo[]): void {
  try {
    fs.mkdirSync(path.dirname(DISMISSED_PATH), { recursive: true });
    fs.writeFileSync(DISMISSED_PATH, JSON.stringify(list, null, 2));
  } catch (e) {
    log.warn(`유튜브 제외 영상 목록 저장 실패: ${(e as Error).message}`);
  }
}

/** 제외 영상 목록(없으면 빈 배열). */
export function loadDismissed(): DismissedVideo[] {
  if (memo) return memo;
  try {
    if (fs.existsSync(DISMISSED_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(DISMISSED_PATH, "utf8"));
      if (Array.isArray(parsed)) {
        memo = parsed as DismissedVideo[];
        return memo;
      }
    }
  } catch (e) {
    log.warn(`유튜브 제외 영상 목록 로드 실패 → 빈 목록 사용: ${(e as Error).message}`);
  }
  memo = [];
  return memo;
}

/** 순수 판정: videoId 가 제외 목록에 있는지. (만료 개념이 없어 시각 인자가 필요 없다 — 테스트 용이성) */
export function isDismissed(list: DismissedVideo[], videoId: string | null | undefined): boolean {
  if (!videoId) return false;
  return list.some((d) => d.videoId === videoId);
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export interface AddDismissInput {
  videoId: string;
  title?: string | null;
  channel?: string | null;
  url?: string | null;
  categoryKey?: string | null;
  reason?: string | null;
}

/**
 * 영상 제외(원클릭). 멱등 — 같은 videoId 를 다시 제외하면 기존 항목을 반환하되,
 * 비어 있던 필드에 새 정보가 들어오면 보강한다(카드마다 아는 정보가 다를 수 있으므로).
 * dismissedAt 은 최초값을 유지한다 — 영구 제외라 갱신해도 의미가 없고, 힌트 정렬만 흔들린다.
 */
export function addDismiss(input: AddDismissInput): DismissedVideo {
  const videoId = (input.videoId || "").trim();
  if (!VIDEO_ID_RE.test(videoId)) {
    throw new Error("유효한 videoId(11자)가 필요합니다.");
  }
  const list = loadDismissed();
  // 길이는 watched.ts 와 같은 기준으로 방어적으로 자른다(프롬프트/파일 비대 방지).
  const title = (input.title ?? "").toString().slice(0, 200);
  const channel = (input.channel ?? "").toString().slice(0, 80);
  const url = input.url?.toString().trim() || null;
  const categoryKey = input.categoryKey?.toString().trim() || null;
  const reason = input.reason?.toString().trim().slice(0, 200) || null;

  const existing = list.find((d) => d.videoId === videoId);
  if (existing) {
    if (title) existing.title = title;
    if (channel) existing.channel = channel;
    if (url) existing.url = url;
    if (categoryKey) existing.categoryKey = categoryKey;
    if (reason) existing.reason = reason;
    save(list);
    memo = list;
    return existing;
  }

  const entry: DismissedVideo = {
    videoId,
    title,
    channel,
    url,
    categoryKey,
    reason,
    dismissedAt: new Date().toISOString(),
  };
  list.push(entry);
  save(list);
  memo = list;
  log.info(`유튜브 영상 제외: "${title || videoId}" [${videoId}]${categoryKey ? ` (${categoryKey})` : ""}`);
  return entry;
}

/**
 * 사유 붙이기/지우기(관리 다이얼로그 전용). 빈 문자열/null 이면 사유를 지운다.
 * 대상이 없으면 null 반환 — 호출부(API)가 404 로 구분할 수 있게 한다.
 */
export function setDismissReason(videoId: string, reason: string | null): DismissedVideo | null {
  const list = loadDismissed();
  const entry = list.find((d) => d.videoId === videoId);
  if (!entry) return null;
  const next = reason?.toString().trim().slice(0, 200) || null;
  entry.reason = next;
  save(list);
  memo = list;
  log.info(`유튜브 제외 사유 ${next ? "설정" : "삭제"}: "${entry.title || videoId}" [${videoId}]`);
  return entry;
}

/** 제외 해제(되돌리기). 제거되면 true. */
export function removeDismiss(videoId: string): boolean {
  const list = loadDismissed();
  const idx = list.findIndex((d) => d.videoId === videoId);
  if (idx < 0) return false;
  const [removed] = list.splice(idx, 1);
  save(list);
  memo = list;
  log.info(`유튜브 영상 제외 해제: "${removed.title || videoId}" [${videoId}]`);
  return true;
}

/** 현재 제외 판정기(원장을 한 번만 읽어 재사용). */
export function buildDismissMatcher(): (videoId: string | null | undefined) => boolean {
  const list = loadDismissed();
  return (videoId) => isDismissed(list, videoId);
}

/**
 * 순수 필터: 판정기에 걸린 영상을 items 에서 제거한 스냅샷 사본. (테스트 용이성)
 * 본영상(annotateWatched)은 플래그만 달아 카드를 남기지만, 제외는 사용자가 "안 보겠다"고 한 것이므로 제거한다.
 */
export function rejectDismissed(
  snapshot: YoutubeSnapshot | null,
  matcher: (videoId: string | null | undefined) => boolean
): YoutubeSnapshot | null {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    categories: snapshot.categories.map((c) => ({
      ...c,
      items: c.items.filter((v: YoutubeVideo) => !matcher(v.videoId)),
    })),
  };
}

/** 제외 영상을 제거한 스냅샷 사본을 반환(읽기 시점 하드 필터 — applyBlocklist 와 같은 형태). */
export function applyDismissed(snapshot: YoutubeSnapshot | null): YoutubeSnapshot | null {
  return rejectDismissed(snapshot, buildDismissMatcher());
}

/** ISO 파싱 실패(손상된 원장 등)를 0으로 떨어뜨려 정렬이 NaN 으로 무너지지 않게 한다. */
function ts(iso: string | null | undefined): number {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 순수 선별: 프롬프트에 넣을 힌트를 고른다. (테스트 용이성)
 * 정렬 기준은 ①사유 있는 항목 우선 ②그 안에서 최근 제외 우선.
 * 사유를 앞세우는 이유 — "왜 싫은지"가 적힌 항목이 큐레이터에게 훨씬 강한 학습 신호라서,
 * 상한에 걸려 잘려나가더라도 그것만은 살아남아야 한다.
 */
export function pickDismissHints(list: DismissedVideo[], limit: number): DismissedVideo[] {
  if (limit <= 0) return [];
  return [...list]
    .sort((a, b) => {
      const ar = a.reason ? 1 : 0;
      const br = b.reason ? 1 : 0;
      if (ar !== br) return br - ar;
      return ts(b.dismissedAt) - ts(a.dismissedAt);
    })
    .slice(0, limit);
}

/** 수집 프롬프트 주입용: 부정 예시로 쓸 제외 영상 목록(사유 우선 + 최근 우선, 기본 40건). */
export function dismissedHints(limit: number = DEFAULT_HINT_LIMIT): DismissedVideo[] {
  return pickDismissHints(loadDismissed(), limit);
}
