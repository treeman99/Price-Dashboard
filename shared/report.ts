// 세 모델 통합 뉴스·유튜브 보고서 — 수집기(봇 홈 collector)와 price 서버·화면이 함께 쓰는 형식.
//
// 수집기는 실행마다 `runs/<runId>/report.json`(이 형식)을 남기고, price 는 그 파일을 그대로 읽어
// '보고서' 탭과 메일·문자 본문을 만든다. 필드를 바꾸면 이미 쌓인 실행 기록과의 호환을 함께 본다
// (version 으로 구분한다).

export type DailyReportModelOutcome = "success" | "skipped-limit" | "skipped-error";

export const DAILY_REPORT_OUTCOME_LABEL: Record<DailyReportModelOutcome, string> = {
  success: "성공",
  "skipped-limit": "한도로 건너뜀",
  "skipped-error": "오류로 건너뜀(조치 필요)",
};

export interface DailyReportModel {
  key: string;
  /** 표시명(예: "Claude Opus 5.5"). */
  label: string;
  /** 요청한 모델 ID. */
  model: string;
  /** 응답에 찍힌 실제 모델 ID. */
  actualModels: string[];
  outcome: DailyReportModelOutcome;
  reason: string;
  newsCount: number;
  youtubeCount: number;
  toolCalls: number;
}

export interface DailyReportEntry {
  kind: "news" | "youtube";
  categoryKey: string;
  categoryLabel: string;
  title: string;
  summary: string;
  /** 뉴스 출처명 또는 유튜브 채널명. */
  source: string;
  url: string | null;
  /** 발행일·업로드일 YYYY-MM-DD. */
  date: string;
  /** 이 항목을 찾은 모델 표시명. */
  foundBy: string[];
  /** 대표가 아닌 출처. */
  secondary: { label: string; link: string }[];
  /** 모델 간 근거 차이(없으면 빈 문자열). */
  conflict: string;
  /** 이전 보고서에 일부가 실렸고 새 출처가 붙은 업데이트. */
  update: boolean;
}

export interface DailyReportSection {
  key: string;
  label: string;
  items: DailyReportEntry[];
}

export interface DailyReportCounts {
  before: number;
  afterMerge: number;
  alreadyReported: number;
  reported: number;
  seedsOnly: number;
}

export interface DailyReportJson {
  version: 1;
  runId: string;
  /** 누가 돌렸나(price:schedule · price:catchup · price:manual · cli). */
  trigger: string;
  preview: boolean;
  startedAt: string;
  finishedAt: string;
  /** 성공 모델이 1개 이상이면 true. */
  ok: boolean;
  successCount: number;
  modelCount: number;
  models: DailyReportModel[];
  editor: { label: string | null; model: string | null; ok: boolean; note: string };
  /** 핵심 요약(편집기 요약이 없으면 대표 제목 몇 개). 새 항목이 없으면 빈 배열. */
  highlights: string[];
  counts: DailyReportCounts;
  coverage: {
    /** 직전 성공 보고 시각(증분 기준). 첫 실행이면 null. */
    lastSuccessAt: string | null;
    freshDays: number;
    /** 뉴스 수집 범위(최근 24시간) 밖이라 확인하지 못한 구간. 없으면 null. */
    gap: { from: string; to: string } | null;
    geekNews: { ok: boolean; count: number; since: string; until: string; error: string | null };
  };
  news: DailyReportSection[];
  youtube: DailyReportSection[];
  /** 세 모델 모두 고르지 않은 추천 채널 신규 업로드(RSS 기준). */
  seedsOnly: { title: string; channel: string; date: string; url: string; categoryLabel: string }[];
  /** 원자료 수집에 실패한 출처. */
  sourceFailures: { label: string; error: string }[];
}

// ── price API ──

/** 보고서 목록 1행(GET /api/report). */
export interface DailyReportRunSummary {
  runId: string;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  successCount: number;
  modelCount: number;
  models: { key: string; label: string; outcome: DailyReportModelOutcome }[];
  counts: DailyReportCounts;
  highlights: string[];
  /** price 가 이 실행 결과로 메일·문자를 보냈는지(보낸 채널만). */
  delivered: { email?: string; imessage?: string };
}

/** 메일·문자 채널 상태(화면 표시용). 비밀값·주소는 싣지 않는다. */
export interface DailyReportChannelState {
  /** 보고서 탭 스위치. */
  enabled: boolean;
  /** .env·계정 연결까지 갖춰져 실제로 보낼 수 있는가. */
  ready: boolean;
  /** ready 가 아니면 그 이유. */
  problem: string | null;
}

export interface DailyReportListResponse {
  runs: DailyReportRunSummary[];
  /** 지금 price 가 수집기를 돌리는 중이면 그 시작 정보. */
  running: { trigger: string; startedAt: string } | null;
  lastAttempt: DailyReportAttempt | null;
  channels: { email: DailyReportChannelState; imessage: DailyReportChannelState };
  /** 수집기 위치·빌드 정보(진단용). */
  collector: { available: boolean; commit: string | null; builtAt: string | null };
}

/** price 가 마지막으로 수집기를 돌린 결과. */
export interface DailyReportAttempt {
  at: string;
  finishedAt: string;
  trigger: string;
  ok: boolean;
  runId: string | null;
  /** 다른 실행(Orca 자동화 등)이 진행 중이어서 그 결과를 이어받았는가. */
  adopted: boolean;
  error: string | null;
}
