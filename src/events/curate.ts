import { query } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../util/log.ts";
import { MANDATORY_VENUES, type RawCorpus, type RawGroup } from "./gather.ts";
import type {
  EventsSnapshot,
  PopupItem,
  ExhibitionItem,
  VenueGroup,
  EventTag,
} from "../../shared/types.ts";

const REGIONS = [
  // 서울
  "성수", "홍대", "여의도", "강남", "잠실", "명동", "한남", "이태원", "연남", "압구정", "삼성동", "더현대",
  // 경기
  "판교", "분당", "수원", "광교", "일산", "하남", "스타필드", "고양", "용인", "안양", "성남", "동탄",
];

// 서울/경기 한정용 비수도권 지역 키워드(이 단어가 들어간 행사는 제외).
// ※ 오탐 위험 단어는 제외: 세종(세종문화회관=서울), 진주(보석/명화), 양산(우산), 구미(구미호) 등.
const NON_CAPITAL_REGIONS = [
  "부산", "대구", "인천", "광주", "대전", "울산",
  "강원", "춘천", "강릉", "속초", "원주",
  "청주", "충주", "천안", "아산",
  "전주", "군산", "익산", "여수", "순천", "목포",
  "포항", "경주", "안동",
  "창원", "김해", "통영", "거제",
  "제주", "서귀포",
];

/**
 * 행사 텍스트가 서울/경기 권역인지 판별. 비수도권 키워드가 하나라도 있으면 제외.
 * ※ "더현대 대구", "스타필드 부산"처럼 백화점/몰 브랜드는 전국 지점이 있어 지역 신호로 쓸 수 없다.
 *   따라서 수도권 브랜드명으로 구제하지 않고, 비수도권 지명이 있으면 단순 제외한다.
 */
function isCapitalArea(text: string): boolean {
  return !NON_CAPITAL_REGIONS.some((r) => text.includes(r));
}

function dedupe<T extends { link: string | null; title?: string; name?: string }>(arr: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of arr) {
    const key = (x.link || "") + "|" + (x.title || x.name || "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out;
}

function guessRegion(text: string): string {
  for (const r of REGIONS) if (text.includes(r)) return r;
  return "기타";
}

function flat(groups: RawGroup[]): { title: string; description: string; link: string }[] {
  return groups.flatMap((g) => g.items);
}

// ── 폴백: 네이버 검색 원본을 그대로 구조화 ──
function rawSnapshot(corpus: RawCorpus, date: string): EventsSnapshot {
  // 폴백은 검색 원본이라 날짜를 알 수 없음 → startDate/endDate null, tag null (필터/배지 불가)
  const popups: PopupItem[] = dedupe(flat(corpus.popupGroups))
    .filter((it) => isCapitalArea(it.title + " " + it.description))
    .slice(0, 24)
    .map((it) => ({
      name: it.title,
      region: guessRegion(it.title + it.description),
      period: "",
      startDate: null,
      endDate: null,
      summary: it.description,
      link: it.link,
      category: null,
      tag: null as EventTag,
    }));

  const venues: VenueGroup[] = corpus.venues.map((v) => ({
    name: v.venue,
    items: dedupe(flat(v.groups))
      .slice(0, 6)
      .map((it) => ({
        title: it.title,
        venue: v.venue,
        period: "",
        startDate: null,
        endDate: null,
        summary: it.description,
        link: it.link,
        tag: null as EventTag,
      })),
  }));

  const general: ExhibitionItem[] = dedupe(flat(corpus.generalGroups))
    .filter((it) => isCapitalArea(it.title + " " + it.description))
    .slice(0, 10)
    .map((it) => ({
      title: it.title,
      venue: "서울/경기",
      period: "",
      startDate: null,
      endDate: null,
      summary: it.description,
      link: it.link,
      tag: null as EventTag,
    }));

  return {
    date,
    updatedAt: new Date().toISOString(),
    source: "naver-raw",
    popups,
    exhibitions: { venues, general },
    notes: "네이버 검색 결과 원본 (LLM 큐레이션 비활성: ANTHROPIC_API_KEY 미설정)",
  };
}

// ── 프롬프트용 코퍼스 직렬화 (간결하게) ──
function corpusToText(corpus: RawCorpus): string {
  const lines: string[] = [];
  const dump = (label: string, items: { title: string; description: string; link: string }[]) => {
    lines.push(`\n### ${label}`);
    items.slice(0, 10).forEach((it) => {
      lines.push(`- ${it.title} | ${it.description} | ${it.link}`);
    });
  };
  lines.push("## 팝업스토어 검색결과");
  corpus.popupGroups.forEach((g) => dump(g.label, g.items));
  lines.push("\n## 전시장별 검색결과");
  corpus.venues.forEach((v) => v.groups.forEach((g) => dump(g.label, g.items)));
  lines.push("\n## 일반 전시 검색결과");
  corpus.generalGroups.forEach((g) => dump(g.label, g.items));
  return lines.join("\n");
}

function buildPrompt(corpus: RawCorpus, today: string): string {
  return `너는 한국 팝업스토어·전시 큐레이터다. 아래 네이버 검색 결과(제목 | 설명 | 링크)는 단서일 뿐,
대부분 블로그 "총정리/모음" 글이고 **날짜·내용이 부정확**하다. 절대 스니펫의 날짜를 그대로 믿지 마라.
WebSearch/WebFetch로 **실제 원문·공식 페이지를 직접 열어 검증**한 뒤 "행사 리스트"를 만들어라.
기준 시점: ${corpus.month}. **오늘 날짜: ${today}**.

추출 규칙:
1. 제목은 블로그 글 제목이 아니라 **실제 행사의 정식 명칭**. (예: "톰브라운 팝업스토어", "2026 서울국제도서전")
2. **하나의 글/링크에 여러 행사가 있으면 그 행사들을 모두 개별 항목으로 추출**한다. 한 개만 뽑지 말 것.
3. **같은 행사는 하나로 합친다**(행사명+장소+기간 동일).
4. "총정리/모음/추천/TOP/가볼만한곳" 묶음 글 자체는 행사가 아니므로 출력하지 않는다.
5. 각 행사 startDate/endDate를 "YYYY-MM-DD"로(연도 모르면 ${corpus.month.slice(0, 4)} 가정). 확인 불가면 null.
6. **이미 종료된 행사(endDate < ${today})는 출력하지 마라.** 진행 중이거나 시작 예정인 것만.
7. **서울·경기(수도권)만** 대상. 지역: 서울(성수/홍대/여의도/강남/잠실 등)+경기(판교/분당/수원/광교/일산/하남 스타필드/용인 등). 경기 누락 금지.
   **부산·대구·인천·광주·대전·울산·강원·충청·전라·경상·제주 등 서울/경기 외 지역의 팝업·전시는 절대 포함하지 마라.** 장소가 불명확하면 제외.
8. 전시는 다음 전시장 섹션을 모두 포함(없으면 빈 배열): ${MANDATORY_VENUES.join(", ")}. 그 외는 general.
   ※ 수원컨벤션센터(광교, SCC)와 수원메쎄(권선구, SUWON MESSE)는 **서로 다른 전시장**이니 섞지 말 것.
9. summary는 한 줄. 팝업 최대 20, 전시장별 최대 8, general 최대 12. 실제 행사만, 중복 없이.

검증 강도(중요):
- **팝업**: 검색 단서에서 **적극적으로 많이 추출**하라(최대 20개). 팝업은 공식 페이지 확인이 어려우니 WebFetch 검증을 강제하지 않는다.
  날짜가 불명확하면 startDate/endDate만 null로 두고 **행사 자체는 버리지 마라.**
- **전시(4개 전시장 + 일반)**: 날짜가 중요하므로 가능하면 WebSearch/WebFetch로 공식 페이지를 열어 시작/종료일을 검증한다.
  공식 일정 페이지 예: 코엑스 https://www.coex.co.kr , 세텍 https://www.setec.or.kr , 킨텍스 https://www.kintex.com , 수원컨벤션센터 https://www.scc.or.kr , 수원메쎄 https://www.suwonmesse.com.
  스니펫 날짜와 공식 날짜가 다르면 **공식 날짜를 따른다**.
- **link**: 도메인 루트(예: https://www.coex.co.kr)만 아는 경우엔 link를 null로 둬도 된다(서버가 출처 링크를 자동 보정함).
  임의의 URL은 절대 지어내지 마라.
- tag 는 서버가 날짜로 자동 계산하니 출력하지 말 것.

검색 단서:
${corpusToText(corpus)}

검증을 마친 뒤, 반드시 아래 JSON만 출력(다른 텍스트 없이):
{"popups":[{"name":string,"region":string,"period":string,"startDate":string|null,"endDate":string|null,"summary":string,"link":string|null,"category":string|null}],
"exhibitions":{"venues":[{"name":string,"items":[{"title":string,"venue":string,"period":string,"startDate":string|null,"endDate":string|null,"summary":string,"link":string|null}]}],"general":[{"title":string,"venue":string,"period":string,"startDate":string|null,"endDate":string|null,"summary":string,"link":string|null}]},
"notes":string|null}`;
}

// ── 링크 검증: 환각/무관 URL 차단 ──
// 허용: 코퍼스(실제 수집된 검색결과)에 있던 링크 OR 공식 전시장/예매 도메인
const OFFICIAL_LINK_DOMAINS = [
  "coex.co.kr", "kintex.com", "setec.or.kr", "scc.or.kr", "suwonmesse.com",
  "interpark.com", "ticketlink.co.kr", "yes24.com", "ticket.melon.com",
];

function normUrl(u: string): string {
  try {
    const url = new URL(u.trim());
    return (url.hostname.replace(/^www\./, "") + url.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return u.trim().toLowerCase().replace(/\/+$/, "");
  }
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

interface CorpusItem {
  title: string;
  description: string;
  link: string;
}

function collectCorpusItems(corpus: RawCorpus): CorpusItem[] {
  const out: CorpusItem[] = [];
  const add = (items: CorpusItem[]) => items.forEach((it) => it.link && out.push(it));
  corpus.popupGroups.forEach((g) => add(g.items));
  corpus.venues.forEach((v) => v.groups.forEach((g) => add(g.items)));
  corpus.generalGroups.forEach((g) => add(g.items));
  return out;
}

const STOPWORDS = new Set([
  "팝업", "팝업스토어", "스토어", "전시", "전시회", "展", "박람회", "페어", "store", "popup",
  "in", "the", "and", "2026", "2025", "서울", "경기",
]);

function hasPath(u: string): boolean {
  try {
    return new URL(u).pathname.replace(/\/+$/, "").length > 0;
  } catch {
    return false;
  }
}

// 링크로 인정할 신뢰 도메인(블로그/카페/SNS/공식·예매/공공). 그 외(랜덤 도메인)는 거른다.
const REPUTABLE_DOMAIN_SUFFIXES = [
  "naver.com", "naver.me", "tistory.com", "daum.net", "brunch.co.kr", "blog.me",
  "instagram.com", "facebook.com",
  "coex.co.kr", "kintex.com", "setec.or.kr", "scc.or.kr", "suwonmesse.com",
  "interpark.com", "ticketlink.co.kr", "yes24.com", "melon.com", "ticketbay.co.kr",
  ".go.kr", ".or.kr",
];

function reputableHost(host: string): boolean {
  if (!host) return false;
  return REPUTABLE_DOMAIN_SUFFIXES.some((s) =>
    s.startsWith(".") ? host.endsWith(s) : host === s || host.endsWith("." + s)
  );
}

/** 링크 인정 조건: 신뢰 도메인 + 실제 경로 보유 */
function acceptableLink(link: string | null): boolean {
  return !!link && reputableHost(hostOf(link)) && hasPath(link);
}

/** 행사명에서 식별 토큰(브랜드/고유명) 추출 */
function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** 행사명을 검색결과(코퍼스)에 매칭해 실제 출처 링크를 찾는다. 가장 식별력 높은 토큰이 포함된 항목 우선. */
function matchCorpusLink(name: string, items: CorpusItem[]): string | null {
  const tokens = nameTokens(name);
  if (!tokens.length) return null;
  const key = tokens.slice().sort((a, b) => b.length - a.length)[0]; // 가장 긴 토큰(보통 고유명)
  let best: string | null = null;
  let bestScore = 0;
  for (const it of items) {
    if (!acceptableLink(it.link)) continue; // 잡 도메인/루트 링크는 후보 제외
    const hay = (it.title + " " + it.description).toLowerCase();
    if (!hay.includes(key)) continue; // 핵심 토큰 없으면 무관으로 간주
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = it.link;
    }
  }
  return best;
}

// 전시장 정식명 ↔ LLM이 돌려준 전시장명 매칭용 키워드(수원컨벤션센터/수원메쎄 충돌 방지)
const VENUE_KEYWORDS: Record<string, string[]> = {
  코엑스: ["코엑스", "coex"],
  세텍: ["세텍", "setec", "학여울"],
  킨텍스: ["킨텍스", "kintex"],
  수원컨벤션센터: ["수원컨벤션", "컨벤션센터", "scc", "광교"],
  수원메쎄: ["수원메쎄", "메쎄", "메세", "messe"],
};

function matchVenue(llmName: string, canonical: string): boolean {
  const hay = llmName.toLowerCase();
  const kws = VENUE_KEYWORDS[canonical] ?? [canonical];
  return kws.some((k) => hay.includes(k.toLowerCase()));
}

/**
 * 행사 링크 결정(서버 주도). 우선순위:
 * 1) LLM 링크가 실제 코퍼스 링크면 사용
 * 2) LLM 링크가 공식 전시장 도메인 + 구체 경로(루트 아님)면 사용
 * 3) 행사명을 코퍼스에 매칭해 실제 출처 링크 부여
 * 4) 없으면 null (링크 없이 표시)
 */
function resolveLink(
  name: string,
  llmLink: string | null,
  corpusLinks: Set<string>,
  corpusItems: CorpusItem[]
): string | null {
  let cand: string | null = null;
  if (llmLink && corpusLinks.has(normUrl(llmLink))) {
    cand = llmLink; // LLM이 고른 실제 출처
  } else if (llmLink) {
    const h = hostOf(llmLink);
    if (OFFICIAL_LINK_DOMAINS.some((d) => h === d || h.endsWith("." + d)) && hasPath(llmLink)) {
      cand = llmLink; // 공식 전시장 구체 페이지
    }
  }
  if (!cand) cand = matchCorpusLink(name, corpusItems); // 행사명↔검색결과 매칭
  // 최종 관문: 신뢰 도메인 + 경로 있는 링크만 통과(잡/루트 링크 제거)
  return acceptableLink(cand) ? cand : null;
}

/** 날짜 기준 상태 계산 + 종료 행사 제외용 헬퍼 */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

/** endDate가 오늘보다 과거면 종료된 행사 */
function isEnded(endDate: string | null, today: string): boolean {
  return !!endDate && endDate < today;
}

/** 날짜로 태그 계산: 시작 전→예정, 7일내 종료→종료임박, 그 외 null */
function computeTag(startDate: string | null, endDate: string | null, today: string): EventTag {
  if (startDate && startDate > today) return "예정";
  if (endDate && endDate >= today && daysBetween(today, endDate) <= 7) return "종료임박";
  return null;
}

/** 제목 정규화: 공백/괄호/특수문자 제거 후 비교용 키 */
function titleKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\[\]()·,~!?.“”"'`\-_/]/g, "")
    .replace(/(전시회|전시|展|팝업스토어|팝업|박람회|페어|expo|fair)/g, "");
}

/** 제목 기준 중복 제거 (LLM 누락 대비 안전장치) */
function dedupeByTitle<T>(arr: T[], getTitle: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of arr) {
    const k = titleKey(getTitle(x));
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function extractJson(text: string): unknown {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e <= s) throw new Error("JSON 미발견");
  return JSON.parse(text.slice(s, e + 1));
}

/**
 * RawCorpus → EventsSnapshot. Agent SDK LLM 큐레이션(실제 행사 추출·중복제거·검수).
 * 명시적 키가 없어도 Claude Code 로그인 자격증명으로 동작하며, 실패 시에만 원본 폴백.
 */
export async function curate(corpus: RawCorpus, date: string): Promise<EventsSnapshot> {
  try {
    const q = query({
      prompt: buildPrompt(corpus, date),
      options: {
        // 실제 원문·공식 페이지를 열어 날짜/내용 검증
        allowedTools: ["WebSearch", "WebFetch"],
        permissionMode: "bypassPermissions",
        settingSources: [],
        maxTurns: 40,
        systemPrompt:
          "너는 꼼꼼한 팝업/전시 큐레이터다. 스니펫을 믿지 말고 WebSearch/WebFetch로 실제 날짜를 검증한 뒤, 실제 개별 행사를 중복 없이 추려 마지막에 지정된 JSON 한 개만 출력한다.",
      },
    });
    let finalText = "";
    for await (const msg of q) {
      if (msg.type === "result" && msg.subtype === "success") finalText = msg.result;
    }
    if (!finalText) return rawSnapshot(corpus, date);

    const p = extractJson(finalText) as any;
    const corpusItems = collectCorpusItems(corpus);
    const corpusLinks = new Set(corpusItems.map((it) => normUrl(it.link)));

    // 필수 전시장 보정: 누락된 전시장은 빈 섹션으로 채움. 종료된 행사는 제외.
    const venuesIn: VenueGroup[] = Array.isArray(p?.exhibitions?.venues) ? p.exhibitions.venues : [];
    const venues: VenueGroup[] = MANDATORY_VENUES.map((name) => {
      const found = venuesIn.find((v) => v?.name && matchVenue(String(v.name), name));
      const items = Array.isArray(found?.items)
        ? found!.items
            .map(normExhibition(name, date))
            .map((e) => ({ ...e, link: resolveLink(e.title, e.link, corpusLinks, corpusItems) }))
            .filter((e) => !isEnded(e.endDate, date))
        : [];
      return { name, items: dedupeByTitle(items, (x) => x.title).slice(0, 8) };
    });

    const popups = dedupeByTitle(
      (Array.isArray(p?.popups) ? p.popups : [])
        .map(normPopup(date))
        .map((e: PopupItem) => ({ ...e, link: resolveLink(e.name, e.link, corpusLinks, corpusItems) }))
        .filter((e: PopupItem) => !isEnded(e.endDate, date))
        .filter((e: PopupItem) => isCapitalArea(`${e.name} ${e.region} ${e.summary}`)),
      (x: PopupItem) => x.name
    ).slice(0, 20);

    const general = dedupeByTitle(
      (Array.isArray(p?.exhibitions?.general) ? p.exhibitions.general : [])
        .map(normExhibition("서울/경기", date))
        .map((e: ExhibitionItem) => ({ ...e, link: resolveLink(e.title, e.link, corpusLinks, corpusItems) }))
        .filter((e: ExhibitionItem) => !isEnded(e.endDate, date))
        .filter((e: ExhibitionItem) => isCapitalArea(`${e.title} ${e.venue} ${e.summary}`)),
      (x: ExhibitionItem) => x.title
    ).slice(0, 12);

    const snapshot: EventsSnapshot = {
      date,
      updatedAt: new Date().toISOString(),
      source: "llm",
      popups,
      exhibitions: { venues, general },
      notes: p?.notes ? String(p.notes) : null,
    };
    log.info(
      `이벤트 큐레이션(LLM) 완료 — 팝업 ${snapshot.popups.length}, 전시장 ${venues.reduce((a, v) => a + v.items.length, 0)}, 일반 ${snapshot.exhibitions.general.length}`
    );
    return snapshot;
  } catch (e) {
    log.warn(`이벤트 큐레이션 실패 → 원본 폴백: ${(e as Error).message}`);
    return rawSnapshot(corpus, date);
  }
}

function normDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  return m ? v.trim() : null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 해당 연·월의 마지막 날 */
function lastDayOfMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

/**
 * period 문자열에서 시작/종료일 보완 파싱.
 * 예) "2026.06~2026.06.24", "2026.06", "6.24~6.28", "2026.05~2026.08"
 * 일(day)이 없으면 시작은 1일, 종료는 말일로 보정. 연도 없으면 fallbackYear 사용.
 */
function parsePeriod(period: string, fallbackYear: number): { start: string | null; end: string | null } {
  if (!period) return { start: null, end: null };
  const parts = period.split(/[~∼〜\-–—]/).map((s) => s.trim()).filter(Boolean);
  const parseOne = (s: string, isEnd: boolean): string | null => {
    const nums = (s.match(/\d+/g) ?? []).map(Number);
    if (!nums.length) return null;
    // 첫 숫자가 4자리면 연도, 아니면 fallbackYear
    let year = fallbackYear;
    let rest = nums;
    if (nums[0] >= 1900) {
      year = nums[0];
      rest = nums.slice(1);
    }
    if (!rest.length) return null; // 월을 알 수 없음(연도만)
    const mo = rest[0];
    if (mo < 1 || mo > 12) return null;
    const day = rest[1] ?? (isEnd ? lastDayOfMonth(year, mo) : 1);
    if (day < 1 || day > 31) return null;
    return `${year}-${pad(mo)}-${pad(day)}`;
  };
  if (parts.length === 1) {
    // 단일: 시작은 1일, 종료는 말일
    return { start: parseOne(parts[0], false), end: parseOne(parts[0], true) };
  }
  return { start: parseOne(parts[0], false), end: parseOne(parts[parts.length - 1], true) };
}

/** startDate/endDate가 null이면 period에서 보완 */
function fillDates(
  startDate: string | null,
  endDate: string | null,
  period: string,
  fallbackYear: number
): { startDate: string | null; endDate: string | null } {
  if (startDate && endDate) return { startDate, endDate };
  const parsed = parsePeriod(period, fallbackYear);
  return {
    startDate: startDate ?? parsed.start,
    endDate: endDate ?? parsed.end,
  };
}

function normPopup(today: string) {
  const fy = Number(today.slice(0, 4));
  return (r: any): PopupItem => {
    const period = String(r?.period ?? "");
    const { startDate, endDate } = fillDates(normDate(r?.startDate), normDate(r?.endDate), period, fy);
    return {
      name: String(r?.name ?? "").slice(0, 120),
      region: String(r?.region ?? "기타"),
      period,
      startDate,
      endDate,
      summary: String(r?.summary ?? ""),
      link: r?.link ? String(r.link) : null,
      category: r?.category ? String(r.category) : null,
      tag: computeTag(startDate, endDate, today),
    };
  };
}

function normExhibition(defaultVenue: string, today: string) {
  const fy = Number(today.slice(0, 4));
  return (r: any): ExhibitionItem => {
    const period = String(r?.period ?? "");
    const { startDate, endDate } = fillDates(normDate(r?.startDate), normDate(r?.endDate), period, fy);
    return {
      title: String(r?.title ?? "").slice(0, 140),
      venue: String(r?.venue ?? defaultVenue),
      period,
      startDate,
      endDate,
      summary: String(r?.summary ?? ""),
      link: r?.link ? String(r.link) : null,
      tag: computeTag(startDate, endDate, today),
    };
  };
}
