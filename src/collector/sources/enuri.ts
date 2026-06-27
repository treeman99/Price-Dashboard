// 에누리 소스 — 폴백(문서 §2 작업2). 2026-06 라이브 실측 기반 구현.
//
// 실측 결과(스파이크):
// - robots 친화적: Allow:/, Crawl-delay 1s, ClaudeBot 허용, ajax 디스얼로우 없음. /detail.jsp 허용.
// - ⚠️ 에누리는 **쿠팡 개별가/로켓을 깔끔히 노출하지 않는다.** SSR HTML에 "쿠팡" 0회,
//   쿠팡 토큰은 기획전(coupangexh.jsp)·광고(ad_coupang)뿐 — 다나와 cmpnyc=TP40F 같은
//   판매처 가격 행이 없다. 따라서 enuri 에서 쿠팡 개별가는 추출 불가 → coupang=null 고정.
// - 단, **전체 최저가는 매우 안정적으로 노출**: JSON-LD schema.org Product "lowPrice"(1차),
//   og:description "최저가 N원"(2차). 상품명은 og:title.
//
// 역할: 다나와(1차)가 차단/실패했을 때 **전체 최저가 시계열을 유지**하는 폴백.
//   쿠팡 개별가가 필요하면 폴백 체인이 llm-websearch 로 이어진다.

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

function parsePriceNum(s: string): number | null {
  const n = Number(s.replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface EnuriDetail {
  productName: string | null;
  /** 전체 최저가(원). 쿠팡 개별가가 아니라 에누리 집계 최저가. */
  overallLowest: number | null;
}

/** 에누리 상세 HTML → 전체 최저가 + 상품명. 순수함수(고정 픽스처로 단위테스트). */
export function parseEnuriDetail(html: string): EnuriDetail {
  // 전체 최저가 — 라이브 실측 안정 앵커.
  // 1차: JSON-LD schema.org Product "lowPrice": N (구조화 데이터, 가장 안정적)
  // 2차: og:description content="최저가 N원"
  const ldM = /"lowPrice"\s*:\s*"?([\d,]+)"?/.exec(html);
  const ogM = /<meta\s+property="og:description"\s+content="[^"]*최저가\s*([\d,]+)\s*원/.exec(html);
  const raw = ldM?.[1] ?? ogM?.[1] ?? null;
  const overallLowest = raw ? parsePriceNum(raw) : null;

  const ogTitleM = /<meta\s+property="og:title"\s+content="([^"]+)"/.exec(html);
  const productName = ogTitleM
    ? ogTitleM[1].replace(/\s*-\s*에누리\s*가격비교\s*$/, "").trim() || null
    : null;

  return { productName, overallLowest };
}

/** 에누리 검색 HTML → 상품 상세 링크 후보(modelno). 매칭/확정은 사람 검수에 위임. */
export function parseEnuriCandidates(html: string): Array<{ refId: string; url: string; title: string }> {
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

/** 에누리 PriceSource 인스턴스 생성. 전체최저가 폴백(쿠팡 개별가는 미노출 → null). */
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
      try {
        const res = await fetcher(ref.url, {
          headers: baseHeaders({ Referer: "https://www.enuri.com/" }),
        });
        if (looksBlocked(res)) return base("blocked", { raw: { stage: "detail" } });

        const d = parseEnuriDetail(res.body);
        if (d.overallLowest == null) {
          return base("not-listed", {
            productName: d.productName,
            raw: { note: "에누리 최저가 추출 실패" },
          });
        }
        // 에누리는 쿠팡 개별가/로켓 미노출 → coupang 은 null. 전체최저가만 채운다.
        return base("ok", {
          productName: d.productName,
          overallLowest: { price: d.overallLowest, mall: "에누리최저가", url: ref.url },
        });
      } catch (e) {
        return base("parse-error", { raw: { error: (e as Error).message } });
      }
    },
  };
}
