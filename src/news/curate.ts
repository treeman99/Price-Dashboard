import { log } from "../util/log.ts";
import { config } from "../config.ts";
import { runAgentQueryText } from "../util/agent-query.ts";
import { localDate, localDateDaysAgo } from "../util/date.ts";
import { loadCategories } from "./categories.ts";
import type {
  NewsSnapshot,
  NewsItem,
  NewsCategory,
  NewsCategoryDef,
} from "../../shared/types.ts";

function nowLabel(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${localDate(d)} ${hh}:${mm}`;
}

function buildPrompt(defs: NewsCategoryDef[], today: string, yesterday: string, now: string): string {
  const cats = defs
    .map((c) => `${c.emoji} ${c.label} (key: "${c.key}")${c.description ? ` — ${c.description}` : ""}`)
    .join("\n  - ");
  return `너는 한국어 뉴스 큐레이터다. 지금 시각은 ${now}. **최근 24시간 이내(${yesterday} 이후 ~ ${today})**에 발행된 뉴스만 모아
아래 ${defs.length}개 카테고리로 정리한다. 모든 제목·요약은 **반드시 한국어**로 작성한다(영문 소스도 번역).

카테고리:
  - ${cats}

수집 방법(WebSearch / WebFetch 사용):
1. 각 카테고리별로 WebSearch를 여러 번 수행한다. 한국 소식은 "site:news.naver.com" 등을 활용하고,
   해외 소식은 영문 키워드(techcrunch, theverge, reuters, apnews, bloomberg 등)로 검색한다.
2. **GeekNews**: https://news.hada.io/new 를 WebFetch로 가져와, 페이지의 "N시간전" 표기가 24시간 미만인 글만 채택한다.
   (이 사이트 타임스탬프는 신뢰한다. "1일전" 이상은 제외.) 출처는 "GeekNews", 링크는 토픽 링크.
3. 필요하면 주요 발표/사건은 공식 페이지를 WebFetch로 열어 내용을 보강한다.

⚠️ 24시간 신선도 규칙(최우선, 기사 수보다 중요):
- 검색 결과 스니펫에 **명시적 날짜("YYYY-MM-DD", "YYYY년 M월 D일")** 또는 "N시간 전(N<24)"이 보이는 기사만 채택.
- "1일 전/2일 전/어제/그저께" 같은 상대 표현 → **제외**(부정확). GeekNews 페이지의 "N시간전"만 예외로 신뢰.
- 날짜가 불명확/미상이면 **제외**. 쿼터를 채우려고 오래된 기사를 넣지 마라. 0건이어도 괜찮다.
- 각 기사 date는 발행일을 "YYYY-MM-DD"로. ${today} 또는 (cutoff 이후가 확실한) ${yesterday}만 허용.

⚠️ 유튜브/영상 제외(중요):
- 이 뉴스 다이제스트는 **텍스트 기사 전용**이다. YouTube 등 영상은 출처로도 related로도 넣지 마라.
  (유튜브 소식은 별도 "유튜브 소식" 탭에서 전문적으로 다룬다.)

중복 통합:
- 제목이 달라도 "누가+무엇을"이 같으면 동일 사건. 카테고리를 넘어서도 중복 제거(더 맞는 한 곳에만).
- 가장 상세한 출처를 대표로 삼고, 나머지는 related(최대 2개, 텍스트 기사만)로 붙인다.

출력 형식 — 검증을 마친 뒤 **아래 JSON 한 개만** 출력(다른 텍스트 없이). 각 카테고리 key 아래 기사 배열, 없으면 빈 배열:
{"categories":{${defs.map((c) => `"${c.key}":[{"title":string,"source":string,"date":"YYYY-MM-DD","summary":string,"link":string|null,"related":[{"label":string,"link":string}]}]`).join(",")}},
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

/** 최근 24시간(오늘 또는 어제 날짜)만 통과 */
function isFresh(date: string | null, today: string, yesterday: string): boolean {
  return date === today || date === yesterday;
}

function normItem(r: any): NewsItem | null {
  const title = String(r?.title ?? "").trim();
  const date = normDate(r?.date);
  if (!title || !date) return null; // 제목/날짜 없으면 버림(신선도 판정 불가)
  const related = Array.isArray(r?.related)
    ? r.related
        .map((x: any) => ({ label: String(x?.label ?? "").trim(), link: String(x?.link ?? "").trim() }))
        .filter((x: { label: string; link: string }) => x.label && x.link)
        .slice(0, 2)
    : [];
  return {
    title: title.slice(0, 200),
    source: String(r?.source ?? "").slice(0, 80),
    date,
    summary: String(r?.summary ?? "").slice(0, 1000),
    link: r?.link ? String(r.link) : null,
    related,
  };
}

function toCategory(def: NewsCategoryDef, items: NewsItem[]): NewsCategory {
  return { key: def.key, label: def.label, emoji: def.emoji, color: def.color, items };
}

function emptySnapshot(date: string, note: string): NewsSnapshot {
  return {
    date,
    updatedAt: new Date().toISOString(),
    source: "empty",
    categories: loadCategories().map((c) => toCategory(c, [])),
    notes: note,
  };
}

/**
 * 최근 24시간 뉴스 7개 카테고리를 Claude Agent SDK(WebSearch/WebFetch)로 수집·요약한다.
 * 실패 시 빈 스냅샷 반환.
 */
export async function curateNews(date: string): Promise<NewsSnapshot> {
  const today = date;
  const yesterday = localDateDaysAgo(1);
  const defs = loadCategories();
  try {
    const finalText = await runAgentQueryText(
      buildPrompt(defs, today, yesterday, nowLabel()),
      {
        allowedTools: ["WebSearch", "WebFetch"],
        permissionMode: "bypassPermissions",
        settingSources: [],
        maxTurns: 80,
        systemPrompt:
          "너는 꼼꼼한 한국어 뉴스 큐레이터다. 최근 24시간 기사만 채택하고(오래되거나 날짜 불명확하면 버림), " +
          "같은 사건은 통합하며, 영문 소스도 한국어로 요약해 마지막에 지정된 JSON 한 개만 출력한다.",
      },
      config.agentQueryTimeoutMs,
      "뉴스 큐레이션"
    );
    if (!finalText) return emptySnapshot(today, "뉴스 큐레이션 결과가 비어 있습니다.");

    const p = extractJson(finalText) as any;
    const catsIn = p?.categories ?? {};

    const categories: NewsCategory[] = defs.map((meta) => {
      const raw = Array.isArray(catsIn?.[meta.key]) ? catsIn[meta.key] : [];
      const items = raw
        .map(normItem)
        .filter((x: NewsItem | null): x is NewsItem => !!x)
        .filter((x: NewsItem) => isFresh(x.date, today, yesterday));
      return toCategory(meta, items);
    });

    const total = categories.reduce((a, c) => a + c.items.length, 0);
    const snapshot: NewsSnapshot = {
      date: today,
      updatedAt: new Date().toISOString(),
      source: "llm",
      categories,
      notes: p?.notes ? String(p.notes) : null,
    };
    log.info(
      `뉴스 큐레이션(LLM) 완료 — 총 ${total}건 [` +
        categories.map((c) => `${c.emoji}${c.items.length}`).join(" ") +
        "]"
    );
    return snapshot;
  } catch (e) {
    log.warn(`뉴스 큐레이션 실패: ${(e as Error).message}`);
    return emptySnapshot(today, `뉴스 큐레이션 실패: ${(e as Error).message}`);
  }
}
