import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrompt,
  stripBlockedRecommended,
  extractVideoId,
  matchesExclude,
  isForeignForKr,
  applyRegionFilter,
} from "./curate.ts";
import { parseHandle, extractUploadIso } from "./oembed.ts";
import type { YoutubeCategoryDef, YoutubeSnapshot } from "../../shared/types.ts";

const defs: YoutubeCategoryDef[] = [
  { key: "ai", label: "AI · LLM", emoji: "🤖", color: "#000", region: "global" },
  { key: "reviews", label: "신제품 리뷰", emoji: "🆕", color: "#000", region: "kr" },
  { key: "game", label: "게임", emoji: "🎮", color: "#000" }, // region 미지정 → kr 취급
];

test("buildPrompt: global 카테고리는 해외 가능, 그 외/미지정은 한국 전용 명시", () => {
  const p = buildPrompt(defs, "2026-06-28", "2026-06-21", 7, "2026-06-28 12:00", []);
  assert.match(p, /AI · LLM \(key: "ai"\) \[검색범위: 해외\(영어 포함\) 가능\]/);
  assert.match(p, /신제품 리뷰 \(key: "reviews"\) \[검색범위: 한국 채널·한국어 영상만\]/);
  assert.match(p, /게임 \(key: "game"\) \[검색범위: 한국 채널·한국어 영상만\]/);
  // 검색범위 준수 규칙 블록 포함
  assert.match(p, /검색 범위.*반드시 준수/s);
});

test("buildPrompt: 차단 채널이 있으면 제외 섹션 포함", () => {
  const p = buildPrompt(defs, "2026-06-28", "2026-06-21", 7, "2026-06-28 12:00", ["나쁜채널 (@bad)"]);
  assert.match(p, /제외 채널/);
  assert.match(p, /나쁜채널 \(@bad\)/);
});

test("buildPrompt: 추천 채널이 있으면 ⭐ 취향 프로필 섹션 포함, 없으면 미포함", () => {
  // 추천 채널 없음 → 취향 섹션 없음(불필요한 프롬프트 팽창 방지)
  const without = buildPrompt(defs, "2026-06-28", "2026-06-21", 7, "2026-06-28 12:00", []);
  assert.doesNotMatch(without, /취향 프로필/);

  const withRec: YoutubeCategoryDef[] = [
    { ...defs[0], recommendedChannels: ["테크몽 (@techmong)"] },
    defs[1],
    defs[2],
  ];
  const p = buildPrompt(withRec, "2026-06-28", "2026-06-21", 7, "2026-06-28 12:00", []);
  // 카테고리 줄의 [추천 채널] 표기 + 전역 취향 프로필 섹션이 함께 들어간다.
  assert.match(p, /\[추천 채널\(먼저 확인\): 테크몽 \(@techmong\)\]/);
  assert.match(p, /⭐ 취향 프로필/);
  assert.match(p, /명시적 취향 신호/);
  assert.match(p, /유사 채널 발굴/);
  // 취향 학습은 카테고리별로 한정(다른 카테고리 취향 끌어오기 금지).
  assert.match(p, /취향 학습\(\*\*카테고리별\*\*\)/);
  // 취향 신호가 절대 규칙(신선도·다양성·검색범위·차단·본영상)을 넘지 못함을 명시한다.
  assert.match(p, /취향 신호는 \*\*어떤 절대 규칙도 이기지 못한다\*\*/);
  assert.match(p, /신선도·다양성·검색범위·🚫제외 채널·👁본영상/);
  // 채널 페이지 WebFetch 가 빈 결과일 수 있음을 알리고 검색 폴백을 지시한다(실행 불가 지시 방지).
  assert.match(p, /빈 결과를 "새 영상 없음"으로\s*\n?\s*단정하지 말고/);
});

test("stripBlockedRecommended: 차단 채널과 매칭되는 추천 항목만 제거(이름/핸들 매칭)", () => {
  const withRec: YoutubeCategoryDef[] = [
    {
      ...defs[0],
      recommendedChannels: ["테크몽 (@techmong)", "조코딩", "@paniboy"],
    },
    defs[1],
  ];
  // 핸들로 차단 → "테크몽 (@techmong)" 제거, 이름으로 차단 → "조코딩" 제거. "@paniboy"는 유지.
  const out = stripBlockedRecommended(withRec, [
    { channel: "테크몽 Techmong", handle: "@TechMong" }, // 이름 표기가 달라도 핸들로 매칭
    { channel: "조코딩", handle: null },
  ]);
  assert.deepEqual(out[0].recommendedChannels, ["@paniboy"]);
  assert.equal(out[1], defs[1]); // 추천 채널 없는 카테고리는 그대로
  // 차단 목록이 비면 원본 그대로.
  assert.equal(stripBlockedRecommended(withRec, []), withRec);
});

test("matchesExclude: 제목/채널/원제에 제외 키워드 포함 시 true(대소문자 무시)", () => {
  const kw = ["자동차", "SUV", "모빌리티"];
  assert.equal(matchesExclude({ title: "현대 투싼 vs 기아 스포티지 SUV 비교", channel: "스튜디오ㅋㅇㅋ" }, kw), true);
  assert.equal(matchesExclude({ title: "신형 아반떼 리뷰", channel: "mediaAUTO", originalTitle: "부산모빌리티쇼 CN8" }, kw), true);
  assert.equal(matchesExclude({ title: "갤럭시 Z플립8 유출 총정리", channel: "케통령" }, kw), false);
  assert.equal(matchesExclude({ title: "아이폰 리뷰", channel: "잇섭" }, []), false); // 키워드 없으면 제외 안 함
  assert.equal(matchesExclude({ title: "테슬라 오토파일럿", channel: "ch" }, ["테슬라"]), true);
});

test("isForeignForKr: kr 카테고리에서 원제가 비한국어면 해외로 판정", () => {
  // region=kr(또는 미지정): 원제가 영어면 해외
  assert.equal(isForeignForKr({ originalTitle: "Best Gaming Laptops 2026" }, "kr"), true);
  assert.equal(isForeignForKr({ originalTitle: "M4 MacBook Pro Review" }, undefined), true);
  // 원제에 한글 포함 → 한국 영상
  assert.equal(isForeignForKr({ originalTitle: "게이밍 노트북 추천 TOP5" }, "kr"), false);
  // 원제 없음 → 한국 영상으로 간주(통과)
  assert.equal(isForeignForKr({ originalTitle: null }, "kr"), false);
  assert.equal(isForeignForKr({}, "kr"), false);
  // global 카테고리는 항상 통과
  assert.equal(isForeignForKr({ originalTitle: "Best Gaming Laptops 2026" }, "global"), false);
  // 숫자/기호만 있는 원제는 라틴 문자 없음 → 판정 보류(통과)
  assert.equal(isForeignForKr({ originalTitle: "2026 vs 2025" }, "kr"), true);
  assert.equal(isForeignForKr({ originalTitle: "1234" }, "kr"), false);
  // 채널명에 한글이 있으면 영어 원제라도 한국 채널로 보고 통과(오탐 방지)
  assert.equal(
    isForeignForKr({ originalTitle: "iPhone 16 Pro Max Unboxing", channel: "잇섭ITSub" }, "kr"),
    false
  );
  // 채널·원제 모두 비한국어 → 해외
  assert.equal(isForeignForKr({ originalTitle: "iPhone Review", channel: "MKBHD" }, "kr"), true);
});

test("applyRegionFilter: kr 카테고리의 해외 영상만 제거, global은 유지", () => {
  const defs: YoutubeCategoryDef[] = [
    { key: "krlaptop", label: "게이밍 노트북", emoji: "💻", color: "#000", region: "kr" },
    { key: "world", label: "월드", emoji: "🌐", color: "#000", region: "global" },
  ];
  const vid = (originalTitle: string | null) => ({
    title: "한국어 제목",
    originalTitle,
    channel: "ch",
    channelHandle: null,
    date: "2026-06-28",
    summary: "s",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    videoId: "dQw4w9WgXcQ",
    thumbnail: null,
  });
  const snap: YoutubeSnapshot = {
    date: "2026-06-28",
    updatedAt: "2026-06-28T00:00:00Z",
    source: "llm",
    freshDays: 7,
    categories: [
      { key: "krlaptop", label: "게이밍 노트북", emoji: "💻", color: "#000", items: [vid("Best Gaming Laptop"), vid("게이밍 노트북 추천"), vid(null)] },
      { key: "world", label: "월드", emoji: "🌐", color: "#000", items: [vid("Global English Video")] },
    ],
    notes: null,
  };
  const out = applyRegionFilter(snap, defs)!;
  // kr: 영어 원제 1개 제거 → 2개 남음
  assert.equal(out.categories[0].items.length, 2);
  // global: 그대로 유지
  assert.equal(out.categories[1].items.length, 1);
  assert.equal(applyRegionFilter(null, defs), null);
});

test("parseHandle: author_url에서 @handle 추출", () => {
  assert.equal(parseHandle("https://www.youtube.com/@KTpresident"), "@KTpresident");
  assert.equal(parseHandle("https://www.youtube.com/@media.AUTO_1"), "@media.AUTO_1");
  assert.equal(parseHandle("https://www.youtube.com/channel/UCabc123"), null);
  assert.equal(parseHandle(null), null);
});

test("extractUploadIso: watch 페이지 마크업에서 실제 업로드 ISO 추출(실측 형태)", () => {
  // 실제 유튜브 watch 페이지에서 관측된 형태: itemprop 메타 / ytInitialData 필드
  const metaHtml =
    '<meta itemprop="datePublished" content="2026-07-03T08:19:32-07:00"><meta itemprop="uploadDate" content="x">';
  assert.equal(extractUploadIso(metaHtml), "2026-07-03T08:19:32-07:00");
  const jsonHtml = 'foo"uploadDate":"2026-06-26T04:39:55-07:00","publishDate":"2026-06-26T04:45:32-07:00"bar';
  assert.equal(extractUploadIso(jsonHtml), "2026-06-26T04:39:55-07:00");
  // datePublished 메타가 있으면 최우선
  const both =
    '"uploadDate":"2020-01-01T00:00:00-07:00" ... <meta itemprop="datePublished" content="2026-07-12T10:00:00-07:00">';
  assert.equal(extractUploadIso(both), "2026-07-12T10:00:00-07:00");
  assert.equal(extractUploadIso("날짜 정보 없음"), null);
});

test("extractVideoId: 다양한 URL에서 11자 id 추출", () => {
  assert.equal(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://youtu.be/dQw4w9WgXcQ?si=x"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://example.com/none"), null);
  assert.equal(extractVideoId(null), null);
});
