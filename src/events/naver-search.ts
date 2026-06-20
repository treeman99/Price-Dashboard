import { config } from "../config.ts";
import { withRetry } from "../util/log.ts";

/** 네이버 검색 결과 항목 (webkr/blog 공통) */
export interface NaverSearchItem {
  title: string;
  link: string;
  description: string;
}

function strip(s: string): string {
  return (s || "")
    .replace(/<\/?b>/gi, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

type Endpoint = "webkr" | "blog";

/**
 * 네이버 검색 API 호출 (검색 계열은 쇼핑과 동일한 자격증명 공용).
 * webkr=웹문서, blog=블로그.
 */
export async function naverSearch(
  query: string,
  endpoint: Endpoint = "webkr",
  display = 15
): Promise<NaverSearchItem[]> {
  if (!config.naver.clientId || !config.naver.clientSecret) {
    throw new Error("네이버 검색 자격증명(NAVER_CLIENT_ID/SECRET) 미설정");
  }
  const url = new URL(`https://openapi.naver.com/v1/search/${endpoint}.json`);
  url.searchParams.set("query", query);
  url.searchParams.set("display", String(display));
  url.searchParams.set("sort", "sim");

  const items = await withRetry(
    async () => {
      const res = await fetch(url, {
        headers: {
          "X-Naver-Client-Id": config.naver.clientId,
          "X-Naver-Client-Secret": config.naver.clientSecret,
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`네이버 검색 ${res.status}: ${body.slice(0, 150)}`);
      }
      const json = (await res.json()) as { items?: NaverSearchItem[] };
      return json.items ?? [];
    },
    { label: `네이버검색(${endpoint}:${query})`, tries: 3 }
  );

  return items.map((it) => ({
    title: strip(it.title),
    link: it.link,
    description: strip(it.description),
  }));
}
