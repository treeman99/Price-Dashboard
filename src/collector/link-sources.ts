// 상품 × 가격비교 소스 ref(pcode/modelno) 확정 도우미.
//
// 배경(2026-07-29): product_sources 가 비어 있으면 스크래핑 소스가 한 번도 실행되지 않고,
// 종합 최저가가 네이버 단독이 된다. 예전엔 그 빈자리를 LLM 웹검색이 메웠는데, LLM 이 낸
// 가격은 자기가 준 링크의 실제 최저가와 2/10 만 일치해서 "표시가 ≠ 착지가" 버그를 만들었다.
// 그래서 LLM 을 가격 소스에서 빼고(collect.ts), 대신 이 도우미로 스크래핑 ref 를 확정한다.
//
// 안전장치: 후보를 고르는 것으로 끝내지 않고 **실제로 그 페이지를 조회해 가격이 파싱되는지**
// 확인한 것만 확정 대상으로 올린다. 검증에 실패한 후보는 확정하지 않는다(네이버 단독 유지).

import { resolveCandidates } from "../api/resolve.ts";
import { createDanawaSource } from "./sources/danawa.ts";
import { createEnuriSource } from "./sources/enuri.ts";
import { delay, jitterMs } from "./sources/http.ts";
import { log } from "../util/log.ts";
import { listProducts, upsertProductSource } from "../db/repo.ts";
import type { PriceSource, ResolveQuery, SourceRef } from "./sources/types.ts";
import type { Product } from "../../shared/types.ts";

/** 소스 1개에 대한 확정 시도 결과(사람이 읽는 리포트 단위). */
export interface LinkAttempt {
  source: "danawa" | "enuri";
  /** 검증까지 통과해 확정 대상이 된 후보. 없으면 null. */
  picked: { refId: string | null; url: string; title: string; price: number } | null;
  /** mustInclude/mustExclude 통과 후보 수. */
  candidateCount: number;
  /** 사람이 읽을 사유(후보 없음 / 검증 실패 / 차단 등). */
  note: string | null;
}

export interface LinkReport {
  productId: number;
  productName: string;
  attempts: LinkAttempt[];
  /** 실제로 DB 에 확정 저장했는지(apply=false 면 항상 false). */
  applied: boolean;
}

/** 후보 검증 상한 — 상위 몇 개까지 실제 페이지를 열어볼지(매너 §8: 호출 최소화). */
const MAX_VERIFY = 3;

function toQuery(p: Product): ResolveQuery {
  return {
    name: p.name,
    mustInclude: p.mustInclude,
    minPrice: p.minPrice,
    mustExclude: p.mustExclude,
  };
}

/**
 * 상품 1개 × 소스 1개: 후보 검색 → 상위 후보를 실제 조회해 가격 파싱 확인 → 첫 성공 후보 반환.
 * 네트워크 실패/차단은 throw 하지 않고 note 로 흡수한다.
 */
async function tryLinkSource(
  product: Product,
  source: "danawa" | "enuri",
  instance: PriceSource
): Promise<LinkAttempt> {
  const resolved = await resolveCandidates(source, toQuery(product));
  const candidates = resolved.candidates;
  if (candidates.length === 0) {
    return { source, picked: null, candidateCount: 0, note: resolved.note ?? "후보 없음" };
  }

  for (let i = 0; i < Math.min(candidates.length, MAX_VERIFY); i++) {
    const c = candidates[i];
    if (i > 0) await delay(jitterMs(800, 1800));
    const ref: SourceRef = { source, refId: c.refId, url: c.url };
    let price: number | null = null;
    let status = "";
    try {
      const r = await instance.fetch(ref);
      status = r.status;
      price = r.overallLowest?.price ?? null;
    } catch (e) {
      status = `예외:${(e as Error).message}`;
    }
    if (price != null) {
      return {
        source,
        picked: { refId: c.refId, url: c.url, title: c.title, price },
        candidateCount: candidates.length,
        note: null,
      };
    }
    log.info(`ref 검증 실패 [${product.name}/${source}] ${c.title} → ${status}`);
  }

  return {
    source,
    picked: null,
    candidateCount: candidates.length,
    note: `후보 ${candidates.length}개 모두 가격 파싱 실패(품절/차단/마크업 변경)`,
  };
}

/**
 * 전 상품(또는 지정 상품)의 다나와·에누리 ref 를 조사한다.
 * apply=false(기본)면 조사만 하고 DB 를 건드리지 않는다 — 사람이 리포트를 보고 결정한다.
 */
export async function linkSources(opts: {
  apply?: boolean;
  onlyProductId?: number;
} = {}): Promise<LinkReport[]> {
  const apply = opts.apply ?? false;
  const all = listProducts(true);
  const products = opts.onlyProductId ? all.filter((p) => p.id === opts.onlyProductId) : all;

  const danawa = createDanawaSource();
  const enuri = createEnuriSource();

  const reports: LinkReport[] = [];
  let first = true;
  for (const p of products) {
    if (!first) await delay(jitterMs(2000, 5000));
    first = false;

    const attempts: LinkAttempt[] = [];
    // 다나와 우선, 실패하면 에누리. 다나와가 확정되면 에누리는 굳이 두드리지 않는다(매너 §8).
    const d = await tryLinkSource(p, "danawa", danawa);
    attempts.push(d);
    if (!d.picked) {
      await delay(jitterMs(1000, 2500));
      attempts.push(await tryLinkSource(p, "enuri", enuri));
    }

    let applied = false;
    if (apply) {
      for (const a of attempts) {
        if (!a.picked) continue;
        upsertProductSource({
          productId: p.id,
          source: a.source,
          refId: a.picked.refId,
          url: a.picked.url,
          confirmed: true,
        });
        applied = true;
      }
    }
    reports.push({ productId: p.id, productName: p.name, attempts, applied });
  }
  return reports;
}

/** 리포트를 사람이 읽는 텍스트로. CLI 출력 전용. */
export function formatLinkReport(reports: LinkReport[], apply: boolean): string {
  const lines: string[] = [];
  let ok = 0;
  for (const r of reports) {
    const picked = r.attempts.find((a) => a.picked);
    if (picked?.picked) {
      ok++;
      lines.push(
        `✅ [${r.productId}] ${r.productName}\n` +
          `     ${picked.source} · ${picked.picked.price.toLocaleString("ko-KR")}원 · ${picked.picked.title}\n` +
          `     ${picked.picked.url}${r.applied ? "  (확정 저장됨)" : ""}`
      );
    } else {
      const why = r.attempts.map((a) => `${a.source}: ${a.note ?? "-"}`).join(" / ");
      lines.push(`❌ [${r.productId}] ${r.productName}\n     ${why}\n     → 네이버 단독으로 수집합니다`);
    }
  }
  lines.push(
    `\n연결 ${ok}/${reports.length}개${apply ? " (DB 확정 완료)" : " — 조사만 했습니다. 확정하려면 --apply"}`
  );
  return lines.join("\n");
}
