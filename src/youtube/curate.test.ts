import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrompt,
  stripBlockedRecommended,
  extractVideoId,
  matchesExclude,
  isForeignForKr,
  applyRegionFilter,
  dedupeCategoriesByVideoId,
  applyYoutubeDedup,
} from "./curate.ts";
import { parseHandle, extractUploadIso, isLiveOrUpcomingHtml } from "./oembed.ts";
import type {
  YoutubeCategoryDef,
  YoutubeSnapshot,
  BlockedChannel,
  DismissedVideo,
} from "../../shared/types.ts";

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

// 제외 영상은 buildPrompt 의 **마지막**(11번째) 위치 인자라, 앞의 기본값 인자들을 전부 채워 호출한다.
const promptWithDismissed = (
  items: DismissedVideo[],
  catDefs: YoutubeCategoryDef[] = defs
): string =>
  buildPrompt(catDefs, "2026-06-28", "2026-06-21", 7, "2026-06-28 12:00", [], [], "", new Map(), new Map(), items);

const dis = (over: Partial<DismissedVideo> = {}): DismissedVideo => ({
  videoId: "dQw4w9WgXcQ",
  title: "요즘 뜨는 AI 툴 15개 몰아보기",
  channel: "떠먹여주는AI",
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  categoryKey: null,
  reason: null,
  dismissedAt: "2026-06-27T00:00:00.000Z",
  ...over,
});

test("buildPrompt: 제외 영상이 없으면 🙅 섹션이 아예 안 생긴다(프롬프트 팽창 방지)", () => {
  const p = promptWithDismissed([]);
  assert.doesNotMatch(p, /🙅/);
  assert.doesNotMatch(p, /제외한 영상/);
});

test("buildPrompt: 제외 영상은 \"제목\" — 채널 형태로 나열되고 하드/소프트 두 층위를 모두 지시한다", () => {
  const p = promptWithDismissed([dis()]);
  assert.match(p, /🙅 제외한 영상/);
  assert.match(p, /"요즘 뜨는 AI 툴 15개 몰아보기" — 떠먹여주는AI/);
  // (1) 하드 규칙: 그 영상 자체는 재수집 금지
  assert.match(p, /\*\*하드 규칙\*\*.*어떤 카테고리에도 다시 넣지 마라/);
  // (2) 소프트 학습 신호: 비슷한 '종류'를 후순위로
  assert.match(p, /\*\*학습 신호\*\*/);
  assert.match(p, /비슷한 성격의 다른 영상도 우선순위를 낮춰라/);
  // 채널 배제와 종류 회피를 혼동하지 않도록 못박는다(제외 채널 섹션과의 역할 분리).
  assert.match(p, /채널 자체를 배제하지는 마라/);
});

test("buildPrompt: 사유가 있으면 (사유: ...)로 붙고 명시적 지시로 취급하라고 지시한다", () => {
  const p = promptWithDismissed([dis({ reason: "얕은 나열식 요약 영상은 싫다" })]);
  assert.match(p, /"요즘 뜨는 AI 툴 15개 몰아보기" — 떠먹여주는AI \(사유: 얕은 나열식 요약 영상은 싫다\)/);
  assert.match(p, /명시적 지시\*\*로 취급해 반드시 준수하라/);
  // 사유 없는 항목에는 (사유: ...) 가 붙지 않는다(규칙 설명문에도 같은 문구가 상수로 들어 있으므로
  // 전체 프롬프트가 아니라 "— 채널명" 뒤를 좁혀서 본다).
  assert.doesNotMatch(promptWithDismissed([dis()]), /떠먹여주는AI \(사유:/);
});

test("buildPrompt: categoryKey 가 있으면 어느 카테고리에서 거부됐는지 드러낸다", () => {
  const p = promptWithDismissed([dis({ categoryKey: "ai" })]);
  assert.match(p, /— 떠먹여주는AI \[ai 카테고리에서 거부\]/);
  // categoryKey 가 없으면 항목 줄에 표기가 붙지 않는다(규칙 설명문에는 같은 문구가 상수로 들어 있으므로
  // 전체 프롬프트가 아니라 "— 채널명" 뒤를 좁혀서 본다).
  assert.doesNotMatch(promptWithDismissed([dis()]), /— 떠먹여주는AI \[/);
});

test("buildPrompt: 제목이 비어 있으면(원클릭 제외) videoId 로 대체 표기한다", () => {
  const p = promptWithDismissed([dis({ title: "", channel: "" })]);
  assert.match(p, /"dQw4w9WgXcQ" — \(채널 미상\)/);
});

test("buildPrompt: 취향 신호 우선순위 문장에 🙅제외 영상이 포함된다(추천 채널이 제외 규칙을 이기지 못하게)", () => {
  const withRec: YoutubeCategoryDef[] = [
    { ...defs[0], recommendedChannels: ["테크몽 (@techmong)"] },
    defs[1],
  ];
  const p = promptWithDismissed([dis()], withRec);
  assert.match(p, /신선도·다양성·검색범위·🚫제외 채널·👁본영상·🙅제외 영상 규칙이/);
  assert.match(p, /추천 채널의 영상이라도 🙅제외한 영상과 같은 종류면 넣지 마라/);
});

const blk = (channel: string, handle: string | null, categoryKey: string | null = null): BlockedChannel => ({
  id: `${handle ?? channel}::${categoryKey ?? "*"}`,
  channel,
  handle,
  categoryKey,
  blockedAt: "2026-01-01T00:00:00.000Z",
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
    blk("테크몽 Techmong", "@TechMong"), // 이름 표기가 달라도 핸들로 매칭(전역 차단)
    blk("조코딩", null),
  ]);
  assert.deepEqual(out[0].recommendedChannels, ["@paniboy"]);
  assert.equal(out[1], defs[1]); // 추천 채널 없는 카테고리는 그대로
  // 차단 목록이 비면 원본 그대로.
  assert.equal(stripBlockedRecommended(withRec, []), withRec);
});

test("stripBlockedRecommended: 카테고리별 차단은 그 카테고리 추천에서만 제거", () => {
  const withRec: YoutubeCategoryDef[] = [
    { ...defs[0], recommendedChannels: ["@paniboy"] }, // key "ai"
    { ...defs[1], recommendedChannels: ["@paniboy"] }, // key "reviews"
  ];
  // "@paniboy"를 reviews 에서만 차단 → ai 추천은 유지, reviews 추천만 제거.
  const out = stripBlockedRecommended(withRec, [blk("빠니보틀", "@paniboy", "reviews")]);
  assert.deepEqual(out[0].recommendedChannels, ["@paniboy"]); // ai 유지
  assert.deepEqual(out[1].recommendedChannels, []); // reviews 제거
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

test("dedupeCategoriesByVideoId: 교차 카테고리 같은 videoId 는 먼저 나온 카테고리만 남긴다", () => {
  const vid = (videoId: string | null, summary: string) => ({
    title: "제목",
    originalTitle: null,
    channel: "같은채널",
    channelHandle: null,
    date: "2026-07-16",
    summary,
    url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : "https://x",
    videoId,
    thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null,
  });
  const cats = [
    { key: "ai", label: "AI", emoji: "🤖", color: "#000", items: [vid("aaaaaaaaaaa", "요약A"), vid("bbbbbbbbbbb", "고유")] },
    // 같은 영상(aaaaaaaaaaa)이 요약만 살짝 다르게 두 번째 카테고리에도 들어옴 → 제거 대상
    { key: "reviews", label: "리뷰", emoji: "🆕", color: "#000", items: [vid("aaaaaaaaaaa", "요약A2"), vid("ccccccccccc", "고유")] },
  ];
  const out = dedupeCategoriesByVideoId(cats);
  assert.deepEqual(out.map((c) => c.items.map((v) => v.videoId)), [
    ["aaaaaaaaaaa", "bbbbbbbbbbb"], // 먼저 나온 ai 는 그대로
    ["ccccccccccc"], // reviews 의 중복 aaaaaaaaaaa 만 제거
  ]);
  // 원본 불변(순수 함수)
  assert.equal(cats[1].items.length, 2);
});

test("dedupeCategoriesByVideoId: 같은 카테고리 내 중복도 제거, videoId 없는 항목은 유지", () => {
  const v = (videoId: string | null) => ({
    title: "t", originalTitle: null, channel: "c", channelHandle: null,
    date: "2026-07-16", summary: "s",
    url: "https://x", videoId, thumbnail: null,
  });
  const cats = [
    { key: "ai", label: "AI", emoji: "🤖", color: "#000", items: [v("aaaaaaaaaaa"), v("aaaaaaaaaaa"), v(null), v(null)] },
  ];
  const out = dedupeCategoriesByVideoId(cats);
  // 같은 videoId 1개만, videoId 없는 항목(판별 불가)은 둘 다 유지
  assert.deepEqual(out[0].items.map((x) => x.videoId), ["aaaaaaaaaaa", null, null]);
});

test("applyYoutubeDedup: null 은 그대로, 스냅샷은 교차 카테고리 중복 제거", () => {
  assert.equal(applyYoutubeDedup(null), null);
  const snap: YoutubeSnapshot = {
    date: "2026-07-16", updatedAt: "2026-07-16T00:00:00Z", source: "llm", freshDays: 7,
    categories: [
      { key: "a", label: "A", emoji: "🅰️", color: "#000", items: [{ title: "t", originalTitle: null, channel: "c", channelHandle: null, date: "2026-07-16", summary: "s", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ", thumbnail: null }] },
      { key: "b", label: "B", emoji: "🅱️", color: "#000", items: [{ title: "t2", originalTitle: null, channel: "c", channelHandle: null, date: "2026-07-16", summary: "s2", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ", thumbnail: null }] },
    ],
    notes: null,
  };
  const out = applyYoutubeDedup(snap)!;
  assert.equal(out.categories[0].items.length, 1);
  assert.equal(out.categories[1].items.length, 0);
});

test("parseHandle: author_url에서 @handle 추출", () => {
  assert.equal(parseHandle("https://www.youtube.com/@KTpresident"), "@KTpresident");
  assert.equal(parseHandle("https://www.youtube.com/@media.AUTO_1"), "@media.AUTO_1");
  assert.equal(parseHandle("https://www.youtube.com/channel/UCabc123"), null);
  assert.equal(parseHandle(null), null);
});

test("isLiveOrUpcomingHtml: 방송중/예정만 true, 종료 라이브 VOD·일반 영상은 false(실측 마크업)", () => {
  // 방송 중(실측: @LofiGirl/live 등) — liveBroadcastDetails.isLiveNow:true, endTimestamp 없음
  const liveNow =
    '..."liveBroadcastDetails":{"isLiveNow":true,"startTimestamp":"2026-07-01T15:18:47+00:00"}...';
  assert.equal(isLiveOrUpcomingHtml(liveNow), true);
  // 키 순서가 바뀌어도 방송중으로 판정(정규식이 순서에 의존하지 않음)
  const liveNowReordered =
    '..."liveBroadcastDetails":{"startTimestamp":"2026-07-01T15:18:47+00:00","isLiveNow":true}...';
  assert.equal(isLiveOrUpcomingHtml(liveNowReordered), true);
  // 예정(시작 전) — videoDetails.isUpcoming:true
  const upcoming = '..."isUpcoming":true,"isLiveContent":true...';
  assert.equal(isLiveOrUpcomingHtml(upcoming), true);
  // 종료된 라이브 다시보기(VOD) — isLiveNow:false + endTimestamp 존재 → 유지 대상
  const endedVod =
    '..."liveBroadcastDetails":{"isLiveNow":false,"startTimestamp":"2022-07-12T15:59:30+00:00","endTimestamp":"2026-05-20T02:11:23+00:00"}...';
  assert.equal(isLiveOrUpcomingHtml(endedVod), false);
  // 일반 영상(실측: dQw4w9WgXcQ) — isLiveContent:false, 라이브 토큰 없음
  const normal = '..."isLiveContent":false...';
  assert.equal(isLiveOrUpcomingHtml(normal), false);
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
