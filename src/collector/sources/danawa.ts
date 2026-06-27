// 다나와 소스 (문서 부록 A 레시피 TS 이식).
// 3단계: (1) 검색→pcode 후보 해석(resolve)  (2) pcode 페이지→cate+SSR 요약 최저가
//        (3) getAllPriceCompareMallList.ajax.php→쿠팡 행(cmpnyc=TP40F) 개별가+로켓.
//
// ⚠️ 구현 주의(부록 A): prc_c 가 여러 개 → 쿠팡 행을 cmpnyc 마커 단위 블록으로 잘라 매칭(전역 첫 매치 금지).
//    로켓 판정도 body 전역이 아니라 쿠팡 행 블록 내부로 한정.
// 파서는 전부 순수함수로 분리(고정 HTML 픽스처로 단위테스트). 실제 fetch 는 주입(Fetcher).

import { localDate } from "../../util/date.ts";
import { log } from "../../util/log.ts";
import {
  baseHeaders,
  delay,
  detectLocalGuard,
  looksBlocked,
  realFetcher,
  type Fetcher,
  type HttpResponse,
} from "./http.ts";
import type { PriceSource, ResolveQuery, SourcePriceResult, SourceRef } from "./types.ts";

/** 쿠팡 몰코드 (로고 alt="쿠팡") */
export const COUPANG_CODE = "TP40F";
const AJAX_URL = "https://prod.danawa.com/info/ajax/getAllPriceCompareMallList.ajax.php";
const SEARCH_URL = "https://search.danawa.com/dsearch.php";
const INFO_URL = "https://prod.danawa.com/info/?pcode=";

/** 알려진 몰코드→상호 (alt 추출 실패 시 폴백) */
const MALL_NAMES: Record<string, string> = { TP40F: "쿠팡" };

/** 로켓배송 식별(쿠팡 행 블록 내부 한정) */
const ROCKET_RE = /로켓\s*(배송|와우|프레시|직구|설치|모바일)|로켓배송/;

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

export interface DanawaCate {
  cate1: string | null;
  cate2: string | null;
  cate3: string | null;
  cate4: string | null;
}

export interface DanawaProductPage {
  cate: DanawaCate;
  productCode: string | null;
  summaryLowest: number | null;
  productName: string | null;
}

/** pcode 상품 페이지 → cate 코드 + productCode + SSR 요약 최저가 + 상품명. */
export function parseProductPage(html: string): DanawaProductPage {
  const cateOf = (n: number): string | null => {
    const m = new RegExp(`cate${n}\\s*[=:]\\s*['"]?(\\d+)`).exec(html);
    return m ? m[1] : null;
  };
  const pcodeM = /productCode\s*[=:]\s*['"](\d+)['"]/.exec(html);
  // SSR 요약 최저가: <span class="price lowest"> ... <em class="prc_c">NNN</em>
  const sumM =
    /class="[^"]*\blowest\b[^"]*"[\s\S]{0,200}?<em class="prc_c">([\d,]+)<\/em>/.exec(
      html
    );
  const ogM = /<meta\s+property="og:title"\s+content="([^"]+)"/.exec(html);
  const titleM = /<title>([^<]+)<\/title>/.exec(html);
  const name = ogM ? stripTags(ogM[1]) : titleM ? stripTags(titleM[1]) : null;

  return {
    cate: { cate1: cateOf(1), cate2: cateOf(2), cate3: cateOf(3), cate4: cateOf(4) },
    productCode: pcodeM ? pcodeM[1] : null,
    summaryLowest: sumM ? parsePriceNum(sumM[1]) : null,
    productName: name,
  };
}

interface MallRow {
  code: string;
  start: number;
  end: number;
  html: string;
}

/** ajax 응답을 cmpnyc 마커 단위 행 블록으로 분할(연속 동일코드=같은 행: 로고+상호 링크 대응). */
export function mallRows(html: string): MallRow[] {
  const re = /cmpnyc=([A-Za-z0-9]+)/g;
  const groups: { code: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const last = groups[groups.length - 1];
    if (last && last.code === m[1]) continue; // 연속 동일코드 병합
    groups.push({ code: m[1], start: m.index });
  }
  const rows: MallRow[] = [];
  for (let i = 0; i < groups.length; i++) {
    const start = groups[i].start;
    const end = i + 1 < groups.length ? groups[i + 1].start : html.length;
    rows.push({ code: groups[i].code, start, end, html: html.slice(start, end) });
  }
  return rows;
}

function firstPrcC(block: string): number | null {
  const m = /<em class="prc_c">([\d,]+)<\/em>/.exec(block);
  return m ? parsePriceNum(m[1]) : null;
}

function mallUrlOf(block: string, code: string): string | null {
  const m = new RegExp(`href="([^"]*cmpnyc=${code}[^"]*)"`).exec(block);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

function mallNameOf(row: MallRow): string {
  const m = /alt="([^"]+)"/.exec(row.html);
  if (m && m[1].trim()) return m[1].trim();
  return MALL_NAMES[row.code] ?? row.code;
}

/** 쿠팡 행(cmpnyc=TP40F) 개별가 + 로켓여부. 행 블록 내부로 스코프(전역 첫 매치 금지). */
export function parseCoupangRow(
  html: string
): { price: number; isRocket: boolean; url: string | null } | null {
  const row = mallRows(html).find((r) => r.code === COUPANG_CODE);
  if (!row) return null;
  const price = firstPrcC(row.html);
  if (price == null) return null;
  return {
    price,
    isRocket: ROCKET_RE.test(row.html),
    url: mallUrlOf(row.html, COUPANG_CODE),
  };
}

/** 전체 최저가/판매처: 'price lowest' 배지가 붙은 몰 행. 없으면 모든 몰 행 중 최저 prc_c. */
export function parseOverallLowest(
  html: string
): { price: number; mall: string; url: string | null } | null {
  const rows = mallRows(html);
  if (rows.length === 0) return null;
  let row: MallRow | undefined;
  const idx = html.search(/class="[^"]*\bprice\b[^"]*\blowest\b[^"]*"/);
  if (idx !== -1) row = rows.find((r) => idx >= r.start && idx < r.end);
  if (!row) {
    let bestP = Infinity;
    for (const r of rows) {
      const p = firstPrcC(r.html);
      if (p != null && p < bestP) {
        bestP = p;
        row = r;
      }
    }
  }
  if (!row) return null;
  const price = firstPrcC(row.html);
  if (price == null) return null;
  return { price, mall: mallNameOf(row), url: mallUrlOf(row.html, row.code) };
}

/** ajax 판매처 목록 응답 차단/정상 판정. 기대 셀렉터(defaultMallList) 부재도 차단으로 본다. */
export function detectMallListBlock(res: HttpResponse): "ok" | "blocked" {
  if (looksBlocked(res)) return "blocked";
  // 기대 컨테이너 부재 → 응답 구조 비정상(차단/변경)
  if (!/defaultMallList/.test(res.body) && !/cmpnyc=/.test(res.body)) return "blocked";
  return "ok";
}

// ── 소스 구현 ───────────────────────────────────────────

export interface DanawaDeps {
  /** 주입 가능한 fetch (테스트). 기본 realFetcher. */
  fetcher?: Fetcher;
  /** ajax 활성 여부. 기본은 로컬 가드 결과(데이터센터면 false). */
  ajaxEnabled?: boolean;
  /** ajax 호출 전 지연 함수(테스트에서 0으로 주입). 기본 delay. */
  sleep?: (ms: number) => Promise<void>;
  /** 현재 ISO 시각 주입(테스트). */
  now?: () => string;
  /** 당일 백오프 키(로컬 날짜). 테스트 주입. */
  today?: () => string;
}

/** 다나와 PriceSource 인스턴스 생성. */
export function createDanawaSource(deps: DanawaDeps = {}): PriceSource {
  const fetcher = deps.fetcher ?? realFetcher;
  const sleep = deps.sleep ?? delay;
  const now = deps.now ?? (() => new Date().toISOString());
  const today = deps.today ?? (() => localDate());

  let ajaxEnabled = deps.ajaxEnabled;
  if (ajaxEnabled === undefined) {
    const guard = detectLocalGuard();
    ajaxEnabled = guard.isLocal;
    if (!guard.isLocal) {
      log.warn(`다나와 ajax 비활성화 — ${guard.reason}. SSR 요약 최저가만 사용합니다.`);
    }
  }

  // 당일 차단 백오프: 한 번 차단되면 그 날짜는 즉시 blocked 반환(네트워크 호출 안 함).
  let blockedDate: string | null = null;

  const base = (status: SourcePriceResult["status"], extra: Partial<SourcePriceResult> = {}): SourcePriceResult => ({
    source: "danawa",
    status,
    fetchedAt: now(),
    productName: null,
    modelName: null,
    coupang: null,
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

      // (1) 상품 페이지: SSR 요약 최저가 + cate 코드 + 상품명
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
      const summaryRef =
        info.summaryLowest != null
          ? { price: info.summaryLowest, mall: "다나와(요약최저가)", url: infoUrl }
          : null;

      // (c) ajax 비활성(데이터센터 가드) → SSR 요약만으로 degrade
      if (!ajaxEnabled) {
        if (summaryRef) return base("ok", { productName, overallLowest: summaryRef });
        return base("not-listed", { productName });
      }

      // (2) 판매처 목록 ajax — 매너: info→ajax 최소 2s 간격
      await sleep(2000);
      const params = new URLSearchParams();
      params.set("pcode", pcode);
      if (info.cate.cate1) params.set("cate1", info.cate.cate1);
      if (info.cate.cate2) params.set("cate2", info.cate.cate2);
      if (info.cate.cate3) params.set("cate3", info.cate.cate3);
      if (info.cate.cate4) params.set("cate4", info.cate.cate4);
      params.set("depth", "4");

      const ajax = await fetcher(AJAX_URL, {
        method: "POST",
        headers: baseHeaders({
          Referer: infoUrl,
          "X-Requested-With": "XMLHttpRequest",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        }),
        body: params.toString(),
      });

      if (detectMallListBlock(ajax) === "blocked") {
        blockedDate = today();
        log.warn(`다나와 ajax 차단/비정상 [pcode=${pcode}] → 당일 백오프`);
        return base("blocked", { raw: { stage: "ajax" } });
      }

      const coupang = parseCoupangRow(ajax.body);
      const overall = parseOverallLowest(ajax.body) ?? summaryRef;

      if (!coupang && !overall) return base("not-listed", { productName });
      return base("ok", { productName, coupang, overallLowest: overall });
    },
  };
}
