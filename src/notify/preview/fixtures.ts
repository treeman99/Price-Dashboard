// 메일 미리보기(`npm run mail:preview`)용 가상 스냅샷.
//
// 실제 수집 없이 메일 5종의 모양을 한 화면에서 보려고 만든 데이터다. 실제 타입으로 선언해 두어
// 스냅샷 모양이 바뀌면 tsc 가 여기서 먼저 깨진다 — 픽스처가 조용히 낡지 않게 하려는 것이다.
//
// 원칙
//  - 실존 기사·인물처럼 읽히지 않게 가상 회사명·가상 저장소명·example.com 링크만 쓴다.
//    (증시 종목코드는 실제 코드를 쓰되 서술은 전부 '예시' 문장이다.)
//  - 메일마다 **모든 상태가 한 번씩** 보이게 짠다(빈 카테고리·링크 없는 기사·태그 종류·순위 변동·
//    미검증 시세·해외 참고·휴장 …). 상태를 하나 지우면 그 모양을 미리 볼 방법이 사라진다.
//  - 날짜는 실행한 날 기준으로 만든다. '오늘 종료' 같은 표시가 실행일과 비교해 갈리기 때문이다.

import { localDate } from "../../util/date.ts";
import { summarizeHolding } from "../../../shared/holdings.ts";
import type {
  EventsSnapshot,
  NewsSnapshot,
  StockAnalysis,
  StockHolding,
  StockIndex,
  StockPoint,
  StockPositionReview,
  StockSnapshot,
  StockWatchItem,
  YoutubeSnapshot,
  YoutubeVideo,
} from "../../../shared/types.ts";
import type { SkillRankEntry, SkillRepo, SkillsSnapshot } from "../../../shared/skills.ts";

// ── 날짜 ───────────────────────────────────────────────────────────────────────

/** 실행일(로컬). */
export const TODAY = localDate();

/** 실행일 기준 n일 뒤(음수면 앞) 로컬 날짜. */
function dayOffset(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDate(d);
}

/** 어제부터 거슬러 올라간 평일 count 개(오래된 순). 증시 차트의 '최근 20거래일'용. */
function recentWeekdays(count: number): string[] {
  const out: string[] = [];
  for (let back = 1; out.length < count; back++) {
    const d = new Date();
    d.setDate(d.getDate() - back);
    if (d.getDay() !== 0 && d.getDay() !== 6) out.unshift(localDate(d));
  }
  return out;
}

const SESSIONS = recentWeekdays(20);

// ── 뉴스 ───────────────────────────────────────────────────────────────────────

/** 카테고리 4개 — 사용자 emoji·색 포함, 마지막 하나는 빈 카테고리. 관련 출처·링크 없는 기사 포함. */
export const newsFixture: NewsSnapshot = {
  date: TODAY,
  updatedAt: `${TODAY}T08:00:00+09:00`,
  source: "llm",
  notes: null,
  categories: [
    {
      key: "ai",
      label: "AI / LLM",
      emoji: "🤖",
      color: "#7c3aed",
      items: [
        {
          title: "(예시) 가상 연구소 '한빛랩스', 문서 요약 전용 소형 언어 모델 공개",
          source: "예시일보",
          date: TODAY,
          summary:
            "미리보기용 가상 기사입니다. 한빛랩스가 노트북에서 돌아가는 요약 전용 모델을 공개했다는 설정으로, 요약이 두세 줄일 때 행이 어떻게 보이는지 확인합니다.",
          link: "https://example.com/news/hanbit-small-model",
          related: [
            { label: "샘플테크", link: "https://example.com/related/sampletech" },
            { label: "Example Wire", link: "https://example.com/related/wire" },
          ],
        },
        {
          title: "(예시) 링크가 없는 기사 — 제목이 링크 없이 글자만 남는 경우",
          source: "가상통신",
          date: TODAY,
          summary: "원문 주소를 얻지 못한 기사입니다. 제목이 앵커 없이 표시되고 '원문 보기'도 붙지 않아야 합니다.",
          link: null,
          related: [],
        },
        {
          title: "(예시) 누리소프트, 사내 코드 리뷰 에이전트 시범 운영 결과 발표",
          source: "샘플테크",
          date: dayOffset(-1),
          summary: "가상 회사 누리소프트가 리뷰 대기 시간이 줄었다고 밝혔다는 예시 문장입니다.",
          link: "https://example.com/news/nuri-review-agent",
          related: [{ label: "예시일보", link: "https://example.com/related/yesi" }],
        },
      ],
    },
    {
      key: "dev",
      label: "개발 · 오픈소스",
      emoji: "💻",
      color: "#0891b2",
      items: [
        {
          title: "(예시) 가상 프레임워크 'Moa.js' 2.0 정식 출시 — 빌드 시간 절반으로",
          source: "Example Wire",
          date: TODAY,
          summary: "새 버전의 핵심 변화 세 가지를 정리한 예시 요약입니다. 긴 제목이 두 줄로 꺾일 때의 모양도 함께 봅니다.",
          link: "https://example.com/news/moajs-2",
          related: [],
        },
        {
          title: "(예시) 오픈소스 재단, 보안 패치 공개 주기 표준안 초안 공유",
          source: "샘플테크",
          date: dayOffset(-1),
          summary: "보안 패치 공개 시점에 대한 예시 기사입니다.",
          link: "https://example.com/news/patch-cadence",
          related: [],
        },
      ],
    },
    {
      key: "gadget",
      label: "가젯 · 신제품",
      emoji: "📱",
      color: "#ea580c",
      items: [
        {
          title: "(예시) 별무리전자, 접이식 전자잉크 노트 '페이지원' 예약 판매",
          source: "예시일보",
          date: TODAY,
          summary: "가상 제품 소개 예시입니다. 무게·배터리 같은 수치가 요약에 섞일 때의 줄바꿈을 확인합니다.",
          link: "https://example.com/news/pageone",
          related: [],
        },
      ],
    },
    { key: "economy", label: "경제 · 산업", emoji: "🏭", color: "#16a34a", items: [] },
  ],
};

// ── 유튜브 ─────────────────────────────────────────────────────────────────────

/**
 * 썸네일 자리표시 주소. safeHref 가 http(s) 만 통과시켜 data: URI 썸네일은 메일에서 지워지므로,
 * 픽스처에는 절대 해석되지 않는 `.invalid` 주소(RFC 2606)를 넣고 미리보기 스크립트가 렌더 뒤
 * 인라인 SVG 로 바꿔 끼운다 — 외부 요청 없이 썸네일 배치를 볼 수 있다.
 */
export const PREVIEW_THUMB_PREFIX = "https://thumb.preview.invalid/";

function video(o: Omit<YoutubeVideo, "url" | "thumbnail"> & { thumb?: boolean }): YoutubeVideo {
  const { thumb = true, ...v } = o;
  return {
    ...v,
    url: `https://www.youtube.com/watch?v=${v.videoId}`,
    thumbnail: thumb ? `${PREVIEW_THUMB_PREFIX}${v.videoId}.jpg` : null,
  };
}

/** 카테고리 3개 — 마지막은 빈 카테고리. 번역 제목(원제)·핸들/조회수/길이 유무·썸네일 없음 포함. */
export const youtubeFixture: YoutubeSnapshot = {
  date: TODAY,
  updatedAt: `${TODAY}T09:00:00+09:00`,
  source: "llm",
  freshDays: 3,
  notes: null,
  categories: [
    {
      key: "ai",
      label: "AI · LLM",
      emoji: "🤖",
      color: "#7c3aed",
      items: [
        video({
          title: "(예시) 작은 모델로 사내 문서 검색 만들기 — 처음부터 끝까지",
          originalTitle: "(Sample) Building internal doc search with a small model, end to end",
          channel: "Sample Lab",
          channelHandle: "@samplelab",
          date: TODAY,
          summary: "영문 영상을 번역 제목으로 보여 주는 경우의 예시입니다. 원제가 함께 보존됩니다.",
          videoId: "PREVIEW0001",
          views: "조회수 3.2만회",
          duration: "18:42",
        }),
        video({
          title: "(예시) 에이전트 평가표 직접 짜 보기",
          channel: "예시 테크 채널",
          channelHandle: null,
          date: dayOffset(-1),
          summary: "핸들·조회수·길이 정보가 없는 영상입니다. 메타 줄이 채널명과 날짜만으로 줄어듭니다.",
          videoId: "PREVIEW0002",
          views: null,
          duration: null,
        }),
        video({
          title: "(예시) 썸네일이 없는 영상 — 글자만으로 행이 서는 경우",
          channel: "가상 강의실",
          channelHandle: "@virtual-class",
          date: dayOffset(-2),
          summary: "thumbnail 이 null 인 영상입니다. 썸네일 칸 없이 본문이 왼쪽에 붙어야 합니다.",
          videoId: "PREVIEW0003",
          views: "조회수 870회",
          duration: "7:05",
          thumb: false,
        }),
      ],
    },
    {
      key: "review",
      label: "신제품 리뷰",
      emoji: "📦",
      color: "#ea580c",
      items: [
        video({
          title: "(예시) 별무리전자 '페이지원' 2주 사용기",
          channel: "가상리뷰 TV",
          channelHandle: "@gasang-review",
          date: TODAY,
          summary: "가상 제품의 장단점을 정리한 예시 요약입니다. 요약이 길어 세 줄 이상으로 넘어갈 때 썸네일 옆 본문이 어떻게 흐르는지 확인합니다.",
          videoId: "PREVIEW0004",
          views: "조회수 12만회",
          duration: "11:20",
        }),
      ],
    },
    { key: "science", label: "과학 · 교양", emoji: "🔬", color: "#0891b2", items: [] },
  ],
};

// ── 팝업 · 전시 · 축제 ──────────────────────────────────────────────────────────

/**
 * 태그 종류가 전부 한 번씩 나오게 짠다: 신규(날짜 태그) · isNew(재등장) · 오늘 종료(종료임박 + 오늘 끝남) ·
 * 종료임박 · 오픈예정 · 태그 없음. 팝업은 서울/서울 외 두 그룹, 전시장은 4곳 중 1곳이 빈 그룹.
 */
export const eventsFixture: EventsSnapshot = {
  date: TODAY,
  updatedAt: `${TODAY}T10:00:00+09:00`,
  source: "llm",
  notes: null,
  popups: [
    {
      name: "(예시) 가상 브랜드 '모아모아' 10주년 팝업",
      region: "서울 성수",
      period: `${dayOffset(-1)} ~ ${dayOffset(12)}`,
      startDate: dayOffset(-1),
      endDate: dayOffset(12),
      summary: "새로 열린 팝업(신규 태그 + 재등장 표시)의 예시입니다.",
      link: "https://example.com/popup/moamoa",
      category: "패션",
      tag: "신규",
      isNew: true,
    },
    {
      name: "(예시) 샘플 캐릭터 '구름이' 굿즈 팝업",
      region: "서울 여의도",
      period: `${dayOffset(-10)} ~ ${TODAY}`,
      startDate: dayOffset(-10),
      endDate: TODAY,
      summary: "오늘 끝나는 팝업 — 화면에서는 '오늘 종료'로 갈라 보인다.",
      link: "https://example.com/popup/gureumi",
      category: "캐릭터",
      tag: "종료임박",
    },
    {
      name: "(예시) 향수 브랜드 '라온' 체험 팝업",
      region: "서울 한남",
      period: `${dayOffset(3)} ~ ${dayOffset(17)}`,
      startDate: dayOffset(3),
      endDate: dayOffset(17),
      summary: "아직 열리지 않은 팝업(오픈예정)의 예시입니다.",
      link: "https://example.com/popup/raon",
      category: "뷰티",
      tag: "예정",
    },
    {
      name: "(예시) 가상 게임 '별빛 모험' 팝업",
      region: "경기 수원(스타필드 수원)",
      period: `${dayOffset(-5)} ~ ${dayOffset(3)}`,
      startDate: dayOffset(-5),
      endDate: dayOffset(3),
      summary: "며칠 뒤 끝나는 서울 외 팝업(종료임박)입니다.",
      link: "https://example.com/popup/byeolbit",
      category: "게임",
      tag: "종료임박",
    },
    {
      name: "(예시) 동네 베이커리 연합 팝업",
      region: "경기 화성(동탄)",
      period: "",
      startDate: null,
      endDate: null,
      summary: "기간 정보가 없고 태그도 없는 팝업입니다.",
      link: "https://example.com/popup/bakery",
      category: null,
      tag: null,
    },
  ],
  exhibitions: {
    venues: [
      {
        name: "코엑스",
        items: [
          {
            title: "(예시) 2026 가상 리빙 박람회",
            venue: "코엑스",
            period: `${dayOffset(-2)} ~ ${dayOffset(2)}`,
            startDate: dayOffset(-2),
            endDate: dayOffset(2),
            summary: "재등장 표시(isNew)만 있고 날짜 태그는 종료임박인 전시입니다.",
            link: "https://example.com/exhibition/living",
            tag: "종료임박",
            isNew: true,
          },
          {
            title: "(예시) 샘플 디자인 페어",
            venue: "코엑스",
            period: `${dayOffset(9)} ~ ${dayOffset(12)}`,
            startDate: dayOffset(9),
            endDate: dayOffset(12),
            summary: "곧 열리는 전시(오픈예정)입니다.",
            link: "https://example.com/exhibition/design-fair",
            tag: "예정",
          },
        ],
      },
      {
        name: "세텍",
        items: [
          {
            title: "(예시) 가상 캠핑·아웃도어 쇼",
            venue: "세텍",
            period: `${dayOffset(-3)} ~ ${TODAY}`,
            startDate: dayOffset(-3),
            endDate: TODAY,
            summary: "오늘 끝나는 전시입니다.",
            link: "https://example.com/exhibition/camping",
            tag: "종료임박",
          },
        ],
      },
      {
        name: "킨텍스",
        items: [
          {
            title: "(예시) 예시 로보틱스 전시회",
            venue: "킨텍스",
            period: `${dayOffset(-1)} ~ ${dayOffset(20)}`,
            startDate: dayOffset(-1),
            endDate: dayOffset(20),
            summary: "태그가 없는 진행 중 전시입니다.",
            link: "https://example.com/exhibition/robotics",
            tag: null,
          },
        ],
      },
      { name: "수원메쎄", items: [] },
    ],
  },
  festivals: [
    {
      name: "(예시) 가상 강변 불빛 축제",
      region: "서울 여의도",
      period: `${dayOffset(-6)} ~ ${TODAY}`,
      startDate: dayOffset(-6),
      endDate: TODAY,
      summary: "오늘 끝나는 축제입니다.",
      link: "https://example.com/festival/lights",
      tag: "종료임박",
    },
    {
      name: "(예시) 샘플 국화 축제",
      region: "경남 예시군",
      period: `${dayOffset(5)} ~ ${dayOffset(15)}`,
      startDate: dayOffset(5),
      endDate: dayOffset(15),
      summary: "오픈예정 축제입니다.",
      link: "https://example.com/festival/chrysanthemum",
      tag: "예정",
    },
    {
      name: "(예시) 가상 전통시장 먹거리 축제",
      region: "전남 예시시",
      period: `${dayOffset(-1)} ~ ${dayOffset(30)}`,
      startDate: dayOffset(-1),
      endDate: dayOffset(30),
      summary: "새로 등장한(isNew) 진행 중 축제입니다.",
      link: "https://example.com/festival/market",
      tag: null,
      isNew: true,
    },
  ],
};

// ── 스킬 랭킹 ──────────────────────────────────────────────────────────────────

let repoSeq = 9000;
function repo(fullName: string, o: Partial<SkillRepo> & { stars: number }): SkillRepo {
  const [owner, name] = fullName.split("/");
  return {
    id: repoSeq++,
    fullName,
    owner,
    name,
    url: `https://github.com/${fullName}`,
    description: null,
    summary: null,
    forks: Math.round(o.stars / 9),
    watchers: Math.round(o.stars / 40),
    openIssues: 12,
    language: "TypeScript",
    license: "MIT",
    topics: ["agent-skills"],
    createdAt: "2025-11-02T00:00:00Z",
    pushedAt: `${dayOffset(-1)}T12:00:00Z`,
    archived: false,
    ...o,
  };
}

const R = {
  kit: repo("hanbit-labs/agent-skills-kit", {
    stars: 48210,
    summary: "(예시) 문서·스프레드시트·발표 자료를 다루는 스킬 묶음. 요약은 AI 가 쓴 한국어 두 줄이라는 설정입니다.",
    access: { kind: "local", total: 12, checked: 12, network: 0, signals: [] },
  }),
  recipes: repo("sample-org/claude-skill-recipes", {
    stars: 31877,
    summary: "(예시) 자주 쓰는 작업 절차를 스킬로 정리한 레시피 모음입니다.",
    access: { kind: "partial", total: 30, checked: 30, network: 7, signals: ["WebFetch", "curl"] },
  }),
  collection: repo("example-dev/skills-collection", {
    stars: 29540,
    description: "(sample) A curated collection of community skills — 요약이 없어 GitHub 원문 설명으로 폴백하는 경우.",
    language: "Python",
    license: "Apache-2.0",
    access: { kind: "local-sampled", total: 864, checked: 40, network: 0, signals: [] },
  }),
  nuri: repo("nuri-ai/doc-skills", {
    stars: 12090,
    summary: "(예시) 회의록·보고서 서식 스킬. 이번 회차에 처음 순위에 든 저장소입니다.",
    language: null,
    license: null,
    access: { kind: "external", total: 5, checked: 5, network: 5, signals: ["MCP", "api 호스트"] },
  }),
  devops: repo("byeol/devops-skills", {
    stars: 9875,
    summary: "(예시) 배포·모니터링 스킬 모음. 순위 변동이 없는 저장소입니다.",
    language: "Shell",
    access: { kind: "unknown", total: 0, checked: 0, network: 0, signals: [] },
  }),
  awesome: repo("moa-studio/awesome-skill-list", {
    stars: 8421,
    // 요약·설명 둘 다 없는 저장소 — 메일이 안내 문구로 폴백한다.
    license: "CC0-1.0",
    language: null,
    access: { kind: "no-skill", total: 0, checked: 0, network: 0, signals: [] },
  }),
  archived: repo("preview-org/legacy-skills", {
    stars: 7310,
    summary: "(예시) 보관(archived)된 저장소입니다.",
    archived: true,
    pushedAt: "2026-03-01T00:00:00Z",
  }),
};

function entry(rank: number, r: SkillRepo, prevRank: number | null, starsGained: number | null): SkillRankEntry {
  return { rank, repo: r, prevRank, starsGained };
}

/** 총합·증가 랭킹 각 6~7건 — 순위 상승·하락·신규·변동 없음이 모두 나오고 비교 구간(window)이 있다. */
export const skillsFixture: SkillsSnapshot = {
  date: TODAY,
  updatedAt: `${TODAY}T09:00:00+09:00`,
  source: "github",
  trackedCount: 400,
  byStars: [
    entry(1, R.kit, 1, 1204), // 변동 없음
    entry(2, R.recipes, 3, 2310), // 상승
    entry(3, R.collection, 2, 95), // 하락
    entry(4, R.nuri, null, 3402), // 신규
    entry(5, R.devops, 5, 41), // 변동 없음
    entry(6, R.awesome, 9, 880), // 상승
    entry(7, R.archived, 6, -3), // 하락(감소)
  ],
  byGrowth: [
    entry(1, R.nuri, null, 3402),
    entry(2, R.recipes, 4, 2310),
    entry(3, R.kit, 1, 1204),
    entry(4, R.awesome, 3, 880),
    entry(5, R.collection, 5, 95),
    entry(6, R.devops, 2, 41),
  ],
  window: { fromDate: dayOffset(-7), toDate: TODAY, days: 7 },
  notes: "(예시) 일부 저장소는 요약을 만들지 못해 GitHub 원문 설명으로 대신했습니다.",
};

/** 스킬 메일 머리줄의 갱신 주기 문구. 픽스처에서는 data/schedule.json 을 읽지 않도록 고정한다. */
export const SKILLS_CYCLE_LABEL_FIXTURE = "매주 월요일 09:00 갱신";

// ── 증시 ───────────────────────────────────────────────────────────────────────

const DISCLAIMER =
  "본 분석은 AI가 생성한 참고자료이며, 투자 판단의 근거로 사용하지 마세요. " +
  "관심 종목은 시장에서 거론되는 사실을 정리한 것으로 매수 추천이 아니며, " +
  "투자 손실 책임은 투자자 본인에게 있습니다.";

/**
 * 결정론적 20거래일 종가 — 기울기(drift)와 출렁임(swing)만 다르게 준다. 마지막 값이 last 가 된다.
 * 원화 종목은 10원 단위, 달러 종목·지수(point)는 소수 2자리로 맞춘다.
 */
function history(last: number, drift: number, swing: number, currency: "KRW" | "USD", point = false): StockPoint[] {
  const n = SESSIONS.length;
  const round = (v: number) =>
    currency === "KRW" && !point ? Math.round(v / 10) * 10 : Math.round(v * 100) / 100;
  const closes = SESSIONS.map((_, i) => {
    const t = i - (n - 1); // 마지막 날이 0
    return round(last * (1 + drift * (t / n) + swing * Math.sin(i * 0.9) * (i === n - 1 ? 0 : 1)));
  });
  return SESSIONS.map((date, i) => {
    const prev = i ? closes[i - 1] : null;
    return {
      date,
      close: closes[i],
      prevClose: prev,
      changePct: prev ? Math.round(((closes[i] - prev) / prev) * 10000) / 100 : null,
      volume: 1_000_000 + i * 37_000,
      currency,
    };
  });
}

function lastChange(h: StockPoint[]): number | null {
  return h[h.length - 1]?.changePct ?? null;
}

function weekChange(h: StockPoint[]): number | null {
  const a = h[h.length - 6]?.close;
  const b = h[h.length - 1]?.close;
  return a && b ? Math.round(((b - a) / a) * 10000) / 100 : null;
}

function avg(h: StockPoint[], n: number): number | null {
  const xs = h.slice(-n).map((p) => p.close).filter((v): v is number => v != null);
  return xs.length === n ? Math.round(xs.reduce((a, b) => a + b, 0) / n) : null;
}

function analysis(
  o: Pick<StockAnalysis, "symbol" | "name" | "summary" | "outlook" | "rationale" | "risks" | "verdict"> & {
    history: StockPoint[];
    currency?: "KRW" | "USD";
  }
): StockAnalysis {
  const h = o.history;
  return {
    quoteCode: o.symbol,
    currency: o.currency ?? "KRW",
    close: h[h.length - 1]?.close ?? null,
    changePct: lastChange(h),
    weekChangePct: weekChange(h),
    ma5: avg(h, 5),
    ma20: avg(h, 20),
    verified: true,
    ...o,
  };
}

const KOSPI_H = history(3245.12, 0.04, 0.012, "KRW", true);
const KOSDAQ_H = history(837.43, -0.03, 0.015, "KRW", true);

const indicesKr: StockIndex[] = [
  {
    name: "코스피",
    value: 3245.12,
    changePct: lastChange(KOSPI_H),
    history: KOSPI_H,
    comment: "(예시) 반도체 대형주 중심으로 오른 하루라는 설정의 관측 요약입니다.",
    outlook: "(예시) 박스권 상단을 시험하는 흐름",
    rationale: "(예시) 외국인 순매수가 사흘째 이어졌다는 가상 근거",
  },
  {
    name: "코스닥",
    value: 837.43,
    changePct: lastChange(KOSDAQ_H),
    history: KOSDAQ_H,
    comment: "(예시) 개인 매도로 약세. 전망은 근거(rationale)가 없어 감춰지는 경우입니다.",
    outlook: "(예시) 약세 지속 — 근거가 없어 메일에 나오면 안 되는 문장",
    rationale: null,
  },
];

const SAMSUNG_H = history(84300, 0.09, 0.018, "KRW");
const HYNIX_H = history(198500, -0.07, 0.022, "KRW");
const NAVER_H = history(212000, 0.02, 0.01, "KRW");

const analysesKr: StockAnalysis[] = [
  analysis({
    symbol: "005930",
    name: "삼성전자",
    history: SAMSUNG_H,
    summary: "(예시) 가상 고객사 '한빛칩스'와의 공급 계약 기대가 거론됐다는 설정의 관측 요약입니다.",
    outlook: "(예시) 단기 상승 흐름 유지 가능성",
    rationale: "(예시) 5일선 위에서 거래량이 늘었다는 가상 근거",
    risks: "(예시) 환율 변동성, 업황 둔화 우려",
    verdict: "📈",
  }),
  analysis({
    symbol: "000660",
    name: "SK하이닉스",
    history: HYNIX_H,
    summary: "(예시) 차익 실현 매물이 나왔다는 설정입니다.",
    outlook: "(예시) 단기 조정 가능성",
    rationale: "(예시) 20일선을 밑돈 채 마감했다는 가상 근거",
    risks: "(예시) 메모리 가격 하락 전환 시 낙폭 확대",
    verdict: "📉",
  }),
  {
    // 시세 검증 실패(조회 실패) — close 계열이 비고 '시세 미검증'이 붙는 경우. 지난 시계열은 남아 있다.
    ...analysis({
      symbol: "035420",
      name: "NAVER",
      history: NAVER_H,
      summary: "(예시) 시세를 확인하지 못한 종목입니다. 서술만 있고 숫자는 '-'로 나와야 합니다.",
      outlook: "(예시) 방향성 판단 보류",
      rationale: "(예시) 시세 조회 실패로 근거 부족",
      risks: "(예시) 데이터 공백",
      verdict: "➡️",
    }),
    close: null,
    changePct: null,
    weekChangePct: null,
    ma5: null,
    ma20: null,
    verified: false,
  },
];

function watch(
  a: StockAnalysis,
  o: Pick<StockWatchItem, "attention" | "levels"> & { market: StockWatchItem["market"] }
): StockWatchItem {
  return { ...a, ...o };
}

const watchlistKr: StockWatchItem[] = [
  watch(
    analysis({
      symbol: "005380",
      name: "현대차",
      history: history(241500, 0.05, 0.012, "KRW"),
      summary: "(예시) 가상 전기차 전시회 소식으로 거론됐다는 설정입니다.",
      outlook: "(예시) 관심 지속",
      rationale: "(예시) 거래대금 상위 진입",
      risks: "(예시) 관세 관련 불확실성",
      verdict: "📈",
    }),
    { attention: "🔥강", levels: "(예시) 24만원 지지, 25만원 저항", market: "kr" }
  ),
  watch(
    analysis({
      symbol: "035720",
      name: "카카오",
      history: history(41250, -0.04, 0.02, "KRW"),
      summary: "(예시) 주목 가격대 정보가 없는 관심 종목입니다.",
      outlook: "(예시) 단기 변동성 확대",
      rationale: "(예시) 가상 신규 서비스 발표 일정",
      risks: "(예시) 규제 이슈",
      verdict: "➡️",
    }),
    { attention: "⚡중", levels: null, market: "kr" }
  ),
  // 해외 참고 — 이 장(한국장)에 상장되지 않은 종목. 통화·시세는 상장 시장 기준.
  watch(
    analysis({
      symbol: "NVDA",
      name: "엔비디아",
      currency: "USD",
      history: history(182.4, 0.06, 0.02, "USD"),
      summary: "(예시) 간밤 미국장 흐름이 국내 반도체 관심을 끌었다는 설정입니다.",
      outlook: "(예시) 고점 부근 등락",
      rationale: "(예시) 가상 실적 발표 일정",
      risks: "(예시) 밸류에이션 부담",
      verdict: "📈",
    }),
    { attention: "💧약", levels: null, market: "us" }
  ),
];

function holding(o: Pick<StockHolding, "id" | "symbol" | "name" | "quantity" | "avgPrice" | "targetPrice" | "stopPrice" | "horizon" | "memo">): StockHolding {
  return {
    market: "kr",
    quoteCode: o.symbol,
    exchange: "코스피",
    sortOrder: o.id,
    createdAt: "2026-08-01T09:00:00+09:00",
    updatedAt: "2026-10-01T09:00:00+09:00",
    ...o,
  };
}

const LGES_H = history(368500, -0.08, 0.015, "KRW");

/** 포지션 2건 — 이익(목표·손절, 펄스 요약 있음) / 손실(펄스 요약 없음). 파생값은 서버와 같은 summarizeHolding 으로. */
const positionsKr: StockPositionReview[] = [
  {
    ...summarizeHolding(
      holding({
        id: 1,
        symbol: "005930",
        name: "삼성전자",
        quantity: 30,
        avgPrice: 72000,
        targetPrice: 95000,
        stopPrice: 68000,
        horizon: "long",
        memo: "(예시) 장기 보유",
      }),
      { close: SAMSUNG_H[SAMSUNG_H.length - 1].close, changePct: lastChange(SAMSUNG_H), currency: "KRW" },
      SAMSUNG_H
    ),
    factors: "(예시) 가상 공급 계약 기대가 우호적으로 작용. 장기 관점에선 영향 중립에 가깝다는 서술입니다.",
    pulseSummary: "(예시) 지난 24시간 실시간 취합 3건 — 문자 문턱을 넘지 못한 소식들이 여기에 모인다는 설정입니다.",
  },
  {
    ...summarizeHolding(
      holding({
        id: 2,
        symbol: "373220",
        name: "LG에너지솔루션",
        quantity: 4,
        avgPrice: 420000,
        targetPrice: 480000,
        stopPrice: 350000,
        horizon: "mid",
        memo: "",
      }),
      { close: LGES_H[LGES_H.length - 1].close, changePct: lastChange(LGES_H), currency: "KRW" },
      LGES_H
    ),
    factors: "(예시) 업황 둔화 우려가 부정적으로 작용했다는 서술입니다.",
    pulseSummary: null,
  },
];

/** 한국장 정상 브리핑 — 포지션·뉴스·지수·등록 종목(미검증 포함)·관심 종목·해외 참고·notes·면책. */
export const stockKrFixture: StockSnapshot = {
  market: "kr",
  date: TODAY,
  sessionDate: TODAY,
  role: "both",
  roleReason: "market=kr — 역할 분리는 미국장 전용",
  slot: "08:00",
  updatedAt: `${TODAY}T08:05:00+09:00`,
  source: "llm",
  closed: false,
  closedReason: null,
  indices: indicesKr,
  news: [
    {
      title: "(예시) 가상 중앙은행, 기준금리 동결 — 시장 예상과 같아",
      source: "예시일보",
      date: TODAY,
      summary: "금리 관련 뉴스가 '해외 시장' 묶음에 들어가는 예시입니다.",
      link: "https://example.com/stock-news/rate",
      bucket: "해외 시장",
    },
    {
      title: "(예시) 원·달러 환율 좁은 범위에서 등락 — 링크 없는 뉴스",
      source: "가상통신",
      date: TODAY,
      summary: "원문 링크가 없는 증시 뉴스입니다.",
      link: null,
      bucket: "환율·금리",
    },
    {
      title: "(예시) 가상 소재 기업 '누리머티리얼즈', 증설 계획 발표",
      source: "샘플경제",
      date: dayOffset(-1),
      summary: "산업·기업 묶음의 예시입니다.",
      link: "https://example.com/stock-news/capex",
      bucket: "산업·기업",
    },
    {
      title: "(예시) 외국인, 반도체 대형주 사흘째 순매수",
      source: "예시일보",
      date: TODAY,
      summary: "수급 묶음의 예시입니다.",
      link: "https://example.com/stock-news/flow",
      bucket: "수급",
    },
  ],
  analyses: analysesKr,
  watchlist: watchlistKr,
  disclaimer: DISCLAIMER,
  notes: "(예시) NAVER 시세 조회가 실패해 해당 종목은 서술만 실었습니다.",
  positions: positionsKr,
};

/** 차트를 붙일 고정(pinned) 종목 — 원장 대신 픽스처에서 정한다(DB 를 읽지 않는다). */
export const STOCK_KR_PINNED: ReadonlySet<string> = new Set(["005930", "000660"]);

/** 한국장 휴장 변형 — holidaySnapshot 과 같은 모양(서술 없음, 지수는 직전 거래일 종가). */
export const stockKrClosedFixture: StockSnapshot = {
  market: "kr",
  date: TODAY,
  sessionDate: dayOffset(1),
  role: "both",
  roleReason: "market=kr — 역할 분리는 미국장 전용",
  slot: "08:00",
  updatedAt: `${TODAY}T08:01:00+09:00`,
  source: "holiday",
  closed: true,
  closedReason: "임시 휴장(예시)",
  indices: indicesKr.map((i) => ({ ...i, comment: null, outlook: null, rationale: null })),
  news: [],
  analyses: [],
  watchlist: [],
  disclaimer: DISCLAIMER,
  notes: "휴장(임시 휴장(예시)) — 브리핑을 생성하지 않았습니다.",
};
