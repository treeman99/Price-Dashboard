import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import type { NewsExcludedDomain } from "../../shared/types.ts";

/**
 * 뉴스 '취합 제외 사이트' 저장소(data/news-excluded-domains.json — 2026-11-23 새로 둔 파일).
 *
 * 사용자가 보고서 항목에서 '이 사이트는 앞으로 취합에서 제외'를 누르면 그 기사 링크의 도메인을 기록한다.
 * 적용은 세 겹이다: ① 세 모델 뉴스 프롬프트의 제외 목록 ② 모델별 큐레이션 후처리(대표·관련 출처 링크 하드 필터)
 * ③ 보고서 통합 단계(모델이 가져와도 다시 걸러낸다 — src/report/pipeline.ts). 유튜브는 기존 채널 차단을 쓴다.
 */
const STORE_PATH = path.join(path.dirname(config.dbPath), "news-excluded-domains.json");

/** 프롬프트에 넣을 최대 도메인 수(목록이 길어도 지시가 희석되지 않게). 필터는 전부 적용한다. */
const PROMPT_LIMIT = 60;

/** 호스트 정규화: 소문자, 끝 점·www.·m. 제거. 유효한 호스트가 아니면 null. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let host = String(input).trim().toLowerCase();
  if (!host) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  } else {
    host = host.split(/[/?#]/)[0].replace(/:\d+$/, "");
  }
  host = host.replace(/\.$/, "").replace(/^(www\d?|m)\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return host;
}

/** 링크의 정규화 도메인(http(s) 만). */
export function domainOf(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(String(url).trim())) return null;
  return normalizeDomain(url);
}

function read(): NewsExcludedDomain[] {
  try {
    if (!fs.existsSync(STORE_PATH)) return [];
    const v = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is NewsExcludedDomain => !!x && typeof x.domain === "string" && !!normalizeDomain(x.domain));
  } catch (e) {
    log.warn(`news-excluded-domains.json 읽기 실패 → 제외 없음으로 진행: ${(e as Error).message}`);
    return [];
  }
}

function write(list: NewsExcludedDomain[]): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
  fs.renameSync(tmp, STORE_PATH);
}

/** 제외 목록(최근 것이 앞). 호출마다 파일을 읽는다(수 KB). */
export function loadExcludedDomains(): NewsExcludedDomain[] {
  return read().sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

/** 도메인(또는 기사 URL) 하나를 제외 목록에 넣는다. 이미 있으면 그대로 둔다. 잘못된 값이면 throw. */
export function addExcludedDomain(input: { domain?: string; url?: string; label?: string | null }, now = new Date()): NewsExcludedDomain {
  const domain = normalizeDomain(input.domain ?? input.url ?? "");
  if (!domain) throw new Error("제외할 사이트 주소(도메인)가 올바르지 않습니다.");
  const list = read();
  const found = list.find((d) => d.domain === domain);
  if (found) return found;
  const entry: NewsExcludedDomain = {
    domain,
    label: input.label ? String(input.label).trim().slice(0, 80) || null : null,
    addedAt: now.toISOString(),
  };
  write([...list, entry]);
  log.info(`뉴스 취합 제외 사이트 추가: ${domain}${entry.label ? ` (${entry.label})` : ""}`);
  return entry;
}

/** 제외 해제. 없으면 false. */
export function removeExcludedDomain(domain: string): boolean {
  const d = normalizeDomain(domain);
  const list = read();
  const next = list.filter((x) => x.domain !== d);
  if (next.length === list.length) return false;
  write(next);
  log.info(`뉴스 취합 제외 사이트 해제: ${d}`);
  return true;
}

/** 링크가 제외 도메인(또는 그 하위 도메인)인가. */
export function buildDomainMatcher(list: NewsExcludedDomain[] = read()): (url: string | null | undefined) => boolean {
  const domains = list.map((d) => d.domain);
  return (url) => {
    const host = domainOf(url);
    if (!host) return false;
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  };
}

/** 뉴스 프롬프트의 제외 사이트 섹션(없으면 빈 문자열). */
export function excludedDomainsSection(list: NewsExcludedDomain[] = read()): string {
  if (!list.length) return "";
  const rows = list
    .slice(0, PROMPT_LIMIT)
    .map((d) => `  - ${d.domain}${d.label ? ` (${d.label})` : ""}`)
    .join("\n");
  return `

🚫 취합 제외 사이트(사용자가 직접 뺀 출처 — 이 도메인과 그 하위 도메인의 기사는 대표 링크로도 related 로도 넣지 마라.
   같은 사건을 다른 출처가 다뤘으면 그 출처를 써라. 서버도 이 도메인 링크를 자동으로 걸러낸다):
${rows}`;
}
