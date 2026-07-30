import type {
  ProductSummary,
  ProductHistory,
  CreateProductInput,
  UpdateProductInput,
  CollectResult,
  PeriodDays,
  EventsSnapshot,
  NewsSnapshot,
  NewsCategoryDef,
  YoutubeSnapshot,
  YoutubeCategoryDef,
  BlockedChannel,
  WatchedVideo,
  DismissedVideo,
  ProductSource,
  UpsertProductSourceInput,
  ResolveResult,
  ScheduleSettings,
  AgentModelSettings,
  StockMarket,
  StockSnapshot,
  StockTicker,
  StockSearchCandidate,
  StockPoint,
  StockHolding,
  StockHoldingSummary,
  StockHorizon,
  PulseRunResult,
} from "@shared/types";
import type { LottoSnapshot } from "@shared/lotto";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `요청 실패 (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export interface AppConfig {
  port: number;
  collectTime: string;
  notify: { email: boolean };
  warnings: string[];
}

export const api = {
  config: () => fetch("/api/config").then((r) => j<AppConfig>(r)),

  products: () => fetch("/api/products").then((r) => j<ProductSummary[]>(r)),

  history: (id: number, days: PeriodDays) =>
    fetch(`/api/products/${id}/history?days=${days}`).then((r) => j<ProductHistory>(r)),

  runToday: () => fetch("/api/runs/today").then((r) => j<CollectResult | null>(r)),

  /** 탭별 자동 수집 시각(스케줄) 조회. */
  schedule: () => fetch("/api/schedule").then((r) => j<ScheduleSettings>(r)),

  /** 스케줄 부분 수정. 저장 즉시 서버가 cron 재등록. 갱신된 전체 스케줄 반환. */
  updateSchedule: (patch: Partial<ScheduleSettings>) =>
    fetch("/api/schedule", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => j<ScheduleSettings>(r)),

  /** 수집·큐레이션 에이전트 + 선택지 조회. */
  modelSettings: () => fetch("/api/model").then((r) => j<AgentModelSettings>(r)),

  /** 모델 선택 변경. 다음 수집부터 적용. 갱신된 설정 반환. */
  updateModel: (model: string) =>
    fetch("/api/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    }).then((r) => j<AgentModelSettings>(r)),

  addProduct: (input: CreateProductInput) =>
    fetch("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<ProductSummary>(r)),

  /** 상품 정보 수정(검색어/포함·제외 규칙/최소가). 부분 수정 가능. 수정된 요약 반환. */
  updateProduct: (id: number, patch: UpdateProductInput) =>
    fetch(`/api/products/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => j<ProductSummary>(r)),

  /** 단일 상품만 즉시 재수집(매칭 규칙 수정 후 오늘 가격 정정). 갱신된 요약 반환. */
  collectProduct: (id: number) =>
    fetch(`/api/products/${id}/collect`, { method: "POST" }).then((r) => j<ProductSummary>(r)),

  /** 영구 삭제(가격 이력 포함). 오삭제 방지로 상품명을 confirm 으로 전달. */
  deleteProduct: (id: number, name: string) =>
    fetch(`/api/products/${id}?confirm=${encodeURIComponent(name)}`, {
      method: "DELETE",
    }).then((r) => j(r)),

  /** 대시보드 카드 표시 순서 변경(전체 상품 id 순서 전달). 재정렬된 요약 목록 반환. */
  reorderProducts: (ids: number[]) =>
    fetch("/api/products/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).then((r) => j<ProductSummary[]>(r)),

  /**
   * 전체 수집을 백그라운드로 시작(202)하고 즉시 반환. 이미 수집 중이면 409 → { busy: true }.
   * 완료 여부는 collectStatus() 폴링으로 확인한다.
   */
  collectNow: async (): Promise<{ started: boolean; busy: boolean }> => {
    const res = await fetch("/api/collect", { method: "POST" });
    if (res.status === 409) return { started: false, busy: true };
    await j<{ started: boolean }>(res); // 202; 비정상(5xx)이면 throw
    return { started: true, busy: false };
  },

  collectStatus: () =>
    fetch("/api/collect/status").then((r) => j<{ collecting: boolean }>(r)),

  // ── 상품 × 소스 ref (pcode 확정) ──
  listSources: (id: number) =>
    fetch(`/api/products/${id}/sources`).then((r) => j<ProductSource[]>(r)),

  /** pcode 확정/수정 (멱등). productId 는 경로에서 채워지므로 본문에서 생략. */
  upsertSource: (id: number, input: Omit<UpsertProductSourceInput, "productId">) =>
    fetch(`/api/products/${id}/sources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<ProductSource>(r)),

  deleteSource: (id: number, source: string) =>
    fetch(`/api/products/${id}/sources/${encodeURIComponent(source)}`, {
      method: "DELETE",
    }).then((r) => j<{ ok: boolean }>(r)),

  /** resolve 프록시: 사람이 고를 pcode 후보 목록. 실패/차단 시 candidates:[] + note. */
  resolveSource: (id: number, source = "danawa") =>
    fetch(`/api/products/${id}/resolve?source=${encodeURIComponent(source)}`).then((r) =>
      j<ResolveResult>(r)
    ),

  serviceStatus: () =>
    fetch("/api/service/status").then((r) => j<{ installed: boolean; label: string }>(r)),

  uninstallService: () =>
    fetch("/api/service/uninstall", { method: "POST" }).then((r) =>
      j<{ ok: boolean; message: string }>(r)
    ),

  events: () => fetch("/api/events").then((r) => j<EventsSnapshot | null>(r)),

  /**
   * 수집을 백그라운드로 시작(202)하고 즉시 반환. 이미 수집 중이면 409 → { busy: true }.
   * 완료 여부는 eventsStatus() 폴링으로 확인한다.
   */
  refreshEvents: async (): Promise<{ started: boolean; busy: boolean }> => {
    const res = await fetch("/api/events/refresh", { method: "POST" });
    if (res.status === 409) return { started: false, busy: true };
    await j<{ started: boolean }>(res); // 202; 비정상(5xx)이면 throw
    return { started: true, busy: false };
  },

  eventsStatus: () =>
    fetch("/api/events/status").then((r) =>
      j<{ collecting: boolean; updatedAt: string | null }>(r)
    ),

  news: () => fetch("/api/news").then((r) => j<NewsSnapshot | null>(r)),

  /**
   * 수집을 백그라운드로 시작(202)하고 즉시 반환. 이미 수집 중이면 409 → { busy: true }.
   * 완료 여부는 newsStatus() 폴링으로 확인한다.
   */
  refreshNews: async (): Promise<{ started: boolean; busy: boolean }> => {
    const res = await fetch("/api/news/refresh", { method: "POST" });
    if (res.status === 409) return { started: false, busy: true };
    await j<{ started: boolean }>(res); // 202; 비정상(5xx)이면 throw
    return { started: true, busy: false };
  },

  newsStatus: () =>
    fetch("/api/news/status").then((r) =>
      j<{ collecting: boolean; updatedAt: string | null }>(r)
    ),

  newsCategories: () =>
    fetch("/api/news/categories").then((r) => j<NewsCategoryDef[]>(r)),

  addNewsCategory: (input: {
    label: string;
    emoji?: string;
    color?: string;
    description?: string;
    region?: "kr" | "global";
    excludeKeywords?: string[];
  }) =>
    fetch("/api/news/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<NewsCategoryDef>(r)),

  updateNewsCategory: (
    key: string,
    patch: {
      label?: string;
      emoji?: string;
      color?: string;
      description?: string;
      region?: "kr" | "global";
      excludeKeywords?: string[];
    }
  ) =>
    fetch(`/api/news/categories/${encodeURIComponent(key)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => j<NewsCategoryDef>(r)),

  deleteNewsCategory: (key: string) =>
    fetch(`/api/news/categories/${encodeURIComponent(key)}`, { method: "DELETE" }).then((r) =>
      j<{ ok: boolean }>(r)
    ),

  reorderNewsCategories: (keys: string[]) =>
    fetch("/api/news/categories/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    }).then((r) => j<NewsCategoryDef[]>(r)),

  // ── 유튜브 소식 ──
  youtube: () => fetch("/api/youtube").then((r) => j<YoutubeSnapshot | null>(r)),

  /**
   * 수집을 백그라운드로 시작(202)하고 즉시 반환. 이미 수집 중이면 409 → { busy: true }.
   * 완료 여부는 youtubeStatus() 폴링으로 확인한다.
   */
  refreshYoutube: async (): Promise<{ started: boolean; busy: boolean }> => {
    const res = await fetch("/api/youtube/refresh", { method: "POST" });
    if (res.status === 409) return { started: false, busy: true };
    await j<{ started: boolean }>(res); // 202; 비정상(5xx)이면 throw
    return { started: true, busy: false };
  },

  youtubeStatus: () =>
    fetch("/api/youtube/status").then((r) =>
      j<{
        collecting: boolean;
        updatedAt: string | null;
        /** 마지막 수집 '시도' 결과. 실패해도 기존 스냅샷을 유지하므로 화면 경고에 필요하다. */
        lastAttempt: { at: string; ok: boolean; trigger: string; error: string | null } | null;
      }>(r)
    ),

  /** 카드(영상)를 다른 카테고리로 이동. 갱신된 스냅샷을 반환. */
  moveYoutubeVideo: (input: { videoId: string; fromKey: string; toKey: string }) =>
    fetch("/api/youtube/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<YoutubeSnapshot>(r)),

  youtubeCategories: () =>
    fetch("/api/youtube/categories").then((r) => j<YoutubeCategoryDef[]>(r)),

  addYoutubeCategory: (input: {
    label: string;
    emoji?: string;
    color?: string;
    description?: string;
    region?: "kr" | "global";
    excludeKeywords?: string[];
    recommendedChannels?: string[];
  }) =>
    fetch("/api/youtube/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<YoutubeCategoryDef>(r)),

  updateYoutubeCategory: (
    key: string,
    patch: {
      label?: string;
      emoji?: string;
      color?: string;
      description?: string;
      region?: "kr" | "global";
      excludeKeywords?: string[];
      recommendedChannels?: string[];
    }
  ) =>
    fetch(`/api/youtube/categories/${encodeURIComponent(key)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => j<YoutubeCategoryDef>(r)),

  deleteYoutubeCategory: (key: string) =>
    fetch(`/api/youtube/categories/${encodeURIComponent(key)}`, { method: "DELETE" }).then((r) =>
      j<{ ok: boolean }>(r)
    ),

  reorderYoutubeCategories: (keys: string[]) =>
    fetch("/api/youtube/categories/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    }).then((r) => j<YoutubeCategoryDef[]>(r)),

  // ── 카테고리 추천 채널(카드 ⭐ 버튼) ──
  /** 카드의 채널을 카테고리 추천 채널에 추가. 갱신된 카테고리 반환. */
  addYoutubeRecommendedChannel: (key: string, input: { channel: string; handle?: string | null }) =>
    fetch(`/api/youtube/categories/${encodeURIComponent(key)}/recommended-channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<YoutubeCategoryDef>(r)),

  /** 카드의 채널을 카테고리 추천 채널에서 해제. 갱신된 카테고리 반환. */
  removeYoutubeRecommendedChannel: (key: string, input: { channel: string; handle?: string | null }) => {
    const q = new URLSearchParams({ channel: input.channel });
    if (input.handle) q.set("handle", input.handle);
    return fetch(
      `/api/youtube/categories/${encodeURIComponent(key)}/recommended-channels?${q.toString()}`,
      { method: "DELETE" }
    ).then((r) => j<YoutubeCategoryDef>(r));
  },

  // ── 유튜브 채널 차단(조사 제외) ──
  youtubeBlocklist: () =>
    fetch("/api/youtube/blocklist").then((r) => j<BlockedChannel[]>(r)),

  blockYoutubeChannel: (input: { channel: string; handle?: string | null; categoryKey?: string | null }) =>
    fetch("/api/youtube/blocklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<BlockedChannel>(r)),

  unblockYoutubeChannel: (id: string) =>
    fetch(`/api/youtube/blocklist/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) =>
      j<{ ok: boolean }>(r)
    ),

  // ── 유튜브 '본영상' 체크(수집 제외) ──
  youtubeWatched: () => fetch("/api/youtube/watched").then((r) => j<WatchedVideo[]>(r)),

  /** 본영상 체크 ON. 이후 일정 기간 수집(검색)에서 제외된다. */
  markYoutubeWatched: (input: { videoId: string; title?: string; channel?: string }) =>
    fetch("/api/youtube/watched", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<WatchedVideo>(r)),

  /** 본영상 체크 OFF(해제). 다시 검색에 노출될 수 있다. */
  unmarkYoutubeWatched: (videoId: string) =>
    fetch(`/api/youtube/watched/${encodeURIComponent(videoId)}`, { method: "DELETE" }).then((r) =>
      j<{ ok: boolean }>(r)
    ),

  // ── 유튜브 '이 영상 제외'(영구 제외) ──
  youtubeDismissed: () => fetch("/api/youtube/dismissed").then((r) => j<DismissedVideo[]>(r)),

  /**
   * 영상 1건을 영구 제외. 사유는 선택이라 원클릭 제외 시엔 보내지 않는다.
   * 서버는 기존 항목이 있으면 truthy 한 값만 덮어쓰므로 재호출해도 안전하다(멱등).
   */
  dismissYoutubeVideo: (input: {
    videoId: string;
    title?: string | null;
    channel?: string | null;
    url?: string | null;
    categoryKey?: string | null;
    reason?: string | null;
  }) =>
    fetch("/api/youtube/dismissed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<DismissedVideo>(r)),

  /**
   * 제외 사유만 수정. null 을 보내면 사유가 지워진다
   * (제외 자체는 유지 — 사유 삭제는 이 경로로만 가능하다).
   */
  updateYoutubeDismissReason: (videoId: string, reason: string | null) =>
    fetch(`/api/youtube/dismissed/${encodeURIComponent(videoId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    }).then((r) => j<DismissedVideo>(r)),

  /** 제외 해제(영구 제외이므로 이게 유일한 복구 경로다). */
  undismissYoutubeVideo: (videoId: string) =>
    fetch(`/api/youtube/dismissed/${encodeURIComponent(videoId)}`, { method: "DELETE" }).then((r) =>
      j<{ ok: boolean }>(r)
    ),

  // ── 증시 브리핑 (한국장 / 미국장) ──
  stock: (market: StockMarket) =>
    fetch(`/api/stock/${market}`).then((r) => j<StockSnapshot | null>(r)),

  stockStatus: (market: StockMarket) =>
    fetch(`/api/stock/${market}/status`).then((r) =>
      j<{ collecting: boolean; updatedAt: string | null }>(r)
    ),

  /**
   * 브리핑을 백그라운드로 시작(202)하고 즉시 반환. 이미 수집 중이면 409 → { busy: true }.
   * 완료 여부는 stockStatus() 폴링으로 확인한다.
   */
  refreshStock: async (market: StockMarket): Promise<{ started: boolean; busy: boolean }> => {
    const res = await fetch(`/api/stock/${market}/refresh`, { method: "POST" });
    if (res.status === 409) return { started: false, busy: true };
    await j<{ started: boolean }>(res); // 202; 비정상(5xx)이면 throw
    return { started: true, busy: false };
  },

  stockTickers: (market: StockMarket) =>
    fetch(`/api/stock/${market}/tickers`).then((r) => j<StockTicker[]>(r)),

  /** 종목 검색 후보. 사람이 보고 1건을 고른다(자동 선택 금지). */
  searchTickers: (market: StockMarket, q: string) =>
    fetch(`/api/stock/search?q=${encodeURIComponent(q)}&market=${market}`).then((r) =>
      j<StockSearchCandidate[]>(r)
    ),

  /** 종목 추가. query 는 종목코드·티커·종목명 아무거나(서버가 자동완성으로 해석). */
  addTicker: (market: StockMarket, input: { query: string; pinned?: boolean }) =>
    fetch(`/api/stock/${market}/tickers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<StockTicker>(r)),

  updateTicker: (id: number, patch: { name?: string; pinned?: boolean }) =>
    fetch(`/api/stock/tickers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => j<StockTicker>(r)),

  /** 종목 표시 순서 변경(해당 시장의 전체 id 순서 전달). 재정렬된 목록 반환. */
  reorderTickers: (market: StockMarket, ids: number[]) =>
    fetch(`/api/stock/${market}/tickers/order`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).then((r) => j<StockTicker[]>(r)),

  /** 종목 삭제. 오삭제 방지로 심볼을 confirm 으로 전달. */
  deleteTicker: (id: number, symbol: string) =>
    fetch(`/api/stock/tickers/${id}?confirm=${encodeURIComponent(symbol)}`, {
      method: "DELETE",
    }).then((r) => j<{ ok: boolean }>(r)),

  /** 종목 일별 종가(차트용). days=거래일 행 수, 오름차순. */
  tickerHistory: (id: number, days = 20) =>
    fetch(`/api/stock/tickers/${id}/history?days=${days}`).then((r) => j<StockPoint[]>(r)),

  // ── 보유 종목 (별도 탭) ──

  /**
   * 보유 종목 + 현재가·손익률. 서버가 종목마다 네이버 시세를 치므로 **느리다**(수백 ms~수 초).
   * 화면은 로딩 표시를 반드시 두어야 한다.
   */
  holdings: (market?: StockMarket) =>
    fetch(`/api/stock/holdings${market ? `?market=${market}` : ""}`).then((r) =>
      j<StockHoldingSummary[]>(r)
    ),

  /**
   * 보유 종목 추가. query 는 종목코드·티커·종목명 아무거나(서버가 자동완성으로 해석).
   * 서버가 등록 종목(관심 종목)에도 자동으로 넣는다 — 여기서 따로 부를 필요 없다.
   */
  addHolding: (input: {
    market: StockMarket;
    query: string;
    quantity: number;
    avgPrice: number;
    targetPrice?: number | null;
    stopPrice?: number | null;
    horizon?: StockHorizon;
    memo?: string;
  }) =>
    fetch(`/api/stock/holdings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => j<StockHolding>(r)),

  /**
   * 보유 종목 수정.
   * ⚠️ targetPrice/stopPrice 에 `null` 을 넘기면 **해제**, 키를 아예 빼면 **유지**다.
   *    이 구분이 서버까지 그대로 가야 목표가를 지울 수 있다.
   */
  updateHolding: (
    id: number,
    patch: {
      quantity?: number;
      avgPrice?: number;
      targetPrice?: number | null;
      stopPrice?: number | null;
      horizon?: StockHorizon;
      memo?: string;
    }
  ) =>
    fetch(`/api/stock/holdings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => j<StockHolding>(r)),

  /** 보유 종목 삭제. 등록 종목(관심 종목)은 남는다 — 다 팔아도 계속 지켜볼 수 있게. */
  deleteHolding: (id: number, symbol: string) =>
    fetch(`/api/stock/holdings/${id}?confirm=${encodeURIComponent(symbol)}`, {
      method: "DELETE",
    }).then((r) => j<{ ok: boolean; keptTicker: boolean }>(r)),

  // ── 펄스(시간당 실시간 취합) ──

  /** 펄스 상태 + 최근 24시간 판정 목록. 화면에 피드는 없지만 동작 확인 창구는 필요하다. */
  pulseStatus: () =>
    fetch(`/api/stock/pulse/status`).then((r) =>
      j<{
        running: boolean;
        lastRun: PulseRunResult | null;
        notifyEnabled: boolean;
        schedule: string[];
        recent: Array<{
          id: number;
          at: string;
          slot: string;
          status: string;
          severity: string;
          direction: string;
          symbol: string | null;
          name: string;
          headline: string;
        }>;
      }>(r)
    ),

  /** 펄스 지금 실행(202). 이미 실행 중이면 409 → { busy: true }. */
  runPulse: async (): Promise<{ started: boolean; busy: boolean }> => {
    const res = await fetch(`/api/stock/pulse/run`, { method: "POST" });
    if (res.status === 409) return { started: false, busy: true };
    await j<{ started: boolean }>(res);
    return { started: true, busy: false };
  },

  // ── 로또 ──
  // 조회 하나뿐이다. 갱신은 매주 일요일 10:00 서버 cron 이 하고 화면에는 조작 버튼이 없다.
  // 백엔드가 500 을 내면 그대로 throw 되므로 화면에서 try/catch 로 받아 빈 상태를 그린다.
  lotto: () => fetch("/api/lotto").then((r) => j<LottoSnapshot>(r)),
};
