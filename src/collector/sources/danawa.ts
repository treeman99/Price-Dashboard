// 다나와 소스 (문서 부록 A 레시피 TS 이식).
// 2단계: (1) 검색→pcode 후보 해석(resolve)  (2) pcode 페이지→cate+SSR 요약 최저가.
//
// ⚠️ 2026-07-28: 쿠팡 수집을 없애면서 3단계였던 판매처 목록 ajax
//    (getAllPriceCompareMallList.ajax.php)를 삭제했다. 그 엔드포인트는 robots 의
//    `Disallow: /info/ajax/` 대상이었고, 유일한 존재 이유가 쿠팡 행(cmpnyc=TP40F)의
//    개별가·로켓 판정이었다. 전체 최저가는 robots 허용 경로인 info 페이지의 SSR 요약
//    최저가로 계속 잡는다(몰별 분해가 없으므로 판매처는 "다나와(요약최저가)"로 표기).
// 파서는 전부 순수함수로 분리(고정 HTML 픽스처로 단위테스트). 실제 fetch 는 주입(Fetcher).

import { localDate } from "../../util/date.ts";
import { log } from "../../util/log.ts";
import { baseHeaders, looksBlocked, realFetcher, type Fetcher } from "./http.ts";
import type { PriceSource, ResolveQuery, SourcePriceResult, SourceRef } from "./types.ts";

const SEARCH_URL = "https://search.danawa.com/dsearch.php";
const INFO_URL = "https://prod.danawa.com/info/?pcode=";

// ── 순수 파서 ───────────────────────────────────────────

export interface DanawaCandidate {
  pcode: string;
  title: string;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function parsePriceNum(s: string): number | null {
  const n = Number(s.replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 검색 결과 HTML → pcode 후보 목록(제목 포함). pcode 기준 중복 제거(첫 제목 유지). */
export function parseSearchCandidates(html: string): DanawaCandidate[] {
  const re =
    /<a\b[^>]*href="[^"]*\/info\/\?pcode=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const out: DanawaCandidate[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const pcode = m[1];
    const title = stripTags(m[2]);
    if (!title || seen.has(pcode)) continue;
    seen.add(pcode);
    out.push({ pcode, title });
  }
  return out;
}

/** mustInclude(AND of OR-groups) + 제외(해외구매/mustExclude) 적용. 제목 기준, 대소문자 무시. */
export function matchCandidates(
  cands: DanawaCandidate[],
  q: Pick<ResolveQuery, "mustInclude" | "mustExclude">
): DanawaCandidate[] {
  const excludes = ["해외구매", "해외직구", ...(q.mustExclude ?? [])].map((x) =>
    x.toLowerCase()
  );
  return cands.filter((c) => {
    const t = c.title.toLowerCase();
    if (excludes.some((x) => x && t.includes(x))) return false;
    for (const group of q.mustInclude ?? []) {
      if (group.length === 0) continue;
      if (!group.some((syn) => t.includes(syn.toLowerCase()))) return false;
    }
    return true;
  });
}

export interface DanawaProductPage {
  productCode: string | null;
  summaryLowest: number | null;
  productName: string | null;
}

/**
 * pcode 상품 페이지 → productCode + SSR 요약 최저가 + 상품명.
 * (cate1~4 파싱은 ajax 파라미터 전용이었으므로 ajax 삭제와 함께 제거했다.)
 */
export function parseProductPage(html: string): DanawaProductPage {
  const pcodeM = /productCode\s*[=:]\s*['"](\d+)['"]/.exec(html);
  const productCode = pcodeM ? pcodeM[1] : null;

  // SSR 요약 최저가 — 2026-06 라이브 info 페이지 실측 앵커 기반(2가지).
  // 1차(가장 안정적): id="min_price_{pcode}" hidden input value. 콤마 없는 숫자값.
  //   속성 순서(id-먼저·value-먼저)가 바뀔 수 있어 양방향 매칭.
  //   productCode 를 페이지 내부에서 파싱했으므로 specific하게 쓰되,
  //   미파싱 시 generic 패턴(id="min_price_\d+")으로 폴백.
  // 2차(보조): og:description content에서 "최저가 N,NNN원" 추출.
  // ※ data-base-price / .lowest+prc_c 전략은 ajax mall list 응답 마크업 — info 페이지에 없으므로 제거.
  const minPriceRe = productCode
    ? new RegExp(`id="min_price_${productCode}"[^>]*value="(\\d+)"`)
    : /id="min_price_\d+"[^>]*value="(\d+)"/;
  const minPriceRevRe = productCode
    ? new RegExp(`value="(\\d+)"[^>]*id="min_price_${productCode}"`)
    : /value="(\d+)"[^>]*id="min_price_\d+"/;
  const minPriceM = minPriceRe.exec(html) ?? minPriceRevRe.exec(html);
  const ogDescM = /content="[^"]*최저가\s*([\d,]+)\s*원/.exec(html);
  const sumRaw = minPriceM?.[1] ?? ogDescM?.[1] ?? null;

  const ogM = /<meta\s+property="og:title"\s+content="([^"]+)"/.exec(html);
  const titleM = /<title>([^<]+)<\/title>/.exec(html);
  const name = ogM ? stripTags(ogM[1]) : titleM ? stripTags(titleM[1]) : null;

  return {
    productCode: pcodeM ? pcodeM[1] : null,
    summaryLowest: sumRaw != null ? parsePriceNum(sumRaw) : null,
    productName: name,
  };
}

// ── 소스 구현 ───────────────────────────────────────────

export interface DanawaDeps {
  /** 주입 가능한 fetch (테스트). 기본 realFetcher. */
  fetcher?: Fetcher;
  /** 현재 ISO 시각 주입(테스트). */
  now?: () => string;
  /** 당일 백오프 키(로컬 날짜). 테스트 주입. */
  today?: () => string;
}

/** 다나와 PriceSource 인스턴스 생성. */
export function createDanawaSource(deps: DanawaDeps = {}): PriceSource {
  const fetcher = deps.fetcher ?? realFetcher;
  const now = deps.now ?? (() => new Date().toISOString());
  const today = deps.today ?? (() => localDate());

  // 당일 차단 백오프: 한 번 차단되면 그 날짜는 즉시 blocked 반환(네트워크 호출 안 함).
  let blockedDate: string | null = null;

  const base = (status: SourcePriceResult["status"], extra: Partial<SourcePriceResult> = {}): SourcePriceResult => ({
    source: "danawa",
    status,
    fetchedAt: now(),
    productName: null,
    modelName: null,
    overallLowest: null,
    ...extra,
  });

  return {
    id: "danawa",

    async resolve(q: ResolveQuery): Promise<SourceRef[]> {
      const url = `${SEARCH_URL}?k1=${encodeURIComponent(q.name)}`;
      const res = await fetcher(url, {
        headers: baseHeaders({ Referer: "https://www.danawa.com/" }),
      });
      if (looksBlocked(res)) {
        log.warn(`다나와 검색 차단 감지 [${q.name}] → 후보 없음`);
        return [];
      }
      const matched = matchCandidates(parseSearchCandidates(res.body), q);
      log.info(`다나와 resolve [${q.name}] 후보 ${matched.length}개`);
      return matched.map((c) => ({
        source: "danawa" as const,
        refId: c.pcode,
        url: `${INFO_URL}${c.pcode}`,
      }));
    },

    async fetch(ref: SourceRef): Promise<SourcePriceResult> {
      const pcode = ref.refId;
      if (!pcode) return base("parse-error", { raw: { error: "pcode(refId) 없음" } });

      // (d) 당일 차단 백오프
      if (blockedDate === today()) {
        return base("blocked", { raw: { reason: "당일 차단 백오프 — 소스 스킵" } });
      }

      // 상품 페이지(robots 허용 경로): SSR 요약 최저가 + 상품명.
      // 판매처별 분해가 필요했던 ajax 단계는 쿠팡 제거와 함께 삭제됐다(파일 상단 주석).
      const infoUrl = `${INFO_URL}${pcode}`;
      const page = await fetcher(infoUrl, {
        headers: baseHeaders({ Referer: "https://search.danawa.com/" }),
      });
      if (looksBlocked(page)) {
        blockedDate = today();
        log.warn(`다나와 상품페이지 차단 [pcode=${pcode}] → 당일 백오프`);
        return base("blocked", { raw: { stage: "info" } });
      }
      const info = parseProductPage(page.body);
      const productName = info.productName;
      if (info.summaryLowest == null) return base("not-listed", { productName });
      return base("ok", {
        productName,
        overallLowest: {
          price: info.summaryLowest,
          mall: "다나와(요약최저가)",
          url: infoUrl,
        },
      });
    },
  };
}
