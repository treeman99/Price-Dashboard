import type { NewsItem } from "../../shared/types.ts";
import { logResolutions, resolveRedirects, type LinkResolution, type ResolveOptions } from "../util/redirect-resolve.ts";

/**
 * 모델이 가져온 뉴스 항목의 경유 주소(대표 링크·관련 출처)를 원래 기사 주소로 바꾼다 — 수집 직후, 조사 구간·제외 사이트
 * 판정보다 먼저(그래야 제외 사이트·URL 중복 통합이 원래 주소로 돈다).
 *
 * 풀지 못한 링크는 지우지 않고 그대로 두되(나중에 눌러 보면 열릴 수 있다), 검색 결과에 원래 도메인이 있었으면
 * 대표 링크는 sourceDomain, 관련 출처는 domain 에 적는다. 화면·메일은 경유 주소를 '원래 주소 확인 불가'로 표시한다.
 */
export async function resolveNewsLinks(
  items: NewsItem[],
  label: string,
  opts: ResolveOptions = {}
): Promise<{ items: NewsItem[]; resolutions: Map<string, LinkResolution> }> {
  const links: string[] = [];
  for (const it of items) {
    if (it.link) links.push(it.link);
    for (const r of it.related) links.push(r.link);
  }
  const res = await resolveRedirects(links, opts);
  if (!res.size) return { items, resolutions: res };
  logResolutions(label, res);
  const out = items.map((it) => {
    const main = it.link ? res.get(it.link) : undefined;
    const related = it.related.map((r) => {
      const x = res.get(r.link);
      if (!x) return r;
      return x.url ? { label: r.label, link: x.url } : { label: r.label, link: r.link, domain: x.domain };
    });
    const next: NewsItem = { ...it, related };
    if (main?.url) next.link = main.url;
    else if (main) next.sourceDomain = main.domain;
    return next;
  });
  return { items: out, resolutions: res };
}
