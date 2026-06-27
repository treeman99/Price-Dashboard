// resolve 프록시 헬퍼 (문서 §7 pcode 확정 흐름 / §9 작업 4-2).
// 상품의 name/mustInclude/mustExclude 로 가격비교 사이트 검색을 1회 호출해
// 사람이 고를 pcode 후보(refId + url + 표시용 title)를 만든다.
//
// 설계 메모:
//  - 소스 모듈의 resolve() 는 SourceRef(식별자만) 를 돌려주고 표시용 title 을 버린다.
//    프론트가 사람에게 보여주려면 title 이 필요하므로, 여기서는 소스 모듈이 export 한
//    순수 파서(parseSearchCandidates/matchCandidates/parseEnuriCandidates)를 직접 써서
//    "검색 1회"로 title 까지 채운다(매너 §8: 외부 호출 최소화).
//  - 외부 fetch 는 주입(Fetcher) → 단위테스트에서 실제 네트워크 호출 금지.
//  - 실패/차단은 throw 하지 않고 { candidates: [], note } 로 흡수(라우트가 200 으로 안내).

import {
  matchCandidates,
  parseSearchCandidates,
  type DanawaCandidate,
} from "../collector/sources/danawa.ts";
import { parseEnuriCandidates } from "../collector/sources/enuri.ts";
import {
  baseHeaders,
  looksBlocked,
  realFetcher,
  type Fetcher,
} from "../collector/sources/http.ts";
import { log } from "../util/log.ts";
import type { ResolveCandidate, ResolveResult } from "../../shared/types.ts";
import type { ResolveQuery } from "../collector/sources/types.ts";

// ⚠️ 검색 엔드포인트 URL 은 소스 모듈의 private 상수와 중복이다(파서만 export 되어 있어 재사용 불가).
//    pipeline 이 소스 검색 URL 을 바꾸면 여기도 같이 바꿔야 한다 — 보고서에 동기화 리스크로 명시.
const DANAWA_SEARCH = "https://search.danawa.com/dsearch.php";
const DANAWA_INFO = "https://prod.danawa.com/info/?pcode=";
const ENURI_SEARCH = "https://www.enuri.com/search.jsp";

export interface ResolveDeps {
  /** 주입 가능한 fetch (테스트). 기본 realFetcher. */
  fetcher?: Fetcher;
}

/** source 별로 검색 1회 → 사람 확정용 후보(title 포함) 목록. */
export async function resolveCandidates(
  source: string,
  q: ResolveQuery,
  deps: ResolveDeps = {}
): Promise<ResolveResult> {
  const fetcher = deps.fetcher ?? realFetcher;
  if (source === "danawa") return resolveDanawa(q, fetcher);
  if (source === "enuri") return resolveEnuri(q, fetcher);
  // llm-websearch 등은 식별자 후보 개념이 없음 → 빈 후보 + 안내.
  return {
    source,
    candidates: [],
    note: `'${source}' 소스는 후보 검색을 지원하지 않습니다(danawa/enuri 만 가능).`,
  };
}

async function resolveDanawa(q: ResolveQuery, fetcher: Fetcher): Promise<ResolveResult> {
  try {
    const url = `${DANAWA_SEARCH}?k1=${encodeURIComponent(q.name)}`;
    const res = await fetcher(url, {
      headers: baseHeaders({ Referer: "https://www.danawa.com/" }),
    });
    if (looksBlocked(res)) {
      log.warn(`resolve(danawa) 차단 감지 [${q.name}]`);
      return {
        source: "danawa",
        candidates: [],
        note: "다나와 검색이 차단되었거나 응답이 비정상입니다. 잠시 후 다시 시도하세요.",
      };
    }
    const matched = matchCandidates(parseSearchCandidates(res.body), q);
    const candidates: ResolveCandidate[] = matched.map((c) => ({
      source: "danawa",
      refId: c.pcode,
      url: `${DANAWA_INFO}${c.pcode}`,
      title: c.title,
    }));
    log.info(`resolve(danawa) [${q.name}] 후보 ${candidates.length}개`);
    return {
      source: "danawa",
      candidates,
      note:
        candidates.length === 0
          ? "조건에 맞는 후보가 없습니다. 검색어 또는 매칭 규칙(mustInclude/mustExclude)을 확인하세요."
          : null,
    };
  } catch (e) {
    log.warn(`resolve(danawa) 호출 실패 [${q.name}]: ${(e as Error).message}`);
    return {
      source: "danawa",
      candidates: [],
      note: `다나와 검색 호출 실패: ${(e as Error).message}`,
    };
  }
}

async function resolveEnuri(q: ResolveQuery, fetcher: Fetcher): Promise<ResolveResult> {
  try {
    const url = `${ENURI_SEARCH}?keyword=${encodeURIComponent(q.name)}`;
    const res = await fetcher(url, {
      headers: baseHeaders({ Referer: "https://www.enuri.com/" }),
    });
    if (looksBlocked(res)) {
      return {
        source: "enuri",
        candidates: [],
        note: "에누리 검색이 차단되었거나 응답이 비정상입니다.",
      };
    }
    const raw = parseEnuriCandidates(res.body);
    const byRef = new Map(raw.map((c) => [c.refId, c]));
    // matchCandidates 는 title 만 보므로 DanawaCandidate 형태로 어댑트해 재사용.
    const adapted: DanawaCandidate[] = raw.map((c) => ({ pcode: c.refId, title: c.title }));
    const matched = matchCandidates(adapted, q);
    const candidates: ResolveCandidate[] = matched.map((c) => ({
      source: "enuri",
      refId: c.pcode,
      url: byRef.get(c.pcode)?.url ?? "",
      title: c.title,
    }));
    return {
      source: "enuri",
      candidates,
      note:
        candidates.length === 0
          ? "에누리 후보가 없습니다(폴백 골격 — 다나와를 우선 사용하세요)."
          : null,
    };
  } catch (e) {
    return {
      source: "enuri",
      candidates: [],
      note: `에누리 검색 호출 실패: ${(e as Error).message}`,
    };
  }
}
