import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { localDate } from "../util/date.ts";
import { gatherCorpus } from "./gather.ts";
import { curate } from "./curate.ts";
import { sendEventsEmail } from "../notify/events-email.ts";
import type { EventsSnapshot } from "../../shared/types.ts";

// 이력 저장 없음: 최신 스냅샷 1개만 캐시(JSON 파일 + 메모리)
const SNAPSHOT_PATH = path.join(path.dirname(config.dbPath), "events-latest.json");

let memo: EventsSnapshot | null = null;
let running = false;

function loadFromDisk(): EventsSnapshot | null {
  try {
    if (fs.existsSync(SNAPSHOT_PATH)) {
      return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")) as EventsSnapshot;
    }
  } catch (e) {
    log.warn(`이벤트 스냅샷 로드 실패: ${(e as Error).message}`);
  }
  return null;
}

function saveToDisk(s: EventsSnapshot): void {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(s, null, 2));
  } catch (e) {
    log.warn(`이벤트 스냅샷 저장 실패: ${(e as Error).message}`);
  }
}

/** 현재 캐시된 스냅샷 (메모리 우선, 없으면 디스크) */
export function getEventsSnapshot(): EventsSnapshot | null {
  if (!memo) memo = loadFromDisk();
  return memo;
}

/** 오늘자 스냅샷이 이미 있는지 (catch-up 판단) */
export function hasTodaySnapshot(): boolean {
  return getEventsSnapshot()?.date === localDate();
}

/**
 * 팝업/전시 수집 실행: 네이버 검색 → 큐레이션 → 캐시 갱신 → (옵션)이메일.
 * 이력은 저장하지 않고 최신 스냅샷만 덮어쓴다.
 */
export async function refreshEvents(opts: { trigger: string; notify?: boolean } = { trigger: "manual" }): Promise<EventsSnapshot> {
  if (running) {
    log.warn(`이벤트 수집 진행 중 → ${opts.trigger} 중복 방지`);
    return getEventsSnapshot() ?? emptySnapshot();
  }
  running = true;
  try {
    const date = localDate();
    const corpus = await gatherCorpus();
    const snapshot = await curate(corpus, date);
    memo = snapshot;
    saveToDisk(snapshot);

    if (opts.notify) {
      await sendEventsEmail(snapshot).catch((e) =>
        log.warn(`이벤트 이메일 발송 예외: ${(e as Error).message}`)
      );
    }
    log.info(`이벤트 수집 완료 [${opts.trigger}] ${date} (source=${snapshot.source})`);
    return snapshot;
  } finally {
    running = false;
  }
}

function emptySnapshot(): EventsSnapshot {
  return {
    date: localDate(),
    updatedAt: new Date().toISOString(),
    source: "naver-raw",
    popups: [],
    exhibitions: { venues: [] },
    festivals: [],
    notes: "아직 수집되지 않았습니다.",
  };
}
