import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSkillsEmailHtml,
  rankDeltaLabel,
  skillsIMessageText,
  windowLabel,
} from "./skills-email.ts";
import type { SkillRankEntry, SkillRepo, SkillsSnapshot } from "../../shared/skills.ts";

/**
 * 주간 알림 본문의 계약.
 *
 * 가장 중요한 규칙은 **구간 라벨이 SkillWindow.days 를 그대로 인용한다**는 것이다. "최근 7일간
 * +2,400"이라고 적어 두고 실제로는 14일치(맥이 월요일을 놓친 주)를 보여주는 쪽이, 구간을
 * 아예 숨기는 것보다 훨씬 나쁘다 — 사용자가 그 숫자로 주간 추세를 판단하기 때문이다.
 *
 * 두 번째 규칙은 **첫 회차에는 증가 섹션을 통째로 생략한다**는 것이다. 비교 대상이 없는데
 * 빈 표를 보내면 "이번 주엔 아무것도 안 늘었다"로 읽힌다.
 */

function repo(over: Partial<SkillRepo> & { id: number }): SkillRepo {
  return {
    fullName: `owner/repo-${over.id}`,
    owner: "owner",
    name: `repo-${over.id}`,
    url: `https://github.com/owner/repo-${over.id}`,
    description: "GitHub 원문 설명",
    summary: null,
    stars: 1000,
    forks: 10,
    watchers: 1000,
    openIssues: 2,
    language: "Python",
    license: "MIT",
    topics: ["agent-skills"],
    createdAt: "2026-01-01T00:00:00Z",
    pushedAt: "2026-08-01T00:00:00Z",
    archived: false,
    ...over,
  };
}

function entry(over: Partial<SkillRankEntry> & { rank: number; repo: SkillRepo }): SkillRankEntry {
  return { prevRank: null, starsGained: null, ...over };
}

function snapshot(over: Partial<SkillsSnapshot> = {}): SkillsSnapshot {
  return {
    date: "2026-09-14",
    updatedAt: "2026-09-14T09:06:02.000Z",
    source: "github",
    trackedCount: 400,
    byStars: [entry({ rank: 1, repo: repo({ id: 1, stars: 172948 }), starsGained: 1204 })],
    byGrowth: [
      entry({ rank: 1, repo: repo({ id: 2, stars: 5000 }), starsGained: 1204, prevRank: 3 }),
    ],
    window: { fromDate: "2026-09-07", toDate: "2026-09-14", days: 7 },
    ...over,
  };
}

test("증가 라벨은 window.days 를 그대로 인용한다 — 7 을 가정하지 않는다", () => {
  assert.equal(windowLabel(7), "최근 7일간");
  assert.equal(windowLabel(14), "최근 14일간");

  const html = buildSkillsEmailHtml(snapshot({ window: { fromDate: "2026-08-31", toDate: "2026-09-14", days: 14 } }));
  assert.match(html, /최근 14일간 증가/);
  assert.match(html, />\+1,204</);
  assert.doesNotMatch(html, /최근 7일간/, "실제 구간이 14일인데 7일이라고 적으면 안 된다");
  assert.match(html, /2026-08-31 → 2026-09-14 \(14일\)/, "비교 구간을 그대로 밝힌다");
});

test("첫 회차(window=null)에는 증가 섹션 대신 이유를 적는다", () => {
  const html = buildSkillsEmailHtml(snapshot({ byGrowth: [], window: null }));
  assert.doesNotMatch(html, /최근 \d+일간/, "구간이 없으면 구간 라벨도 없다");
  assert.match(html, /비교할 지난 스냅샷이 없어/, "설명 없이 섹션만 사라지면 고장으로 오해한다");
  assert.match(html, /star 총합 순위/, "총합 랭킹은 첫 회차에도 나온다");
});

test("증가분은 부호와 천단위 구분을 붙여 표기한다", () => {
  const html = buildSkillsEmailHtml(
    snapshot({
      byGrowth: [entry({ rank: 1, repo: repo({ id: 2 }), starsGained: -30 })],
    })
  );
  assert.match(html, /최근 7일간 증가/);
  assert.match(html, />-30</);
});

test("요약이 없으면 원문 description 으로 폴백한다 — 목록이 비면 안 된다", () => {
  const withSummary = buildSkillsEmailHtml(
    snapshot({ byStars: [entry({ rank: 1, repo: repo({ id: 1, summary: "AI 요약 문장이다." }) })] })
  );
  assert.match(withSummary, /AI 요약 문장이다\./);

  const withoutSummary = buildSkillsEmailHtml(snapshot());
  assert.match(withoutSummary, /GitHub 원문 설명/);

  const neither = buildSkillsEmailHtml(
    snapshot({ byStars: [entry({ rank: 1, repo: repo({ id: 1, description: null }) })] })
  );
  assert.match(neither, /설명이 없는 저장소입니다/);
});

test("HTML 은 저장소 이름·설명을 이스케이프한다", () => {
  const html = buildSkillsEmailHtml(
    snapshot({
      byStars: [
        entry({
          rank: 1,
          repo: repo({ id: 1, fullName: "evil/<script>alert(1)</script>", description: '"><img>' }),
        }),
      ],
    })
  );
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("javascript: URL 은 앵커로 만들지 않는다", () => {
  const html = buildSkillsEmailHtml(
    snapshot({ byStars: [entry({ rank: 1, repo: repo({ id: 1, url: "javascript:alert(1)" }) })] })
  );
  assert.doesNotMatch(html, /href="javascript:/);
});

test("보관된 저장소는 배지로 표시한다(목록에서 지우지 않는다)", () => {
  const html = buildSkillsEmailHtml(
    snapshot({ byStars: [entry({ rank: 1, repo: repo({ id: 1, archived: true }) })] })
  );
  assert.match(html, /보관됨/);
});

test("순위 변동 배지: 직전 순위가 없으면 NEW", () => {
  assert.equal(rankDeltaLabel(1, null), "NEW");
  assert.equal(rankDeltaLabel(1, 3), "▲2");
  assert.equal(rankDeltaLabel(5, 2), "▼3");
  assert.equal(rankDeltaLabel(4, 4), "―");
});

test("buildSkillsEmailHtml: 옛 카드 모양(상자·굵은 왼쪽 테두리·하드코딩 링크색·flex)을 쓰지 않는다", () => {
  const html = buildSkillsEmailHtml(snapshot());
  for (const old of ["border-left:4px", "border-radius:8px", "#4361ee", "#f8f9fa", "#fff3cd", "display:flex"]) {
    assert.ok(!html.includes(old), old);
  }
});

test("iMessage 본문은 총합·증가 각 5건이고 첫 회차에는 증가 블록이 없다", () => {
  const text = skillsIMessageText(snapshot());
  assert.match(text, /🧩 스킬 랭킹 — 2026-09-14/);
  assert.match(text, /1\. owner\/repo-1 \(172,948\)/);
  assert.match(text, /최근 7일간 증가 TOP 5/);
  assert.match(text, /1\. owner\/repo-2 \(\+1,204\)/);

  const first = skillsIMessageText(snapshot({ byGrowth: [], window: null }));
  assert.doesNotMatch(first, /증가 TOP/);
});
