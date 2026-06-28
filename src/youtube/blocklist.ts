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

/** 안정적 식별자(키): 핸들 우선, 없으면 이름. */
export function channelKey(channel: string, handle: string | null | undefined): string {
  const h = normHandle(handle);
  if (h) return `@${h}`;
  return `name:${normName(channel)}`;
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
        memo = parsed as BlockedChannel[];
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
}

/** 채널 차단 추가. (id 멱등 — 같은 채널 재차단 시 기존 항목 반환) */
export function addBlock(input: AddBlockInput): BlockedChannel {
  const channel = (input.channel || "").trim();
  const handle = input.handle ? input.handle.trim() : null;
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
  const id = channelKey(channel, handle);
  const existing = list.find((b) => b.id === id);
  if (existing) return existing;

  const entry: BlockedChannel = {
    id,
    channel: channel || handle || id,
    handle: handle && normHandle(handle) ? (handle.startsWith("@") ? handle : `@${normHandle(handle)}`) : null,
    blockedAt: new Date().toISOString(),
  };
  list.push(entry);
  save(list);
  memo = list;
  log.info(`유튜브 채널 차단: ${entry.channel}${entry.handle ? ` (${entry.handle})` : ""} [${id}]`);
  return entry;
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
 * 현재 차단 목록 기준의 매처. 영상(채널명/핸들)이 차단 대상이면 true.
 * 항목별 판정 규칙은 프론트 sameChannel과 동일하다:
 *   - 차단항목과 영상 "둘 다" 핸들이 있으면 → 핸들 일치로만 판정(동명 다른채널 과차단 방지)
 *   - 그 외(어느 한쪽이라도 핸들이 없으면) → 채널명 일치로 폴백
 * 이로써 핸들로 차단해도 같은 채널의 핸들 없는 영상까지 일관되게 잡는다.
 */
/** 순수 판정: 주어진 차단 목록 기준으로 (채널명, 핸들)이 차단 대상인지. (테스트 용이성) */
export function isChannelBlocked(
  list: BlockedChannel[],
  channel: string,
  handle: string | null | undefined
): boolean {
  const vh = normHandle(handle);
  const vn = normName(channel);
  return list.some((b) => {
    const bh = normHandle(b.handle);
    const bn = normName(b.channel);
    if (bh && vh) return bh === vh; // 양쪽 모두 핸들 → 핸들 일치
    return !!bn && bn === vn; // 그 외 → 채널명 일치
  });
}

export function buildBlockMatcher(): (channel: string, handle: string | null | undefined) => boolean {
  const list = loadBlocklist();
  return (channel: string, handle: string | null | undefined) =>
    isChannelBlocked(list, channel, handle);
}

/** 차단 채널 영상을 제거한 스냅샷 사본을 반환(읽기 시점 필터). */
export function applyBlocklist(snapshot: YoutubeSnapshot | null): YoutubeSnapshot | null {
  if (!snapshot) return snapshot;
  const isBlocked = buildBlockMatcher();
  return {
    ...snapshot,
    categories: snapshot.categories.map((c) => ({
      ...c,
      items: c.items.filter((v: YoutubeVideo) => !isBlocked(v.channel, v.channelHandle)),
    })),
  };
}
