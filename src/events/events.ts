import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { localDate } from "../util/date.ts";
import { gatherCorpus } from "./gather.ts";
import { curate } from "./curate.ts";
import { markNewItems } from "./new-tracker.ts";
import { sendEventsEmail, sendEventsIMessage } from "../notify/events-email.ts";
import type { EventsSnapshot } from "../../shared/types.ts";

// 이력 저장 없음: 최신 스냅샷 1개만 캐시(JSON 파일 + 메모리)
const SNAPSHOT_PATH = path.join(path.dirname(config.dbPath), "events-latest.json");

/**
 * 마지막 수집 **시도**의 성패 기록(스냅샷과 별도 파일).
 *
 * 스냅샷의 source 만 봐도 성패를 알 수 있는 것처럼 보이지만, 스냅샷은 '지금 화면에 뭐가 떠 있나'이고
 * 이 기록은 '마지막으로 시도했을 때 어떻게 됐나'다. 둘은 수명이 다르다(뉴스 쪽 주석 참고).
 * 메모리 변수로 두지 않는 이유도 같다 — launchd 재시작마다 리셋되면 실패 이력이 사라진다.
 */
const ATTEMPT_PATH = path.join(path.dirname(config.dbPath), "events-attempt.json");

let memo: EventsSnapshot | null = null;
let attemptMemo: EventsAttemptRecord | null = null;
let running = false;

/** 디스크에 남기는 시도 기록. 노출 계약(ok/at/source)보다 넓다 — 사후 추적용 필드 포함. */
interface EventsAttemptRecord {
  /** 이 시도가 '성공'이었는지 (source==="llm" 일 때만 true) */
  ok: boolean;
  /** 시도 시작 시각(ISO) */
  at: string;
  /** 그 시도가 만든 스냅샷의 source ("llm" | "naver-raw" | 예외 시 "error") */
  source: string;
  /** 트리거("schedule" | "catchup" | "manual" ...) */
  trigger?: string;
  /** 그 시도가 모은 항목 총 건수(팝업+전시+축제) */
  total?: number;
  /** 실패 사유(있으면) */
  error?: string | null;
}

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
    const tmp = `${SNAPSHOT_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, SNAPSHOT_PATH); // 원자적 교체 — 부분 기록으로 기존 스냅샷을 깨뜨리지 않는다
  } catch (e) {
    log.warn(`이벤트 스냅샷 저장 실패: ${(e as Error).message}`);
  }
}

function loadAttemptFromDisk(): EventsAttemptRecord | null {
  try {
    if (fs.existsSync(ATTEMPT_PATH)) {
      return JSON.parse(fs.readFileSync(ATTEMPT_PATH, "utf8")) as EventsAttemptRecord;
    }
  } catch (e) {
    log.warn(`이벤트 시도 기록 로드 실패: ${(e as Error).message}`);
  }
  return null;
}

/** 시도 기록 저장. 실패해도 수집 자체를 죽이지 않는다(기록은 부가정보). */
function recordAttempt(r: EventsAttemptRecord): void {
  attemptMemo = r;
  try {
    fs.mkdirSync(path.dirname(ATTEMPT_PATH), { recursive: true });
    fs.writeFileSync(ATTEMPT_PATH, JSON.stringify(r, null, 2));
  } catch (e) {
    log.warn(`이벤트 시도 기록 저장 실패: ${(e as Error).message}`);
  }
}

/** 팝업+전시+축제 총 건수 */
function countItems(s: EventsSnapshot): number {
  return (
    s.popups.length +
    s.exhibitions.venues.reduce((a, v) => a + v.items.length, 0) +
    s.festivals.length
  );
}

/**
 * 스냅샷에서 시도 결과를 유도한다(시도 기록 파일이 아직 없을 때의 대체 경로).
 *
 * ok 는 **source==="llm" 일 때만** true 다. naver-raw 는 큐레이션이 실패했을 때의 원본 폴백이라
 * 건수가 아무리 많아도 성공이 아니다 — 실측(2026-08-02 02:18): 폴백 스냅샷의 '팝업 24건'은
 * 실제 팝업이 아니라 블로그 글 제목이었다. 스케줄러의 catch-up 게이트가 날짜만 보고 이걸
 * 성공으로 오인해 그날 재시도가 끊겼다.
 */
export function deriveEventsAttempt(
  s: EventsSnapshot | null
): { ok: boolean; at: string; source: string } | null {
  if (!s) return null;
  return { ok: s.source === "llm", at: s.updatedAt, source: s.source };
}

/** 마지막 이벤트(팝업·전시·축제) 수집 시도의 성패. 스케줄러의 catch-up/백오프 판정용. */
export function getEventsLastAttempt(): { ok: boolean; at: string; source: string } | null {
  if (!attemptMemo) attemptMemo = loadAttemptFromDisk();
  if (attemptMemo) {
    const { ok, at, source } = attemptMemo;
    return { ok, at, source };
  }
  // 기록 파일이 없는 경우(이 기능 배포 직후 첫 회차, data 디렉터리 초기화 등)만 스냅샷에서 유도.
  return deriveEventsAttempt(getEventsSnapshot());
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

/** 현재 팝업/전시 수집이 진행 중인지 (API가 '수집 중' 안내에 사용). 수동·정시 수집 모두 반영. */
export function isEventsCollecting(): boolean {
  return running;
}

/** refreshEvents 한 회차의 알림 방침(순수 판정 — 디스크/알림 부작용 없음). */
export interface EventsPublishDecision {
  /** 이번 회차 결과가 알림(이메일·iMessage) 대상인지 — opts.notify 와 AND 로 묶인다 */
  notify: boolean;
  /** 발송을 생략한 이유(보낼 때는 null). 로그 문구로 그대로 쓴다. */
  skipReason: string | null;
  /** 이번 시도의 성패 기록 */
  attempt: EventsAttemptRecord;
}

/**
 * 알림 품질 게이트.
 *
 * 큐레이션이 실패하면 curate() 는 네이버 검색 **원본**(source="naver-raw")으로 폴백한다.
 * 원본은 제목·링크가 그대로라 팝업이 아닌 블로그 글·광고가 섞이고, 기간/장소도 정리되지 않는다.
 * 그런데 알림 코드가 source 를 보지 않아 이 저품질 결과가 **정상인 척** 이메일+iMessage 로 나갔다
 * (실측 2026-08-02 02:18: '팝업 24건'이 전부 블로그 글 제목).
 *
 * 정책: **발송 생략**. "원본 폴백(미큐레이션)"이라고 제목에 붙여 보내는 안도 있었지만,
 * - 알림은 훑어보는 매체라 꼬리표를 붙여도 목록 자체는 그대로 신뢰하게 된다(오인 위험이 남는다).
 * - 화면(대시보드)에는 폴백 결과가 그대로 남으므로 정보가 사라지는 게 아니다. 보고 싶으면 볼 수 있다.
 * - 매일 오는 알림이 한 번이라도 거짓이면 나머지 정상 발송까지 못 믿게 된다. 침묵이 손해가 작다.
 * 침묵을 사고와 구분할 수단은 따로 있다 — getEventsLastAttempt().ok=false 와 아래 warn 로그.
 */
export function decideEventsPublish(
  snapshot: EventsSnapshot,
  attemptedAt: string,
  trigger = "manual"
): EventsPublishDecision {
  const total = countItems(snapshot);
  const ok = snapshot.source === "llm";
  const attempt: EventsAttemptRecord = {
    ok,
    at: attemptedAt,
    source: snapshot.source,
    trigger,
    total,
    error: ok ? null : (snapshot.notes ?? "큐레이션 실패(원본 폴백)"),
  };
  if (!ok) {
    return {
      notify: false,
      skipReason: `원본 폴백(source=${snapshot.source}, ${total}건) → 이메일·iMessage 발송 생략`,
      attempt,
    };
  }
  return { notify: true, skipReason: null, attempt };
}

/**
 * 팝업/전시 수집 실행: 네이버 검색 → 큐레이션 → 캐시 갱신 → (옵션)이메일.
 * 이력은 저장하지 않고 최신 스냅샷만 덮어쓴다.
 *
 * 뉴스·유튜브와 달리 실패해도 스냅샷을 덮어쓴다 — 폴백(naver-raw)도 '오늘 검색 결과'라
 * 화면에 띄울 값어치는 있다고 보고 이번 작업 범위에서는 기존 동작을 유지했다.
 * 다만 그 결과로 알림을 보내지는 않는다(decideEventsPublish).
 */
export async function refreshEvents(opts: { trigger: string; notify?: boolean } = { trigger: "manual" }): Promise<EventsSnapshot> {
  if (running) {
    log.warn(`이벤트 수집 진행 중 → ${opts.trigger} 중복 방지`);
    return getEventsSnapshot() ?? emptySnapshot();
  }
  running = true;
  const startedAt = new Date().toISOString();
  try {
    const date = localDate();
    const corpus = await gatherCorpus();
    const snapshot = await curate(corpus, date);
    // '신규(약 일주일 만에 등장)' 태깅 — 등장 원장 갱신. 폴백 원본은 제목 노이즈로 제외.
    if (snapshot.source === "llm") {
      try {
        markNewItems(snapshot, date);
      } catch (e) {
        log.warn(`이벤트 신규 태깅 예외: ${(e as Error).message}`);
      }
    }
    memo = snapshot;
    saveToDisk(snapshot);

    const decision = decideEventsPublish(snapshot, startedAt, opts.trigger);
    recordAttempt(decision.attempt);

    if (opts.notify && decision.notify) {
      await sendEventsEmail(snapshot).catch((e) =>
        log.warn(`이벤트 이메일 발송 예외: ${(e as Error).message}`)
      );
      await sendEventsIMessage(snapshot); // 자체 게이트·자체 catch(throw 안 함)
    } else if (opts.notify && decision.skipReason) {
      log.warn(`이벤트 ${decision.skipReason}`);
    }
    log.info(`이벤트 수집 완료 [${opts.trigger}] ${date} (source=${snapshot.source})`);
    return snapshot;
  } catch (e) {
    // 여기까지 예외가 올라오는 경우(네이버 검색 실패 등)도 '실패한 시도'로 남긴다.
    recordAttempt({
      ok: false,
      at: startedAt,
      source: "error",
      trigger: opts.trigger,
      total: 0,
      error: (e as Error).message,
    });
    throw e;
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
