import { log } from "../util/log.ts";

/**
 * 세이브티커(saveticker.com) 속보 수집기 — **결정론적 소스**.
 *
 * ## 왜 웹검색이 아니라 직접 호출인가
 * 사용자가 "긴급 뉴스는 saveticker 도 참고하라"고 지정했다. 그런데 이 사이트는 Next.js
 * App Router SPA 라 **HTML 에는 기사 본문이 한 줄도 없다**(실측: /news 를 가져오면 네비게이션
 * 껍데기만 온다). 에이전트에게 "이 URL 을 WebFetch 하라"고 시키면 빈 페이지를 받고,
 * 그 사실을 아무도 모른 채 "참고했다"고 착각하게 된다 — 조용한 실패의 교과서적 사례다.
 *
 * 그래서 클라이언트가 실제로 호출하는 공개 API 를 직접 친다. 이 저장소가 네이버 증권
 * 비공개 API 를 쓰는 것과 같은 판단이다: **숫자·사실은 결정론적 소스에서, 서술은 LLM 에서.**
 *
 * ## 이 소스의 진짜 가치는 태그다
 * 응답의 `tag_names` 에 `"속보"` 와 `"$NVDA"` 형태의 티커 태그가 들어온다(실측 태그 분포:
 * 속보 8 / 정보 9 / $NVDA 2 / $INTC 2 / $AVGO 1 / $QCOM 1 / $SKHY 1 …).
 * 덕분에 "이 속보가 내 보유 종목 건인가"를 **LLM 판단 이전에 결정론적으로** 알 수 있다.
 *
 * ## 실패 정책: fail-open
 * 이 소스가 죽어도 펄스는 웹검색만으로 계속 돈다. 속보 하나 때문에 시간당 취합 전체를
 * 실패시키면 손해가 훨씬 크다.
 */

const NEWS_API = "https://api.saveticker.com/api/news/top-stories";
const ARTICLE_BASE = "https://www.saveticker.com/news";

/** SPA 껍데기가 아니라 API 를 치므로 UA 가 필수는 아니지만, 봇 차단 회피용으로 맞춰 둔다. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** 속보 태그. 이 값이 붙은 항목이 사용자가 말한 "긴급 뉴스"다. */
const BREAKING_TAG = "속보";

export interface SavetickerItem {
  id: string;
  title: string;
  /** 요약 본문. 짧다(실측 80~200자) — 원문 전체가 아니라 발췌다. */
  content: string;
  /** 원 매체명("블룸버그", "로이터"). null 인 항목도 있다(세이브티커 자체 속보). */
  source: string | null;
  /** 게시 시각 ISO(+09:00). */
  createdAt: string;
  /** 원문 태그 전체. */
  tags: string[];
  /** `속보` 태그 보유 여부. */
  breaking: boolean;
  /** `$` 접두 태그에서 뽑은 티커(접두사 제거·대문자). 예: ["NVDA","INTC"] */
  tickers: string[];
  link: string;
}

interface RawNews {
  id?: unknown;
  title?: unknown;
  content?: unknown;
  source?: unknown;
  created_at?: unknown;
  tag_names?: unknown;
  is_deleted?: unknown;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * 티커 태그 추출. `"$NVDA"` → `"NVDA"`.
 *
 * ⚠️ 한국 종목은 `$SKHY`(SK하이닉스)처럼 **세이브티커 자체 코드**를 쓴다 — KRX 6자리 코드가
 * 아니라서 보유 원장의 symbol("000660")과 절대 매칭되지 않는다. 그래서 이 값으로는
 * **미국 종목만** 결정론적으로 이어붙이고, 한국 종목 연결은 LLM 판정에 맡긴다.
 * 여기서 억지로 이름 유사도 매칭을 하면 엉뚱한 종목에 속보가 붙는다.
 */
function extractTickers(tags: string[]): string[] {
  return tags
    .filter((t) => t.startsWith("$"))
    .map((t) => t.slice(1).trim().toUpperCase())
    .filter(Boolean);
}

function normalizeItem(r: RawNews): SavetickerItem | null {
  const id = str(r?.id, 40);
  const title = str(r?.title, 300);
  const createdAt = str(r?.created_at, 40);
  // id·제목·시각이 없으면 신선도 판정도 링크 생성도 불가능하다 → 버린다.
  if (!id || !title || !createdAt) return null;
  if (r?.is_deleted === true) return null;

  const tags = Array.isArray(r?.tag_names)
    ? (r.tag_names as unknown[]).map((t) => str(t, 40)).filter(Boolean)
    : [];

  return {
    id,
    title,
    content: str(r?.content, 1000),
    source: typeof r?.source === "string" && r.source.trim() ? r.source.trim() : null,
    createdAt,
    tags,
    breaking: tags.includes(BREAKING_TAG),
    tickers: extractTickers(tags),
    link: `${ARTICLE_BASE}/${id}`,
  };
}

export interface FetchSavetickerOptions {
  /**
   * 이 시간(시) 이내 게시된 항목만.
   *
   * 기본 6시간. 매시간 도는 것에 비하면 넉넉한데, 좁히면 **조용한 시간대에 이 소스가 통째로
   * 비어버린다**(실측 2026-07-27 20:20 KST: 3시간 창 → 0건. 최신 기사가 16:56 이었다).
   * 넓혀도 안전한 이유는 두 가지다: 표에 게시 시각이 그대로 찍혀 나가 모델이 신선도를
   * 스스로 판단할 수 있고, 같은 이슈의 반복은 지문 원장이 어차피 막는다.
   */
  withinHours?: number;
  /** 최대 반환 건수(프롬프트 폭주 방지). */
  limit?: number;
  timeoutMs?: number;
}

/**
 * 응답 본문 → 정규화·필터된 항목. **순수 함수**(테스트 대상).
 *
 * 신선도 필터를 우리 쪽에서 거는 이유: top-stories 는 최근 며칠치를 섞어 준다
 * (실측: 최신 오늘 16:56 ~ 가장 오래된 것 3일 전). 필터가 없으면 사흘 전 뉴스가
 * "지금 막 나온 속보"로 둔갑해 펄스 프롬프트에 들어간다.
 */
export function normalizeSavetickerBody(
  body: unknown,
  opts: { withinHours: number; limit: number; now?: number }
): SavetickerItem[] {
  const b = body as { news_list?: unknown } | null;
  const rows = Array.isArray(b?.news_list) ? (b.news_list as RawNews[]) : [];
  const cutoff = (opts.now ?? Date.now()) - opts.withinHours * 3600_000;
  return rows
    .map(normalizeItem)
    .filter((x): x is SavetickerItem => !!x)
    .filter((x) => {
      const t = Date.parse(x.createdAt);
      // 시각 파싱 실패는 **남긴다**. 파싱 실패를 '오래됐다'로 처리하면 응답 포맷이 한 번
      // 바뀌는 순간 이 소스가 통째로, 경고도 없이 사라진다. 남기면 최소한 눈에 띈다.
      return !Number.isFinite(t) || t >= cutoff;
    })
    .slice(0, opts.limit);
}

/**
 * 최신 속보·주요뉴스를 가져온다. **실패는 빈 배열**(throw 하지 않는다 — fail-open).
 *
 * 신선도 필터를 서버(우리 쪽)에서 거는 이유: top-stories 는 최근 며칠치를 섞어 준다
 * (실측: 최신 오늘 16:56 ~ 가장 오래된 것 3일 전). 필터 없이 프롬프트에 넣으면 사흘 전
 * 뉴스가 "지금 막 나온 속보"로 둔갑한다.
 */
export async function fetchSavetickerNews(
  opts: FetchSavetickerOptions = {}
): Promise<SavetickerItem[]> {
  const withinHours = opts.withinHours ?? 6;
  const limit = opts.limit ?? 20;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(NEWS_API, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Referer: "https://www.saveticker.com/",
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      log.warn(`세이브티커 속보 조회 실패: HTTP ${res.status} → 웹검색만으로 진행`);
      return [];
    }
    const body = (await res.json()) as { news_list?: unknown };
    const total = Array.isArray(body?.news_list) ? (body.news_list as unknown[]).length : 0;
    const items = normalizeSavetickerBody(body, { withinHours, limit });

    log.info(
      `세이브티커 속보 ${items.length}건 (전체 ${total} / 최근 ${withinHours}시간, ` +
        `속보태그 ${items.filter((i) => i.breaking).length}건)`
    );
    return items;
  } catch (e) {
    const msg = ac.signal.aborted ? `타임아웃(${timeoutMs}ms)` : (e as Error).message;
    log.warn(`세이브티커 속보 조회 예외: ${msg} → 웹검색만으로 진행`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** 프롬프트에 넣을 마크다운 표. 항목이 없으면 그 사실을 명시한다(빈 문자열이면 LLM 이 헷갈린다). */
export function savetickerTable(items: SavetickerItem[]): string {
  if (!items.length)
    return "(세이브티커 속보 없음 — 이 소스는 건너뛰고 웹검색 결과만 사용하라.)";
  return items
    .map((i) => {
      const flag = i.breaking ? "🚨속보" : "정보";
      const tick = i.tickers.length ? ` [${i.tickers.map((t) => `$${t}`).join(" ")}]` : "";
      const src = i.source ? ` · ${i.source}` : "";
      return (
        `- ${flag} ${i.createdAt.slice(0, 16).replace("T", " ")}${src}${tick}\n` +
        `  ${i.title}\n` +
        (i.content ? `  ${i.content.slice(0, 200)}\n` : "") +
        `  ${i.link}`
      );
    })
    .join("\n");
}
