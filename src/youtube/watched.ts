import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import type { WatchedVideo, YoutubeSnapshot, YoutubeVideo } from "../../shared/types.ts";

/**
 * '본영상' 원장 — 사용자가 카드에서 본영상으로 체크한 영상을 videoId 기준으로 기록한다.
 * 체크된 영상은 watchedAt 으로부터 youtubeWatchedExcludeDays 동안 수집(검색)에서 제외되고,
 * 그 기간이 지나면 만료되어(원장에서 정리) 다시 검색에 노출될 수 있다.
 * 차단목록(blocklist.ts)과 동일한 파일 원장 + 읽기시점 주석/하드 후필터 패턴을 따른다.
 */

const WATCHED_PATH = path.join(path.dirname(config.dbPath), "youtube-watched.json");
const DAY_MS = 86400000;

let memo: WatchedVideo[] | null = null;

function save(list: WatchedVideo[]): void {
  try {
    fs.mkdirSync(path.dirname(WATCHED_PATH), { recursive: true });
    fs.writeFileSync(WATCHED_PATH, JSON.stringify(list, null, 2));
  } catch (e) {
    log.warn(`유튜브 본영상 목록 저장 실패: ${(e as Error).message}`);
  }
}

/** 본영상 목록(없으면 빈 배열). */
export function loadWatched(): WatchedVideo[] {
  if (memo) return memo;
  try {
    if (fs.existsSync(WATCHED_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(WATCHED_PATH, "utf8"));
      if (Array.isArray(parsed)) {
        memo = parsed as WatchedVideo[];
        return memo;
      }
    }
  } catch (e) {
    log.warn(`유튜브 본영상 목록 로드 실패 → 빈 목록 사용: ${(e as Error).message}`);
  }
  memo = [];
  return memo;
}

/** 순수 판정: videoId 가 now 기준 제외 활성(watchedAt 이 excludeDays 이내)인지. (테스트 용이성) */
export function isWatchedActive(
  list: WatchedVideo[],
  videoId: string | null | undefined,
  now: number,
  excludeDays: number
): boolean {
  if (!videoId) return false;
  const cutoff = now - excludeDays * DAY_MS;
  return list.some((w) => w.videoId === videoId && Date.parse(w.watchedAt) >= cutoff);
}

/** 만료(excludeDays 초과) 항목을 제거한 사본. */
export function pruneWatched(list: WatchedVideo[], now: number, excludeDays: number): WatchedVideo[] {
  const cutoff = now - excludeDays * DAY_MS;
  return list.filter((w) => Date.parse(w.watchedAt) >= cutoff);
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export interface MarkWatchedInput {
  videoId: string;
  title?: string | null;
  channel?: string | null;
}

/** '본영상' 체크(추가/갱신). 같은 videoId 재체크 시 watchedAt 을 갱신해 제외 기간을 연장한다. 멱등. */
export function markWatched(input: MarkWatchedInput): WatchedVideo {
  const videoId = (input.videoId || "").trim();
  if (!VIDEO_ID_RE.test(videoId)) {
    throw new Error("유효한 videoId(11자)가 필요합니다.");
  }
  const list = loadWatched();
  const now = new Date().toISOString();
  const title = (input.title ?? "").toString().slice(0, 200);
  const channel = (input.channel ?? "").toString().slice(0, 80);
  const existing = list.find((w) => w.videoId === videoId);
  if (existing) {
    existing.watchedAt = now;
    if (title) existing.title = title;
    if (channel) existing.channel = channel;
    save(list);
    memo = list;
    return existing;
  }
  const entry: WatchedVideo = { videoId, title, channel, watchedAt: now };
  list.push(entry);
  save(list);
  memo = list;
  log.info(`유튜브 본영상 체크: "${title || videoId}" [${videoId}]`);
  return entry;
}

/** '본영상' 해제(체크 취소). 제거되면 true. */
export function unmarkWatched(videoId: string): boolean {
  const list = loadWatched();
  const idx = list.findIndex((w) => w.videoId === videoId);
  if (idx < 0) return false;
  const [removed] = list.splice(idx, 1);
  save(list);
  memo = list;
  log.info(`유튜브 본영상 해제: "${removed.title || videoId}" [${videoId}]`);
  return true;
}

/**
 * 현재 활성 제외 판정기. 만료 항목은 정리(원장 축소, 변화 있을 때만 저장) 후,
 * videoId 가 제외 활성인지 돌려주는 함수를 반환한다.
 */
export function buildWatchedMatcher(): (videoId: string | null | undefined) => boolean {
  const list = loadWatched();
  const now = Date.now();
  const days = config.youtubeWatchedExcludeDays;
  const pruned = pruneWatched(list, now, days);
  if (pruned.length !== list.length) {
    save(pruned);
    memo = pruned;
  }
  return (videoId) => isWatchedActive(pruned, videoId, now, days);
}

/** 수집 프롬프트 힌트/디버그용: 현재 제외 활성인 본영상 목록(만료 제외). */
export function activeWatched(): WatchedVideo[] {
  return pruneWatched(loadWatched(), Date.now(), config.youtubeWatchedExcludeDays);
}

/**
 * 읽기 시점 주석: 스냅샷 각 영상에 watched 플래그를 채운다(제거하지 않음).
 * 카드가 그대로 남아 '본영상' 상태를 표시하고 사용자가 토글/해제할 수 있게 한다.
 * (수집 제외는 curate 후필터가 담당 — 다음 수집부터 검색에 안 나온다.)
 */
export function annotateWatched(snapshot: YoutubeSnapshot | null): YoutubeSnapshot | null {
  if (!snapshot) return snapshot;
  const isWatched = buildWatchedMatcher();
  return {
    ...snapshot,
    categories: snapshot.categories.map((c) => ({
      ...c,
      items: c.items.map((v: YoutubeVideo) => ({ ...v, watched: isWatched(v.videoId) })),
    })),
  };
}
