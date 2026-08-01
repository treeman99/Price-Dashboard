// 백엔드(api)와 프론트(web)가 공유하는 타입.
// 백엔드는 상대경로로, web은 vite alias `@shared`로 임포트한다.
//
// ⚠️ 가격 추적 타입(Product / PricePoint / Listing / Review / ProductSummary / CollectResult /
// ProductSource / ResolveResult 등)은 가격 탭과 함께 2026-08-01 제거했다. 네이버 쇼핑 검색
// API 가 2026-07-31 부로 영구 종료(유예·대체 API 없음)되어 판매처별 가격 리스팅을 얻을 정식
// 경로가 사라졌기 때문이다. 과거 이력은 DB(price_points/listings/reviews)에 그대로 남아 있다.

/**
 * 탭별 자동 수집(갱신) 시각. 모두 24시간 "HH:mm" 목록(하루 여러 번 가능).
 * .env 기본값 위에 사용자가 대시보드에서 +/-로 바꾼 값이 병합된다.
 */
export interface ScheduleSettings {
  events: string[];
  news: string[];
  youtube: string[];
  /** 한국장 브리핑(개장 전 프리뷰). 기본 08:00. */
  stockKr: string[];
  /** 미국장 브리핑(전일 종가 결산 + 당일 밤 개장 프리뷰). 기본 18:00. */
  stockUs: string[];
  /**
   * 시간당 펄스(실시간 취합) 시각. 다른 탭과 달리 **하루 10회 이상**이 정상이다.
   * 기본은 장중·장전후 집중(한국장 08~16시 + 미국장 22~06시).
   *
   * ⚠️ 펄스는 **catch-up 하지 않는다.** 지나간 시각의 '실시간' 취합은 보충할 가치가 없고,
   *    보충하면 서버 재시작 직후 밀린 시각만큼 연쇄 실행되어 토큰을 태운다.
   */
  stockPulse: string[];
}

// ── 수집/큐레이션 에이전트 모델 설정 ──

/** 선택 가능한 에이전트 모델 1건. */
export interface AgentModelOption {
  /** 제공자 실행기에 그대로 넘기는 모델 ID (예: "claude-opus-5", "gpt-5.6-sol"). */
  id: string;
  /** UI 표시명 (예: "Opus 5"). */
  label: string;
  /** 선택 화면 보조 설명. */
  description?: string;
}

/**
 * Codex 를 쓸 수 없어 임시로 대체 모델이 실행되고 있는 상태.
 * 다음 실행에서 Codex 가 정상 응답하거나 사용자가 직접 모델을 고르면 해제된다.
 */
export interface AgentModelFallbackState {
  /** 대체된 쪽 = 사용자가 골라 뒀지만 지금 쓸 수 없는 모델 ID. */
  from: string;
  /** 처음 사용 불가를 확인한 시각(ISO). 대체가 이어지는 동안 갱신하지 않는다. */
  at: string;
  /** 사용 불가 판단의 근거가 된 오류 원문 요약(로그인 초기화 / 한도 소진 등). */
  reason: string;
}

/**
 * 가격·뉴스·유튜브·팝업/전시·증시 등 모든 수집·큐레이션이 공통으로 쓰는 에이전트 모델.
 * data/model.json 에 사용자가 고른 값이 저장되고, 없으면 목록 첫 항목(기본값)을 쓴다.
 */
export interface AgentModelSettings {
  /** 사용자가 고른 모델 ID. 자동 대체가 이 값을 덮어쓰지 않는다. */
  model: string;
  /** 선택 가능한 모델 목록(백엔드가 단일 진실원). */
  options: AgentModelOption[];
  /** 평상시 기본 모델 ID. */
  primary: string;
  /** 선택 모델을 쓸 수 없을 때 대신 실행할 모델 ID. */
  fallbackModel: string;
  /** 임시 대체 중이면 그 내역, 아니면 null. */
  fallback: AgentModelFallbackState | null;
}

// ── 팝업스토어 · 전시회 보드 (이력 저장 없음, 최신 스냅샷만) ──

export type EventTag = "신규" | "종료임박" | "예정" | null;

export interface PopupItem {
  name: string;
  /** 지역(성수/홍대/여의도/강남/기타 등) */
  region: string;
  /** 기간 표시용 문자열, 없으면 "" */
  period: string;
  /** 구조화 시작/종료일 (YYYY-MM-DD), 모르면 null */
  startDate: string | null;
  endDate: string | null;
  summary: string;
  link: string | null;
  category: string | null;
  tag: EventTag;
  /**
   * 약 일주일 이상 목록에 없다가 다시(또는 처음) 등장한 행사면 true.
   * 서버가 등장 이력(events-seen.json)으로 계산하며, 프론트는 이 값으로 '신규' 배지를 표시한다.
   */
  isNew?: boolean;
}

export interface ExhibitionItem {
  title: string;
  venue: string;
  period: string;
  startDate: string | null;
  endDate: string | null;
  summary: string;
  link: string | null;
  tag: EventTag;
  /** 약 일주일 이상 없다가 다시(또는 처음) 등장하면 true. 서버가 계산. */
  isNew?: boolean;
}

export interface VenueGroup {
  name: string; // 코엑스 / 세텍 / 킨텍스 / 수원컨벤션센터
  items: ExhibitionItem[];
}

/** 대한민국 축제(전국). 지역 제한 없음. */
export interface FestivalItem {
  name: string;
  /** 개최 지역 (예: "전남 함평", "서울 여의도", "경남 진해") */
  region: string;
  period: string;
  startDate: string | null;
  endDate: string | null;
  summary: string;
  link: string | null;
  tag: EventTag;
  /** 약 일주일 이상 없다가 다시(또는 처음) 등장하면 true. 서버가 계산. */
  isNew?: boolean;
}

export interface EventsSnapshot {
  date: string; // YYYY-MM-DD (로컬)
  updatedAt: string; // ISO
  /** 큐레이션 출처: LLM 정제 or 네이버 검색 원본 */
  source: "llm" | "naver-raw";
  popups: PopupItem[];
  exhibitions: {
    venues: VenueGroup[];
  };
  /** 대한민국 전역 축제 */
  festivals: FestivalItem[];
  notes: string | null;
}

// ── 데일리 뉴스 다이제스트 (최근 24시간, 7개 카테고리) ──

/** 동적 카테고리 키 (기본 7종 + 사용자 추가). */
export type NewsCategoryKey = string;

/**
 * 카테고리 정의(설정). 뉴스·유튜브 보드가 공유한다.
 * 스냅샷의 NewsCategory/YoutubeCategory와 달리 items 대신 검색 가이드(description)를 갖는다.
 */
export interface CategoryDef {
  key: string;
  label: string;
  emoji: string;
  color: string;
  /** LLM 수집 가이드(이 카테고리에서 무엇을 원하는지). 선택. */
  description?: string;
  /**
   * (유튜브 전용) 검색 범위.
   * - "kr": 한국 채널·한국어 영상만
   * - "global": 해외(영어 등) 포함
   * 미지정이면 유튜브에서는 "kr"로 취급. 뉴스에서는 무시.
   */
  region?: "kr" | "global";
  /**
   * (유튜브 전용) 제외 키워드. 제목/채널명에 이 단어가 포함된 영상은 하드 제거.
   * 예) 신제품 리뷰에서 자동차를 빼려면 ["자동차","SUV","모빌리티",...]. 대소문자 무시.
   */
  excludeKeywords?: string[];
  /**
   * (유튜브 전용) 추천 채널. 이 카테고리에서 **우선적으로 최근 업로드를 확인**할 채널 목록.
   * 하드 필터가 아니라 '먼저 살펴볼 채널' 힌트로 큐레이션 프롬프트에 주입된다.
   * 채널명 또는 @핸들. 예) ["안될과학","@3blue1brown","Two Minute Papers"]
   */
  recommendedChannels?: string[];
}

/** 뉴스 카테고리 정의(=공용 CategoryDef). 하위 호환을 위해 별칭 유지. */
export type NewsCategoryDef = CategoryDef;

export interface NewsRelated {
  /** 관련 출처 라벨 (예: "Reuters", "Bloomberg") */
  label: string;
  link: string;
}

export interface NewsItem {
  /** 한국어 제목 */
  title: string;
  /** 출처 (예: "TechCrunch", "GeekNews", "연합뉴스") — 영상/유튜브 제외 */
  source: string;
  /** 발행일 YYYY-MM-DD */
  date: string;
  /** 한국어 요약 (5줄 이내) */
  summary: string;
  link: string | null;
  /** 중복 통합 시 관련 출처 (최대 2개) */
  related: NewsRelated[];
}

export interface NewsCategory {
  key: NewsCategoryKey;
  /** 표시 라벨 (예: "AI / LLM") */
  label: string;
  emoji: string;
  /** 섹션 색상 (hex) */
  color: string;
  items: NewsItem[];
}

export interface NewsSnapshot {
  date: string; // YYYY-MM-DD (로컬)
  updatedAt: string; // ISO
  /** 큐레이션 출처: LLM or 미수집(empty) */
  source: "llm" | "empty";
  categories: NewsCategory[];
  notes: string | null;
}

// ── 유튜브 소식 (AI·LLM / 신제품 리뷰 등, 최근 며칠 영상) ──

/** 유튜브 카테고리 정의(=공용 CategoryDef). */
export type YoutubeCategoryDef = CategoryDef;

/** 큐레이션된 유튜브 영상 1건 */
export interface YoutubeVideo {
  /** 한국어 제목(원제가 영어면 번역, 원제는 originalTitle에 보존) */
  title: string;
  /** 원제(번역 전). 한국어 영상이면 title과 동일하거나 생략 가능. */
  originalTitle?: string | null;
  /** 채널명 (예: "Marques Brownlee") */
  channel: string;
  /** 채널 핸들 (예: "@mkbhd"). 모르면 null. */
  channelHandle?: string | null;
  /** 영상 게시일 YYYY-MM-DD (없으면 상대표현 추정 불가 → 채택 안 함) */
  date: string;
  /** 한국어 요약 — 영상이 다루는 핵심 내용(제목 재진술이 아니라 실제 내용). */
  summary: string;
  /** 영상 watch URL (https://www.youtube.com/watch?v=...) */
  url: string;
  /** 영상 ID(url에서 추출). 썸네일/임베드에 사용. */
  videoId: string | null;
  /** 썸네일 URL(videoId에서 파생). 없으면 null. */
  thumbnail: string | null;
  /** 조회수 표시 문자열 (예: "1.2M views", "조회수 53만회"). 모르면 null. */
  views?: string | null;
  /** 영상 길이 표시 (예: "12:34"). 모르면 null. */
  duration?: string | null;
  /**
   * 사용자가 이 카드를 수동으로 이 카테고리로 옮겼는지.
   * true면 읽기 시점 지역필터(applyRegionFilter)를 건너뛰어 사용자의 배치를 존중한다.
   */
  movedByUser?: boolean;
  /**
   * 사용자가 '본영상'으로 체크했는지(읽기 시점 주석 — 스냅샷에 영속되지 않음).
   * true면 프론트가 카드를 '본 영상'으로 표시하고, 서버는 이 영상을 일정 기간 수집(검색)에서 제외한다.
   */
  watched?: boolean;
}

/**
 * 사용자가 '본영상'으로 체크한 영상(수집 제외 원장 1건). videoId 기준.
 * watchedAt 시점부터 youtubeWatchedExcludeDays 동안 수집·검색에서 제외되고, 이후 만료된다.
 */
export interface WatchedVideo {
  /** YouTube 11자 videoId(안정 식별자). */
  videoId: string;
  /** 표시/디버그용 제목(체크 시점). */
  title: string;
  /** 표시/디버그용 채널명(체크 시점). */
  channel: string;
  /** 체크 시각(ISO). 이 시점부터 N일간 제외. */
  watchedAt: string;
}

/**
 * 사용자가 카드에서 '제외'한 영상(영구 제외 원장 1건). videoId 기준.
 * '본영상'(WatchedVideo)이 N일 만료되는 기간제인 것과 달리, 이쪽은 만료가 없다 —
 * "이 영상은 내가 원하는 종류가 아니다"라는 취향 신호이므로 시간이 지나도 유효하기 때문이다.
 * 해제는 관리 다이얼로그의 [해제]로만 가능하며, 다음 수집 프롬프트에 부정 예시로 주입된다.
 */
export interface DismissedVideo {
  /** YouTube 11자 videoId(안정 식별자). */
  videoId: string;
  /** 표시/디버그용 제목(제외 시점). 프롬프트 부정 예시의 핵심 신호. */
  title: string;
  /** 표시/디버그용 채널명(제외 시점). */
  channel: string;
  /** 원본 watch URL. 관리 다이얼로그에서 원본 확인용. 모르면 null. */
  url?: string | null;
  /** 어느 카테고리 카드에서 제외했는지(맥락 — 프롬프트 힌트에 활용). 모르면 null. */
  categoryKey?: string | null;
  /** 선택적 사유. 원클릭 제외 시엔 비어 있고, 나중에 관리 화면에서 붙일 수 있다. */
  reason?: string | null;
  /** 제외 시각(ISO). 만료는 없고 정렬(최근 우선)에만 쓴다. */
  dismissedAt: string;
}

/**
 * 사용자가 카드를 다른 카테고리로 옮긴 사례(재분류 피드백).
 * 다음 수집 프롬프트에 few-shot 규칙으로 주입해 큐레이터의 분류를 교정한다.
 */
export interface YoutubeReclass {
  /** 정규화된 식별키(제목+채널 기반). 같은 영상 재이동 시 최신으로 덮어씀. */
  id: string;
  /** 옮긴 영상 제목(학습 신호의 핵심 패턴). */
  title: string;
  /** 채널명. */
  channel: string;
  /** 출발 카테고리 key/라벨(삭제·개명 대비 라벨도 보존). */
  fromKey: string;
  fromLabel: string;
  /** 도착 카테고리 key/라벨. */
  toKey: string;
  toLabel: string;
  /** 이동 시각(ISO). */
  movedAt: string;
}

export interface YoutubeCategory {
  key: NewsCategoryKey;
  /** 표시 라벨 (예: "AI · LLM") */
  label: string;
  emoji: string;
  /** 섹션 색상 (hex) */
  color: string;
  items: YoutubeVideo[];
}

export interface YoutubeSnapshot {
  date: string; // YYYY-MM-DD (로컬)
  updatedAt: string; // ISO
  /** 큐레이션 출처: LLM or 미수집(empty) */
  source: "llm" | "empty";
  /** 신선도 기준일 수(이 일수 이내 게시 영상만 채택) */
  freshDays: number;
  categories: YoutubeCategory[];
  notes: string | null;
}

/** 조사에서 제외할 유튜브 채널(차단 목록 1건). */
export interface BlockedChannel {
  /** 안정적 식별자. "채널키::카테고리키"(채널키: handle 있으면 "@handle", 없으면 "name:채널명"; 카테고리키 없으면 "*"=전역). */
  id: string;
  /** 표시용 채널명(차단 시점에 보였던 이름). */
  channel: string;
  /** 채널 핸들(있으면, 예: "@mkbhd"). 없으면 null. */
  handle: string | null;
  /**
   * 제외 적용 범위. 특정 카테고리 key 면 **그 카테고리에서만** 제외되고 다른 카테고리에서는 계속 조사된다.
   * null 이면 전역(모든 카테고리 제외 — 구버전 항목 하위호환).
   */
  categoryKey: string | null;
  /** 차단 시각(ISO). */
  blockedAt: string;
}

// ── 증시 브리핑 (한국장 = 개장 전 프리뷰 / 미국장 = 슬롯별 마감결산·개장프리뷰) ──
//
// ⚠️ 이 섹션에는 서로 다른 '날짜' 개념이 두 개 공존한다. 헷갈리면 차트 x축이 하루씩 밀린다.
//   · StockPoint.date / StockSnapshot.sessionDate → **거래소 로컬 거래일**
//   · StockSnapshot.date                          → **서버 로컬 수집일**(KST)
// 미국장은 이 둘이 다를 수 있다. role='close'(간밤 결산)면 거의 항상 다르고,
// role='preview'(오늘 밤 프리뷰)면 오늘 밤 뉴욕 날짜라 KST 수집일과 같아지는 날이 많다.

/** 거래소 구분. 'kr'=KRX(코스피·코스닥), 'us'=NYSE·NASDAQ. */
export type StockMarket = "kr" | "us";

/**
 * 브리핑의 성격. 슬롯 시각에서 유도한다(src/stock/slot-role.ts).
 * - 'close'   = 간밤에 **마감된** 뉴욕 세션의 결산 (아침 슬롯)
 * - 'preview' = 오늘 밤 **열릴** 뉴욕 세션의 개장 프리뷰 (오후 슬롯)
 * - 'both'    = 두 성격을 한 브리핑에 담는 현행 혼합본. 역할 분리가 비활성일 때의 폴백이며
 *               **하위호환의 기본값**이다(구 스냅샷의 role 부재도 이 값으로 읽는다).
 */
export type StockSlotRole = "close" | "preview" | "both";

/**
 * 사용자가 등록한 관심 종목 1건(원장).
 * 자연키는 name 이 아니라 (market, symbol) — 같은 이름의 한/미 종목이 공존할 수 있다.
 */
export interface StockTicker {
  id: number;
  market: StockMarket;
  /** 정규화된 심볼. KR=6자리 코드("005930"), US=대문자 티커("AAPL"). */
  symbol: string;
  /** 표시명(한국어 우선). 네이버 자동완성이 채운다. 예: "삼성전자", "애플" */
  name: string;
  /**
   * 네이버 시세 조회용 내부 코드. KR="005930", US="AAPL.O"(로이터 코드).
   * 자동완성 응답의 reutersCode 를 그대로 보관 — 이게 없으면 시세 조회 경로를 못 만든다.
   */
  quoteCode: string;
  /** 소속 시장 표시용. 예: "코스피", "코스닥", "나스닥 증권거래소" */
  exchange: string;
  /** true면 브리핑에 20일 차트 + 상세 분석이 첨부되는 고정 종목. */
  pinned: boolean;
  sortOrder: number;
  createdAt: string;
}

/** 종목 추가 요청. symbol 만 오면 서버가 네이버 자동완성으로 나머지를 채운다. */
export interface CreateStockTickerInput {
  market: StockMarket;
  /** 종목코드·티커·종목명 아무거나. 서버가 자동완성으로 해석한다. */
  query: string;
  pinned?: boolean;
}

/** 종목 검색 후보 1건 (사람이 보고 확정하는 표시 단위). */
export interface StockSearchCandidate {
  market: StockMarket;
  symbol: string;
  name: string;
  quoteCode: string;
  exchange: string;
}

/** 일별 종가 1점. date 는 **거래소 로컬 거래일**(수집일 아님). */
export interface StockPoint {
  /** YYYY-MM-DD, 거래소 로컬 거래일. */
  date: string;
  close: number | null;
  prevClose: number | null;
  changePct: number | null;
  volume: number | null;
  /** "KRW" | "USD" */
  currency: string;
}

/** 지수 1건 (코스피/코스닥/S&P500/나스닥/다우). */
export interface StockIndex {
  /** 표시명. 예: "코스피", "S&P 500" */
  name: string;
  value: number | null;
  changePct: number | null;
  /** 최근 20거래일 종가(스파크라인용). */
  history: StockPoint[];
  /** LLM 서술 — 관측된 사실 요약. 투자 권유 금지. */
  comment: string | null;
  /** 오늘/오늘 밤 장에 대한 전망 서술. 근거는 rationale. */
  outlook: string | null;
  /** 전망 사유(뉴스·수급·데이터 근거). 없으면 outlook 을 표시하지 않는다. */
  rationale: string | null;
}

/** 브리핑에 인용된 뉴스 1건. */
export interface StockNewsItem {
  title: string;
  source: string;
  /** 발행일 YYYY-MM-DD. */
  date: string;
  summary: string;
  link: string | null;
  /** 분류. 예: "해외 시장", "환율·금리", "산업·기업", "수급" */
  bucket: string;
}

/**
 * 종목 분석 1건.
 * ⚠️ 숫자 필드(close/changePct/history)는 **서버가 네이버 시세로 채운 값**이다.
 * LLM 이 되돌려준 숫자는 폐기한다 — LLM 은 서술(summary/rationale/risks)만 만든다.
 */
export interface StockAnalysis {
  symbol: string;
  name: string;
  quoteCode: string;
  close: number | null;
  changePct: number | null;
  /** 5거래일 등락률. */
  weekChangePct: number | null;
  currency: string;
  /** 최근 20거래일 종가(차트용). 조회 실패 시 빈 배열. */
  history: StockPoint[];
  ma5: number | null;
  ma20: number | null;
  /** 관찰된 사실 요약(뉴스·공시·수급). */
  summary: string;
  /** 전망 서술. */
  outlook: string;
  /** 전망 사유 — 필수. 비면 항목을 버린다. */
  rationale: string;
  /** 리스크 요인 — 필수. 비면 항목을 버린다. */
  risks: string;
  /** 한줄 판단 이모지: 📈 / 📉 / ➡️ */
  verdict: string;
  /**
   * 시세를 결정론적 소스로 검증했는지.
   * - analyses(등록 종목): **false 가 될 수 있다**(curate.ts 의 `verified: q.close != null`).
   *   화면·메일이 '시세 미검증' 배지를 띄운다 — 이 배지는 등록 종목 전용이다.
   * - watchlist: **항상 true**. 검증 실패 항목은 verifyWatchlist 가 드롭하므로
   *   false 인 watchlist 항목은 더 이상 생성되지 않는다(옛 스냅샷에는 남아 있을 수 있다).
   */
  verified: boolean;
}

/**
 * 오늘의 관심 종목 1건 — **매수 추천이 아니다.**
 * 시장에서 왜 거론되는지를 관측 가능한 사실로만 정리한다.
 */
export interface StockWatchItem extends StockAnalysis {
  /** 주목 강도: "🔥강" | "⚡중" | "💧약" */
  attention: string;
  /** 단기 지지/저항 등 주목 가격대 서술. */
  levels: string | null;
  /**
   * 이 종목이 **실제로 상장된 시장**. verifyWatchlist 가 네이버 자동완성 후보의
   * nationCode 로 확정해 붙인다. StockSnapshot.market 과 다르면 '해외 참고' 항목이다.
   *
   * 옵셔널인 이유: 이 필드 도입 이전에 저장된 스냅샷 JSON 에는 키가 없다
   * (loadFromDisk 가 `as StockSnapshot` 캐스트라 런타임 검증이 없다).
   * 읽는 쪽은 반드시 `partitionWatchlist` 를 거친다. 옛 항목 중 **verified===true** 인 것만
   * '스냅샷 시장 소속'이 보장되고(옛 verifyWatchlist 가 c.market===market 로 거른 뒤에만
   * 시세를 붙였다), `태그 없음 && verified!==true` 는 옛 정책이 통과시킨 오염 의심 항목이라
   * 렌더에서 제외된다(한국장 스냅샷의 NVDA 가 그 사례).
   */
  market?: StockMarket;
}

export interface StockSnapshot {
  market: StockMarket;
  /** 서버 로컬 수집일 YYYY-MM-DD (KST). */
  date: string;
  /**
   * 브리핑이 다루는 **거래소 로컬 거래일**. 의미가 role 별로 다르다:
   * - role='close'   → 이미 **마감된** 직전 뉴욕 거래일(lastUsSessionDate)
   * - role='preview' → **오늘 밤 열릴** 뉴욕 거래일(= KST 수집일과 같은 날짜)
   * - role='both'    → 직전 마감 거래일(현행 혼합본과 동일)
   * - kr             → 오늘(09:00 개장 전) 또는 다음 거래일(휴장 시)
   * ⚠️ preview 는 이 날짜가 date 와 같아질 수 있다. `sessionDate !== date` 조건으로 거래일
   *    표기를 켜고 끄면 프리뷰에서 대상 세션이 화면에서 조용히 사라진다 — 렌더는 role 로 분기할 것.
   */
  sessionDate: string | null;
  /**
   * 이 브리핑의 성격. **옵셔널이어야 한다** — loadFromDisk 가 `as StockSnapshot` 캐스트라
   * 런타임 검증이 전혀 없고, 이 필드 도입 이전에 저장된 디스크 스냅샷에는 키가 없다
   * (StockWatchItem.market 과 같은 패턴). 읽는 쪽은 **반드시** shared/stock.ts 의
   * effectiveRole() 을 거쳐 undefined 를 'both' 로 접을 것.
   *
   * ⚠️ source('llm'|'empty'|'holiday')를 재활용해 역할을 표현하면 안 된다. 후퇴 방지 가드와
   *    알림 게이트(stock.ts)가 그 값을 분기 조건으로 쓰고 있어 값이 늘면 판정이 오염된다.
   */
  role?: StockSlotRole;
  /** 역할 판정 근거(로그·화면 툴팁용). 예: "slot=08:00 close 밴드 / 분리 활성" */
  roleReason?: string;
  /** 귀속 슬롯("HH:mm" 또는 "manual"). catch-up 게이트(hasSnapshotForSlot)와 표시에 쓴다. */
  slot?: string;
  updatedAt: string;
  /**
   * 'llm'=정상 큐레이션, 'empty'=수집 실패, 'holiday'=휴장(정상 결과).
   * ⚠️ 'holiday'를 'empty'와 구분하는 이유: 후퇴 방지 가드(empty면 이전 스냅샷 유지)가
   *    휴장을 실패로 오인해 지난 브리핑을 계속 보여주면 안 되기 때문.
   */
  source: "llm" | "empty" | "holiday";
  /** 휴장일이면 true. */
  closed: boolean;
  /** 휴장 사유. 예: "설날", "주말" */
  closedReason: string | null;
  indices: StockIndex[];
  news: StockNewsItem[];
  /** 사용자 등록 종목 분석. */
  analyses: StockAnalysis[];
  /**
   * 오늘의 관심 종목(사실 요약). 등록 종목과 겹치지 않는다.
   * ⚠️ **이 시장 종목과 '해외 참고'(타 시장) 항목이 한 배열에 섞여 있다.** 항목의 market 태그로
   *    렌더 계층이 분리한다 — 반드시 shared/stock.ts 의 partitionWatchlist 를 거쳐 렌더할 것.
   *    그냥 통째로 그리면 한국장 브리핑에 NVDA 가 섞여 보이던 원래 버그가 재발한다.
   * 시세가 검증된 항목만 들어온다(검증 실패는 verifyWatchlist 가 드롭).
   */
  watchlist: StockWatchItem[];
  /** 전 채널(화면·메일·iMessage)에 노출되는 면책 문구. */
  disclaimer: string;
  notes: string | null;
  /**
   * 내 포지션 점검(보유 종목). 브리핑 맨 앞에 렌더된다.
   *
   * 옵셔널인 이유는 StockSnapshot.role 과 같다 — loadFromDisk 가 `as StockSnapshot` 캐스트라
   * 런타임 검증이 없고, 이 필드 도입 이전 디스크 스냅샷에는 키가 없다. 읽는 쪽은 `?? []`.
   */
  positions?: StockPositionReview[];
}

// ── 보유 종목 (한국장·미국장과 별도 탭) ──

/**
 * 투자 기간. **종목마다 다르다** — 사용자가 종목별로 지정한다.
 *
 * 이 값은 장식이 아니라 영향도 판정의 축이다. 같은 재료도 기간에 따라 판정이 뒤집힌다
 * (금리 인하 기대 후퇴 → short 는 부정, long 은 중립). 펄스 프롬프트에 그대로 주입된다.
 */
export type StockHorizon = "short" | "mid" | "long";

/**
 * 보유 종목 1건(원장). 자연키는 (market, symbol) — `stocks` 와 같은 규칙이다.
 *
 * ⚠️ 이 표에는 **시세가 없다.** 현재가·손익률은 조회 시점마다 quote.ts 로 계산해 붙인다
 * (StockHoldingSummary). 시세를 원장에 캐시하면 화면과 실제가 언제 갈라졌는지 알 수 없다.
 */
export interface StockHolding {
  id: number;
  market: StockMarket;
  /** 정규화된 심볼. KR=6자리 코드, US=대문자 티커. */
  symbol: string;
  name: string;
  /** 네이버 시세 조회용 내부 코드. 등록 종목(stocks)과 같은 값. */
  quoteCode: string;
  exchange: string;
  /** 보유 수량. 해외주식 소수점 매수가 있으므로 정수가 아니다. */
  quantity: number;
  /** 평균 매입 단가(현지 통화). 손익률의 기준. */
  avgPrice: number;
  /** 목표가. 없으면 null — 알림 트리거가 아니라 브리핑의 '거리 표시'에만 쓴다. */
  targetPrice: number | null;
  /** 손절가. 없으면 null. 목표가와 같은 용도. */
  stopPrice: number | null;
  horizon: StockHorizon;
  /** 보유 이유·메모. 판정 프롬프트에 그대로 주입된다(빈 문자열이면 주입하지 않는다). */
  memo: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** 보유 종목 추가 입력. symbol 만 오면 서버가 네이버 자동완성으로 나머지를 채운다. */
export interface CreateStockHoldingInput {
  market: StockMarket;
  /** 종목코드·티커·종목명 아무거나. 서버가 자동완성으로 해석한다. */
  query: string;
  quantity: number;
  avgPrice: number;
  targetPrice?: number | null;
  stopPrice?: number | null;
  horizon?: StockHorizon;
  memo?: string;
}

/** 보유 종목 부분 수정. market/symbol 은 바꿀 수 없다(= 다른 종목이라는 뜻). */
export interface UpdateStockHoldingInput {
  quantity?: number;
  avgPrice?: number;
  targetPrice?: number | null;
  stopPrice?: number | null;
  horizon?: StockHorizon;
  memo?: string;
}

/**
 * 보유 종목 + 시세 파생값. **숫자는 전부 서버가 계산한다 — LLM 미개입.**
 * 시세 조회 실패 시 close 이하가 전부 null 이 된다(항목을 감추지는 않는다 —
 * 보유 사실 자체는 유효하고, 조회 실패를 '보유 없음'으로 표시하면 더 나쁘다).
 */
export interface StockHoldingSummary extends StockHolding {
  close: number | null;
  changePct: number | null;
  currency: string;
  /** 평가손익률 %. (close - avgPrice) / avgPrice * 100 */
  pnlPct: number | null;
  /** 평가손익 금액(현지 통화). (close - avgPrice) * quantity */
  pnlAmount: number | null;
  /** 평가금액(현지 통화). close * quantity */
  marketValue: number | null;
  /** 목표가까지 남은 거리 %. 목표가 미입력이면 null. */
  toTargetPct: number | null;
  /** 손절가까지 남은 거리 %. 손절가 미입력이면 null. 음수면 이미 이탈했다는 뜻. */
  toStopPct: number | null;
  history: StockPoint[];
}

/**
 * 일일 브리핑의 '내 포지션 점검' 1건 = 보유 요약(서버 숫자) + 오늘의 영향 요인(LLM 서술).
 * LLM 은 `factors`·`pulseSummary` 만 채운다. 나머지는 전부 서버 계산값이다.
 */
export interface StockPositionReview extends StockHoldingSummary {
  /** 오늘 이 종목에 작용하는 요인. 투자 권유 금지 — 관측된 사실과 그 영향 방향만. */
  factors: string;
  /** 지난 24시간 펄스 요약. 문자 문턱을 넘지 못한 건이 회수되는 유일한 경로. */
  pulseSummary: string | null;
}

// ── 시간당 펄스 (실시간 취합 → 문자 알림) ──

/**
 * 영향 강도. **정렬 가능한 값**이라는 점이 중요하다 —
 * 중복 억제가 '같은 지문이라도 강도가 오르면 재발송'이라 대소 비교가 필요하다.
 * (비교는 shared/pulse.ts 의 severityRank 로만 할 것. 문자열 비교는 사전순이라 틀린다.)
 */
export type PulseSeverity = "urgent" | "important" | "info";

/** 영향 방향. 투자 권유가 아니라 '재료의 부호'다. */
export type PulseDirection = "positive" | "negative" | "neutral";

/** 펄스가 인용한 출처 1건. */
export interface PulseSource {
  title: string;
  /** 매체명 또는 인물명("도널드 트럼프 / Truth Social"). */
  origin: string;
  url: string | null;
  /** 발행·게시 시각 표기(원문 그대로). 불명확하면 null. */
  publishedAt: string | null;
}

/**
 * 영향도 판정 1건.
 *
 * ⚠️ **액션 의견이 아니다.** 사용자가 인터뷰에서 '영향도 판정까지만'을 선택했으므로
 * 매수/매도/비중조절 표현은 이 타입 어디에도 실리면 안 된다(pulse-prompt.ts 가 검열한다).
 */
export interface PulseImpact {
  /**
   * 영향받는 보유 종목 심볼. 거시·섹터 충격처럼 특정 종목에 귀속되지 않으면 null.
   * null 항목은 별도 상한(macro cap)을 탄다.
   */
  symbol: string | null;
  market: StockMarket | null;
  /** 표시용 종목명. symbol 이 null 이면 섹터·테마명("반도체 섹터"). */
  name: string;
  direction: PulseDirection;
  severity: PulseSeverity;
  /** 한 줄 요지. 문자 본문의 제목이 된다. */
  headline: string;
  /** 판정 근거 — 필수. 비면 항목을 폐기한다(브리핑의 rationale 정책과 동일). */
  rationale: string;
  /** 이 판정이 틀릴 수 있는 조건. 필수. */
  risks: string;
  /** 출처 — 최소 1건 필수. 없으면 폐기한다(지어낸 발언 차단의 유일한 방어선). */
  sources: PulseSource[];
  /** 트리거 분류. 상한 집계와 문자 머리말에 쓴다. */
  trigger: "person" | "company" | "macro";
}

/** 펄스 원장 1행. 지문 중복·상한·야간 큐·일일 요약이 전부 이 표 하나를 본다. */
export interface PulseAlertRecord {
  id: number;
  /** 이슈 지문(24시간 중복 차단 키). */
  fingerprint: string;
  /** 로컬 발생일 YYYY-MM-DD (상한 집계 단위). */
  date: string;
  /** 이 판정을 만든 펄스 실행 시각 "HH:mm". */
  slot: string;
  impact: PulseImpact;
  /**
   * 처리 결과.
   * - 'sent'        문자 발송 완료
   * - 'queued'      야간 보류 큐에 대기(07:00 묶음 발송 대상)
   * - 'dup'         24시간 내 같은 지문이 이미 나감
   * - 'capped'      상한 초과로 잘림
   * - 'below'       문턱(중요) 미달 — 일일 브리핑 요약에서만 회수된다
   * - 'failed'      발송 시도했으나 실패
   */
  status: "sent" | "queued" | "dup" | "capped" | "below" | "failed";
  createdAt: string;
  sentAt: string | null;
}

/** 펄스 1회 실행 결과(로그·상태 API용). */
export interface PulseRunResult {
  slot: string;
  date: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  /** LLM 이 낸 판정 수(정규화 통과분). */
  impacts: number;
  sent: number;
  queued: number;
  suppressed: number;
  error: string | null;
}
