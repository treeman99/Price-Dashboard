import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { UNKNOWN_CHANNEL } from "../../shared/youtube.ts";
import type { BlockedChannel, YoutubeSnapshot, YoutubeVideo } from "../../shared/types.ts";

const BLOCKLIST_PATH = path.join(path.dirname(config.dbPath), "youtube-blocklist.json");

// 채널 미상 플레이스홀더는 shared/youtube.ts(UNKNOWN_CHANNEL)에서 가져와 curate/프론트와 공유한다.
export { UNKNOWN_CHANNEL };

let memo: BlockedChannel[] | null = null;

/** 핸들 정규화: 소문자 + 앞쪽 @ 제거 + 공백 제거. */
function normHandle(h: string | null | undefined): string {
  return (h ?? "").trim().toLowerCase().replace(/^@+/, "");
}
/** 채널명 정규화: 소문자 + trim + 연속 공백 1칸. */
function normName(n: string | null | undefined): string {
  return (n ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** 안정적 채널키: 핸들 우선, 없으면 이름. */
export function channelKey(channel: string, handle: string | null | undefined): string {
  const h = normHandle(handle);
  if (h) return `@${h}`;
  return `name:${normName(channel)}`;
}

/** 차단 항목 식별자: "채널키::카테고리키"(전역은 "*"). 같은 채널을 카테고리별로 각각 차단 가능. */
export function blockId(
  channel: string,
  handle: string | null | undefined,
  categoryKey: string | null | undefined
): string {
  return `${channelKey(channel, handle)}::${(categoryKey ?? "").trim() || "*"}`;
}

function save(list: BlockedChannel[]): void {
  try {
    fs.mkdirSync(path.dirname(BLOCKLIST_PATH), { recursive: true });
    fs.writeFileSync(BLOCKLIST_PATH, JSON.stringify(list, null, 2));
  } catch (e) {
    log.warn(`유튜브 차단목록 저장 실패: ${(e as Error).message}`);
  }
}

/** 차단 목록 (없으면 빈 배열). */
export function loadBlocklist(): BlockedChannel[] {
  if (memo) return memo;
  try {
    if (fs.existsSync(BLOCKLIST_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(BLOCKLIST_PATH, "utf8"));
      if (Array.isArray(parsed)) {
        // 하위호환: categoryKey 필드가 없던 구버전 항목은 전역(null)으로 취급.
        memo = (parsed as BlockedChannel[]).map((b) => ({
          ...b,
          categoryKey: b.categoryKey ?? null,
        }));
        return memo;
      }
    }
  } catch (e) {
    log.warn(`유튜브 차단목록 로드 실패 → 빈 목록 사용: ${(e as Error).message}`);
  }
  memo = [];
  return memo;
}

export interface AddBlockInput {
  channel: string;
  handle?: string | null;
  /** 제외할 카테고리 key. null/미지정이면 전역(모든 카테고리). */
  categoryKey?: string | null;
}

/** 채널 차단 추가. (id 멱등 — 같은 채널+같은 카테고리 재차단 시 기존 항목 반환) */
export function addBlock(input: AddBlockInput): BlockedChannel {
  const channel = (input.channel || "").trim();
  const handle = input.handle ? input.handle.trim() : null;
  const categoryKey = input.categoryKey?.trim() || null;
  const hasHandle = !!normHandle(handle);
  if (!channel && !hasHandle) {
    throw new Error("차단할 채널명 또는 핸들이 필요합니다.");
  }
  // 채널 식별 불가(핸들 없음 + 채널명 미상 플레이스홀더)면 차단 키로 부적합 → 거부
  // (그대로 두면 '(채널 미상)' 영상 전체가 일괄 차단되는 과차단 발생)
  if (!hasHandle && normName(channel) === normName(UNKNOWN_CHANNEL)) {
    throw new Error("채널 정보가 없어 이 영상은 채널 단위로 제외할 수 없습니다.");
  }
  const list = loadBlocklist();
  const id = blockId(channel, handle, categoryKey);
  const existing = list.find((b) => b.id === id);
  if (existing) return existing;

  const entry: BlockedChannel = {
    id,
    channel: channel || handle || channelKey(channel, handle),
    handle: handle && normHandle(handle) ? (handle.startsWith("@") ? handle : `@${normHandle(handle)}`) : null,
    categoryKey,
    blockedAt: new Date().toISOString(),
  };
  list.push(entry);
  save(list);
  memo = list;
  log.info(
    `유튜브 채널 차단: ${entry.channel}${entry.handle ? ` (${entry.handle})` : ""} [${categoryKey ?? "전역"}] [${id}]`
  );
  return entry;
}

/** 카테고리 삭제 시, 그 카테고리 전용 차단 항목을 함께 정리한다. 제거된 개수 반환. */
export function removeBlocksForCategory(categoryKey: string): number {
  const key = (categoryKey || "").trim();
  if (!key) return 0;
  const list = loadBlocklist();
  const kept = list.filter((b) => b.categoryKey !== key);
  const removed = list.length - kept.length;
  if (removed > 0) {
    save(kept);
    memo = kept;
    log.info(`유튜브 카테고리 삭제 → 전용 차단 ${removed}건 정리 [${key}]`);
  }
  return removed;
}

/** 차단 해제(되돌리기). 제거되면 true. */
export function removeBlock(id: string): boolean {
  const list = loadBlocklist();
  const idx = list.findIndex((b) => b.id === id);
  if (idx < 0) return false;
  const [removed] = list.splice(idx, 1);
  save(list);
  memo = list;
  log.info(`유튜브 채널 차단 해제: ${removed.channel} [${id}]`);
  return true;
}

/**
 * 차단 항목 1건이 주어진 (채널명, 핸들)과 같은 채널을 가리키는지. 판정 규칙은 프론트 sameChannel과 동일:
 *   - 차단항목과 영상 "둘 다" 핸들이 있으면 → 핸들 일치로만 판정(동명 다른채널 과차단 방지)
 *   - 그 외(어느 한쪽이라도 핸들이 없으면) → 채널명 일치로 폴백
 * 이로써 핸들로 차단해도 같은 채널의 핸들 없는 영상까지 일관되게 잡는다.
 */
function entryMatchesChannel(b: BlockedChannel, channel: string, handle: string | null | undefined): boolean {
  const vh = normHandle(handle);
  const vn = normName(channel);
  const bh = normHandle(b.handle);
  const bn = normName(b.channel);
  if (bh && vh) return bh === vh; // 양쪽 모두 핸들 → 핸들 일치
  return !!bn && bn === vn; // 그 외 → 채널명 일치
}

/**
 * 순수 판정: 주어진 차단 목록 기준으로 (채널명, 핸들)이 **해당 카테고리에서** 차단 대상인지. (테스트 용이성)
 * 채널이 일치하고, 차단항목이 전역(categoryKey=null)이거나 그 카테고리(categoryKey===categoryKey)면 차단.
 * categoryKey 를 주지 않으면(undefined) 전역 항목만 매칭한다(카테고리 무관 판정용).
 */
export function isChannelBlocked(
  list: BlockedChannel[],
  channel: string,
  handle: string | null | undefined,
  categoryKey?: string | null
): boolean {
  return list.some((b) => {
    if (!entryMatchesChannel(b, channel, handle)) return false;
    if (b.categoryKey == null) return true; // 전역 차단
    return categoryKey != null && b.categoryKey === categoryKey; // 해당 카테고리 차단
  });
}

export function buildBlockMatcher(): (
  channel: string,
  handle: string | null | undefined,
  categoryKey?: string | null
) => boolean {
  const list = loadBlocklist();
  return (channel, handle, categoryKey) => isChannelBlocked(list, channel, handle, categoryKey);
}

/** 차단 채널 영상을 제거한 스냅샷 사본을 반환(읽기 시점 필터 — 카테고리별 제외 반영). */
export function applyBlocklist(snapshot: YoutubeSnapshot | null): YoutubeSnapshot | null {
  if (!snapshot) return snapshot;
  const isBlocked = buildBlockMatcher();
  return {
    ...snapshot,
    categories: snapshot.categories.map((c) => ({
      ...c,
      items: c.items.filter((v: YoutubeVideo) => !isBlocked(v.channel, v.channelHandle, c.key)),
    })),
  };
}
