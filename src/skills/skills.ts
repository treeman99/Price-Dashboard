import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { localDate } from "../util/date.ts";
import { collectSkillRepos } from "./github.ts";
import {
  buildRankings,
  loadScans,
  loadStarsAt,
  previousSnapshotDate,
  saveScan,
  saveWeeklySnapshot,
} from "./store.ts";
import {
  attachSummaries,
  loadSummaryCache,
  mergeSummaries,
  pickSummaryTargets,
  summarizeSkillRepos,
} from "./curate.ts";
import { pruneDeadLinks, type PruneResult } from "./verify.ts";
import { attachAccess, scanRepos, type RepoScan } from "./scan.ts";
import { sendSkillsEmail, sendSkillsIMessage } from "../notify/skills-email.ts";
import { getSchedule } from "../scheduler/schedule-store.ts";
import { lastOccurrence, nextOccurrence } from "../../shared/schedule.ts";
import type { JobSchedule } from "../../shared/types.ts";
import type { SkillRepo, SkillsSnapshot } from "../../shared/skills.ts";

/**
 * 스킬 랭킹 주간 회차 오케스트레이션.
 *
 * 구조는 `src/news/news.ts` 를 그대로 본떴다(스냅샷 캐시 + 시도 기록 + 스냅샷 보호 + 동시 실행
 * 가드). 다른 점은 **주 1회**라는 것과, 화면에 나가는 숫자가 LLM 이 아니라 GitHub API 실측값과
 * 우리 DB 차분에서 나온다는 것뿐이다.
 *
 * 회차 1회의 순서:
 *   1. GitHub 검색으로 추적 풀(최대 SKILLS_TRACK_POOL)을 모은다
 *   2. 그 주 스냅샷을 DB 에 저장한다 (skill_repo_points — 증가 랭킹의 유일한 근거)
 *   3. 직전 스냅샷과 차분해 두 랭킹을 만든다 (첫 회차면 증가 랭킹은 빈 배열)
 *   4. 원문이 바뀐 항목만 LLM 으로 한국어 요약한다 (숫자는 절대 생성시키지 않는다)
 *   5. 스냅샷 보호 판정 후 캐시에 쓰고, 보호되지 않은 회차만 알림을 보낸다
 */

/** 최신 스냅샷 1개만 캐시한다(이력은 DB 의 skill_repo_points 가 갖는다). */
const SNAPSHOT_PATH = path.join(path.dirname(config.dbPath), "skills-latest.json");

/**
 * 마지막 수집 **시도**의 성패 기록(스냅샷과 별도 파일).
 *
 * 스냅샷에서 유도하지 않는 이유는 news.ts 와 같다 — 아래 스냅샷 보호가 발동하면 디스크에는
 * '직전 성공본'(지난주 것)이 그대로 남고, 그 상태에서 성패를 스냅샷으로만 유도하면
 * "마지막 시도 = 성공"으로 읽혀 스케줄러 백오프가 풀린다. 시도 기록은 스냅샷과 수명이 다르다.
 *
 * 메모리가 아니라 디스크인 이유도 같다 — launchd 상시 구동이라 재시작마다 리셋되면
 * 재시작 직후 catch-up 이 '기록 없음'에서 출발해 실패 이력을 잃는다.
 */
const ATTEMPT_PATH = path.join(path.dirname(config.dbPath), "skills-attempt.json");

let memo: SkillsSnapshot | null = null;
let attemptMemo: SkillsAttemptRecord | null = null;
let running = false;

/** 디스크에 남기는 시도 기록. 노출 계약(ok/at/source)보다 넓다 — 사후 추적용 필드 포함. */
interface SkillsAttemptRecord {
  ok: boolean;
  /** 시도 시작 시각(ISO) */
  at: string;
  /** 그 시도가 만든 스냅샷의 source */
  source: string;
  trigger?: string;
  /** 그 시도가 추적한 저장소 수 */
  tracked?: number;
  error?: string | null;
}

function loadFromDisk(): SkillsSnapshot | null {
  try {
    if (fs.existsSync(SNAPSHOT_PATH)) {
      return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")) as SkillsSnapshot;
    }
  } catch (e) {
    log.warn(`스킬 스냅샷 로드 실패: ${(e as Error).message}`);
  }
  return null;
}

/**
 * 스냅샷 저장. 임시 파일에 쓰고 rename 으로 바꾼다(원자적 교체).
 * 보호가 걸린 회차에도 notes 를 갱신하느라 파일을 다시 쓰므로, 중간에 프로세스가 죽어 부분
 * 기록이 남으면 **유일하게 남은 성공본**을 잃는다. news.ts 와 같은 이유·같은 방식이다.
 */
function saveToDisk(s: SkillsSnapshot): void {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    const tmp = `${SNAPSHOT_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, SNAPSHOT_PATH);
  } catch (e) {
    log.warn(`스킬 스냅샷 저장 실패: ${(e as Error).message}`);
  }
}

function loadAttemptFromDisk(): SkillsAttemptRecord | null {
  try {
    if (fs.existsSync(ATTEMPT_PATH)) {
      return JSON.parse(fs.readFileSync(ATTEMPT_PATH, "utf8")) as SkillsAttemptRecord;
    }
  } catch (e) {
    log.warn(`스킬 시도 기록 로드 실패: ${(e as Error).message}`);
  }
  return null;
}

/** 시도 기록 저장. 실패해도 수집 자체를 죽이지 않는다(기록은 부가정보). */
function recordAttempt(r: SkillsAttemptRecord): void {
  attemptMemo = r;
  try {
    fs.mkdirSync(path.dirname(ATTEMPT_PATH), { recursive: true });
    fs.writeFileSync(ATTEMPT_PATH, JSON.stringify(r, null, 2));
  } catch (e) {
    log.warn(`스킬 시도 기록 저장 실패: ${(e as Error).message}`);
  }
}

/**
 * 이 스냅샷이 '성공한 회차'인지.
 *
 * source 만 보지 않고 **건수까지** 보는 이유는 뉴스에서 실제로 데인 그대로다 — 0건 스냅샷이
 * source 만 정상으로 남으면 그것이 '이번 주는 커버됨'으로 읽혀 catch-up 이 영구 봉인된다.
 * 스킬 랭킹은 topic 4종에서 800건을 훑으므로 0건은 정의상 실패다.
 */
export function isSkillsSuccess(s: SkillsSnapshot | null | undefined): boolean {
  if (!s) return false;
  return s.source === "github" && s.byStars.length > 0;
}

/** 현재 캐시된 스냅샷 (메모리 우선, 없으면 디스크). API 라우트의 진입점이다. */
export function getSkillsSnapshot(): SkillsSnapshot | null {
  if (!memo) memo = loadFromDisk();
  return memo;
}

/** 현재 스킬 수집이 진행 중인지 (API 가 '수집 중' 안내에 사용). 수동·정시 수집 모두 반영. */
export function isSkillsCollecting(): boolean {
  return running;
}

/**
 * 스냅샷에서 시도 결과를 유도한다(시도 기록 파일이 아직 없을 때의 대체 경로).
 * 보호가 발동한 회차는 스냅샷만으로 성패를 알 수 없으므로 어디까지나 fallback 이다.
 */
export function deriveSkillsAttempt(
  s: SkillsSnapshot | null
): { ok: boolean; at: string; source: string } | null {
  if (!s) return null;
  return { ok: isSkillsSuccess(s), at: s.updatedAt, source: s.source };
}

/** 마지막 스킬 수집 시도의 성패. 스케줄러의 catch-up/백오프 판정용. */
export function getSkillsLastAttempt(): { ok: boolean; at: string; source: string } | null {
  if (!attemptMemo) attemptMemo = loadAttemptFromDisk();
  if (attemptMemo) {
    const { ok, at, source } = attemptMemo;
    return { ok, at, source };
  }
  return deriveSkillsAttempt(getSkillsSnapshot());
}

// ── 회차 경계 (스케줄러 catch-up 판정) ────────────────────────────────────────
//
// 스케줄 v2 이후 회차 시각은 `getSchedule().skills`(기본 매주 월요일 09:00)가 정본이다. 예전에는
// cron 식과 경계 계산이 shared/skills.ts 의 SKILLS_CYCLE_* 상수를 같이 봤는데, 이제는 스케줄러의
// cron 게이트(isDueDate)와 이 경계(lastOccurrence)가 **같은 스케줄 값**을 본다 — 어긋나면
// "cron 은 09:00 에 도는데 경계는 10:00 로 계산"되어 매 틱마다 보충이 돌거나 영영 안 돈다.

/**
 * 경계 계산용 스케줄. **켜기/끄기는 무시한다** — 꺼져 있어도 '이번 회차가 언제부터인가'는
 * 정의돼야 한다(꺼짐의 의미는 '자동으로 돌지 않음'이고, 보충을 막는 것은 스케줄러의 몫이다).
 */
function boundaryJob(job: JobSchedule): JobSchedule {
  return { ...job, enabled: true };
}

/**
 * 직전 회차 시각 경계(기본: 로컬 월요일 09:00). '놓친 실행'을 판정하는 기준선이다.
 * 유효한 스케줄이면 400일 안에 반드시 걸리므로 null 은 나오지 않지만, 만에 하나면 epoch 로
 * 접는다(= 무엇이든 커버로 본다 — 매 틱 20분짜리 보충이 도는 쪽보다 안전하다).
 */
export function lastSkillsCycleBoundary(
  now: Date = new Date(),
  job: JobSchedule = getSchedule().skills
): Date {
  return lastOccurrence(boundaryJob(job), now) ?? new Date(0);
}

/** 다음 자동 실행 예정 시각. 화면이 "다음 갱신"으로 보여준다. */
export function nextSkillsCycleAt(
  now: Date = new Date(),
  job: JobSchedule = getSchedule().skills
): Date {
  return nextOccurrence(boundaryJob(job), now) ?? new Date(0);
}

/**
 * occurrence(예정 시각) 이후의 회차가 **성공적으로** 커버돼 있는지(계약 §1.3 — 정상 결과의
 * updatedAt ≥ occurrence).
 *
 * ⚠️ 날짜만 비교하지 않는다. 실패 스냅샷(source="error")이 이번 주 날짜를 달고 있으면 날짜만
 *    보는 게이트는 그걸 커버로 오인해 그 주 재시도를 통째로 봉인한다(뉴스 탭 실측 사고).
 *    보호가 걸린 회차는 updatedAt 이 지난 회차 것이라 여기서 자연히 '미커버'로 잡히고,
 *    무한 재시도는 스케줄러의 백오프가 막는다.
 */
export function skillsCoveredSince(occurrence: Date): boolean {
  return snapshotCoversSince(getSkillsSnapshot(), occurrence);
}

/**
 * skillsCoveredSince 의 순수 판정. 중간 점검(`interim`)은 점검 시각이 아니라 **딛고 선 정식
 * 회차의 시각**으로 판정한다 — 월요일 08:59 에 시작한 점검이 09:05 에 끝나도 그 주 회차를
 * 돈 것은 아니다(shared/skills.ts 의 interim 주석).
 */
export function snapshotCoversSince(snap: SkillsSnapshot | null, occurrence: Date): boolean {
  if (!isSkillsSuccess(snap)) return false;
  const at = new Date(cycleUpdatedAt(snap!)).getTime();
  return Number.isFinite(at) && at >= occurrence.getTime();
}

/** 마지막 **정식 회차**가 끝난 시각(ISO). 중간 점검이면 그 점검이 딛고 선 회차의 시각이다. */
function cycleUpdatedAt(s: SkillsSnapshot): string {
  return s.interim?.cycleUpdatedAt ?? s.updatedAt;
}

/** 이번 회차(직전 경계 이후)가 성공적으로 커버돼 있는지. */
export function skillsCoveredThisWeek(now: Date = new Date()): boolean {
  return skillsCoveredSince(lastSkillsCycleBoundary(now));
}

// ── 수동 '지금 갱신' ─────────────────────────────────────────────────────────

/**
 * '지금 갱신' 한 번의 처리 방침(순수 판정).
 *
 * 증가 랭킹은 **기록된 회차끼리의 차분**이라, 버튼을 누를 때마다 스냅샷을 남기면 비교 기준이
 * 회차 사이 아무 날로 끌려온다(수요일에 누르면 다음 월요일 '주간 증가'가 5일치가 된다).
 * 그래서 이번 회차가 이미 기록돼 있으면 **중간 점검**(record=false)으로만 돌린다 — 지금 star 로
 * 순위를 다시 매겨 보여주되 DB 에는 남기지 않는다.
 *
 * 이번 회차가 아직 비어 있으면(맥이 자서 놓쳤거나 첫 수집 전) 이 버튼이 곧 그 회차다 —
 * 스케줄러 보충이 했을 일을 그대로 하므로 기록하고, 자동 실행이 켜져 있으면 알림도 보낸다
 * (안 보내면 그 회차 알림이 영영 사라진다 — 보충은 이제 '커버됨'을 보고 건너뛴다).
 * 회차당 한 번뿐이라 눌러 댈 때마다 메일이 나가는 일은 없다.
 */
export function decideManualRun(
  snap: SkillsSnapshot | null,
  boundary: Date,
  autoEnabled: boolean
): { record: boolean; notify: boolean } {
  if (snapshotCoversSince(snap, boundary)) return { record: false, notify: false };
  return { record: true, notify: autoEnabled };
}

/** '지금 갱신'(POST /api/skills/refresh). 판정은 실행 직전에 한다(decideManualRun). */
export function refreshSkillsNow(now: Date = new Date()): Promise<SkillsSnapshot> {
  const job = getSchedule().skills;
  const { record, notify } = decideManualRun(
    getSkillsSnapshot(),
    lastSkillsCycleBoundary(now, job),
    job.enabled
  );
  return refreshSkills({ trigger: record ? "manual" : "manual:interim", notify, record });
}

// ── 스냅샷 보호 ──────────────────────────────────────────────────────────────

/** refreshSkills 한 회차의 처리 방침(순수 판정 — 디스크/알림 부작용 없음). */
export interface SkillsSnapshotDecision {
  /** "save" = 이번 결과를 저장 / "keep" = 직전 스냅샷 유지(실패 결과의 덮어쓰기 차단) */
  action: "save" | "keep";
  /** 실제로 화면·API 에 노출할 스냅샷 */
  snapshot: SkillsSnapshot;
  /** 이번 회차 결과가 알림 대상인지 — opts.notify 와 AND 로 묶인다 */
  notify: boolean;
  /** 이번 시도의 성패 기록 */
  attempt: SkillsAttemptRecord;
}

/**
 * 스냅샷 보호 판정 — 뉴스(decideNewsSnapshot)와 같은 규칙이다.
 *
 * 1. 이번 결과가 실패성(byStars 0건 또는 source!=="github")이고 **직전이 성공**이면 유지한다.
 *    지난주 랭킹이 보이는 것이 빈 화면보다 낫다. 대신 notes 에 상황을 적어 날짜를 오해하지
 *    않게 한다(스키마는 그대로 두고 계약에 이미 있는 notes 만 쓴다).
 * 2. 직전이 없거나 직전도 실패성이면 이번 결과를 그대로 저장한다(첫 실행의 빈 화면은 정상).
 * 3. 보호가 걸린 회차는 **알림을 보내지 않는다** — 지난주 랭킹이 이번 주 메일로 또 오면 안 된다.
 *
 * 성패를 attempt 로 함께 돌려주어 스케줄러가 getSkillsLastAttempt() 로 백오프를 걸 수 있게
 * 한다(자기봉인과 무한 재시도를 동시에 막는 조합이다).
 */
export function decideSkillsSnapshot(
  prev: SkillsSnapshot | null,
  fresh: SkillsSnapshot,
  attemptedAt: string,
  trigger = "manual"
): SkillsSnapshotDecision {
  const ok = isSkillsSuccess(fresh);
  const attempt: SkillsAttemptRecord = {
    ok,
    at: attemptedAt,
    source: fresh.source,
    trigger,
    tracked: fresh.trackedCount,
    error: ok ? null : (fresh.notes ?? "원인 미상"),
  };

  if (!ok && isSkillsSuccess(prev)) {
    const kept = prev as SkillsSnapshot;
    return {
      action: "keep",
      // date/updatedAt 은 건드리지 않는다 — 스케줄러 catch-up 이 이 값으로 '언제 자료인지'를 본다.
      // notes 는 매번 통째로 다시 쓴다(누적 append 금지 — 실패가 반복돼도 길이가 늘지 않는다).
      snapshot: { ...kept, notes: staleNote(kept, fresh, attemptedAt) },
      notify: false,
      attempt,
    };
  }

  return { action: "save", snapshot: fresh, notify: ok, attempt };
}

/** 보호 발동 시 스냅샷에 남길 안내문(화면·API·JSON 을 직접 열어본 사람 모두를 위한 것). */
function staleNote(kept: SkillsSnapshot, fresh: SkillsSnapshot, attemptedAt: string): string {
  return (
    `⚠️ ${fresh.date} 수집 실패(${fresh.byStars.length}건, source=${fresh.source}) → ` +
    `${kept.date} 스냅샷을 유지합니다. 마지막 시도 ${attemptedAt}. ` +
    `원인: ${fresh.notes ?? "원인 미상"}`
  );
}

function emptySnapshot(date: string, source: "empty" | "error", note: string): SkillsSnapshot {
  return {
    date,
    updatedAt: new Date().toISOString(),
    source,
    trackedCount: 0,
    byStars: [],
    byGrowth: [],
    window: null,
    notes: note,
  };
}

// ── 회차 실행 ────────────────────────────────────────────────────────────────

/**
 * 스킬 랭킹 1회차: GitHub 수집 → 주간 스냅샷 저장 → 차분·랭킹 → 요약 → 캐시 → (옵션)알림.
 *
 * 실패한 회차는 직전 스냅샷을 덮어쓰지 않는다(decideSkillsSnapshot).
 */
export async function refreshSkills(
  opts: { trigger: string; notify?: boolean; record?: boolean } = { trigger: "manual" }
): Promise<SkillsSnapshot> {
  if (running) {
    log.warn(`스킬 수집 진행 중 → ${opts.trigger} 중복 방지`);
    return getSkillsSnapshot() ?? emptySnapshot(localDate(), "empty", "아직 수집되지 않았습니다.");
  }
  running = true;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  try {
    const date = localDate();
    const prev = getSkillsSnapshot();
    // record:false = 중간 점검(decideManualRun). 딛고 설 정식 회차가 없으면 점검이 성립하지 않으므로
    // 그때는 평소처럼 기록한다.
    const interim =
      opts.record === false && isSkillsSuccess(prev) ? { cycleUpdatedAt: cycleUpdatedAt(prev!) } : undefined;
    const fresh = await buildSnapshot(date, interim);
    const decision = decideSkillsSnapshot(prev, fresh, startedAt, opts.trigger);

    // action="keep" 이면 decision.snapshot 은 '직전 성공본 + 안내 notes'다(이번 실패 결과가
    // 아니다). 그래서 여기서 저장해도 랭킹 데이터는 덮이지 않고 notes 만 바뀐다. 메모리만
    // 갱신하면 재시작 후 "왜 지난주 날짜가 떠 있지?"를 설명할 안내가 사라지므로 디스크까지 쓴다.
    memo = decision.snapshot;
    saveToDisk(decision.snapshot);
    recordAttempt(decision.attempt);

    if (decision.action === "keep") {
      log.warn(
        `스킬 수집 실패 → 기존 스냅샷 유지 [${opts.trigger}] ` +
          `(유지: ${decision.snapshot.date}, 원인: ${decision.attempt.error}) · 알림 발송 생략`
      );
      return decision.snapshot;
    }

    if (opts.notify && decision.notify) {
      await sendSkillsEmail(decision.snapshot).catch((e) =>
        log.warn(`스킬 이메일 발송 예외: ${(e as Error).message}`)
      );
      await sendSkillsIMessage(decision.snapshot); // 자체 게이트·자체 catch(throw 안 함)
    } else if (opts.notify) {
      log.info("스킬 랭킹 0건 → 알림 발송 생략");
    }

    log.info(
      `스킬 랭킹 ${interim ? "중간 점검(기록 안 함)" : "회차"} 완료 [${opts.trigger}] ${date} — 추적 ${decision.snapshot.trackedCount}건, ` +
        `총합 ${decision.snapshot.byStars.length}위 / 증가 ${decision.snapshot.byGrowth.length}위` +
        (decision.snapshot.window
          ? ` (최근 ${decision.snapshot.window.days}일 비교)`
          : " (첫 회차 — 증가 랭킹 없음)") +
        ` (${Math.round((Date.now() - t0) / 1000)}초)`
    );
    return decision.snapshot;
  } catch (e) {
    // 여기까지 예외가 올라오는 경우(DB 오류 등)도 '실패한 시도'로 남긴다.
    recordAttempt({
      ok: false,
      at: startedAt,
      source: "error",
      trigger: opts.trigger,
      tracked: 0,
      error: (e as Error).message,
    });
    throw e;
  } finally {
    running = false;
  }
}

/**
 * 이번 회차 스냅샷 1건을 만든다. **예외를 던지지 않는다** — 실패는 source="error" 스냅샷으로
 * 돌려주고, 그걸 받은 refreshSkills 가 보호 판정을 거쳐 지난주 랭킹을 지킨다.
 * `interim` 이 있으면 중간 점검이다 — 순위는 똑같이 매기되 DB 스냅샷은 남기지 않는다.
 */
async function buildSnapshot(
  date: string,
  interim?: SkillsSnapshot["interim"]
): Promise<SkillsSnapshot> {
  let collected;
  try {
    collected = await collectSkillRepos();
  } catch (e) {
    log.error(`스킬 저장소 수집 실패: ${(e as Error).message}`);
    return emptySnapshot(date, "error", `GitHub 수집 실패: ${(e as Error).message}`);
  }

  const { repos, warnings } = collected;

  // 1) 주간 스냅샷 저장. **랭킹보다 먼저** 한다 — 뒤의 LLM 요약이 실패하더라도 그 주의 관측값은
  //    남아야 다음 주 차분이 성립한다. 요약 때문에 star 이력에 구멍이 나면 복구할 방법이 없다.
  //    중간 점검은 저장하지 않는다 — 남기면 그 날짜가 다음 회차의 비교 기준이 된다.
  const trackedCount = interim ? repos.length : saveWeeklySnapshot(date, repos);

  // 2) 차분. 직전 스냅샷이 없으면 첫 회차 — 증가 랭킹은 빈 배열, window 는 null 이다.
  const prevDate = previousSnapshotDate(date);
  const prevPrevDate = prevDate ? previousSnapshotDate(prevDate) : null;
  const rankingInput = {
    date,
    prevDate,
    prevStars: loadStarsAt(prevDate),
    prevPrevStars: prevPrevDate ? loadStarsAt(prevPrevDate) : null,
  };

  // 2-1) 링크 생사 검증. **순위를 매기기 전**에 죽은 저장소를 풀에서 뺀다 — 순위 뒤에 빼면
  //      1~50위에 구멍이 생기고 그 자리를 채웠어야 할 다음 후보가 올라오지 못한다.
  //      검증 대상은 노출 후보(두 랭킹 TOP 50 의 합집합)뿐이고, 죽은 것을 빼면 새로 올라온
  //      후보만 추가로 두드린다(verify.ts 의 라운드 루프).
  //
  //      ⚠️ 검증 단계의 예외가 회차를 죽이면 안 된다. 링크 확인은 목록을 다듬는 부가 장치이지
  //         수집 결과를 폐기할 권한이 있는 장치가 아니다 — 터지면 검증 없이 그대로 간다.
  let live = repos;
  let prune: PruneResult | null = null;
  try {
    prune = await pruneDeadLinks(repos, (pool) => {
      const r = buildRankings({ ...rankingInput, repos: pool });
      const byId = new Map<number, SkillRepo>();
      for (const e of [...r.byStars, ...r.byGrowth]) byId.set(e.repo.id, e.repo);
      return [...byId.values()];
    });
    live = prune.repos;
  } catch (e) {
    log.warn(`스킬 링크 검증 실패 → 검증 없이 진행: ${(e as Error).message}`);
  }

  const ranking = buildRankings({ ...rankingInput, repos: live });

  // 3) 네트워크 접근 스캔. 노출 후보(두 랭킹 TOP 50 의 합집합)의 SKILL.md 를 실제로 읽어
  //    "로컬 전용인가 / 외부로 나가는가"를 판정한다. 링크 사망 검증을 **통과한 뒤**라서
  //    죽은 저장소를 두드리지 않는다. 실패해도 회차를 죽이지 않는다(태그만 안 붙는다).
  //    기본 브랜치는 검색 응답에 이미 들어 있던 값을 그대로 넘긴다 — 이걸 안 넘기면 스캐너가
  //    main → master 를 찍어 보다가 **낡은 비기본 브랜치의 파일로 판정**한다(실측 3건).
  const shownRepos = dedupeById([...ranking.byStars, ...ranking.byGrowth].map((e) => e.repo));
  const scanned = await scanAccess(shownRepos, collected.defaultBranches);
  const scans = scanned.scans;

  // 4) 요약. 노출되는 두 랭킹의 합집합 중 **원문이 바뀐 것만** LLM 을 태운다.
  const shown = [...ranking.byStars, ...ranking.byGrowth];
  const shownIds = [...new Set(shown.map((e) => e.repo.id))];
  const cached = loadSummaryCache(shownIds);
  const targets = pickSummaryTargets(ranking.byStars, ranking.byGrowth, cached);
  const fresh = await summarizeSkillRepos(targets);
  const summaries = mergeSummaries(
    shown.map((e) => e.repo),
    cached,
    fresh
  );

  return {
    date,
    updatedAt: new Date().toISOString(),
    source: "github",
    trackedCount,
    byStars: attachAccess(attachSummaries(ranking.byStars, summaries), scans),
    byGrowth: attachAccess(attachSummaries(ranking.byGrowth, summaries), scans),
    window: ranking.window,
    notes: buildNotes(warnings, prune, scanned.budgetSkipped),
    ...(interim ? { interim } : {}),
  };
}

/** id 로 중복 제거(두 랭킹에 같은 저장소가 동시에 오르는 것이 정상이다). */
function dedupeById(repos: SkillRepo[]): SkillRepo[] {
  const byId = new Map<number, SkillRepo>();
  for (const r of repos) byId.set(r.id, r);
  return [...byId.values()];
}

/**
 * 노출 후보의 네트워크 접근을 판정한다. **예외를 던지지 않는다.**
 *
 * ★ 캐시 키는 `pushed_at` 이다. 파일 목록을 얻는 git/trees 호출이 스캔의 유일한 core 쿼터
 *   소비 지점이고 그 쿼터는 무인증 60회/시간뿐이라, 마지막 푸시가 그대로인 저장소를 걸러내는
 *   것이 매주 도는 유일한 방법이다(첫 회차만 50회 남짓, 그 뒤로는 그 주에 푸시된 것만).
 *
 * ★ fail-open: 스캔이 통째로 터져도 빈 맵을 돌려준다. 그러면 access 가 없는 스냅샷이 되고,
 *   화면은 칩을 그리지 않는다 — 태그 하나 때문에 그 주 랭킹을 잃을 이유가 없다.
 */
async function scanAccess(
  repos: SkillRepo[],
  defaultBranches: Map<number, string>
): Promise<{ scans: Map<number, RepoScan>; budgetSkipped: number }> {
  if (repos.length === 0) return { scans: new Map(), budgetSkipped: 0 };
  try {
    const cache = loadScans(repos.map((r) => r.id));
    const hits = new Set<number>();
    const summary = await scanRepos(
      repos,
      (repo) => {
        const hit = cache.get(repo.id);
        // pushed_at 이 다르면 파일이 바뀌었을 수 있다 → 다시 본다.
        // (신호 정의가 바뀐 행은 loadScans 가 이미 걸러 내므로 여기서 다시 볼 필요가 없다.)
        if (!hit || (hit.pushedAt ?? "") !== (repo.pushedAt ?? "")) return null;
        hits.add(repo.id);
        return {
          repoId: repo.id,
          fullName: repo.fullName,
          branch: null, // 캐시에는 브랜치를 남기지 않는다(판정에 쓰이지 않는다)
          access: hit.access,
          units: hit.units,
        };
      },
      { defaultBranch: (repo) => defaultBranches.get(repo.id) ?? null }
    );

    // 새로 조회한 것만 저장한다(캐시 적중분을 다시 쓰면 scanned_at 이 매주 갱신돼
    // "언제 실제로 읽었나"를 잃는다). kind="unknown" 은 saveScan 이 스스로 거른다.
    const now = new Date().toISOString();
    for (const repo of repos) {
      if (hits.has(repo.id)) continue;
      const s = summary.scans.get(repo.id);
      if (!s) continue;
      saveScan({
        repoId: repo.id,
        pushedAt: repo.pushedAt || null,
        scannedAt: now,
        access: s.access,
        units: s.units,
      });
    }
    return { scans: summary.scans, budgetSkipped: summary.budgetSkipped };
  } catch (e) {
    log.warn(`스킬 네트워크 스캔 실패 → 접근 태그 없이 진행: ${(e as Error).message}`);
    return { scans: new Map(), budgetSkipped: 0 };
  }
}

/**
 * 화면·메일에 띄울 **이상 상황 안내**. 정상 회차에는 undefined 를 돌려준다.
 *
 * notes 는 SkillsBoard 에서 앰버 경고 배너로 그대로 렌더링된다. 그래서 여기에 상시 정보를
 * 한 줄이라도 넣으면 배너가 평상시에도 켜져 있게 되는데, 이 저장소는 그 위험을 App.tsx 의
 * 가동 중단 배너 주석에 이미 못 박아 뒀다 —
 *
 *   "★ 평상시에는 아무것도 렌더링되지 않는다. 화면은 이 기능이 없던 때와 100% 동일하다.
 *     이 성질이 깨지면 사용자가 배너를 배경으로 학습해 버려서, 정작 진짜 사고 때 읽지 않는다."
 *
 * 스킬 탭도 같은 규칙을 따른다. 그래서 notes 에는 **이상 상황만** 남긴다.
 *
 * 여기서 뺀 두 문장은 정보가 사라진 것이 아니다:
 *   - 추적 저장소 수 → `SkillsSnapshot.trackedCount` 를 화면이 각주로 이미 렌더링한다.
 *   - 첫 회차 안내   → 화면에 `window === null` 전용 빈 상태 문구가 이미 있다(경고색 없이).
 * 둘 다 notes 로 또 내보내면 같은 말이 두 번 나오고, 그중 하나가 경고색으로 뜬다.
 *
 * (스냅샷 보호 안내는 여기가 아니라 staleNote() 가 별도로 덮어쓴다 — 그쪽은 진짜 이상 상황이다.)
 */
export function buildNotes(
  warnings: string[],
  prune: PruneResult | null,
  scanBudgetSkipped = 0
): string | undefined {
  const parts: string[] = [];
  // 제외 건수를 남긴다 — 조용히 사라지면 "왜 그 저장소가 없지?"를 나중에 답할 수 없다.
  if (prune && prune.removed.length > 0) {
    parts.push(
      `링크 사망 확인 ${prune.removed.length}건 제외(${prune.removed
        .slice(0, 5)
        .map((r) => r.fullName)
        .join(", ")}${prune.removed.length > 5 ? " 외" : ""}).`
    );
  }
  if (prune && prune.unknown > 0) {
    parts.push(
      `링크 판정 불가 ${prune.unknown}건은 목록에 그대로 뒀습니다(네트워크 사정으로 목록을 지우지 않습니다).`
    );
  }
  // GitHub 쿼터가 모자라 접근을 못 본 건수. **'로컬'이 아니라 '판정 불가'** 라는 사실을 적는다 —
  // 이 구분이 무너지면 사용자가 안 본 저장소를 로컬로 믿는다(그 오류를 막자고 만든 기능이다).
  if (scanBudgetSkipped > 0) {
    parts.push(
      `GitHub 쿼터가 모자라 ${scanBudgetSkipped}건은 네트워크 접근을 판정하지 못했습니다` +
        `(로컬로 단정하지 않고 '판정 불가'로 뒀습니다. GITHUB_TOKEN 을 설정하면 사라집니다).`
    );
  }
  if (warnings.length) {
    parts.push(`일부 검색이 실패해 후보가 줄었을 수 있습니다: ${warnings.join(" / ")}`);
  }
  // 이상 없음 = undefined. 화면 배너가 저절로 꺼진다.
  return parts.length ? parts.join(" ") : undefined;
}
