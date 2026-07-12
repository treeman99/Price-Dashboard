import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { titleKey } from "./curate.ts";
import type { EventsSnapshot } from "../../shared/types.ts";

/**
 * 팝업·전시·축제 '신규(약 일주일 만에 새로 등장)' 판정기.
 *
 * 이벤트 보드는 이력을 저장하지 않고 최신 스냅샷만 덮어쓰므로, 어떤 행사가
 * "한동안 목록에 없다가 처음 나타났는지"를 알 수 없다. 이를 위해 별도의
 * 등장 원장(events-seen.json)에 행사별 최초/최종 등장일을 기록하고,
 * 이를 근거로 각 행사에 isNew 플래그를 부여한다.
 *
 * 판정 규칙(오늘 = today):
 *  - 워밍업: 추적 시작(since)으로부터 gapDays 미만이면, 이전에 있었는지 알 수 없으므로
 *    신규로 표시하지 않는다(원장만 채운다). → 첫 도입 시 전부 신규로 오탐하는 것을 방지.
 *  - 수집공백 재개: 마지막 성공 수집(lastRun)으로부터 gapDays 이상 지난 뒤 재개된 회차도
 *    같은 이유로 신규 판정을 보류한다(맥북 장기 종료/연속 폴백 복귀 시 대량 오탐 방지).
 *  - 워밍업 이후: 해당 key가 원장에 없거나(처음 등장), 마지막 등장일이 gapDays 이상 과거이면
 *    '재등장'으로 보고 newSince=today 로 찍는다.
 *  - 표시: newSince 이후 showDays 이내면 '신규' 배지를 노출한다(며칠간 유지).
 */

const RETENTION_DAYS = 60; // 이보다 오래 안 보인 원장 항목은 정리(무한 성장 방지)

export interface SeenEntry {
  firstSeen: string; // YYYY-MM-DD
  lastSeen: string; // YYYY-MM-DD
  /** 가장 최근 '재등장'으로 신규 판정된 날. 없으면 null. */
  newSince: string | null;
}

export interface SeenLedger {
  /** 추적을 시작한 날(첫 기록일). 워밍업 판단 기준. */
  since: string;
  /**
   * 마지막으로 신규 판정을 실행한 날(=마지막 성공 수집일). 없으면 미기록.
   * 이 값으로부터 gapDays 이상 지난 뒤 수집이 재개되면, '행사가 사라진 것'이 아니라
   * '수집을 못/안 한 것'이므로 그 회차의 신규 판정을 보류한다(대량 오탐 방지).
   */
  lastRun?: string;
  items: Record<string, SeenEntry>;
}

/** 두 YYYY-MM-DD 사이의 일수(b - a). 음수 가능. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

/**
 * 행사명 정규화 키: titleKey(공백/기호/행사어 제거) 위에 **연도 토큰(19xx/20xx) 제거**.
 * LLM이 같은 행사를 어제는 '서울국제도서전', 오늘은 '2026 서울국제도서전'으로 적어도
 * 같은 key가 되도록 하여 연도 표기 흔들림에 의한 '신규' 오탐을 줄인다.
 */
function nameKey(s: string): string {
  return titleKey(s).replace(/(?:19|20)\d{2}/g, "");
}

/** 행사 식별키: 종류 접두어 + 정규화 제목(+전시는 전시장). */
function popupKey(name: string): string {
  return `p:${nameKey(name)}`;
}
function exhibitionKey(venue: string, title: string): string {
  return `e:${nameKey(venue)}:${nameKey(title)}`;
}
function festivalKey(name: string): string {
  return `f:${nameKey(name)}`;
}

/**
 * 순수 판정 로직(디스크 미접근, 테스트 대상). ledger 를 갱신한 새 객체와
 * key→isNew 맵을 돌려준다. 원본 ledger 는 변형하지 않는다.
 */
export function detectNew(
  ledger: SeenLedger,
  keys: string[],
  today: string,
  opts: { gapDays: number; showDays: number; retentionDays?: number }
): { ledger: SeenLedger; isNew: Map<string, boolean> } {
  const since = ledger.since || today; // 첫 실행이면 오늘부터 추적 시작
  const inWarmup = daysBetween(since, today) < opts.gapDays;
  // 마지막 성공 수집(lastRun)으로부터 gapDays 이상 지난 뒤 재개된 회차면(맥북 장기 종료·연속 폴백 등),
  // 진행 중이던 행사들의 lastSeen 이 그동안 멈춰 있어 전부 gap>=gapDays 가 된다.
  // 이는 '사라졌다 재등장'이 아니라 '그동안 수집을 못 한 것'이므로 이번 회차의 신규 판정을 보류한다.
  const resumedAfterGap = !!ledger.lastRun && daysBetween(ledger.lastRun, today) >= opts.gapDays;
  const suppressNew = inWarmup || resumedAfterGap;
  const items: Record<string, SeenEntry> = { ...ledger.items };
  const isNew = new Map<string, boolean>();

  for (const key of new Set(keys)) {
    const prev = items[key];
    const gap = prev ? daysBetween(prev.lastSeen, today) : Number.POSITIVE_INFINITY;
    // 워밍업/수집공백 재개가 아니고, gapDays 이상 공백(처음 등장 포함)이면 재등장 = 신규
    const reappeared = !suppressNew && gap >= opts.gapDays;

    const next: SeenEntry = prev
      ? { ...prev }
      : { firstSeen: today, lastSeen: today, newSince: null };
    if (reappeared) next.newSince = today;
    next.lastSeen = today;
    items[key] = next;

    const show =
      next.newSince != null && daysBetween(next.newSince, today) <= opts.showDays;
    isNew.set(key, show);
  }

  // 오래 안 보인 항목 정리
  const retention = opts.retentionDays ?? RETENTION_DAYS;
  for (const [k, e] of Object.entries(items)) {
    if (daysBetween(e.lastSeen, today) > retention) delete items[k];
  }

  return { ledger: { since, lastRun: today, items }, isNew };
}

function ledgerPath(): string {
  return path.join(path.dirname(config.dbPath), "events-seen.json");
}

function loadLedger(p: string): SeenLedger {
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      if (raw && typeof raw === "object" && raw.items && typeof raw.items === "object") {
        return { since: typeof raw.since === "string" ? raw.since : "", items: raw.items };
      }
    }
  } catch (e) {
    log.warn(`이벤트 등장 원장 로드 실패: ${(e as Error).message}`);
  }
  return { since: "", items: {} };
}

function saveLedger(p: string, ledger: SeenLedger): void {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(ledger, null, 2));
  } catch (e) {
    log.warn(`이벤트 등장 원장 저장 실패: ${(e as Error).message}`);
  }
}

/**
 * 스냅샷의 팝업·전시·축제 항목에 isNew 를 부여하고 등장 원장을 갱신·저장한다.
 * (LLM 큐레이션 결과에만 호출할 것 — 폴백 원본은 제목 노이즈로 원장을 오염시킴)
 */
export function markNewItems(snapshot: EventsSnapshot, today: string): void {
  const refs: { key: string; set: (v: boolean) => void }[] = [];

  for (const p of snapshot.popups) {
    refs.push({ key: popupKey(p.name), set: (v) => { p.isNew = v; } });
  }
  for (const v of snapshot.exhibitions.venues) {
    for (const e of v.items) {
      refs.push({ key: exhibitionKey(v.name, e.title), set: (val) => { e.isNew = val; } });
    }
  }
  for (const f of snapshot.festivals) {
    refs.push({ key: festivalKey(f.name), set: (v) => { f.isNew = v; } });
  }

  const p = ledgerPath();
  const ledger = loadLedger(p);
  const { ledger: nextLedger, isNew } = detectNew(
    ledger,
    refs.map((r) => r.key),
    today,
    { gapDays: config.eventsNewGapDays, showDays: config.eventsNewShowDays }
  );
  for (const r of refs) r.set(isNew.get(r.key) ?? false);
  saveLedger(p, nextLedger);

  const newCount = refs.filter((r) => isNew.get(r.key)).length;
  log.info(`이벤트 신규 판정 — ${newCount}건 (추적 시작 ${nextLedger.since})`);
}
