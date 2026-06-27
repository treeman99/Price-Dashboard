// 소스 폴백 오케스트레이션 (문서 §5.2).
// 확정된 SourceRef 들을 우선순위(danawa → enuri → llm-websearch)대로 시도:
//   - status === "ok" 이고 coupang/overallLowest 중 하나라도 있으면 채택 후 종료.
//   - status === "blocked" → 로그 + 알림 큐 적재 + 다음 소스로 폴백.
//   - "not-listed"/"empty"/"parse-error" → 다음 소스. 모두 미편입이면 chosen=null(쿠팡가 null 정상 저장).
// §11 당일 캐시: cache 훅이 주입되면 ref마다 cache.get 선행 확인 → hit이면 source.fetch 호출 없음.

import { log } from "../../util/log.ts";
import type { PriceSource, SourceId, SourceRef, SourcePriceResult } from "./types.ts";

/**
 * §11 하드요구사항 구현용 캐시 훅.
 * 구현은 collect 레이어(source 모듈은 순수 유지). repo.getSourceFetchCache/putSourceFetchCache가 뒤를 받친다.
 * 모든 터미널 상태를 캐시(실패도 당일 재요청 금지).
 */
export interface FetchCache {
  /** 캐시 hit이면 결과 반환, miss면 null. */
  get(ref: SourceRef): SourcePriceResult | null;
  /** 결과 캐시 기록(ok/blocked/not-listed/parse-error/empty 모두). */
  set(ref: SourceRef, result: SourcePriceResult): void;
}

export interface OrchestratorInput {
  /** 우선순위 순으로 정렬된 ref 목록 (danawa → enuri → llm-websearch). */
  refs: SourceRef[];
  /** SourceId → 소스 인스턴스 해석기. 없으면(미구성/가드로 비활성) null 반환. */
  getSource: (id: SourceId) => PriceSource | null;
  /** 차단 감지 시 콜백(알림 큐 적재 등). 선택. */
  onBlocked?: (r: SourcePriceResult, ref: SourceRef) => void;
  /** 사람이 읽기 좋은 라벨(로그용). */
  label?: string;
  /**
   * 소스별 당일 캐시 훅(선택).
   * 주입 시: ref마다 get → hit이면 source.fetch 미호출(§11 준수), miss이면 fetch 후 set.
   * 미주입 시: 캐시 없이 매번 fetch(테스트/단일 호출 등 단순 경로).
   */
  cache?: FetchCache;
}

export interface OrchestratorOutput {
  /** 채택된 결과(ok + 가격 있음). 모두 실패/미편입이면 null. */
  chosen: SourcePriceResult | null;
  /** 시도된 모든 결과(감사용, 순서 보존). 캐시 hit 결과도 포함. */
  attempts: SourcePriceResult[];
}

function hasPrice(r: SourcePriceResult): boolean {
  return r.coupang != null || r.overallLowest != null;
}

function processResult(
  result: SourcePriceResult,
  ref: SourceRef,
  input: OrchestratorInput,
  attempts: SourcePriceResult[],
  fromCache: boolean
): { chosen: SourcePriceResult } | null {
  const { onBlocked, label } = input;
  attempts.push(result);

  if (result.status === "ok" && hasPrice(result)) {
    log.info(
      `[${label ?? "수집"}] ${ref.source} 채택${fromCache ? "(캐시)" : ""} — 쿠팡=${result.coupang?.price ?? "-"} 최저가=${result.overallLowest?.price ?? "-"}`
    );
    return { chosen: result };
  }

  if (result.status === "blocked") {
    log.warn(`[${label ?? "수집"}] ${ref.source} 차단 감지${fromCache ? "(캐시)" : ""} → 폴백`);
    onBlocked?.(result, ref);
    return null;
  }

  // not-listed / empty / parse-error / (ok지만 가격 없음) → 다음 소스
  log.info(`[${label ?? "수집"}] ${ref.source} 결과 ${result.status}${fromCache ? "(캐시)" : ""} → 다음 소스`);
  return null;
}

/** 우선순위 폴백 수집. 개별 소스 예외는 parse-error 로 격리하고 다음 소스로 진행한다. */
export async function collectFromSources(
  input: OrchestratorInput
): Promise<OrchestratorOutput> {
  const { refs, getSource, label, cache } = input;
  const attempts: SourcePriceResult[] = [];

  for (const ref of refs) {
    // §11 당일 캐시 확인: hit이면 source.fetch 호출 없음
    const cached = cache?.get(ref);
    if (cached) {
      log.info(
        `[${label ?? "수집"}] ${ref.source} 캐시 hit (status=${cached.status}) → 네트워크 호출 생략`
      );
      const r = processResult(cached, ref, input, attempts, true);
      if (r) return { chosen: r.chosen, attempts };
      continue;
    }

    const source = getSource(ref.source);
    if (!source) {
      log.info(`[${label ?? "수집"}] 소스 비활성/미구성: ${ref.source} → 건너뜀`);
      continue;
    }

    let result: SourcePriceResult;
    try {
      result = await source.fetch(ref);
    } catch (e) {
      // 소스 내부에서 못 잡은 예외도 폴백이 멈추지 않도록 격리
      result = {
        source: ref.source,
        status: "parse-error",
        fetchedAt: new Date().toISOString(),
        productName: null,
        modelName: null,
        coupang: null,
        overallLowest: null,
        raw: { error: (e as Error).message },
      };
      log.warn(
        `[${label ?? "수집"}] 소스 ${ref.source} 예외 → parse-error 처리: ${(e as Error).message}`
      );
    }

    // 모든 터미널 결과(ok/blocked/not-listed/parse-error/empty)를 캐시
    cache?.set(ref, result);

    const r = processResult(result, ref, input, attempts, false);
    if (r) return { chosen: r.chosen, attempts };
  }

  return { chosen: null, attempts };
}
