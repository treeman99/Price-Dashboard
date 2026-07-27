import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { localDate } from "../util/date.ts";
import { curateYoutube } from "./curate.ts";
import { sendYoutubeEmail, sendYoutubeIMessage } from "../notify/youtube-email.ts";
import { loadCategories } from "./categories.ts";
import { addReclass } from "./reclass.ts";
import type { YoutubeSnapshot, YoutubeCategory, YoutubeVideo } from "../../shared/types.ts";

// 이력 저장 없음: 최신 스냅샷 1개만 캐시(JSON 파일 + 메모리)
const SNAPSHOT_PATH = path.join(path.dirname(config.dbPath), "youtube-latest.json");

let memo: YoutubeSnapshot | null = null;
let running = false;

/**
 * 마지막 수집 **시도**의 결과. 수집이 실패해도 기존 스냅샷을 그대로 두는 설계라서(빈 화면 방지)
 * 화면에는 옛 데이터가 남고, 사용자 눈에는 "갱신을 눌러도 아무 일도 안 일어난다"로만 보인다.
 * 실제로 그런 상태가 반나절 넘게 방치된 사례가 있어(큐레이션 타임아웃 반복), 시도 시각과 실패
 * 사유를 남겨 status API 가 화면에 알릴 수 있게 한다. 스냅샷과 달리 프로세스 재시작 시 초기화된다.
 */
export interface YoutubeAttempt {
  at: string;
  ok: boolean;
  trigger: string;
  error: string | null;
}
let lastAttempt: YoutubeAttempt | null = null;

/** 마지막 수집 시도 결과(없으면 null — 기동 후 아직 시도 없음). */
export function getYoutubeLastAttempt(): YoutubeAttempt | null {
  return lastAttempt;
}

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
  const startedAt = new Date().toISOString();
  try {
    const date = localDate();
    const prev = getYoutubeSnapshot();
    const snapshot = await curateYoutube(date);

    // 수집 실패/시간초과(source=empty)면 기존 정상 스냅샷을 빈 데이터로 덮어쓰지 않는다.
    if (snapshot.source === "empty" && prev && prev.source === "llm") {
      log.warn(`유튜브 수집 실패 → 기존 스냅샷 유지 (${snapshot.notes ?? "원인 미상"})`);
      lastAttempt = {
        at: startedAt,
        ok: false,
        trigger: opts.trigger,
        error: snapshot.notes ?? "원인 미상",
      };
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
      await sendYoutubeIMessage(snapshot); // 자체 게이트·자체 catch(throw 안 함)
    } else if (opts.notify) {
      log.info("유튜브 0건 → 이메일 발송 생략");
    }
    log.info(`유튜브 수집 완료 [${opts.trigger}] ${date} (총 ${total}건, source=${snapshot.source})`);
    // 여기까지 왔어도 source=empty 면(이전 스냅샷이 없어 빈 결과를 그대로 저장한 경우) 실패다.
    lastAttempt =
      snapshot.source === "empty"
        ? { at: startedAt, ok: false, trigger: opts.trigger, error: snapshot.notes ?? "원인 미상" }
        : { at: startedAt, ok: true, trigger: opts.trigger, error: null };
    return snapshot;
  } catch (e) {
    lastAttempt = { at: startedAt, ok: false, trigger: opts.trigger, error: (e as Error).message };
    throw e;
  } finally {
    running = false;
  }
}

/**
 * 카드(영상)를 다른 카테고리로 이동한다.
 * - 현재 스냅샷에서 videoId로 영상을 찾아 출발 카테고리에서 제거하고 도착 카테고리 맨 앞에 넣는다.
 * - 이동 영상은 movedByUser=true 로 표시(읽기 시점 지역필터가 존중하도록).
 * - 이동 사례를 재분류 기록(reclass)에 남겨 다음 수집 프롬프트가 학습하게 한다.
 * 성공 시 갱신된 스냅샷을 반환, 실패 시 원인 Error throw.
 */
export function moveYoutubeVideo(videoId: string, fromKey: string, toKey: string): YoutubeSnapshot {
  if (!videoId) throw new Error("영상 식별자(videoId)가 필요합니다.");
  if (fromKey === toKey) throw new Error("같은 카테고리로는 이동할 수 없습니다.");
  const snap = getYoutubeSnapshot();
  if (!snap) throw new Error("이동할 유튜브 데이터가 아직 없습니다.");

  const defs = loadCategories();
  const toDef = defs.find((d) => d.key === toKey);
  if (!toDef) throw new Error("이동 대상 카테고리를 찾을 수 없습니다.");

  const fromCat = snap.categories.find((c) => c.key === fromKey);
  const video = fromCat?.items.find((v) => v.videoId === videoId);
  if (!video) throw new Error("이동할 영상을 현재 목록에서 찾을 수 없습니다.");

  const moved: YoutubeVideo = { ...video, movedByUser: true };

  // 모든 카테고리에서 해당 영상 제거(방어적 중복 제거) 후 대상 앞에 삽입.
  let categories: YoutubeCategory[] = snap.categories.map((c) => ({
    ...c,
    items: c.items.filter((v) => v.videoId !== videoId),
  }));
  const hasTarget = categories.some((c) => c.key === toKey);
  if (hasTarget) {
    categories = categories.map((c) =>
      c.key === toKey ? { ...c, items: [moved, ...c.items] } : c
    );
  } else {
    // 대상 카테고리가 아직 스냅샷에 없으면(수집 이후 추가된 경우) 새 섹션으로 만든다.
    categories.push({
      key: toDef.key,
      label: toDef.label,
      emoji: toDef.emoji,
      color: toDef.color,
      items: [moved],
    });
  }

  const next: YoutubeSnapshot = { ...snap, categories, updatedAt: new Date().toISOString() };
  memo = next;
  saveToDisk(next);

  const fromLabel = fromCat?.label ?? defs.find((d) => d.key === fromKey)?.label ?? fromKey;
  addReclass({
    title: video.title,
    channel: video.channel,
    fromKey,
    fromLabel,
    toKey,
    toLabel: toDef.label,
    movedAt: new Date().toISOString(),
  });
  log.info(`유튜브 카드 이동: "${video.title}" ${fromLabel} → ${toDef.label}`);
  return next;
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
