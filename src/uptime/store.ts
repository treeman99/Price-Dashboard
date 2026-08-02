/**
 * 가동 중단 사후 보고 — **저장소**(사건 원장 + 사람이 읽는 일지).
 *
 * ## 이 모듈이 지는 책임 (명세 §5.2 / §5.3 / §3.6)
 * 1. `data/downtime-events.json` — 기계용 사건 원장. 100건 · 180일로 회전.
 * 2. `data/downtime.log` — **사용자가 직접 열어보는 한국어 일지**(§6.1 포맷). 200건 보관.
 * 3. §3.6 사건 병합 — DarkWake 파편화와 크래시 루프를 한 메커니즘으로 죽인다.
 * 4. ack / 알림 상태 기록, `getDowntimeView()`(P1 API 가 그대로 내려보낼 화면 상태).
 *
 * ## 지지 않는 책임 (여기서 찾지 말 것)
 * - **한국어 문장**: headline/body/reasonLine/일지 항목/일지 헤더는 전부 `narrate.ts` 의 몫이다.
 *   이 파일은 그것들을 `DowntimeNarrator` 로 **주입받는다**(아래 인터페이스 주석에 이유).
 * - **판정**: `classify.ts`. - **증거 수집**: `evidence.ts`. - **놓친 슬롯**: `missed.ts`.
 * - **비컨 파일**(`uptime-beacon.json`): `beacon.ts` 소유. 이 파일은 손대지 않는다.
 *
 * ## 절대 규칙 세 가지 (명세 §5.2 경고 + 작업 지시)
 * - 모든 쓰기는 **tmp + fsync + rename**. 사건 원장은 잃으면 복원 경로가 없다.
 * - **쓰기 실패는 절대 throw 하지 않는다.** 진단 기능이 서비스를 죽이면 본말전도다.
 *   실패는 `writeFailures` 에 누적하고 `log.warn` 한 줄만 남긴다.
 * - **`data/` 안에서 `unlink` 를 부르지 않는다.** `price.db` 와 20여 개 스냅샷이 같은
 *   디렉터리에 산다. 회전은 JSON 배열의 원소를 자르는 것과 텍스트 파일을 다시 쓰는 것뿐이다.
 *   (유일한 예외가 tmp 파일인데, 그것도 `rename` 으로 소비되지 `unlink` 되지 않는다.)
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { localDate } from "../util/date.ts";
import {
  DOWNTIME_EVENTS_FILE,
  DOWNTIME_JOURNAL_FILE,
  DOWNTIME_LEDGER_VERSION,
  DOWNTIME_MENTAL_MODEL_NOTE,
  JOURNAL_MAX_ENTRIES,
  LEDGER_MAX_AGE_DAYS,
  LEDGER_MAX_EVENTS,
  MERGE_WINDOW_MS,
  MIN_GAP_MS,
  severityFor,
  sleepWindowCoversGap,
} from "../../shared/uptime.ts";
import type {
  DowntimeConfidence,
  DowntimeEvent,
  DowntimeEvidence,
  DowntimeLedger,
  DowntimeNotifyState,
  DowntimeRecoveryState,
  DowntimeSource,
  DowntimeView,
  MissedSlot,
  SleepWindow,
  Verdict,
} from "../../shared/uptime.ts";

// ────────────────────────────────────────────────────────────────────────────
// 0. 경로
// ────────────────────────────────────────────────────────────────────────────

/**
 * 저장 위치는 저장소 관례 `path.dirname(config.dbPath)` = `data/`(§5).
 *
 * `logs/` 에 두지 않는 이유: 거기는 launchd 소유라 로그 정리 한 번에 **다음 사고 전체**를
 * 놓친다. `data/` 는 이미 `.gitignore` 대상이다.
 *
 * 모듈 로드 시점에 경로만 계산하고 I/O 는 하지 않는다 — 테스트가 `DB_PATH` 를 임시 경로로
 * 바꾼 뒤 동적 import 하는 저장소 관례(`src/util/model-store.test.ts:9`)를 그대로 쓸 수 있다.
 */
const DATA_DIR = path.dirname(config.dbPath);

/** `data/downtime-events.json` 절대경로. */
export const DOWNTIME_LEDGER_PATH = path.join(DATA_DIR, DOWNTIME_EVENTS_FILE);

/**
 * `data/downtime.log` 절대경로.
 *
 * ★ stdout 경고(§6.2)와 iMessage 본문(§6.3)에 **절대경로를 항상 병기**해야 한다.
 * 상대경로는 폰에서 열 수 없어 알림이 도달해도 정보에는 도달하지 못한다. 그래서 문구를
 * 만드는 쪽이 매번 조립하지 않도록 여기서 값으로 내보낸다.
 */
export const DOWNTIME_JOURNAL_PATH = path.join(DATA_DIR, DOWNTIME_JOURNAL_FILE);

// ────────────────────────────────────────────────────────────────────────────
// 1. 내레이터 주입 계약
// ────────────────────────────────────────────────────────────────────────────

/**
 * 한국어 문구 공급자 — 구현체는 `src/uptime/narrate.ts`, 배선은 `src/uptime/index.ts`.
 *
 * ## 왜 `narrate.ts` 를 직접 import 하지 않는가 (비자명한 결정이라 근거를 남긴다)
 * 1. **문구와 저장은 수명이 다르다.** 병합(§3.6)과 재평가 패치(§8.5)는 저장된 사건의
 *    `missed`/`recoveryState` 를 바꾸고 **문구를 다시 만들어야** 하는데, 그 규칙을 store 가
 *    알면 §6 문구가 두 파일로 복제된다. `shared/lotto.ts` 가 채점 규칙을 한 곳에 둔 것과
 *    같은 이유다 — 복제되면 조용히 갈라진다.
 * 2. **일지 전체 재작성이 가능해진다.** 재평가는 이미 파일에 적힌 항목을 갱신해야 하는데,
 *    원장 사건에서 항목을 **다시 렌더**할 수 있어야 그게 성립한다(아래 `rewriteJournal`).
 * 3. 테스트에서 가짜 내레이터를 넣어 저장·회전·병합만 격리 검증할 수 있다.
 *
 * ★ 구현 측 계약: `journalEntry()` 가 돌려주는 블록의 **첫 줄은 반드시 `[YYYY-MM-DD HH:mm`
 *   로 시작**해야 한다(§6.1 고정 포맷). 일지 재작성이 "이 블록이 원장에서 다시 만들어진
 *   것인지, 원장에서 이미 밀려난 옛 기록인지"를 그 시각으로 가른다.
 */
export interface DowntimeNarrator {
  /** 사건 하나의 headline / body / reasonLine(§6.1). 입력을 변형하지 않는다. */
  narrate(e: DowntimeEvent): { headline: string; body: string; reasonLine: string };
  /**
   * §6.1 일지 사건 항목 블록 전문. 첫 줄은 `[YYYY-MM-DD HH:mm …`.
   * 끝의 빈 줄은 있어도 없어도 된다 — store 가 정규화한다.
   */
  journalEntry(e: DowntimeEvent): string;
  /** 파일 맨 앞 영구 헤더(§6.1). 생략하면 아래 기본 헤더를 쓴다. */
  journalHeader?(): string;
  /**
   * 이미 적힌 일지 본문을 **항목 배열로 되읽는** 역함수(헤더 제외).
   *
   * `narrate.ts` 가 `splitJournalEntries()` 로 내주는 함수를 그대로 꽂으면 된다. 포맷을
   * 만드는 쪽이 되읽는 쪽도 가지고 있어야 둘이 조용히 갈라지지 않는다 —
   * 원장(100건)보다 일지(200항목)가 길어서 **원장에서 이미 밀려난 옛 항목을 텍스트로
   * 보존**해야 하는데, 그 경계를 잘못 읽으면 남의 기록을 먹는다.
   * 생략하면 store 의 기본 파서를 쓴다(현재 포맷과 동치, 아래 `splitJournal`).
   */
  splitEntries?(text: string): string[];
}

/**
 * 내레이터가 헤더를 주지 않을 때의 기본 영구 헤더.
 *
 * ## 명세와 다르게 한 점 (근거)
 * §6.1 은 헤더를 3줄로 적었고 §6.4 는 "P0 = 일지 헤더" 라며 **다른 3줄**(배터리 47% 실측이
 * 들어간 쪽)을 적었다. 둘은 같은 문장의 두 초안이다. 여기서는 §6.1 의 첫 줄(파일의 성격을
 * 설명하는 줄)에 §6.4 원문(`DOWNTIME_MENTAL_MODEL_NOTE`)을 붙여 **4줄**로 쓴다:
 * - §6.4 를 shared 상수에서 그대로 가져오므로 P1 이력 화면 하단과 **한 글자도 갈라지지 않는다**
 *   (그게 shared 에 그 상수를 둔 이유다).
 * - §6.1 3줄은 §6.4 의 부분집합이라 이 조합으로 잃는 정보가 없다.
 */
const DEFAULT_JOURNAL_HEADER = [
  "# 가동 중단 기록 — 자동 수집이 멈췄던 구간만 적힙니다. 아무 일 없으면 이 파일은 늘어나지 않습니다.",
  ...DOWNTIME_MENTAL_MODEL_NOTE.split("\n").map((l) => `# ${l}`),
].join("\n");

// ────────────────────────────────────────────────────────────────────────────
// 2. 원자적 쓰기 + 실패 카운터
// ────────────────────────────────────────────────────────────────────────────

/**
 * 이 모듈의 누적 쓰기 실패 횟수.
 *
 * ⚠️ `DowntimeEvidence.beaconWriteFailures`(비컨 쓰기 실패, §3.4)와 **다른 값**이다. 그쪽은
 * "사망 시각 기록이 얼마나 믿을 만한가"를 재는 신호라 confidence 를 내리는 데 쓰이고,
 * 이쪽은 "사후 보고 자체가 디스크에 남았는가"다. 섞으면 판정 근거가 오염된다.
 */
let writeFailures = 0;

/** 지금까지의 저장 실패 누적 횟수(진단·테스트용). */
export function getStoreWriteFailures(): number {
  return writeFailures;
}

/**
 * tmp 파일에 쓰고 → fsync → rename 으로 교체한다. **성공 여부를 boolean 으로만 돌려준다.**
 *
 * fsync 를 거는 이유는 비컨과 같다(§5.1): 전원이 끊기면 rename 은 반영됐는데 내용은
 * 페이지캐시에만 있어 **0바이트 파일**이 남을 수 있다. 사건 원장은 잃으면 복원 경로가 없고
 * 일지는 사용자가 직접 여는 산출물이라, 사고 직후에 비는 것이 가장 나쁜 실패다.
 * 실측 비용은 수 ms 이고 사건이 있을 때만 부르므로 상시 비용은 0이다.
 */
function writeFileAtomicSync(target: string, data: string): boolean {
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, data, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    return true;
  } catch (e) {
    writeFailures += 1;
    log.warn(
      `가동 중단 기록 저장 실패(${path.basename(target)}, 누적 ${writeFailures}회): ${(e as Error).message}`
    );
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 3. 시각 표기
// ────────────────────────────────────────────────────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * 로컬 오프셋을 붙인 ISO 문자열(`2026-08-02T00:29:10+09:00`).
 *
 * `toISOString()`(UTC Z)을 쓰지 않는 이유: `id`/`gapStart`/`gapEnd` 는 사람이 원장을 열어
 * 사고 시각을 눈으로 확인하는 필드다(§5.2). UTC 로 적으면 "새벽 0시 29분 사건"이
 * `2026-08-01T15:29Z` 로 보여 매번 9시간을 암산해야 한다. 반대로 `updatedAt` 은 기계용이라
 * 명세 예시대로 UTC ISO 를 그대로 쓴다.
 */
function isoWithOffset(ms: number): string {
  const d = new Date(ms);
  const offMin = -d.getTimezoneOffset(); // KST = +540
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/** ISO 문자열 → epoch ms. 파싱 실패는 `null`(사건을 조용히 버리지 않기 위해 호출부에서 처리). */
function isoToMs(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// ────────────────────────────────────────────────────────────────────────────
// 4. 원장 읽기 / 쓰기 / 회전
// ────────────────────────────────────────────────────────────────────────────

function emptyLedger(): DowntimeLedger {
  return { v: DOWNTIME_LEDGER_VERSION, events: [] };
}

/**
 * 원장을 디스크에서 읽는다. **메모리 캐시를 두지 않는다.**
 *
 * 캐시하지 않는 이유: 파일 상한이 100건 ≈ 150KB 라 파싱이 1ms 수준이고, P1 대시보드가
 * 60초 폴링으로 부르는 정도의 빈도다. 반면 캐시를 두면 "원장은 갱신됐는데 화면은 옛 값"
 * 같은 실패가 사고 직후에만 나타나는 방식으로 숨는다. 싼 쪽을 택한다.
 */
export function loadDowntimeLedger(): DowntimeLedger {
  let raw: string;
  try {
    if (!fs.existsSync(DOWNTIME_LEDGER_PATH)) return emptyLedger();
    raw = fs.readFileSync(DOWNTIME_LEDGER_PATH, "utf8");
  } catch (e) {
    log.warn(`가동 중단 원장 읽기 실패: ${(e as Error).message}`);
    return emptyLedger();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DowntimeLedger> | null;
    const events = Array.isArray(parsed?.events) ? (parsed.events as DowntimeEvent[]) : [];
    // 정렬만 정규화한다. 필드 검증을 여기서 하지 않는 이유: 원장은 우리만 쓰고, 어설픈
    // 검증으로 옛 스키마 사건을 통째로 버리면 "이 기능이 오탐하나"를 반증할 근거가 사라진다.
    return { v: typeof parsed?.v === "number" ? parsed.v : DOWNTIME_LEDGER_VERSION, events: sortNewestFirst(events) };
  } catch (e) {
    // JSON 이 깨졌다. **지우지 않는다** — `.broken` 으로 옆에 밀어 두고 새 원장으로 출발한다.
    // 깨진 파일을 그대로 두면 이후 모든 기록이 영영 막히고, 지워 버리면 무엇이 깨졌는지
    // 알 길이 없다. (unlink 금지 조항은 지킨다 — rename 이지 삭제가 아니다.)
    log.warn(`가동 중단 원장 JSON 손상: ${(e as Error).message} → ${DOWNTIME_LEDGER_PATH}.broken 으로 보존`);
    try {
      fs.renameSync(DOWNTIME_LEDGER_PATH, `${DOWNTIME_LEDGER_PATH}.broken`);
    } catch {
      /* 보존조차 실패하면 그냥 진행한다. 다음 저장이 덮어쓴다. */
    }
    return emptyLedger();
  }
}

/** `gapStart` 내림차순(최신이 앞, §5.2). 파싱 못 하는 값은 가장 오래된 것으로 민다. */
function sortNewestFirst(events: readonly DowntimeEvent[]): DowntimeEvent[] {
  return [...events].sort((a, b) => (isoToMs(b.gapStart) ?? 0) - (isoToMs(a.gapStart) ?? 0));
}

/**
 * 100건 · 180일 회전(§5.2). 초과분은 **오래된 것부터** 절삭한다.
 *
 * ★ 안전장치: 나이 절삭이 목록을 통째로 비우지 못하게 최신 1건은 무조건 남긴다.
 * 시스템 시계가 크게 앞으로 튀면(§12.2-12) 방금 기록한 사건이 즉시 "180일 전"이 되어
 * 사라질 수 있는데, 그게 바로 사후 보고가 가장 필요한 순간이다.
 */
function rotate(events: readonly DowntimeEvent[]): DowntimeEvent[] {
  const sorted = sortNewestFirst(events);
  const cutoff = Date.now() - LEDGER_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const aged = sorted.filter((e, i) => {
    if (i === 0) return true;
    const t = isoToMs(e.gapStart);
    return t == null || t >= cutoff; // 시각을 못 읽는 사건은 보존 쪽으로 접는다
  });
  return aged.slice(0, LEDGER_MAX_EVENTS);
}

/** 원장을 통째로 저장한다(회전 포함). 실패해도 throw 하지 않는다. */
function saveLedger(events: readonly DowntimeEvent[]): DowntimeEvent[] {
  const kept = rotate(events);
  writeFileAtomicSync(
    DOWNTIME_LEDGER_PATH,
    `${JSON.stringify({ v: DOWNTIME_LEDGER_VERSION, events: kept } satisfies DowntimeLedger, null, 2)}\n`
  );
  return kept;
}

// ────────────────────────────────────────────────────────────────────────────
// 5. 조회 API
// ────────────────────────────────────────────────────────────────────────────

/** 최신순 사건 목록. `GET /api/downtime/history?limit=50` 용(P1). */
export function listDowntimeEvents(limit?: number): DowntimeEvent[] {
  const all = loadDowntimeLedger().events;
  return limit != null && limit > 0 ? all.slice(0, limit) : all;
}

/** id 로 사건 1건. 없으면 null. */
export function getDowntimeEvent(id: string): DowntimeEvent | null {
  return loadDowntimeLedger().events.find((e) => e.id === id) ?? null;
}

/**
 * 대시보드가 한 번에 받아 가는 상태(§5.4 / §6.5).
 *
 * - `current`  = **배너 1건**. §3.5 표에서 배너가 켜지는 등급은 `사고` 뿐이므로 미확인
 *   `사고` 중 최신 1건. 없으면 null(= 평상시 화면은 지금과 100% 동일).
 * - `unackedCount` = **헤더 배지 숫자**. 배지는 `사고`·`기록만` 둘 다 켜지므로 `무시` 만 뺀다.
 *
 * 둘을 나눈 이유는 §6.5 그대로다 — 이 맥은 `Battery: sleep 1`(유휴 1분)이라 밤샘 절전이
 * 아침 슬롯을 덮는 게 기본값일 수 있어, 연속 발생 시 배지만 올리고 배너는 하루 1회로
 * 제한한다(그 하루 1회 제한은 화면 쪽 규칙이다).
 */
export function getDowntimeView(): DowntimeView {
  const events = loadDowntimeLedger().events;
  const unacked = events.filter((e) => e.ackedAt == null && e.severity !== "무시");
  return {
    current: unacked.find((e) => e.severity === "사고") ?? null,
    unackedCount: unacked.length,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 6. 사건 생성 · 병합 (§3.6)
// ────────────────────────────────────────────────────────────────────────────

/** 사건 하나를 만들기 위해 호출부(`index.ts`)가 모아 오는 재료. */
export interface DowntimeEventInput {
  /** `tick`(T1, 절전) | `boot`(T2, 재시작). §1. */
  source: DowntimeSource;
  /** `classify()` 의 결과. */
  verdict: Verdict;
  /** 공백 시작(epoch ms) = 마지막 생존 시각. */
  gapStartMs: number;
  /** 공백 끝(epoch ms) = 감지 시각. */
  gapEndMs: number;
  /** 원장에 **동결 저장**할 증거(§5.2). */
  evidence: DowntimeEvidence;
  /**
   * 병합 2번 조건("같은 pmset Sleep 윈도 안") 판정 전용. 원장에는 저장하지 않는다 —
   * `pmsetLines` 에서 파생되는 값이라 이중 저장할 이유가 없다(§4.4 / shared 주석).
   */
  sleepWindows?: readonly SleepWindow[];
  /** `describeMissedSlots()` 결과(§8). */
  missed: MissedSlot[];
  /** 생략하면 `복구중`(사건 직후 기본값, §8.5). */
  recoveryState?: DowntimeRecoveryState;
}

/**
 * 이 공백을 **직전 사건에 병합해야 하는가**(§3.6). 대상이 있으면 그 사건, 없으면 null.
 *
 * 조건은 명세 그대로 둘 중 하나:
 * 1. `newGapStart - lastEvent.gapEnd ≤ 15분` **이고** cause 가 같다
 * 2. 두 공백이 **같은 pmset Sleep 윈도** 안에 있다
 *
 * 2번에 cause 동일 조건이 없는 것은 명세 그대로다. 실제로 무해한데, 두 공백이 한 Sleep
 * 윈도 안에 들어갔다는 것은 그 사이 부팅이 없었다는 뜻이라 전원 계열 cause 가 나올 수 없다.
 *
 * ★ 호출부에 대한 계약: 병합될 것 같으면 `describeMissedSlots()` 를 **병합된 창 전체**로
 *   다시 돌려 넘기는 편이 정확하다. 다만 넘기지 않아도 손실이 사라지지는 않는다 —
 *   `recordDowntimeEvent()` 가 기존 `missed` 와 합집합을 취한다(아래 `mergeMissed`).
 */
export function findDowntimeMergeTarget(
  input: Pick<DowntimeEventInput, "verdict" | "gapStartMs" | "gapEndMs" | "sleepWindows">,
  ledger: readonly DowntimeEvent[] = loadDowntimeLedger().events
): DowntimeEvent | null {
  const last = ledger[0]; // sortNewestFirst 보장
  if (!last) return null;
  const lastStart = isoToMs(last.gapStart);
  const lastEnd = isoToMs(last.gapEnd);
  if (lastStart == null || lastEnd == null) return null;

  // ★ 뒤로만 병합한다. 새 공백이 직전 사건의 시작보다 **크게 앞서** 시작했다면 병합하면
  //   안 된다 — id·gapStart 는 불변이라(§3.6) 그 공백의 진짜 시작 시각이 조용히 사라진다.
  //   15분 여유를 두는 이유는 틱(T1)과 기동 부검(T2)이 같은 구간을 최대 한 틱 어긋나게
  //   볼 수 있기 때문이다.
  if (input.gapStartMs < lastStart - MERGE_WINDOW_MS) return null;

  // 조건 1 — 15분 창 + 같은 cause. 음수(새 공백이 직전 사건 안에 있음)도 병합 대상이다:
  // 재기동 부검(T2)이 틱(T1)이 이미 적어 둔 구간을 다시 보는 경우가 그렇다.
  if (last.cause === input.verdict.cause && input.gapStartMs - lastEnd <= MERGE_WINDOW_MS) return last;

  // 조건 2 — 같은 Sleep 윈도가 두 공백을 모두 덮는다. shared 의 술어를 그대로 쓴다
  // (여기서 다시 구현하면 §4.4 의 ±120초 정의가 조용히 갈라진다).
  const windows = input.sleepWindows ?? [];
  const covers = windows.some(
    (w) =>
      sleepWindowCoversGap(w, Math.floor(lastStart / 1000), Math.floor(lastEnd / 1000)) &&
      sleepWindowCoversGap(w, Math.floor(input.gapStartMs / 1000), Math.floor(input.gapEndMs / 1000))
  );
  return covers ? last : null;
}

/** `missed` 항목의 동일성 키. 같은 탭·같은 날짜·같은 슬롯이면 같은 손실이다. */
const missedKey = (m: MissedSlot): string => `${m.tab}|${m.date}|${m.slot}`;

/**
 * 병합 시 손실 목록 합치기. **합집합**이고, 한번 복구된 항목은 복구 상태를 잃지 않는다.
 *
 * 합집합인 이유: 병합되는 두 조각이 서로 다른 시간대를 볼 수 있다(첫 조각은 08:00 뉴스를,
 * 두 번째 조각은 10:00 팝업을 놓쳤다). 교체로 처리하면 앞 조각의 손실이 조용히 사라진다.
 */
function mergeMissed(prev: readonly MissedSlot[], next: readonly MissedSlot[]): MissedSlot[] {
  const byKey = new Map<string, MissedSlot>();
  for (const m of prev) byKey.set(missedKey(m), m);
  for (const m of next) {
    const old = byKey.get(missedKey(m));
    byKey.set(
      missedKey(m),
      old?.recovered && !m.recovered ? { ...m, recovered: true, recoveredAt: old.recoveredAt } : m
    );
  }
  return [...byKey.values()].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

const CONFIDENCE_RANK: Record<DowntimeConfidence, number> = { 확실: 2, 추정: 1, 불명: 0 };

/**
 * 병합 시 증거 합치기.
 *
 * 새 증거로 통째로 덮지 않는 이유가 이 함수의 존재 이유다. DarkWake 파편화(§3.6)에서
 * **두 번째 조각은 3분짜리 사슬 토막**이라 증거가 첫 조각보다 얕다. 그래서 필드마다
 * "공백 **시작**의 사실"과 "가장 **최근**에 읽은 사실"을 나눠 고른다.
 *
 * | 갈래 | 고르는 쪽 | 이유 |
 * |---|---|---|
 * | 공백 시작 맥락(bootEpochBefore/prevPid/prevBeaconMode/batteryAtGapStart) | 이전 | 병합된 사건의 시작은 이전 사건의 시작이다 |
 * | 지금 읽은 사실(bootEpochNow/shutdownLog/panic/pmset) | 새 것 | 더 늦게 읽었으므로 닫는 Wake·최종 잔량까지 들어 있다 |
 * | 신뢰를 깎는 신호(clockSuspect/bootFromFallback/writeFailures) | 나쁜 쪽 | 한 조각에서라도 의심스러웠으면 의심스러운 것이다 |
 * | 누적치(cpuSecondsInGap) | 합 | 병합된 구간 전체의 실가동 시간이어야 한다 |
 */
function mergeEvidence(
  prev: DowntimeEvidence,
  next: DowntimeEvidence,
  mergedGapMs: number
): DowntimeEvidence {
  // pmset 재파싱이 실패했으면 **이전 조각의 동결 사본을 지키는 쪽**이 맞다. `pmset -g log` 는
  // 14일만 보존되므로(§12.2-10) 여기서 덮어쓰면 그 사건의 절전 근거가 영영 사라진다.
  const keepPrevPmset = !next.pmsetParsed && prev.pmsetParsed;
  const cpu =
    prev.cpuSecondsInGap == null && next.cpuSecondsInGap == null
      ? null
      : (prev.cpuSecondsInGap ?? 0) + (next.cpuSecondsInGap ?? 0);
  return {
    ...next,
    bootEpochBefore: prev.bootEpochBefore ?? next.bootEpochBefore,
    prevPid: prev.prevPid ?? next.prevPid,
    prevBeaconMode: prev.prevBeaconMode ?? next.prevBeaconMode,
    batteryAtGapStart: prev.batteryAtGapStart,
    bootFromFallback: prev.bootFromFallback || next.bootFromFallback,
    clockSuspect: prev.clockSuspect || next.clockSuspect,
    beaconWriteFailures: Math.max(prev.beaconWriteFailures, next.beaconWriteFailures),
    panicAtEpoch: next.panicAtEpoch ?? prev.panicAtEpoch,
    panicDirReadable: next.panicDirReadable || prev.panicDirReadable,
    pmsetParsed: keepPrevPmset ? prev.pmsetParsed : next.pmsetParsed,
    pmsetLines: keepPrevPmset ? prev.pmsetLines : next.pmsetLines,
    // 새 pmset 읽기는 자기 조각만 세므로 합치면 이중 계산이 된다. 큰 쪽을 쓴다(보수적).
    darkWakeCount: Math.max(prev.darkWakeCount, next.darkWakeCount),
    cpuSecondsInGap: cpu,
    dutyPercent:
      cpu == null || mergedGapMs <= 0 ? null : Math.round((cpu / (mergedGapMs / 1000)) * 100 * 1000) / 1000,
  };
}

/**
 * 사건을 원장에 기록한다. 병합 대상이 있으면 **직전 사건에 병합**하고(id 불변), 없으면 새로
 * 만든다. 일지(`data/downtime.log`)도 함께 갱신한다.
 *
 * 실패해도 throw 하지 않는다. `MIN_GAP_MS` 미만 입력은 방어적으로 거절하고 `null` 을 돌려준다
 * (§3.2 Q0 은 `classify` 가 이미 막지만, 이 파일이 원장의 **마지막 문지기**다).
 */
export function recordDowntimeEvent(
  input: DowntimeEventInput,
  narrator: DowntimeNarrator
): { event: DowntimeEvent; merged: boolean } | null {
  const gapMs = input.gapEndMs - input.gapStartMs;
  if (!Number.isFinite(gapMs) || gapMs < MIN_GAP_MS) return null;

  const ledger = loadDowntimeLedger().events;
  const target = findDowntimeMergeTarget(input, ledger);

  const nowIso = new Date().toISOString();
  let event: DowntimeEvent;

  if (target) {
    const startMs = isoToMs(target.gapStart) ?? input.gapStartMs;
    const endMs = Math.max(isoToMs(target.gapEnd) ?? input.gapEndMs, input.gapEndMs);
    const mergedGapMs = endMs - startMs;
    const missed = mergeMissed(target.missed, input.missed);
    // cause 가 같으면 **더 확신 있는 쪽**을 남긴다. 파편의 두 번째 조각은 증거가 얕아
    // 확신도가 낮게 나오는데, 그걸로 첫 조각의 "확실"을 깎으면 사연이 이유 없이 흐려진다.
    const sameCause = target.cause === input.verdict.cause;
    const confidence =
      sameCause && CONFIDENCE_RANK[target.confidence] > CONFIDENCE_RANK[input.verdict.confidence]
        ? target.confidence
        : input.verdict.confidence;
    event = {
      ...target,
      updatedAt: nowIso,
      severity: severityFor(input.verdict.cause, mergedGapMs, missed),
      cause: input.verdict.cause,
      confidence,
      gapEnd: isoWithOffset(endMs),
      gapMinutes: Math.round(mergedGapMs / 60_000),
      gapExact: target.gapExact && input.verdict.gapExact,
      missed,
      // reevalCount / notified / ackedAt 는 **일부러 승계**한다. 파편이 들어올 때마다 0으로
      // 되돌리면 10시간 절전이 20조각으로 들어오는 동안 알림 유예(§7-6)가 영원히 끝나지
      // 않고, 이미 보낸 알림이 다시 나갈 수도 있다.
      recoveryState: input.recoveryState ?? target.recoveryState,
      evidence: mergeEvidence(target.evidence, input.evidence, mergedGapMs),
      headline: target.headline,
      body: target.body,
      reasonLine: target.reasonLine,
    };
  } else {
    event = {
      id: isoWithOffset(input.gapStartMs),
      date: localDate(new Date(input.gapStartMs)),
      updatedAt: nowIso,
      source: input.source,
      severity: severityFor(input.verdict.cause, gapMs, input.missed),
      cause: input.verdict.cause,
      confidence: input.verdict.confidence,
      gapStart: isoWithOffset(input.gapStartMs),
      gapEnd: isoWithOffset(input.gapEndMs),
      gapMinutes: Math.round(gapMs / 60_000),
      gapExact: input.verdict.gapExact,
      headline: "",
      body: "",
      reasonLine: "",
      missed: input.missed,
      recoveryState: input.recoveryState ?? "복구중",
      reevalCount: 0,
      evidence: input.evidence,
      notified: { imessage: false, at: null, queuedUntil: null },
      ackedAt: null,
      notes: null,
    };
  }

  event = applyNarration(event, narrator);
  const others = ledger.filter((e) => e.id !== event.id);
  const kept = saveLedger([event, ...others]);
  rewriteJournal(kept, narrator);
  return { event, merged: target != null };
}

/** headline/body/reasonLine 을 내레이터로 다시 채운다. 실패해도 사건을 잃지 않는다. */
function applyNarration(e: DowntimeEvent, narrator: DowntimeNarrator): DowntimeEvent {
  try {
    const n = narrator.narrate(e);
    return { ...e, headline: n.headline, body: n.body, reasonLine: n.reasonLine };
  } catch (err) {
    log.warn(`가동 중단 문구 생성 실패(${e.id}): ${(err as Error).message}`);
    return e;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 7. 패치 (재평가 §8.5) · 알림 상태 · ack
// ────────────────────────────────────────────────────────────────────────────

/** 재평가(§8.5)가 바꾸는 필드들. 지정한 것만 갱신한다. */
export interface DowntimeEventPatch {
  /**
   * 같은 gap 창으로 다시 돌린 `describeMissedSlots()` 결과 **전체**.
   * 여기서는 합집합이 아니라 **교체**다 — 재평가는 "지금도 여전히 빠져 있는가"를 다시 세는
   * 것이고, 복구 판정은 호출부가 이전 목록과 대조해 `recovered` 로 표시해 넘긴다.
   */
  missed?: MissedSlot[];
  recoveryState?: DowntimeRecoveryState;
  reevalCount?: number;
  notes?: string | null;
}

/** 사건을 갱신하고 문구·일지를 다시 만든다. 없는 id 면 null. */
export function patchDowntimeEvent(
  id: string,
  patch: DowntimeEventPatch,
  narrator: DowntimeNarrator
): DowntimeEvent | null {
  const events = loadDowntimeLedger().events;
  const cur = events.find((e) => e.id === id);
  if (!cur) return null;

  const missed = patch.missed ?? cur.missed;
  const startMs = isoToMs(cur.gapStart);
  const endMs = isoToMs(cur.gapEnd);
  const gapMs = startMs != null && endMs != null ? endMs - startMs : cur.gapMinutes * 60_000;
  const next = applyNarration(
    {
      ...cur,
      updatedAt: new Date().toISOString(),
      missed,
      // severity 를 다시 계산한다. 재평가가 손실을 찾아내면 `무시`→`사고` 로 올라가야
      // 하고(그래야 알림·배너가 뒤늦게라도 켜진다), 손실 판정이 취소되면 반대로 내려간다.
      severity: severityFor(cur.cause, gapMs, missed),
      recoveryState: patch.recoveryState ?? cur.recoveryState,
      reevalCount: patch.reevalCount ?? cur.reevalCount,
      notes: patch.notes !== undefined ? patch.notes : cur.notes,
    },
    narrator
  );

  const kept = saveLedger([next, ...events.filter((e) => e.id !== id)]);
  rewriteJournal(kept, narrator);
  return next;
}

/**
 * 알림 상태 기록(§7). `notify.ts` 가 발송 직후/보류 시 부른다.
 *
 * `narrator` 는 선택이다 — 넘기면 일지의 `알림:` 줄까지 즉시 따라잡고, 넘기지 않으면
 * 원장만 갱신하고 일지는 다음 재작성 때 맞춰진다. 발송 경로가 문구 모듈을 몰라도 되게
 * 열어 둔 구멍이고, 알림이 일지 재작성 실패로 막히면 안 되기 때문이다.
 */
export function markDowntimeNotified(
  id: string,
  state: Partial<DowntimeNotifyState>,
  narrator?: DowntimeNarrator
): DowntimeEvent | null {
  const events = loadDowntimeLedger().events;
  const cur = events.find((e) => e.id === id);
  if (!cur) return null;
  const next: DowntimeEvent = {
    ...cur,
    updatedAt: new Date().toISOString(),
    notified: { ...cur.notified, ...state },
  };
  const kept = saveLedger([next, ...events.filter((e) => e.id !== id)]);
  if (narrator) rewriteJournal(kept, narrator);
  return next;
}

/**
 * 사용자가 화면에서 [확인했어요] 를 누른 것을 기록한다(§6.5). `POST /api/downtime/:id/ack`.
 *
 * 대기 중인 알림도 함께 취소한다(§7-4: 이미 화면에서 봤으면 보내지 않는다). 조용시간에
 * 보류된 문자가 아침 7시에 뒤늦게 도착해 "이미 확인한 사고"를 다시 알리는 것을 막는다.
 * 이미 확인한 사건에 다시 부르면 `ackedAt` 을 덮어쓰지 않는다(최초 확인 시각이 사실이다).
 */
export function ackDowntimeEvent(id: string, narrator?: DowntimeNarrator): DowntimeEvent | null {
  const events = loadDowntimeLedger().events;
  const cur = events.find((e) => e.id === id);
  if (!cur) return null;
  const next: DowntimeEvent = {
    ...cur,
    updatedAt: new Date().toISOString(),
    ackedAt: cur.ackedAt ?? new Date().toISOString(),
    notified: { ...cur.notified, queuedUntil: null },
  };
  const kept = saveLedger([next, ...events.filter((e) => e.id !== id)]);
  if (narrator) rewriteJournal(kept, narrator);
  return next;
}

// ────────────────────────────────────────────────────────────────────────────
// 8. 사람이 읽는 일지 `data/downtime.log` (§5.3 / §6.1)
// ────────────────────────────────────────────────────────────────────────────
//
// ## 왜 append 가 아니라 매번 전체 재작성인가
// 재평가(§8.5)가 **이미 적힌 항목의 '놓친 것' / '지금 상태' 줄을 갱신**해야 한다. 즉 어차피
// 재작성 경로가 필요하다. 경로를 둘(append / rewrite) 두면 둘이 만드는 파일 모양이 미묘하게
// 갈라지는데, 이 파일은 사용자가 직접 여는 산출물이라 그 종류의 오차가 가장 비싸다.
// 상한이 200항목 ≈ 120KB 이고 사건이 있을 때만 쓰므로 전체 재작성이 싸다.
//
// ## 어떤 블록을 다시 만들고 어떤 블록을 그대로 두는가
// 원장은 100건, 일지는 200항목이라 **일지에는 원장에서 이미 밀려난 옛 항목이 남는다.**
// 그것들을 원장에서 다시 만들 수는 없으므로 텍스트 그대로 보존해야 한다. 경계는 위치(뒤에서
// N개)가 아니라 **시각**으로 가른다 — 재평가로 severity 가 바뀌어 일지에 적히는 항목 수가
// 달라지면 위치 기준은 조용히 한 칸씩 밀려 남의 기록을 먹는다.

/** 일지 항목 블록의 첫 줄에서 `[YYYY-MM-DD HH:mm` 을 읽는다. 못 읽으면 null. */
function blockAtMs(block: string): number | null {
  const m = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(block);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
}

/** 기존 일지 파일을 헤더(`#` 로 시작하는 앞부분)와 항목 블록들로 쪼갠다. */
function splitJournal(text: string): { blocks: string[] } {
  const lines = text.split("\n");
  let i = 0;
  // 헤더 = 파일 맨 앞의 `#` 줄들 + 그 뒤에 붙은 빈 줄. 헤더는 매번 새로 쓰므로 버린다.
  while (i < lines.length && lines[i].startsWith("#")) i += 1;
  while (i < lines.length && lines[i].trim() === "") i += 1;
  const blocks: string[] = [];
  let cur: string[] = [];
  for (; i < lines.length; i += 1) {
    const ln = lines[i];
    if (ln.startsWith("[")) {
      if (cur.length) blocks.push(cur.join("\n").trimEnd());
      cur = [ln];
    } else if (cur.length) {
      cur.push(ln);
    } else if (ln.trim() !== "") {
      // `[` 로 시작하지 않는 선행 잡문(사용자가 손으로 적어 넣은 메모 등)도 버리지 않는다.
      cur = [ln];
    }
  }
  if (cur.length) blocks.push(cur.join("\n").trimEnd());
  return { blocks: blocks.filter((b) => b.trim() !== "") };
}

/**
 * 파일을 읽어 항목 블록으로 쪼갠다. 파일이 없거나 읽기 실패면 빈 목록.
 * 포맷의 주인(`narrate.ts`)이 역함수를 주면 그걸 쓰고, 없으면 위의 기본 파서로 접는다.
 */
function readJournalBlocks(narrator: DowntimeNarrator): string[] {
  let text: string;
  try {
    if (!fs.existsSync(DOWNTIME_JOURNAL_PATH)) return [];
    text = fs.readFileSync(DOWNTIME_JOURNAL_PATH, "utf8");
  } catch (e) {
    log.warn(`가동 중단 일지 읽기 실패: ${(e as Error).message}`);
    return [];
  }
  let blocks: string[];
  try {
    blocks = narrator.splitEntries ? narrator.splitEntries(text) : splitJournal(text).blocks;
  } catch (e) {
    log.warn(`가동 중단 일지 되읽기 실패(기본 파서로 대체): ${(e as Error).message}`);
    blocks = splitJournal(text).blocks;
  }
  // 끝의 빈 줄 유무는 재조립 때 우리가 다시 넣으므로 여기서 정규화한다.
  return blocks.map((b) => b.replace(/\s+$/, "")).filter((b) => b !== "");
}

/**
 * 원장에서 일지를 다시 만든다. `severity === "무시"` 인 사건은 **일지에 쓰지 않는다**(§5.3).
 *
 * 실패해도 throw 하지 않는다 — 일지가 안 써져도 원장은 이미 저장돼 있고, 사후 보고가
 * 서비스를 죽이는 것보다 낫다.
 */
function rewriteJournal(events: readonly DowntimeEvent[], narrator: DowntimeNarrator): void {
  // 오래된 것이 앞(사람이 위에서 아래로 읽는 순서).
  const ordered = [...events].sort((a, b) => (isoToMs(a.gapStart) ?? 0) - (isoToMs(b.gapStart) ?? 0));

  const rendered: string[] = [];
  const stamps: number[] = [];
  for (const e of ordered) {
    let text: string;
    try {
      text = narrator.journalEntry(e).replace(/\s+$/, "");
    } catch (err) {
      // 한 항목이 실패해도 나머지는 남긴다. 원장이 원본이므로 다음 재작성 때 되살아난다.
      log.warn(`가동 중단 일지 항목 생성 실패(${e.id}): ${(err as Error).message}`);
      continue;
    }
    if (!text) continue;
    // ★ `무시` 사건도 **시각만은** 걷는다. 파일에 쓰지는 않지만, 재평가로 `사고`→`무시` 로
    //   내려간 사건의 옛 블록을 지우려면 "원장이 관할하는 구간의 시작"에 그 사건도 들어가야
    //   한다. 이걸 빼면 강등된 항목이 일지에 유령으로 영원히 남는다(테스트로 못박음).
    const at = blockAtMs(text);
    if (at != null) stamps.push(at);
    if (e.severity !== "무시") rendered.push(text);
  }

  const existing = readJournalBlocks(narrator);
  // 원장이 다시 만들 수 있는 구간의 시작 시각. 이보다 이른 옛 블록만 텍스트로 보존한다.
  const cutoff = stamps.length > 0 ? Math.min(...stamps) : null;
  let legacy: string[];
  if (cutoff != null) {
    legacy = existing.filter((b) => {
      const t = blockAtMs(b);
      return t == null || t < cutoff; // 시각을 못 읽는 옛 블록은 보존 쪽으로 접는다
    });
  } else if (rendered.length > 0) {
    // 내레이터가 `[YYYY-MM-DD HH:mm …` 규약을 어겨 시각을 못 읽는 경우의 최후 수단.
    // 위치 기준으로라도 중복 증식만은 막는다.
    legacy = existing.slice(0, Math.max(0, existing.length - rendered.length));
  } else {
    legacy = existing; // 원장이 비었으면 기존 파일을 그대로 둔다
  }

  let all = [...legacy, ...rendered];
  if (all.length > JOURNAL_MAX_ENTRIES) all = all.slice(all.length - JOURNAL_MAX_ENTRIES);

  let header: string;
  try {
    header = (narrator.journalHeader?.() ?? DEFAULT_JOURNAL_HEADER).replace(/\s+$/, "");
  } catch {
    header = DEFAULT_JOURNAL_HEADER;
  }
  writeFileAtomicSync(DOWNTIME_JOURNAL_PATH, `${[header, ...all].join("\n\n")}\n`);
}

/**
 * 일지를 강제로 다시 만든다(문구 규칙을 바꾼 뒤 따라잡기, 수동 점검용).
 * 평상시에는 `recordDowntimeEvent` / `patchDowntimeEvent` 가 알아서 부른다.
 */
export function rebuildDowntimeJournal(narrator: DowntimeNarrator): void {
  rewriteJournal(loadDowntimeLedger().events, narrator);
}
