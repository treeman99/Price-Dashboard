// 에누리 소스 — 폴백 골격(문서 §2 작업2).
// 에누리 robots 는 친화적(Allow:/, Crawl-delay 1s, ClaudeBot 허용)이나
// 쿠팡가 노출 방식(SSR vs 허용 ajax)이 스파이크에서 미검증.
// 따라서 깊이 구현하지 않고, resolve/fetch 최소 골격 + 차단/미편입 분기만 둔다.
//
// TODO: 쿠팡가 노출 방식 미검증 — 상세(/detail.jsp 등)에서 쿠팡 판매가가
//   SSR HTML 인지 허용 ajax 인지 1회 실측 후 파서 구현. 그 전까지 fetch 는 not-listed/empty.

import { log } from "../../util/log.ts";
import {
  baseHeaders,
  looksBlocked,
  realFetcher,
  type Fetcher,
} from "./http.ts";
import type { PriceSource, ResolveQuery, SourcePriceResult, SourceRef } from "./types.ts";

const SEARCH_URL = "https://www.enuri.com/search.jsp";

export interface EnuriDeps {
  fetcher?: Fetcher;
  now?: () => string;
}

/** 에누리 검색 HTML → 상품 상세 링크 후보(최소 파싱). 매칭/확정은 사람 검수에 위임. */
export function parseEnuriCandidates(html: string): Array<{ refId: string; url: string; title: string }> {
  // TODO: 쿠팡가 노출 방식 미검증 — 상세 페이지 모델번호 추출 패턴도 실측 후 확정.
  const out: Array<{ refId: string; url: string; title: string }> = [];
  const re = /href="([^"]*\/detail\.jsp\?[^"]*modelno=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const refId = m[2];
    if (seen.has(refId)) continue;
    seen.add(refId);
    const title = m[3].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    out.push({ refId, url: m[1].replace(/&amp;/g, "&"), title });
  }
  return out;
}

/** 에누리 PriceSource 인스턴스 생성 (폴백 골격). */
export function createEnuriSource(deps: EnuriDeps = {}): PriceSource {
  const fetcher = deps.fetcher ?? realFetcher;
  const now = deps.now ?? (() => new Date().toISOString());

  const base = (status: SourcePriceResult["status"], extra: Partial<SourcePriceResult> = {}): SourcePriceResult => ({
    source: "enuri",
    status,
    fetchedAt: now(),
    productName: null,
    modelName: null,
    coupang: null,
    overallLowest: null,
    ...extra,
  });

  return {
    id: "enuri",

    async resolve(q: ResolveQuery): Promise<SourceRef[]> {
      try {
        const url = `${SEARCH_URL}?keyword=${encodeURIComponent(q.name)}`;
        const res = await fetcher(url, {
          headers: baseHeaders({ Referer: "https://www.enuri.com/" }),
        });
        if (looksBlocked(res)) {
          log.warn(`에누리 검색 차단 감지 [${q.name}] → 후보 없음`);
          return [];
        }
        return parseEnuriCandidates(res.body).map((c) => ({
          source: "enuri" as const,
          refId: c.refId,
          url: c.url,
        }));
      } catch (e) {
        log.warn(`에누리 resolve 실패 [${q.name}]: ${(e as Error).message}`);
        return [];
      }
    },

    async fetch(ref: SourceRef): Promise<SourcePriceResult> {
      // TODO: 쿠팡가 노출 방식 미검증 — 현재는 차단 감지만 하고 가격 추출은 미구현.
      try {
        const res = await fetcher(ref.url, {
          headers: baseHeaders({ Referer: "https://www.enuri.com/" }),
        });
        if (looksBlocked(res)) return base("blocked", { raw: { stage: "detail" } });
        // 파서 미구현 → 쿠팡가/최저가 추출 불가. 폴백 체인이 llm-websearch 로 이어진다.
        return base("not-listed", { raw: { note: "enuri 파서 미구현(미검증)" } });
      } catch (e) {
        return base("parse-error", { raw: { error: (e as Error).message } });
      }
    },
  };
}
