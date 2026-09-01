import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachSummaries,
  chunk,
  containsMetric,
  mergeSummaries,
  parseSummaryResponse,
  pickSummaryTargets,
  SKILLS_SUMMARY_BATCH,
} from "./curate.ts";
import { summarySourceHash } from "./store.ts";
import type { SkillRankEntry, SkillRepo } from "../../shared/skills.ts";

/**
 * LLM 요약 경로의 두 가지 계약을 못박는다.
 *
 * 1. **숫자는 LLM 이 만들지 않는다.** star·순위·증가분은 전부 API 실측값과 DB 차분에서 나오고,
 *    LLM 은 문장만 쓴다. 모델이 지시를 어기고 수치를 섞어 보내면 그 항목은 채택하지 않는다 —
 *    원문 폴백이 그럴듯한 거짓 숫자보다 낫다.
 * 2. **원문이 안 바뀐 저장소는 다시 요약하지 않는다.** 매주 100건씩 재요약하는 건 순수 낭비다.
 *
 * (이 파일은 순수 함수만 다룬다. 실제 LLM 호출·DB 저장은 여기서 하지 않는다.)
 */

function repo(over: Partial<SkillRepo> & { id: number }): SkillRepo {
  return {
    fullName: `owner/repo-${over.id}`,
    owner: "owner",
    name: `repo-${over.id}`,
    url: `https://github.com/owner/repo-${over.id}`,
    description: `설명 ${over.id}`,
    summary: null,
    stars: 100,
    forks: 1,
    watchers: 100,
    openIssues: 0,
    language: "TypeScript",
    license: "MIT",
    topics: ["agent-skills"],
    createdAt: "2026-01-01T00:00:00Z",
    pushedAt: "2026-08-01T00:00:00Z",
    archived: false,
    ...over,
  };
}

function entry(r: SkillRepo, rank = 1): SkillRankEntry {
  return { rank, repo: r, prevRank: null, starsGained: null };
}

// ── 대상 선별 ──

test("두 랭킹의 합집합에서 원문이 바뀐 것만 요약 대상이다", () => {
  const cached = repo({ id: 1 });
  const changed = repo({ id: 2, description: "새로 바뀐 설명" });
  const fresh = repo({ id: 3 });

  const cache = new Map([
    [1, { sourceHash: summarySourceHash(cached) }], // 원문 그대로 → 건너뛴다
    [2, { sourceHash: "옛-해시" }], // 원문이 바뀌었다 → 다시 요약
    // id 3 은 캐시 자체가 없다 → 요약
  ]);

  const targets = pickSummaryTargets([entry(cached), entry(changed)], [entry(fresh)], cache);
  assert.deepEqual(
    targets.map((r) => r.id),
    [2, 3]
  );
});

test("두 랭킹에 같은 저장소가 걸쳐 있어도 한 번만 요약한다", () => {
  const both = repo({ id: 5 });
  const targets = pickSummaryTargets([entry(both)], [entry(both)], new Map());
  assert.equal(targets.length, 1);
});

test("배치는 상한 크기로 자르고 마지막만 짧다", () => {
  const items = Array.from({ length: SKILLS_SUMMARY_BATCH * 2 + 3 }, (_, i) => i);
  const batches = chunk(items, SKILLS_SUMMARY_BATCH);
  assert.equal(batches.length, 3);
  assert.equal(batches[0].length, SKILLS_SUMMARY_BATCH);
  assert.equal(batches[2].length, 3);
  assert.deepEqual(batches.flat(), items, "빠지는 항목이 없어야 한다");
});

// ── 응답 파싱 ──

test("요청한 id 만 채택하고 빈 요약은 버린다", () => {
  const text = `말머리
{"summaries":[
  {"id":1,"summary":"파일을 정리해 주는 스킬이다."},
  {"id":99,"summary":"요청하지 않은 저장소"},
  {"id":2,"summary":"   "}
]}`;
  const out = parseSummaryResponse(text, new Set([1, 2]));
  assert.equal(out.size, 1);
  assert.equal(out.get(1), "파일을 정리해 주는 스킬이다.");
});

test("수치를 섞어 보낸 요약은 폐기한다 — 숫자는 LLM 이 만들지 않는다", () => {
  const text = `{"summaries":[
    {"id":1,"summary":"star 17만 개를 받은 대표적인 스킬 모음이다."},
    {"id":2,"summary":"코드 리뷰를 돕는 스킬이다. 설정 파일 3개를 읽어 규칙을 적용한다."}
  ]}`;
  const out = parseSummaryResponse(text, new Set([1, 2]));
  assert.equal(out.has(1), false, "star 수치를 지어내면 그 항목은 채택하지 않는다");
  assert.equal(out.has(2), true, '"파일 3개" 같은 일반 숫자까지 막지는 않는다');
});

test("지표 판별은 숫자 자체가 아니라 '숫자+지표 단어'의 결합을 본다", () => {
  assert.equal(containsMetric("star 1,204개를 받았다"), true);
  assert.equal(containsMetric("스타 3.2k"), true);
  assert.equal(containsMetric("이번 주 순위 2위"), true);
  assert.equal(containsMetric("포크 500개"), true);
  assert.equal(containsMetric("증가: 120"), true);
  assert.equal(containsMetric("v2 규격을 따르는 3단계 파이프라인이다"), false);
  assert.equal(containsMetric("Python 3.12 이상이 필요하다"), false);
});

test("JSON 이 없으면 던진다(호출부가 배치 실패로 흡수한다)", () => {
  assert.throws(() => parseSummaryResponse("죄송하지만 요약할 수 없습니다.", new Set([1])), /JSON 미발견/);
});

// ── 캐시 병합·부착 ──

test("캐시는 해시가 맞을 때만 쓴다 — 원문이 바뀌었는데 요약이 실패하면 원문으로 폴백한다", () => {
  const changed = repo({ id: 1, description: "새 설명" });
  const merged = mergeSummaries(
    [changed],
    new Map([[1, { summary: "낡은 요약", sourceHash: "옛-해시" }]]),
    new Map() // 이번 요약이 실패했다
  );
  assert.equal(merged.has(1), false, "낡은 요약보다 원문 description 이 정직하다");
});

test("이번에 만든 요약이 캐시보다 우선한다", () => {
  const r = repo({ id: 1 });
  const merged = mergeSummaries(
    [r],
    new Map([[1, { summary: "낡은 요약", sourceHash: summarySourceHash(r) }]]),
    new Map([[1, "새 요약"]])
  );
  assert.equal(merged.get(1), "새 요약");
});

test("요약을 붙여도 원본 객체를 제자리에서 고치지 않는다", () => {
  const r = repo({ id: 1 });
  const entries = [entry(r)];
  const out = attachSummaries(entries, new Map([[1, "요약문"]]));
  assert.equal(out[0].repo.summary, "요약문");
  assert.equal(r.summary, null, "입력을 변형하면 안 된다(같은 repo 가 두 랭킹에 공유된다)");
});

test("요약이 없는 항목은 summary=null 로 남아 화면이 원문으로 폴백한다", () => {
  const out = attachSummaries([entry(repo({ id: 1 }))], new Map());
  assert.equal(out[0].repo.summary, null, "요약 실패가 목록을 비우면 안 된다");
});
