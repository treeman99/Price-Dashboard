import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { localDate } from "../util/date.ts";
import { curateNews } from "./curate.ts";
import { sendNewsEmail, sendNewsIMessage } from "../notify/news-email.ts";
import { loadCategories } from "./categories.ts";
import type { NewsSnapshot } from "../../shared/types.ts";

// 이력 저장 없음: 최신 스냅샷 1개만 캐시(JSON 파일 + 메모리)
const SNAPSHOT_PATH = path.join(path.dirname(config.dbPath), "news-latest.json");

/**
 * 마지막 수집 **시도**의 성패 기록(스냅샷과 별도 파일).
 *
 * 왜 스냅샷에서 유도하지 않고 파일을 따로 두는가 —
 * 아래 refreshNews 의 스냅샷 보호가 발동하면 디스크에는 '직전 성공본'(어제자일 수도 있다)이
 * 그대로 남는다. 그 상태에서 성패를 스냅샷으로만 유도하면 "마지막 시도 = 성공"으로 읽혀
 * 스케줄러의 백오프가 풀리고 실패를 성공으로 오인한다. 시도 기록은 스냅샷과 수명이 다르다.
 *
 * 왜 메모리 변수가 아닌가 — launchd 로 상시 구동되는 서비스라 재시작마다 리셋되면
 * 재시작 직후의 catch-up 이 다시 '기록 없음'에서 출발해 실패 이력을 잃는다.
 * (유튜브의 getYoutubeLastAttempt 는 메모리 변수라 재시작에 약하다. 여기서는 디스크로 올린다.)
 */
const ATTEMPT_PATH = path.join(path.dirname(config.dbPath), "news-attempt.json");

let memo: NewsSnapshot | null = null;
let attemptMemo: NewsAttemptRecord | null = null;
let running = false;

/** 디스크에 남기는 시도 기록. 노출 계약(ok/at/source)보다 넓다 — 사후 추적용 필드 포함. */
interface NewsAttemptRecord {
  /** 이 시도가 '성공'이었는지 (isNewsSuccess 판정) */
  ok: boolean;
  /** 시도 시작 시각(ISO) */
  at: string;
  /** 그 시도가 만든 스냅샷의 source ("llm" | "empty" | 예외 시 "error") */
  source: string;
  /** 트리거("schedule" | "catchup" | "manual" ...) */
  trigger?: string;
  /** 그 시도가 모은 기사 총 건수 */
  total?: number;
  /** 실패 사유(있으면) */
  error?: string | null;
}

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

/**
 * 스냅샷 저장. 임시 파일에 쓰고 rename 으로 바꾼다(원자적 교체).
 * 보호가 걸린 회차에도 notes 를 갱신하느라 파일을 다시 쓰기 때문에, 중간에 프로세스가 죽어
 * 부분 기록이 남으면 **유일하게 남은 성공본**을 잃는다. 그 사고만은 막는다.
 */
function saveToDisk(s: NewsSnapshot): void {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    const tmp = `${SNAPSHOT_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, SNAPSHOT_PATH);
  } catch (e) {
    log.warn(`뉴스 스냅샷 저장 실패: ${(e as Error).message}`);
  }
}

function loadAttemptFromDisk(): NewsAttemptRecord | null {
  try {
    if (fs.existsSync(ATTEMPT_PATH)) {
      return JSON.parse(fs.readFileSync(ATTEMPT_PATH, "utf8")) as NewsAttemptRecord;
    }
  } catch (e) {
    log.warn(`뉴스 시도 기록 로드 실패: ${(e as Error).message}`);
  }
  return null;
}

/** 시도 기록 저장. 실패해도 수집 자체를 죽이지 않는다(기록은 부가정보). */
function recordAttempt(r: NewsAttemptRecord): void {
  attemptMemo = r;
  try {
    fs.mkdirSync(path.dirname(ATTEMPT_PATH), { recursive: true });
    fs.writeFileSync(ATTEMPT_PATH, JSON.stringify(r, null, 2));
  } catch (e) {
    log.warn(`뉴스 시도 기록 저장 실패: ${(e as Error).message}`);
  }
}

/** 카테고리 전체 기사 수 */
function countItems(s: NewsSnapshot): number {
  return s.categories.reduce((a, c) => a + c.items.length, 0);
}

/**
 * 이 스냅샷이 '성공한 수집'인지.
 *
 * 실측(2026-08-02 00:36): 맥북 슬립으로 큐레이션이 56분 만에 타임아웃해 `총 0건, source=empty`
 * 스냅샷이 저장됐고, 그 빈 스냅샷이 date=오늘이라 catch-up 게이트를 통과시켜 그날 재시도가
 * 영구 봉인됐다. 그래서 성공 판정은 source 만이 아니라 **건수까지** 본다 —
 * 뉴스는 7개 카테고리를 24시간 창으로 훑으므로 총 0건은 사실상 실패다.
 */
function isNewsSuccess(s: NewsSnapshot | null | undefined): boolean {
  if (!s) return false;
  return s.source === "llm" && countItems(s) > 0;
}

/**
 * 스냅샷에서 시도 결과를 유도한다(시도 기록 파일이 아직 없을 때의 대체 경로).
 * 보호가 발동한 회차는 스냅샷만으로 성패를 알 수 없으므로 어디까지나 fallback 이다.
 */
export function deriveNewsAttempt(
  s: NewsSnapshot | null
): { ok: boolean; at: string; source: string } | null {
  if (!s) return null;
  return { ok: isNewsSuccess(s), at: s.updatedAt, source: s.source };
}

/** 마지막 뉴스 수집 시도의 성패. 스케줄러의 catch-up/백오프 판정용. */
export function getNewsLastAttempt(): { ok: boolean; at: string; source: string } | null {
  if (!attemptMemo) attemptMemo = loadAttemptFromDisk();
  if (attemptMemo) {
    const { ok, at, source } = attemptMemo;
    return { ok, at, source };
  }
  // 기록 파일이 없는 경우(이 기능 배포 직후 첫 회차, data 디렉터리 초기화 등)만 스냅샷에서 유도.
  return deriveNewsAttempt(getNewsSnapshot());
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

/** 현재 뉴스 수집이 진행 중인지 (API가 '수집 중' 안내에 사용). 수동·정시 수집 모두 반영. */
export function isNewsCollecting(): boolean {
  return running;
}

/** refreshNews 한 회차의 처리 방침(순수 판정 — 디스크/알림 부작용 없음). */
export interface NewsSnapshotDecision {
  /** "save" = 이번 결과를 저장 / "keep" = 직전 스냅샷 유지(빈 결과의 덮어쓰기 차단) */
  action: "save" | "keep";
  /** 실제로 화면·API 에 노출할 스냅샷 */
  snapshot: NewsSnapshot;
  /** 이번 회차 결과가 알림(이메일·iMessage) 대상인지 — opts.notify 와 AND 로 묶인다 */
  notify: boolean;
  /** 이번 시도의 성패 기록 */
  attempt: NewsAttemptRecord;
}

/**
 * 스냅샷 보호 판정 — 유튜브(src/youtube/youtube.ts 의 prev.source==="llm" 보호)와 같은 패턴.
 *
 * 규칙:
 * 1. 이번 결과가 실패성(총 0건 또는 source!=="llm")이고 **직전 스냅샷이 성공**이면 유지한다.
 *    직전이 어제자여도 유지한다 — "어제 뉴스가 보이는 것"이 "빈 화면"보다 낫다.
 *    대신 notes 에 상황을 적어 날짜를 오해하지 않게 한다(스키마는 그대로 두고 기존 필드만 쓴다).
 * 2. 직전이 없거나 직전도 실패성이면 이번 결과를 그대로 저장한다(첫 실행 시 빈 화면은 정상).
 * 3. 보호가 걸린 회차는 **알림을 보내지 않는다** — 어제 다이제스트가 오늘 아침에 또 오면 안 된다.
 *
 * 이 판정만으로는 catch-up 이 30분마다 무한 재시도할 수 있으므로, 성패를 attempt 로 함께
 * 돌려주어 스케줄러가 getNewsLastAttempt() 로 백오프를 걸 수 있게 한다(자기봉인/무한재시도 동시 차단).
 */
export function decideNewsSnapshot(
  prev: NewsSnapshot | null,
  fresh: NewsSnapshot,
  attemptedAt: string,
  trigger = "manual"
): NewsSnapshotDecision {
  const total = countItems(fresh);
  const ok = isNewsSuccess(fresh);
  const attempt: NewsAttemptRecord = {
    ok,
    at: attemptedAt,
    source: fresh.source,
    trigger,
    total,
    error: ok ? null : (fresh.notes ?? "원인 미상"),
  };

  if (!ok && isNewsSuccess(prev)) {
    const kept = prev as NewsSnapshot;
    return {
      action: "keep",
      // date/updatedAt 은 건드리지 않는다 — 스케줄러 catch-up 이 이 두 값으로 '언제 자료인지'를 본다.
      // notes 는 매번 통째로 다시 쓴다(누적 append 금지 — 실패가 반복돼도 길이가 늘지 않는다).
      snapshot: { ...kept, notes: staleNote(kept, fresh, attemptedAt) },
      notify: false,
      attempt,
    };
  }

  return { action: "save", snapshot: fresh, notify: total > 0, attempt };
}

/** 보호 발동 시 스냅샷에 남길 안내문(화면·API·JSON 을 직접 열어본 사람 모두를 위한 것). */
function staleNote(kept: NewsSnapshot, fresh: NewsSnapshot, attemptedAt: string): string {
  return (
    `⚠️ ${fresh.date} 수집 실패(총 ${countItems(fresh)}건, source=${fresh.source}) → ` +
    `${kept.date} 스냅샷을 유지합니다. 마지막 시도 ${attemptedAt}. ` +
    `원인: ${fresh.notes ?? "원인 미상"}`
  );
}

/**
 * 뉴스 수집 실행: Claude Agent SDK 큐레이션 → 캐시 갱신 → (옵션)이메일.
 * 이력은 저장하지 않고 최신 스냅샷만 덮어쓴다. 단 실패한 회차는 덮어쓰지 않는다(decideNewsSnapshot).
 */
export async function refreshNews(
  opts: { trigger: string; notify?: boolean } = { trigger: "manual" }
): Promise<NewsSnapshot> {
  if (running) {
    log.warn(`뉴스 수집 진행 중 → ${opts.trigger} 중복 방지`);
    return getNewsSnapshot() ?? emptySnapshot();
  }
  running = true;
  const startedAt = new Date().toISOString();
  try {
    const date = localDate();
    const prev = getNewsSnapshot();
    const snapshot = await curateNews(date);
    const decision = decideNewsSnapshot(prev, snapshot, startedAt, opts.trigger);

    // action="keep" 이면 decision.snapshot 은 '직전 성공본 + 안내 notes'다(이번 빈 결과가 아니다).
    // 그래서 여기서 저장해도 기사 데이터는 덮이지 않는다 — 바뀌는 건 notes 뿐이다. 메모리만 갱신하면
    // 재시작 후 "왜 어제 날짜가 떠 있지?"를 설명할 안내가 사라지므로 디스크까지 반영한다.
    memo = decision.snapshot;
    saveToDisk(decision.snapshot);
    recordAttempt(decision.attempt);

    if (decision.action === "keep") {
      log.warn(
        `뉴스 수집 실패 → 기존 스냅샷 유지 [${opts.trigger}] ` +
          `(유지: ${decision.snapshot.date}, 원인: ${decision.attempt.error}) · 알림 발송 생략`
      );
      return decision.snapshot;
    }

    const total = decision.attempt.total ?? 0;
    // 기사가 0건이면 이메일을 보내지 않는다(빈 다이제스트 방지).
    if (opts.notify && decision.notify) {
      await sendNewsEmail(decision.snapshot).catch((e) =>
        log.warn(`뉴스 이메일 발송 예외: ${(e as Error).message}`)
      );
      await sendNewsIMessage(decision.snapshot); // 자체 게이트·자체 catch(throw 안 함)
    } else if (opts.notify) {
      log.info("뉴스 0건 → 이메일 발송 생략");
    }
    log.info(
      `뉴스 수집 완료 [${opts.trigger}] ${date} (총 ${total}건, source=${decision.snapshot.source})`
    );
    return decision.snapshot;
  } catch (e) {
    // 여기까지 예외가 올라오는 경우(카테고리 로드 실패 등)도 '실패한 시도'로 남긴다.
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

function emptySnapshot(): NewsSnapshot {
  return {
    date: localDate(),
    updatedAt: new Date().toISOString(),
    source: "empty",
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
