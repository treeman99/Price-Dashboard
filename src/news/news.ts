import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { localDate } from "../util/date.ts";
import { curateNews } from "./curate.ts";
import { sendNewsEmail } from "../notify/news-email.ts";
import { NEWS_CATEGORIES } from "../../shared/news.ts";
import type { NewsSnapshot } from "../../shared/types.ts";

// 이력 저장 없음: 최신 스냅샷 1개만 캐시(JSON 파일 + 메모리)
const SNAPSHOT_PATH = path.join(path.dirname(config.dbPath), "news-latest.json");

let memo: NewsSnapshot | null = null;
let running = false;

function loadFromDisk(): NewsSnapshot | null {
  try {
    if (fs.existsSync(SNAPSHOT_PATH)) {
      return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")) as NewsSnapshot;
    }
  } catch (e) {
    log.warn(`뉴스 스냅샷 로드 실패: ${(e as Error).message}`);
  }
  return null;
}

function saveToDisk(s: NewsSnapshot): void {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(s, null, 2));
  } catch (e) {
    log.warn(`뉴스 스냅샷 저장 실패: ${(e as Error).message}`);
  }
}

/** 현재 캐시된 스냅샷 (메모리 우선, 없으면 디스크) */
export function getNewsSnapshot(): NewsSnapshot | null {
  if (!memo) memo = loadFromDisk();
  return memo;
}

/** 오늘자 스냅샷이 이미 있는지 (catch-up 판단) */
export function hasTodayNewsSnapshot(): boolean {
  return getNewsSnapshot()?.date === localDate();
}

/**
 * 뉴스 수집 실행: Claude Agent SDK 큐레이션 → 캐시 갱신 → (옵션)이메일.
 * 이력은 저장하지 않고 최신 스냅샷만 덮어쓴다.
 */
export async function refreshNews(
  opts: { trigger: string; notify?: boolean } = { trigger: "manual" }
): Promise<NewsSnapshot> {
  if (running) {
    log.warn(`뉴스 수집 진행 중 → ${opts.trigger} 중복 방지`);
    return getNewsSnapshot() ?? emptySnapshot();
  }
  running = true;
  try {
    const date = localDate();
    const snapshot = await curateNews(date);
    memo = snapshot;
    saveToDisk(snapshot);

    const total = snapshot.categories.reduce((a, c) => a + c.items.length, 0);
    // 기사가 0건이면 이메일을 보내지 않는다(빈 다이제스트 방지).
    if (opts.notify && total > 0) {
      await sendNewsEmail(snapshot).catch((e) =>
        log.warn(`뉴스 이메일 발송 예외: ${(e as Error).message}`)
      );
    } else if (opts.notify) {
      log.info("뉴스 0건 → 이메일 발송 생략");
    }
    log.info(`뉴스 수집 완료 [${opts.trigger}] ${date} (총 ${total}건, source=${snapshot.source})`);
    return snapshot;
  } finally {
    running = false;
  }
}

function emptySnapshot(): NewsSnapshot {
  return {
    date: localDate(),
    updatedAt: new Date().toISOString(),
    source: "empty",
    categories: NEWS_CATEGORIES.map((c) => ({ ...c, items: [] })),
    notes: "아직 수집되지 않았습니다.",
  };
}
