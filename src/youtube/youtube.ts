import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { localDate } from "../util/date.ts";
import { curateYoutube } from "./curate.ts";
import { sendYoutubeEmail } from "../notify/youtube-email.ts";
import { loadCategories } from "./categories.ts";
import type { YoutubeSnapshot } from "../../shared/types.ts";

// 이력 저장 없음: 최신 스냅샷 1개만 캐시(JSON 파일 + 메모리)
const SNAPSHOT_PATH = path.join(path.dirname(config.dbPath), "youtube-latest.json");

let memo: YoutubeSnapshot | null = null;
let running = false;

function loadFromDisk(): YoutubeSnapshot | null {
  try {
    if (fs.existsSync(SNAPSHOT_PATH)) {
      return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")) as YoutubeSnapshot;
    }
  } catch (e) {
    log.warn(`유튜브 스냅샷 로드 실패: ${(e as Error).message}`);
  }
  return null;
}

function saveToDisk(s: YoutubeSnapshot): void {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(s, null, 2));
  } catch (e) {
    log.warn(`유튜브 스냅샷 저장 실패: ${(e as Error).message}`);
  }
}

/** 현재 캐시된 스냅샷 (메모리 우선, 없으면 디스크) */
export function getYoutubeSnapshot(): YoutubeSnapshot | null {
  if (!memo) memo = loadFromDisk();
  return memo;
}

/** 오늘자 스냅샷이 이미 있는지 (catch-up 판단) */
export function hasTodayYoutubeSnapshot(): boolean {
  return getYoutubeSnapshot()?.date === localDate();
}

/** 현재 유튜브 수집이 진행 중인지 (API가 '수집 중' 안내에 사용) */
export function isYoutubeCollecting(): boolean {
  return running;
}

/**
 * 유튜브 소식 수집 실행: Claude Agent SDK 큐레이션 → 캐시 갱신 → (옵션)이메일.
 * 이력은 저장하지 않고 최신 스냅샷만 덮어쓴다.
 */
export async function refreshYoutube(
  opts: { trigger: string; notify?: boolean } = { trigger: "manual" }
): Promise<YoutubeSnapshot> {
  if (running) {
    log.warn(`유튜브 수집 진행 중 → ${opts.trigger} 중복 방지`);
    return getYoutubeSnapshot() ?? emptySnapshot();
  }
  running = true;
  try {
    const date = localDate();
    const prev = getYoutubeSnapshot();
    const snapshot = await curateYoutube(date);

    // 수집 실패/시간초과(source=empty)면 기존 정상 스냅샷을 빈 데이터로 덮어쓰지 않는다.
    if (snapshot.source === "empty" && prev && prev.source === "llm") {
      log.warn(`유튜브 수집 실패 → 기존 스냅샷 유지 (${snapshot.notes ?? "원인 미상"})`);
      return prev;
    }

    memo = snapshot;
    saveToDisk(snapshot);

    const total = snapshot.categories.reduce((a, c) => a + c.items.length, 0);
    // 영상이 0건이면 이메일을 보내지 않는다(빈 다이제스트 방지).
    if (opts.notify && total > 0) {
      await sendYoutubeEmail(snapshot).catch((e) =>
        log.warn(`유튜브 이메일 발송 예외: ${(e as Error).message}`)
      );
    } else if (opts.notify) {
      log.info("유튜브 0건 → 이메일 발송 생략");
    }
    log.info(`유튜브 수집 완료 [${opts.trigger}] ${date} (총 ${total}건, source=${snapshot.source})`);
    return snapshot;
  } finally {
    running = false;
  }
}

function emptySnapshot(): YoutubeSnapshot {
  return {
    date: localDate(),
    updatedAt: new Date().toISOString(),
    source: "empty",
    freshDays: config.youtubeFreshDays,
    categories: loadCategories().map((c) => ({
      key: c.key,
      label: c.label,
      emoji: c.emoji,
      color: c.color,
      items: [],
    })),
    notes: "아직 수집되지 않았습니다.",
  };
}
