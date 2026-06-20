import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { MANDATORY_VENUES, type RawCorpus, type RawGroup } from "./gather.ts";
import type {
  EventsSnapshot,
  PopupItem,
  ExhibitionItem,
  VenueGroup,
  EventTag,
} from "../../shared/types.ts";

const REGIONS = ["성수", "홍대", "여의도", "강남", "잠실", "명동", "한남", "이태원", "연남"];

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
  const popups: PopupItem[] = dedupe(flat(corpus.popupGroups))
    .slice(0, 24)
    .map((it) => ({
      name: it.title,
      region: guessRegion(it.title + it.description),
      period: "",
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
        summary: it.description,
        link: it.link,
      })),
  }));

  const general: ExhibitionItem[] = dedupe(flat(corpus.generalGroups))
    .slice(0, 10)
    .map((it) => ({ title: it.title, venue: "서울/경기", period: "", summary: it.description, link: it.link }));

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

function buildPrompt(corpus: RawCorpus): string {
  return `너는 한국 팝업스토어·전시 큐레이터다. 아래 네이버 검색 결과(제목 | 설명 | 링크)를 분석해
현재 진행 중이거나 곧 시작하는 팝업스토어와 전시/박람회를 정리하라. 기준 시점: ${corpus.month}.

규칙:
- 광고/중복/무관한 결과는 제외하고 실제 행사만 추린다. 링크는 검색결과의 링크를 그대로 사용.
- 팝업은 지역(성수/홍대/여의도/강남/기타 등)으로 분류. 신규 오픈이면 tag "신규", 7일 내 종료면 "종료임박", 아니면 null.
- 전시는 반드시 다음 4개 전시장 섹션을 모두 포함(행사 없으면 빈 배열): ${MANDATORY_VENUES.join(", ")}. 그 외는 general.
- 기간/장소를 알 수 있으면 채우고, 모르면 빈 문자열.
- 팝업 최대 20개, 전시장별 최대 6개, general 최대 10개.

검색결과:
${corpusToText(corpus)}

반드시 아래 JSON만 출력(다른 텍스트 없이):
{"popups":[{"name":string,"region":string,"period":string,"summary":string,"link":string|null,"category":string|null,"tag":"신규"|"종료임박"|null}],
"exhibitions":{"venues":[{"name":string,"items":[{"title":string,"venue":string,"period":string,"summary":string,"link":string|null}]}],"general":[{"title":string,"venue":string,"period":string,"summary":string,"link":string|null}]},
"notes":string|null}`;
}

function extractJson(text: string): unknown {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e <= s) throw new Error("JSON 미발견");
  return JSON.parse(text.slice(s, e + 1));
}

/** RawCorpus → EventsSnapshot. 키 있으면 LLM 큐레이션, 없거나 실패 시 원본 폴백. */
export async function curate(corpus: RawCorpus, date: string): Promise<EventsSnapshot> {
  if (!config.anthropicApiKey) return rawSnapshot(corpus, date);

  try {
    const q = query({
      prompt: buildPrompt(corpus),
      options: {
        allowedTools: [],
        permissionMode: "bypassPermissions",
        settingSources: [],
        maxTurns: 2,
        systemPrompt: "너는 팝업/전시 큐레이터다. 반드시 지정된 JSON 한 개만 출력한다.",
      },
    });
    let finalText = "";
    for await (const msg of q) {
      if (msg.type === "result" && msg.subtype === "success") finalText = msg.result;
    }
    if (!finalText) return rawSnapshot(corpus, date);

    const p = extractJson(finalText) as any;

    // 필수 4개 전시장 보정: 누락된 전시장은 빈 섹션으로 채움
    const venuesIn: VenueGroup[] = Array.isArray(p?.exhibitions?.venues) ? p.exhibitions.venues : [];
    const venues: VenueGroup[] = MANDATORY_VENUES.map((name) => {
      const found = venuesIn.find((v) => v?.name && String(v.name).includes(name.slice(0, 2)));
      return {
        name,
        items: Array.isArray(found?.items)
          ? found!.items.slice(0, 6).map(normExhibition(name))
          : [],
      };
    });

    const snapshot: EventsSnapshot = {
      date,
      updatedAt: new Date().toISOString(),
      source: "llm",
      popups: (Array.isArray(p?.popups) ? p.popups : []).slice(0, 20).map(normPopup),
      exhibitions: {
        venues,
        general: (Array.isArray(p?.exhibitions?.general) ? p.exhibitions.general : [])
          .slice(0, 10)
          .map(normExhibition("서울/경기")),
      },
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

function normPopup(r: any): PopupItem {
  const tag: EventTag = r?.tag === "신규" || r?.tag === "종료임박" ? r.tag : null;
  return {
    name: String(r?.name ?? "").slice(0, 120),
    region: String(r?.region ?? "기타"),
    period: String(r?.period ?? ""),
    summary: String(r?.summary ?? ""),
    link: r?.link ? String(r.link) : null,
    category: r?.category ? String(r.category) : null,
    tag,
  };
}

function normExhibition(defaultVenue: string) {
  return (r: any): ExhibitionItem => ({
    title: String(r?.title ?? "").slice(0, 140),
    venue: String(r?.venue ?? defaultVenue),
    period: String(r?.period ?? ""),
    summary: String(r?.summary ?? ""),
    link: r?.link ? String(r.link) : null,
  });
}
