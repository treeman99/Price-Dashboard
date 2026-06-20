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
  return `너는 한국 팝업스토어·전시 큐레이터다. 아래 네이버 검색 결과(제목 | 설명 | 링크)는 대부분
블로그 "총정리/모음/추천 TOP" 글이라 그대로 쓰면 안 된다. 본문에서 **실제 개별 행사**를 뽑아내
"행사 리스트"를 만들어라. 기준 시점: ${corpus.month}. **오늘 날짜: ${today}**.

핵심 규칙:
1. 제목은 블로그 글 제목(예: "6월 성수 팝업 총정리", "서울 전시회 추천 TOP5")이 아니라
   **실제 행사의 정식 명칭**으로 작성한다. 예: "톰브라운 팝업스토어", "디뮤지엄 ○○展", "베이비페어 2026".
   글에서 행사명을 알 수 없으면 그 항목은 버린다(추측 금지).
2. **같은 행사는 반드시 하나로 합친다.** 여러 글/링크에 같은 행사가 나오면 1개만 출력한다
   (행사명+장소+기간이 같으면 동일 행사). 가장 정보가 풍부한 출처 링크 1개만 남긴다.
3. "총정리/모음/일정정리/추천/베스트/TOP/가볼만한곳" 류의 묶음 글 자체는 행사가 아니므로 출력하지 않는다.
4. 신뢰가 낮거나 모호하면 WebSearch 도구로 실제 행사명·기간·장소를 검수/확인한 뒤 확정한다.
5. **날짜 필수**: 각 행사의 startDate(시작일), endDate(종료일)를 "YYYY-MM-DD"로 채운다(연도 모르면 ${corpus.month.slice(0, 4)} 가정). 정말 모르면 null.
6. **이미 종료된 행사(endDate가 오늘 ${today}보다 과거)는 출력하지 마라.** 진행 중이거나 시작 예정인 것만.
7. 팝업은 **서울과 경기 모두** 대상. 지역 분류: 서울(성수/홍대/여의도/강남/잠실 등) + 경기(판교/분당/수원/광교/일산/하남 스타필드/용인 등). 경기 누락 금지.
8. 전시는 반드시 4개 전시장 섹션을 모두 포함(없으면 빈 배열): ${MANDATORY_VENUES.join(", ")}. 그 외는 general.
9. summary는 한 줄 핵심만. 팝업 최대 20개, 전시장별 최대 6개, general 최대 12개. 실제 행사만, 중복 없이.
   (tag 는 신경쓰지 말 것 — 서버가 날짜로 자동 계산함)

검색결과:
${corpusToText(corpus)}

반드시 아래 JSON만 출력(다른 텍스트 없이):
{"popups":[{"name":string,"region":string,"period":string,"startDate":string|null,"endDate":string|null,"summary":string,"link":string|null,"category":string|null}],
"exhibitions":{"venues":[{"name":string,"items":[{"title":string,"venue":string,"period":string,"startDate":string|null,"endDate":string|null,"summary":string,"link":string|null}]}],"general":[{"title":string,"venue":string,"period":string,"startDate":string|null,"endDate":string|null,"summary":string,"link":string|null}]},
"notes":string|null}`;
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
        allowedTools: ["WebSearch"], // 실제 행사명/기간 검수용
        permissionMode: "bypassPermissions",
        settingSources: [],
        maxTurns: 16,
        systemPrompt:
          "너는 팝업/전시 큐레이터다. 블로그 묶음글이 아니라 실제 개별 행사를 중복 없이 추려 마지막에 지정된 JSON 한 개만 출력한다.",
      },
    });
    let finalText = "";
    for await (const msg of q) {
      if (msg.type === "result" && msg.subtype === "success") finalText = msg.result;
    }
    if (!finalText) return rawSnapshot(corpus, date);

    const p = extractJson(finalText) as any;

    // 필수 4개 전시장 보정: 누락된 전시장은 빈 섹션으로 채움. 종료된 행사는 제외.
    const venuesIn: VenueGroup[] = Array.isArray(p?.exhibitions?.venues) ? p.exhibitions.venues : [];
    const venues: VenueGroup[] = MANDATORY_VENUES.map((name) => {
      const found = venuesIn.find((v) => v?.name && String(v.name).includes(name.slice(0, 2)));
      const items = Array.isArray(found?.items)
        ? found!.items.map(normExhibition(name, date)).filter((e) => !isEnded(e.endDate, date))
        : [];
      return { name, items: dedupeByTitle(items, (x) => x.title).slice(0, 6) };
    });

    const popups = dedupeByTitle(
      (Array.isArray(p?.popups) ? p.popups : [])
        .map(normPopup(date))
        .filter((e: PopupItem) => !isEnded(e.endDate, date)),
      (x: PopupItem) => x.name
    ).slice(0, 20);

    const general = dedupeByTitle(
      (Array.isArray(p?.exhibitions?.general) ? p.exhibitions.general : [])
        .map(normExhibition("서울/경기", date))
        .filter((e: ExhibitionItem) => !isEnded(e.endDate, date)),
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

function normPopup(today: string) {
  return (r: any): PopupItem => {
    const startDate = normDate(r?.startDate);
    const endDate = normDate(r?.endDate);
    return {
      name: String(r?.name ?? "").slice(0, 120),
      region: String(r?.region ?? "기타"),
      period: String(r?.period ?? ""),
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
  return (r: any): ExhibitionItem => {
    const startDate = normDate(r?.startDate);
    const endDate = normDate(r?.endDate);
    return {
      title: String(r?.title ?? "").slice(0, 140),
      venue: String(r?.venue ?? defaultVenue),
      period: String(r?.period ?? ""),
      startDate,
      endDate,
      summary: String(r?.summary ?? ""),
      link: r?.link ? String(r.link) : null,
      tag: computeTag(startDate, endDate, today),
    };
  };
}
