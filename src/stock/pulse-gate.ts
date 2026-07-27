import { isAtLeast, isSimilarIssue, severityRank } from "../../shared/pulse.ts";
import type { PulseAlertRecord, PulseSeverity } from "../../shared/types.ts";
import type { NormalizedImpact } from "./pulse-prompt.ts";

/**
 * 알림 게이트 — 판정 하나가 문자로 나갈지 결정하는 **순수 함수**.
 *
 * 이 파일에 네트워크·DB·시계를 두지 않는 이유: 알림 피로가 이 기능의 가장 큰 실패 지점이고,
 * 실패가 전부 조용하기 때문이다. 상한이 안 걸리면 문자가 쏟아지고, 과하게 걸리면 진짜 긴급
 * 건이 삼켜지는데 **둘 다 로그를 보기 전엔 모른다.** 판정 규칙만 떼어내 테스트로 못박는다.
 */

/** 게이트 판정 결과. `status` 는 그대로 원장에 기록된다. */
export type GateDecision =
  | { status: "sent"; reason: string }
  | { status: "queued"; reason: string }
  | { status: "dup"; reason: string }
  | { status: "capped"; reason: string }
  | { status: "below"; reason: string };

export interface GateCaps {
  perSymbolCap: number;
  dailyCap: number;
  macroCap: number;
}

export interface GateCounts {
  /** 오늘 전체 발송(예정 포함) 건수 — 종목 알림만 센다. */
  total: number;
  /** 심볼별 오늘 발송 건수. */
  bySymbol: Record<string, number>;
  /** 오늘 거시·섹터 발송 건수. */
  macro: number;
}

export interface GateInput {
  candidate: NormalizedImpact;
  /** 최근 dedupHours 내에 발송했거나 발송 대기 중인 알림들. */
  recent: PulseAlertRecord[];
  counts: GateCounts;
  caps: GateCaps;
  /** 문턱. 이 강도 미만은 문자로 나가지 않는다(기본 'important'). */
  threshold: PulseSeverity;
  /** 지금이 야간(조용 시간)인가. */
  quiet: boolean;
}

/**
 * 같은 사건을 이미 알렸는지.
 *
 * 2단 판정이다:
 *  1) 지문 정확 일치 — LLM 이 같은 issueKey 를 냈을 때
 *  2) 헤드라인 토큰 유사도 — issueKey 가 드리프트했을 때의 2차 방어선
 *
 * ⚠️ **같은 종목(scope) 안에서만 비교한다.** 지문의 앞부분이 심볼이라 1)은 자동으로 만족되지만
 *    2)는 아니다 — 유사도만으로 비교하면 "관세로 반도체 전반 타격"이라는 서로 다른 종목의
 *    두 판정이 하나로 뭉쳐, 두 번째 종목 알림이 조용히 사라진다.
 */
function findDuplicate(
  candidate: NormalizedImpact,
  recent: PulseAlertRecord[]
): PulseAlertRecord | null {
  const scope = candidate.fingerprint.split(":")[0];
  for (const r of recent) {
    if (r.fingerprint === candidate.fingerprint) return r;
    if (r.fingerprint.split(":")[0] !== scope) continue;
    if (isSimilarIssue(r.impact.headline, candidate.impact.headline)) return r;
  }
  return null;
}

/**
 * 판정 → 발송 여부.
 *
 * 순서가 중요하다. **문턱 → 중복 → 상한 → 야간** 이다:
 *  - 문턱을 맨 앞에 두는 이유: 참고(info) 건이 상한을 먹으면 안 된다. 상한은 '문자로 나갈
 *    자격이 있는 것들' 사이의 경쟁이다.
 *  - 중복을 상한보다 앞에 두는 이유: 중복 건이 상한을 소진하면, 같은 이슈 하나가 그날의
 *    알림 예산을 통째로 먹어치운다.
 *  - 야간을 맨 뒤에 두는 이유: 야간 보류는 '안 보냄'이 아니라 '나중에 보냄'이다. 상한·중복을
 *    통과한 뒤에 시각만 미루는 것이라 마지막이어야 한다.
 */
export function decide(input: GateInput): GateDecision {
  const { candidate, recent, counts, caps, threshold, quiet } = input;
  const sev = candidate.impact.severity;
  const isMacro = candidate.impact.symbol == null;

  // 1. 문턱
  if (!isAtLeast(sev, threshold)) {
    return { status: "below", reason: `강도 ${sev} < 문턱 ${threshold}` };
  }

  // 2. 중복 — 단, **강도가 올라갔으면 통과시킨다.**
  //    "중요"로 알린 이슈가 "긴급"이 됐다면 그건 새 정보다. 이 예외가 없으면 상황 악화를
  //    사용자가 영영 모른다(인터뷰에서 명시적으로 선택한 정책).
  const dup = findDuplicate(candidate, recent);
  if (dup && severityRank(sev) <= severityRank(dup.impact.severity)) {
    return {
      status: "dup",
      reason: `24시간 내 동일 이슈 (#${dup.id} ${dup.impact.severity})`,
    };
  }

  // 3. 상한 — 거시·섹터는 종목 상한과 **별도 예산**을 쓴다.
  if (isMacro) {
    if (counts.macro >= caps.macroCap) {
      return { status: "capped", reason: `거시·섹터 일일 상한 ${caps.macroCap}건 초과` };
    }
  } else {
    const symbol = candidate.impact.symbol!;
    const used = counts.bySymbol[symbol] ?? 0;
    if (used >= caps.perSymbolCap) {
      return { status: "capped", reason: `${symbol} 종목 일일 상한 ${caps.perSymbolCap}건 초과` };
    }
    if (counts.total >= caps.dailyCap) {
      return { status: "capped", reason: `전체 일일 상한 ${caps.dailyCap}건 초과` };
    }
  }

  // 4. 야간 — 긴급만 즉시, 나머지는 아침 묶음 큐로.
  if (quiet && sev !== "urgent") {
    return { status: "queued", reason: "야간 보류 — 아침 묶음 발송 대기" };
  }

  return { status: "sent", reason: dup ? "동일 이슈지만 강도 상승" : "발송" };
}

/**
 * 지금이 조용 시간인가. `start > end` 인 **자정을 넘는 창**(23시~7시)이 기본이라
 * 단순 범위 비교로는 틀린다 — 그 경우 OR 로 판정해야 한다.
 */
export function isQuietHour(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false; // 창 없음
  return startHour > endHour
    ? hour >= startHour || hour < endHour // 자정 넘김
    : hour >= startHour && hour < endHour;
}

/**
 * 게이트 통과분을 원장 반영 순서대로 정렬한다 — **강도 높은 것 먼저**.
 *
 * 상한이 있는 이상 순서가 곧 우선순위다. LLM 이 낸 배열 순서를 그대로 쓰면 상한이
 * 임의의 건에서 잘리고, 하필 잘린 것이 긴급 건일 수 있다(그날의 가장 중요한 알림이
 * 배열 마지막에 있었다는 이유로 사라진다).
 */
export function prioritize(items: NormalizedImpact[]): NormalizedImpact[] {
  return [...items].sort((a, b) => {
    const s = severityRank(b.impact.severity) - severityRank(a.impact.severity);
    if (s !== 0) return s;
    // 같은 강도면 종목 직격 > 인물 발언 > 거시. 내 포지션에 가까운 것이 먼저다.
    const order: Record<string, number> = { company: 0, person: 1, macro: 2 };
    return (order[a.impact.trigger] ?? 3) - (order[b.impact.trigger] ?? 3);
  });
}
