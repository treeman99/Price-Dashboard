import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureSet, renderMails } from "./mail-preview.ts";
import {
  eventsFixture,
  newsFixture,
  skillsFixture,
  stockKrClosedFixture,
  stockKrFixture,
  youtubeFixture,
  TODAY,
} from "./fixtures.ts";
import { partitionWatchlist } from "../../../shared/stock.ts";

// 메일 미리보기(npm run mail:preview)의 최소 테스트 — 픽스처로 빌더를 돌려 메일 6통이 깨지지 않고 나오는지,
// 그리고 픽스처가 '모든 상태를 한 번씩' 담는다는 약속을 지키는지 본다(상태가 빠지면 그 모양을 미리 볼 수 없다).

const mails = renderMails(fixtureSet(), { placeholderThumbs: true });

/** 메일별 제목 h1 에 들어 있어야 할 낱말. 문구 개편에도 버티도록 핵심어만 본다. */
const H1_WORD: Record<string, RegExp> = {
  news: /뉴스/,
  youtube: /YouTube|유튜브/,
  events: /팝업/,
  skills: /스킬/,
  "stock-kr": /증시/,
  "stock-kr-closed": /증시/,
};

test("픽스처: 메일 6통(뉴스·유튜브·팝업전시·스킬·증시·증시 휴장)이 렌더된다", () => {
  assert.deepEqual(
    mails.map((m) => m.id),
    ["news", "youtube", "events", "skills", "stock-kr", "stock-kr-closed"]
  );
});

for (const id of Object.keys(H1_WORD)) {
  test(`픽스처: ${id} — HTML 이 나오고 <script 가 없으며 제목 h1 이 있다`, () => {
    const m = mails.find((x) => x.id === id);
    assert.ok(m, `${id} 메일이 없다`);
    assert.ok(m.html.length > 500, "HTML 이 비었다");
    assert.doesNotMatch(m.html, /<script/i);
    const h1 = m.html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    assert.ok(h1, "h1 이 없다");
    assert.match(h1[1], H1_WORD[id]);
    assert.ok(m.subject.length > 0, "제목(subject)이 비었다");
  });
}

test("픽스처: 증시 차트는 cid 없이 data: URI 로 들어가고, 유튜브 썸네일은 외부 주소를 남기지 않는다", () => {
  const stock = mails.find((m) => m.id === "stock-kr")!;
  assert.doesNotMatch(stock.html, /cid:/);
  const youtube = mails.find((m) => m.id === "youtube")!;
  assert.doesNotMatch(youtube.html, /preview\.invalid|i\.ytimg\.com/);
});

test("픽스처 상태: 뉴스 — 카테고리 4개 중 빈 1개, 관련 출처·링크 없는 기사", () => {
  assert.equal(newsFixture.categories.length, 4);
  assert.equal(newsFixture.categories.filter((c) => !c.items.length).length, 1);
  const items = newsFixture.categories.flatMap((c) => c.items);
  assert.ok(items.some((i) => i.related.length));
  assert.ok(items.some((i) => i.link === null));
});

test("픽스처 상태: 유튜브 — 빈 카테고리, 썸네일 없는 영상", () => {
  assert.ok(youtubeFixture.categories.some((c) => !c.items.length));
  assert.ok(youtubeFixture.categories.flatMap((c) => c.items).some((v) => v.thumbnail === null));
});

test("픽스처 상태: 팝업·전시 — 신규·오늘 종료·종료임박·오픈예정, 빈 전시장, 축제", () => {
  const all = [
    ...eventsFixture.popups,
    ...eventsFixture.exhibitions.venues.flatMap((v) => v.items),
    ...eventsFixture.festivals,
  ];
  assert.ok(all.some((e) => e.tag === "신규"));
  assert.ok(all.some((e) => e.isNew));
  assert.ok(all.some((e) => e.tag === "종료임박" && e.endDate === TODAY), "오늘 종료");
  assert.ok(all.some((e) => e.tag === "종료임박" && e.endDate !== TODAY), "종료임박");
  assert.ok(all.some((e) => e.tag === "예정"));
  assert.ok(eventsFixture.exhibitions.venues.length >= 3);
  assert.ok(eventsFixture.exhibitions.venues.some((v) => !v.items.length));
  assert.ok(eventsFixture.festivals.length > 0);
});

test("픽스처 상태: 스킬 — 각 5건 이상, 상승·하락·신규·변동 없음, window", () => {
  assert.ok(skillsFixture.byStars.length >= 5 && skillsFixture.byGrowth.length >= 5);
  const rows = [...skillsFixture.byStars, ...skillsFixture.byGrowth];
  assert.ok(rows.some((e) => e.prevRank === null));
  assert.ok(rows.some((e) => e.prevRank !== null && e.prevRank > e.rank));
  assert.ok(rows.some((e) => e.prevRank !== null && e.prevRank < e.rank));
  assert.ok(rows.some((e) => e.prevRank === e.rank));
  assert.ok(skillsFixture.window);
});

test("픽스처 상태: 증시 — 포지션 이익·손실, 지수 2, 등록 3(20거래일·미검증 1), 관심 2 + 해외 참고 1, 휴장 변형", () => {
  const pos = stockKrFixture.positions ?? [];
  assert.ok(pos.some((p) => (p.pnlPct ?? 0) > 0) && pos.some((p) => (p.pnlPct ?? 0) < 0));
  assert.ok(pos.some((p) => p.pulseSummary));
  assert.equal(stockKrFixture.indices.length, 2);
  assert.equal(stockKrFixture.analyses.length, 3);
  assert.ok(stockKrFixture.analyses.every((a) => a.history.length === 20));
  assert.equal(stockKrFixture.analyses.filter((a) => !a.verified).length, 1);
  const { domestic, foreign } = partitionWatchlist(stockKrFixture);
  assert.equal(domestic.length, 2);
  assert.equal(foreign.length, 1);
  assert.ok(stockKrFixture.notes && stockKrFixture.disclaimer);
  assert.equal(stockKrClosedFixture.closed, true);
});
