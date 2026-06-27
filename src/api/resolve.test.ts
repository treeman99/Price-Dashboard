import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCandidates } from "./resolve.ts";
import type { Fetcher, HttpResponse } from "../collector/sources/http.ts";
import type { ResolveQuery } from "../collector/sources/types.ts";

function resp(body: string, status = 200): HttpResponse {
  return { status, ok: status === 200, body };
}

/** 어떤 URL 이 와도 동일 응답을 주는 fetcher (호출 횟수 카운트). */
function constFetcher(res: HttpResponse, counter?: { n: number }): Fetcher {
  return async () => {
    if (counter) counter.n++;
    return res;
  };
}

// 다나와 검색 결과 픽스처 (info/?pcode= 링크 + 인접 제목).
const DANAWA_SEARCH_HTML = `<ul class="product_list">
  <li><a href="https://prod.danawa.com/info/?pcode=106736861&cate=123">로보락 S10 MaxV Ultra 화이트 (정품)</a></li>
  <li><a href="https://prod.danawa.com/info/?pcode=999&cate=123">로보락 S10 해외구매 직구</a></li>
  <li><a href="https://prod.danawa.com/info/?pcode=222&cate=123">샤오미 로봇청소기</a></li>
</ul>`;

const Q: ResolveQuery = {
  name: "로보락 S10 MaxV Ultra",
  mustInclude: [["로보락", "Roborock"], ["S10"]],
  mustExclude: [],
  minPrice: 0,
};

test("resolve(danawa): pcode 후보 + 표시 title + info URL 매핑, 해외구매/미스매치 제외, 단일 네트워크 호출", async () => {
  const counter = { n: 0 };
  const out = await resolveCandidates("danawa", Q, {
    fetcher: constFetcher(resp(DANAWA_SEARCH_HTML), counter),
  });
  assert.equal(out.source, "danawa");
  assert.equal(out.candidates.length, 1); // 해외구매·샤오미 제외
  assert.deepEqual(out.candidates[0], {
    source: "danawa",
    refId: "106736861",
    url: "https://prod.danawa.com/info/?pcode=106736861",
    title: "로보락 S10 MaxV Ultra 화이트 (정품)",
  });
  assert.equal(out.note, null);
  assert.equal(counter.n, 1); // resolve 는 검색 1회만
});

test("resolve(danawa): 차단(403) → candidates 빈 배열 + note (throw 안 함)", async () => {
  const out = await resolveCandidates("danawa", Q, {
    fetcher: constFetcher(resp("forbidden access denied. padding padding padding padding", 403)),
  });
  assert.equal(out.candidates.length, 0);
  assert.match(out.note ?? "", /차단|비정상/);
});

test("resolve(danawa): 매칭 후보 0개면 note 안내", async () => {
  const out = await resolveCandidates(
    "danawa",
    { ...Q, mustInclude: [["존재하지않는모델명XYZ"]] },
    { fetcher: constFetcher(resp(DANAWA_SEARCH_HTML)) }
  );
  assert.equal(out.candidates.length, 0);
  assert.match(out.note ?? "", /후보가 없습니다/);
});

test("resolve(danawa): fetcher 예외도 흡수해 note 로 반환", async () => {
  const out = await resolveCandidates("danawa", Q, {
    fetcher: async () => {
      throw new Error("네트워크 폭발");
    },
  });
  assert.equal(out.candidates.length, 0);
  assert.match(out.note ?? "", /호출 실패/);
});

// 에누리 검색 픽스처 (detail.jsp?modelno= 링크 + 제목).
const ENURI_SEARCH_HTML = `<ul>
  <li><a href="https://www.enuri.com/detail.jsp?modelno=55667788&x=1">로보락 S10 MaxV Ultra</a></li>
  <li><a href="https://www.enuri.com/detail.jsp?modelno=11112222&x=1">로보락 S10 해외구매</a></li>
</ul>`;

test("resolve(enuri): detail 후보 매핑 + 해외구매 제외", async () => {
  const out = await resolveCandidates("enuri", Q, {
    fetcher: constFetcher(resp(ENURI_SEARCH_HTML)),
  });
  assert.equal(out.source, "enuri");
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].refId, "55667788");
  assert.match(out.candidates[0].url, /modelno=55667788/);
});

test("resolve: 지원하지 않는 소스는 빈 후보 + note", async () => {
  const out = await resolveCandidates("llm-websearch", Q, {
    fetcher: constFetcher(resp("anything")),
  });
  assert.equal(out.candidates.length, 0);
  assert.match(out.note ?? "", /지원하지 않습니다/);
});
