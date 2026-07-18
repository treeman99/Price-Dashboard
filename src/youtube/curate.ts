import { log } from "../util/log.ts";
import { config } from "../config.ts";
import { runAgentQueryText } from "../util/agent-query.ts";
import { getAgentModel } from "../util/model-store.ts";
import { localDate, localDateDaysAgo } from "../util/date.ts";
import { loadCategories } from "./categories.ts";
import { loadBlocklist, buildBlockMatcher, UNKNOWN_CHANNEL } from "./blocklist.ts";
import { isRecommendedChannel } from "../../shared/youtube.ts";
import { activeWatched, buildWatchedMatcher } from "./watched.ts";
import { buildReclassSection } from "./reclass.ts";
import { enrichVideos, fetchUploadDate } from "./oembed.ts";
import type {
  YoutubeSnapshot,
  YoutubeVideo,
  YoutubeCategory,
  YoutubeCategoryDef,
} from "../../shared/types.ts";

function nowLabel(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${localDate(d)} ${hh}:${mm}`;
}

/** YouTube watch/shorts/youtu.be URL에서 11자 video id 추출. 못 찾으면 null. */
export function extractVideoId(url: string | null | undefined): string | null {
  if (!url) return null;
  const s = String(url);
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/, // watch?v=ID
    /youtu\.be\/([A-Za-z0-9_-]{11})/, // youtu.be/ID
    /\/shorts\/([A-Za-z0-9_-]{11})/, // /shorts/ID
    /\/embed\/([A-Za-z0-9_-]{11})/, // /embed/ID
    /\/live\/([A-Za-z0-9_-]{11})/, // /live/ID
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) return m[1];
  }
  return null;
}

function thumbFor(videoId: string | null): string | null {
  return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null;
}

/** 카테고리 검색 범위 라벨. 미지정/그 외는 한국 전용. */
function scopeLabel(region: YoutubeCategoryDef["region"]): string {
  return region === "global" ? "해외(영어 포함) 가능" : "한국 채널·한국어 영상만";
}

/**
 * region="kr"(한국 전용) 카테고리인데 실제로는 해외 영상인지 판정.
 * 큐레이터가 제목(title)은 한국어로 번역하므로 title 로는 판별 불가 → 원제(originalTitle)를 본다.
 * 원제에 한글이 없고 라틴 문자가 있으면(=번역 전 원문이 영어 등) 해외 영상 후보.
 * 단, 그 경우에도 채널명에 한글이 있으면(영어 제목을 단 한국 유튜버) 한국 영상으로 보고 통과 —
 * 원제가 없으면(한국 영상이면 큐레이터가 원제를 비우거나 title과 같게 둠) 통과.
 */
export function isForeignForKr(
  v: { originalTitle?: string | null; channel?: string },
  region: YoutubeCategoryDef["region"]
): boolean {
  if (region === "global") return false;
  const orig = (v.originalTitle ?? "").trim();
  if (!orig) return false;
  if (/[가-힣]/.test(orig)) return false; // 원제에 한글 → 한국 영상
  if (!/[A-Za-z]/.test(orig)) return false; // 라틴도 없음(숫자/기호뿐) → 판정 보류(통과)
  if (/[가-힣]/.test(v.channel ?? "")) return false; // 채널명에 한글 → 한국 채널(오탐 방지)
  return true; // 원제·채널 모두 비한국어 → 해외 영상
}

/**
 * 스냅샷 읽기 시점 지역 필터. kr 카테고리에서 해외 영상을 제거한 사본 반환.
 * (이미 저장된 스냅샷도 재수집 없이 즉시 정리 — applyBlocklist 와 동일한 읽기 필터 패턴)
 */
export function applyRegionFilter(
  snapshot: YoutubeSnapshot | null,
  defs: YoutubeCategoryDef[]
): YoutubeSnapshot | null {
  if (!snapshot) return snapshot;
  const regionByKey = new Map(defs.map((d) => [d.key, d.region]));
  return {
    ...snapshot,
    categories: snapshot.categories.map((c) => ({
      ...c,
      // 사용자가 수동으로 옮긴 카드(movedByUser)는 지역필터를 건너뛰어 배치를 존중한다.
      items: c.items.filter((v) => v.movedByUser || !isForeignForKr(v, regionByKey.get(c.key))),
    })),
  };
}

/** 제목/채널/원제 중 하나라도 제외 키워드를 포함하면 true(대소문자 무시). */
export function matchesExclude(
  v: { title: string; channel: string; originalTitle?: string | null },
  keywords: string[] | undefined
): boolean {
  if (!keywords || !keywords.length) return false;
  const hay = `${v.title} ${v.channel} ${v.originalTitle ?? ""}`.toLowerCase();
  return keywords.some((k) => {
    const t = k.trim().toLowerCase();
    return t.length > 0 && hay.includes(t);
  });
}

/**
 * 프롬프트 주입 전에 각 카테고리 추천 채널에서 **차단 채널을 걸러낸다**.
 * ⭐ 등록 후 같은 채널을 차단해도 추천 목록에서 자동 제거되지 않아, 그대로 두면
 * '절대 조사 금지'(차단)와 '신규 업로드 우선 채택'(추천)이 같은 채널에 동시에 주입되고
 * 취향 학습·유사 채널 발굴이 차단 채널을 긍정 표본으로 삼는 모순이 생긴다.
 */
export function stripBlockedRecommended(
  defs: YoutubeCategoryDef[],
  blocked: { channel: string; handle: string | null }[]
): YoutubeCategoryDef[] {
  if (!blocked.length) return defs;
  return defs.map((d) => {
    const list = d.recommendedChannels;
    if (!list?.length) return d;
    const kept = list.filter(
      (e) => !blocked.some((b) => isRecommendedChannel([e], b.channel, b.handle))
    );
    return kept.length === list.length ? d : { ...d, recommendedChannels: kept };
  });
}

export function buildPrompt(
  defs: YoutubeCategoryDef[],
  today: string,
  cutoff: string,
  freshDays: number,
  now: string,
  blocked: string[],
  watchedTitles: string[] = [],
  reclassSection = ""
): string {
  const cats = defs
    .map((c) => {
      const exclude =
        c.excludeKeywords && c.excludeKeywords.length
          ? ` [제외(절대 넣지 마라): ${c.excludeKeywords.join(", ")}]`
          : "";
      const recommend =
        c.recommendedChannels && c.recommendedChannels.length
          ? ` [추천 채널(먼저 확인): ${c.recommendedChannels.join(", ")}]`
          : "";
      return `${c.emoji} ${c.label} (key: "${c.key}") [검색범위: ${scopeLabel(c.region)}]${exclude}${recommend}${
        c.description ? ` — ${c.description}` : ""
      }`;
    })
    .join("\n  - ");
  const blockSection = blocked.length
    ? `\n\n🚫 제외 채널(사용자가 차단 — 절대 포함 금지, 검색·조사 대상에서 빼라):\n  - ${blocked.join(
        "\n  - "
      )}\n  이 채널들의 영상은 어떤 카테고리에도 넣지 마라.`
    : "";
  const watchedSection = watchedTitles.length
    ? `\n\n👁 이미 본 영상(사용자가 '본영상'으로 체크 — 다시 넣지 마라):\n  - ${watchedTitles.join(
        "\n  - "
      )}\n  위와 동일한 영상은 어떤 카테고리에도 넣지 마라(제목이 조금 달라도 같은 영상이면 제외).`
    : "";
  // ⭐ 취향 프로필: 사용자가 카드에서 직접 별표한 추천 채널이 하나라도 있으면,
  // '먼저 확인할 목록'을 넘어 취향 신호로 적극 활용하도록 별도 섹션을 주입한다.
  const hasRecommended = defs.some((c) => c.recommendedChannels?.length);
  const tasteSection = hasRecommended
    ? `

⭐ 취향 프로필(추천 채널 — 사용자가 영상 카드에서 직접 별표한 채널, 각 카테고리의 [추천 채널] 표기):
- 추천 채널은 사용자가 "이 채널 영상을 다음에도 보고 싶다"고 고른 **명시적 취향 신호**다. 최대한 활용하라.
- (1) 신규 업로드 최우선: 추천 채널 **각각의** 최근 업로드를 개별 확인하라. 확인은 **WebSearch가 확실하다**
  (예: "site:youtube.com <채널명 또는 @핸들>", "<채널명> 최신 영상 <핵심 키워드>").
  채널 페이지를 WebFetch로 열면 영상 목록이 **안 보일 수 있다**(스크립트 렌더링) — 빈 결과를 "새 영상 없음"으로
  단정하지 말고 반드시 검색으로 다시 확인하라. 신선도 창 안의 새 영상이 있으면 관련성이 맞는 한 **빠뜨리지 말고 우선 채택**한다.
- (2) 취향 학습(**카테고리별**): 각 카테고리에서는 **그 카테고리에 표기된** 추천 채널들의 공통점
  (다루는 주제·형식(튜토리얼/리뷰/해설)·깊이·톤)을 파악하고, 그 카테고리에서 추천 채널 밖 후보를 고를 때
  **그 취향과 닮은 영상을 우선**하라. 다른 카테고리의 추천 채널 취향을 끌어오지 마라.
- (3) 유사 채널 발굴: 추천 채널과 성격이 비슷한 다른 채널의 좋은 영상도 적극 후보에 올려,
  사용자가 취향에 맞는 새 채널을 발견하게 하라.
- 단, 취향 신호는 **어떤 절대 규칙도 이기지 못한다**: 신선도·다양성·검색범위·🚫제외 채널·👁본영상 규칙이
  항상 우선한다(추천 채널이라도 오래된 영상 금지, 같은 채널 최대 2개 유지, 추천 채널만으로 카테고리를 채우지 마라.
  제외 채널이나 그와 비슷한 성향의 채널을 '유사 채널'로 발굴하지 마라).`
    : "";
  return `너는 한국어 유튜브 소식 큐레이터다. 지금 시각은 ${now}. **조회 시점 기준 최근 ${freshDays}일 이내(${cutoff} 이후 ~ ${today})**에
업로드된 YouTube 영상만 모아 아래 ${defs.length}개 카테고리로 정리한다. 이 신선도 기준은 **모든 카테고리에 예외 없이 동일하게** 적용된다.
모든 제목·요약은 **반드시 한국어**로 작성한다(영어 영상도 한국어로 번역·요약). 원제는 originalTitle에 보존한다.

카테고리:
  - ${cats}${blockSection}${watchedSection}${tasteSection}${reclassSection}

🌐 검색 범위(각 카테고리의 [검색범위]를 반드시 준수):
- "한국 채널·한국어 영상만": **한국 유튜버가 만든 한국어(음성/자막) 영상만** 채택한다.
  - 해외 유튜버(예: MKBHD, Dave2D, Linus Tech Tips, JerryRigEverything 등) 영상은 **절대 넣지 마라**.
  - 원본이 영어 등 외국어인 영상은, 제목을 한국어로 번역할 수 있더라도 이 카테고리에 **넣지 마라**.
  - 즉 "번역해서 넣기"는 금지 — 한국인이 한국어로 말하는 영상만.
  - 검색도 한국어 키워드 위주로 하고, 한국 채널을 우선 확인한다. 애매하면 제외한다.
- "해외(영어 포함) 가능": 국가 제한 없이 좋은 영상을 채택하되(요약은 한국어).

조사 방법(WebSearch / WebFetch 사용 — 전문적으로 충분히 조사):
1. 각 카테고리마다 WebSearch를 **서로 다른 각도로 최소 4회 이상** 수행한다. YouTube 영상을 노린 쿼리를 쓴다:
   - 주제 키워드: "site:youtube.com <주제> <이번주/최신>", "<주제> 강의/튜토리얼/활용법 youtube".
   - 도구·제품명: "<도구명> tutorial youtube", "<제품명> review youtube".
   - 채널 확인: 각 카테고리의 **[추천 채널(먼저 확인)]** 에 적힌 채널과 description에 언급된 채널들의 **최근 업로드**를 우선 확인한다. 채널명/@핸들 + 핵심 키워드의 WebSearch가 확실하다("site:youtube.com <채널명 또는 @핸들>" 등). 채널 페이지 WebFetch는 영상 목록이 안 보일 수 있으니 빈 결과면 검색으로 재확인한다. 단, 추천 채널이라도 신선도·관련성 기준은 동일하게 적용한다(오래된 영상은 제외).
   - description에 여러 갈래(번호 목록)가 있으면 **갈래마다 별도로 검색**한다. 한 갈래·한 도구가 결과를 독식하면 안 된다.
   - description이 짧은 카테고리도 주제의 인접 영역(신제품 소식·비교·활용법·업계 이슈 등)까지 폭넓게 검색한다.
2. 후보 영상은 WebFetch로 watch 페이지나 검색결과를 열어 **업로드 날짜·채널명·조회수·핵심 내용**을 확인한다.
   - watch URL은 반드시 정식 형식(https://www.youtube.com/watch?v=...)으로 적는다.
3. 요약(summary)은 제목을 바꿔 쓴 게 아니라 **영상이 실제로 무엇을 다루는지**(주요 포인트 2~4개)를 한국어로 적는다.

⚠️ 신선도 규칙(${freshDays}일, 최우선 — 영상 수보다 중요):
- 업로드일이 **${cutoff} 이후 ~ ${today}** 인 영상만 채택. 그보다 오래됐거나 날짜가 불명확하면 **제외**.
- "N일 전/N주 전" 같은 상대표현이 ${freshDays}일을 넘으면 제외. 날짜 미상도 제외.
- 각 영상 date는 업로드일을 "YYYY-MM-DD"로. (정확한 일자를 모르면 그 영상은 버린다.)
- **날짜 위조 금지·검증됨**: 서버가 각 영상의 실제 업로드일을 유튜브에서 **직접 재검증**한다.
  확실치 않아서 ${cutoff}(경계일)로 대충 맞추거나 추정해서 넣은 영상은 **자동 폐기**되어 아무 의미가 없다.
  watch 페이지에서 실제 업로드일을 **눈으로 확인한** 영상만 넣어라(며칠 전 표시가 아니라 정확한 날짜).
- **최신 우선**: 가능하면 오늘·어제 등 **가장 최근** 영상을 앞세우고, 경계(${cutoff}) 근처 오래된 것에 몰리지 마라.
- 쿼터를 채우려고 오래된 영상을 넣지 마라. 카테고리가 0건이어도 괜찮다.

🎯 다양성 규칙(신선도 다음으로 중요):
- 한 카테고리 안에서 같은 도구·제품·주제로 편중 금지 — 서로 다른 주제·도구·채널을 고르게 섞어라.
- 같은 채널의 영상은 카테고리당 최대 2개.
- 카테고리 주제와 무관한 영상으로 개수를 채우지 마라(관련성이 애매하면 제외).

품질 규칙:
- 라이브 예정(아직 방송 전)·쇼츠 광고·중복 재업로드는 제외. 같은 영상은 한 번만.
- 카테고리당 **6개 이상을 목표로, 최대 12개**까지 채택(단 신선도·관련성 규칙이 항상 우선 — 좋은 영상이 부족하면 적어도 된다).
- 조회수가 높거나 신뢰도 높은 채널을 우선하되, 다양성 규칙을 지킨다.
- 한 영상이 여러 카테고리에 맞으면 가장 잘 맞는 **한 곳**에만 넣는다.

출력 형식 — 검증을 마친 뒤 **아래 JSON 한 개만** 출력(다른 텍스트 없이). 각 카테고리 key 아래 영상 배열, 없으면 빈 배열:
{"categories":{${defs
    .map(
      (c) =>
        `"${c.key}":[{"title":string,"originalTitle":string|null,"channel":string,"channelHandle":string|null,"date":"YYYY-MM-DD","summary":string,"url":string,"views":string|null,"duration":string|null}]`
    )
    .join(",")}},
"notes":string|null}`;
}

function extractJson(text: string): unknown {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e <= s) throw new Error("JSON 미발견");
  return JSON.parse(text.slice(s, e + 1));
}

function normDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  return m ? v.trim() : null;
}

/** 최근 freshDays 이내(cutoff~today)면 통과 */
function isFresh(date: string | null, today: string, cutoff: string): boolean {
  return !!date && date >= cutoff && date <= today;
}

/**
 * 실제 업로드일 재검증. LLM 이 준 date 는 검증 불가라 필터 통과를 위해 cutoff(경계일)로
 * 위조되기 쉽다(실측: 07-06 표기 영상 다수가 실제 06-26~07-04). 그래서 watch 페이지에서
 * 진짜 게시일을 가져와 date 를 교체하고, 신선도 창(cutoff~today) 밖이면 드롭한다.
 * 실제 날짜를 못 구하면(마크업 변경·네트워크) 원래 판정을 유지해 탭이 통째로 비는 것을 막는다.
 */
async function verifyRealDates(
  items: YoutubeVideo[],
  today: string,
  cutoff: string
): Promise<YoutubeVideo[]> {
  const checked = await Promise.all(
    items.map(async (v): Promise<YoutubeVideo | null> => {
      if (!v.videoId) return v;
      const real = await fetchUploadDate(v.videoId);
      if (!real) return v; // 검증 불가 → 기존(LLM date) 유지: 우아한 저하
      if (!isFresh(real, today, cutoff)) {
        log.info(`유튜브 신선도 재검증 드롭 — ${v.videoId} 실제 ${real} (창 ${cutoff}~${today} 밖, LLM표기 ${v.date})`);
        return null;
      }
      return v.date === real ? v : { ...v, date: real }; // 실제 게시일로 교체(표시도 정확해짐)
    })
  );
  return checked.filter((v): v is YoutubeVideo => v != null);
}

function nonEmpty(v: unknown, max: number): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
}

function normVideo(r: any): YoutubeVideo | null {
  const title = String(r?.title ?? "").trim();
  const date = normDate(r?.date);
  const url = String(r?.url ?? "").trim();
  const videoId = extractVideoId(url);
  // 제목·날짜·식별 가능한 유튜브 URL이 없으면 버림(신선도/링크 판정 불가).
  if (!title || !date || !videoId) return null;
  return {
    title: title.slice(0, 200),
    originalTitle: nonEmpty(r?.originalTitle, 200),
    channel: String(r?.channel ?? "").slice(0, 80) || UNKNOWN_CHANNEL,
    channelHandle: nonEmpty(r?.channelHandle, 60),
    date,
    summary: String(r?.summary ?? "").slice(0, 1000),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    thumbnail: thumbFor(videoId),
    views: nonEmpty(r?.views, 40),
    duration: nonEmpty(r?.duration, 16),
  };
}

function toCategory(def: YoutubeCategoryDef, items: YoutubeVideo[]): YoutubeCategory {
  return { key: def.key, label: def.label, emoji: def.emoji, color: def.color, items };
}

function emptySnapshot(date: string, note: string): YoutubeSnapshot {
  return {
    date,
    updatedAt: new Date().toISOString(),
    source: "empty",
    freshDays: config.youtubeFreshDays,
    categories: loadCategories().map((c) => toCategory(c, [])),
    notes: note,
  };
}

/**
 * AI·LLM / 신제품 리뷰 등 유튜브 영상을 Claude Agent SDK(WebSearch/WebFetch)로 전문 조사·요약한다.
 * 최근 youtubeFreshDays 이내 영상만 채택. 실패 시 빈 스냅샷 반환.
 */
export async function curateYoutube(date: string): Promise<YoutubeSnapshot> {
  const today = date;
  const freshDays = config.youtubeFreshDays;
  const cutoff = localDateDaysAgo(freshDays);
  const defs = loadCategories();
  const blockList = loadBlocklist();
  const blockedLabels = blockList.map((b) => (b.handle ? `${b.channel} (${b.handle})` : b.channel));
  const isBlocked = buildBlockMatcher();
  // '본영상'으로 체크된 영상은 수집에서 제외한다: 프롬프트로 미리 알리고(중복 조사 방지),
  // 최종적으로 videoId 기준 하드 후필터로 확실히 제거한다.
  const isWatched = buildWatchedMatcher();
  const watchedTitles = activeWatched()
    .map((w) => w.title)
    .filter((t): t is string => !!t)
    .slice(0, 40);
  // 차단 채널이 추천 목록에 남아 있으면 모순된 지시가 함께 주입되므로 프롬프트용 defs에서 제거.
  const promptDefs = stripBlockedRecommended(
    defs,
    blockList.map((b) => ({ channel: b.channel, handle: b.handle ?? null }))
  );
  try {
    const finalText = await runAgentQueryText(
      buildPrompt(promptDefs, today, cutoff, freshDays, nowLabel(), blockedLabels, watchedTitles, buildReclassSection(defs)),
      {
        // tools = 가용 도구 제한(웹 조사 외 Bash/Write 등 차단 — 외부 페이지 프롬프트 인젝션 방어),
        // allowedTools = 그 도구들을 무프롬프트 허용.
        tools: ["WebSearch", "WebFetch"],
        allowedTools: ["WebSearch", "WebFetch"],
        permissionMode: "bypassPermissions",
        settingSources: [],
        model: getAgentModel(), // 대시보드에서 고른 수집·큐레이션 공통 모델
        // 카테고리당 갈래별 검색(최소 4회+)을 보장하되 과도한 탐색(=느린 수집)을 막기 위해 상한을 둔다.
        maxTurns: 120,
        systemPrompt:
          "너는 꼼꼼한 한국어 유튜브 소식 큐레이터다. AI·LLM과 신제품 리뷰 등 최신 YouTube 영상을 " +
          `최근 ${freshDays}일 이내로만 채택하고(오래되거나 날짜 불명확하면 버림), 영어 영상도 한국어로 번역·요약하며, ` +
          "watch URL을 정확히 적고, 같은 영상은 통합해 마지막에 지정된 JSON 한 개만 출력한다.",
      },
      config.agentQueryTimeoutMs,
      "유튜브 큐레이션"
    );
    if (!finalText) return emptySnapshot(today, "유튜브 큐레이션 결과가 비어 있습니다.");

    const p = extractJson(finalText) as any;
    const catsIn = p?.categories ?? {};

    const categories: YoutubeCategory[] = await Promise.all(
      defs.map(async (meta) => {
        const raw = Array.isArray(catsIn?.[meta.key]) ? catsIn[meta.key] : [];
        const seen = new Set<string>();
        const candidates: YoutubeVideo[] = raw
          .map(normVideo)
          .filter((x: YoutubeVideo | null): x is YoutubeVideo => !!x)
          .filter((x: YoutubeVideo) => isFresh(x.date, today, cutoff))
          .filter((x: YoutubeVideo) => {
            // 카테고리 내 videoId 중복 제거
            if (x.videoId && seen.has(x.videoId)) return false;
            if (x.videoId) seen.add(x.videoId);
            return true;
          })
          .slice(0, 12);

        // oEmbed로 실제 채널명/핸들 보강 + 존재하지 않는(지어낸) 영상 제거
        const enriched = await enrichVideos(candidates);

        // 차단 채널 제외(실제 채널명 기준) + 카테고리 제외 키워드(제목/채널) 하드 필터
        // + 한국 전용(kr) 카테고리는 해외(원제가 비한국어) 영상 하드 제외.
        const items = enriched
          .filter((x) => !isBlocked(x.channel, x.channelHandle))
          .filter((x) => !isWatched(x.videoId)) // '본영상' 체크된 영상은 수집 제외
          .filter((x) => !matchesExclude(x, meta.excludeKeywords))
          .filter((x) => !isForeignForKr(x, meta.region));

        // 마지막 관문: watch 페이지의 실제 업로드일로 신선도 재검증(LLM 의 날짜 위조 차단).
        const fresh = await verifyRealDates(items, today, cutoff);
        // 최신(업로드일 내림차순) 우선 정렬 — 저장·API·이메일 모두 일관되게 최신순.
        fresh.sort((a, b) => b.date.localeCompare(a.date));
        return toCategory(meta, fresh);
      })
    );

    const total = categories.reduce((a, c) => a + c.items.length, 0);
    const snapshot: YoutubeSnapshot = {
      date: today,
      updatedAt: new Date().toISOString(),
      source: "llm",
      freshDays,
      categories,
      notes: p?.notes ? String(p.notes) : null,
    };
    log.info(
      `유튜브 큐레이션(LLM) 완료 — 총 ${total}건 [` +
        categories.map((c) => `${c.emoji}${c.items.length}`).join(" ") +
        "]"
    );
    return snapshot;
  } catch (e) {
    log.warn(`유튜브 큐레이션 실패: ${(e as Error).message}`);
    return emptySnapshot(today, `유튜브 큐레이션 실패: ${(e as Error).message}`);
  }
}
