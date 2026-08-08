import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * 0~23 로 자른다. 야간 창(quiet hours) 전용.
 * 범위 밖 값이 그대로 흘러가면 `hour >= 25` 같은 조건이 **영원히 거짓**이 되어 야간 억제가
 * 조용히 꺼진다 — 새벽 3시에 문자가 쏟아지고 나서야 알게 되는 종류의 실패라 입구에서 막는다.
 */
function clampHour(n: number): number {
  return Math.min(23, Math.max(0, Math.trunc(n)));
}

/**
 * 펄스 문자 문턱. 오타·미지정은 'important'(인터뷰에서 확정한 '중요 이상')로 접는다.
 * 조용히 'info' 로 떨어지면 참고 등급까지 전부 문자로 나가 알림 피로가 폭발한다 —
 * fail-open 방향을 **덜 보내는 쪽**으로 잡는다.
 */
function pulseThreshold(v: string | undefined): "urgent" | "important" | "info" {
  const s = (v ?? "").trim().toLowerCase();
  return s === "urgent" || s === "info" ? s : "important";
}

export interface AppConfig {
  port: number;
  eventsCollectTime: string; // HH:mm (팝업/전시 수집)
  newsCollectTimes: string[]; // HH:mm[] (뉴스 다이제스트 수집, 복수 시간 지원)
  youtubeCollectTimes: string[]; // HH:mm[] (유튜브 소식 수집, 복수 시간 지원)
  /** 한국장 브리핑 시각. 09:00 개장 전 프리뷰이므로 기본 08:00. */
  stockKrCollectTimes: string[];
  /**
   * 미국장 브리핑 시각. 기본 18:00 — 17시는 뉴욕 종가(당일 06시 확정)와
   * 야간 개장(22:30) 사이 死구간이라 새 재료가 없다. 18시는 뉴욕 프리마켓
   * 개장(04~05시 ET)과 겹쳐 선물·프리마켓 재료가 실제로 존재한다.
   */
  stockUsCollectTimes: string[];
  /** 종목 시세 조회 간 간격(ms). 네이버에 대한 매너 — 연타 금지. */
  stockFetchDelayMs: number;
  /**
   * 시간당 펄스(실시간 취합) 실행 시각. 기본은 장중·장전후 집중
   * (한국장 08~16시 + 미국장 22~06시). 06~08시·16~22시는 비운다.
   */
  stockPulseTimes: string[];
  /**
   * 펄스 1회 최대 대기(ms). **공용 타임아웃과 별개여야 한다** — 매시간 도는 작업에
   * 60분을 물리면 실행이 다음 정시를 넘겨 겹친다(src/stock/agent.ts timeoutFor 주석).
   */
  stockPulseTimeoutMs: number;
  /** 펄스 알림 정책. 인터뷰에서 확정한 값들 — docs/stock-agent-v2.md §6 참고. */
  stockPulse: {
    /** 종목 1개당 하루 최대 문자 건수. */
    perSymbolCap: number;
    /** 하루 전체 최대 문자 건수(종목 알림 합계). */
    dailyCap: number;
    /** 거시·섹터 충격은 종목 상한과 **별도**로 하루 이만큼. */
    macroCap: number;
    /** 같은 이슈 재발송 차단 시간(시간). 강도가 오르면 이 창 안에서도 다시 보낸다. */
    dedupHours: number;
    /** 문자 발송 문턱. 이 강도 미만은 원장에만 남는다(일일 브리핑 요약에서 회수). */
    threshold: "urgent" | "important" | "info";
    /** 야간 시작 시각(이 시각부터 긴급만 즉시 발송). 예: 23 */
    quietStartHour: number;
    /** 야간 종료 = 보류분 묶음 발송 시각. 예: 7 */
    quietEndHour: number;
  };
  youtubeFreshDays: number; // 최근 N일 이내 게시 영상만 채택
  /** '본영상' 체크된 유튜브 영상을 이만큼(일) 동안 수집·검색에서 제외 */
  youtubeWatchedExcludeDays: number;
  /** 팝업/전시 '신규' 판정: 이만큼(일) 이상 목록에 없다가 다시 나오면 신규 */
  eventsNewGapDays: number;
  /** 팝업/전시 '신규' 배지 유지 일수(재등장일로부터) */
  eventsNewShowDays: number;
  /**
   * 에이전트 큐레이션 1회 최대 대기(ms). 초과 시 중단(hang 방지).
   *
   * ⚠️ **탭별 상수로 분리됐다**(newsTimeoutMs / youtubeTimeoutMs / eventsTimeoutMs /
   * stockBriefTimeoutMs). 탭마다 정상 소요가 3~7분으로 제각각인데 60분 하나를 공유하니
   * "어느 탭이 얼마나 느려졌는지"를 조정할 수단이 없었다. 이 값은 아직 탭별 상수를 배선하지
   * 않은 호출부의 **폴백 기본값**으로만 남긴다 — 새 큐레이터를 붙일 때 참고할 안전한 상한이다.
   */
  agentQueryTimeoutMs: number;
  /**
   * 뉴스 큐레이션 1회 최대 대기(ms). 기본 20분.
   *
   * 실측 정상 소요는 7분이다. 공용 60분은 8배 과대해서, 잘못된 실행 하나가 한 시간을 통째로
   * 붙들고 그 사이 다음 정시·catch-up 을 전부 밀어냈다(2026-08-02 사고). 정상의 약 3배는
   * 카테고리가 늘거나 웹이 느린 날을 흡수하면서도, 죽은 실행을 한 시간씩 끌고 가지 않는다.
   */
  newsTimeoutMs: number;
  /**
   * 유튜브 큐레이션 1회 최대 대기(ms). 기본 20분.
   * 실측 정상 소요 3분. 채널 발굴(신규 채널 탐색)이 얹히는 날을 감안해도 20분이면 넉넉하다.
   */
  youtubeTimeoutMs: number;
  /** 팝업/전시 큐레이션 1회 최대 대기(ms). 기본 20분(실측 정상 소요 4분 + 날짜 검증 여유). */
  eventsTimeoutMs: number;
  /**
   * 증시 브리핑 1회 최대 대기(ms). 기본 15분.
   * 브리핑은 슬롯(08:00 결산 / 17:00 프리뷰)에 묶인 결과물이라 늦게 나온 브리핑은 가치가 급락한다.
   * 다른 탭보다 짧게 잡아, 살아날 가망 없는 실행을 일찍 끊고 catch-up 에 넘긴다.
   */
  stockBriefTimeoutMs: number;
  dbPath: string;
  legacyHistoryJson: string;
  historyRetentionDays: number;
  /**
   * 네이버 후보 링크의 '사망'(판매중지/삭제/잘못된 상품번호) 검증 on/off. 기본 on.
   * 켜면 수집 시 싼 후보 링크를 실제로 프로브해 죽은 링크를 최저가/Top3 에서 제외한다.
   */
  verifyListingLinks: boolean;
  naver: { clientId: string; clientSecret: string };
  /** insane-engine (vendored): 차단 사이트 fetch. 팝업/전시 날짜 검증에 사용 */
  insaneEngine: {
    engineDir: string;
    python: string;
    maxAttempts: number;
  };
  /** 팝업/전시 큐레이션 시 insane-engine 으로 실제 페이지 날짜 검증 on/off */
  eventsVerifyDates: boolean;
  anthropicApiKey: string;
  notify: {
    email: boolean;
    gmailAddress: string;
    /**
     * Google OAuth2 클라이언트 ID(GOOGLE_CLIENT_ID). Gmail API `messages.send` 로 메일을
     * 보내기 위한 자격증명이다. 2026-08-08 앱 비밀번호(SMTP)를 대체했다.
     *
     * **오해 주의**: OAuth 로 옮겼다고 비밀번호 변경에 안 끊기는 게 아니다. Google 문서는
     * refresh token 무효화 조건에 "사용자가 비밀번호를 변경했고 **refresh token 이 Gmail
     * scope 를 포함한** 경우"를 명시한다 — 우리가 딱 그 경우다.
     *
     * 그래도 옮긴 이유는 **끊김을 다루는 방식**이 달라서다. 앱 비밀번호는 폐기돼도 아무 신호가
     * 없어 2026-08-05 사고 때 69건이 실패하도록 사흘간 아무도 몰랐다. OAuth 는 invalid_grant
     * 로 명시적으로 알려주므로, 그 신호를 잡아 iMessage 경고와 대시보드 재연결 배너로 연결했다.
     * 즉 목표는 무중단이 아니라 **빠른 인지와 원클릭 복구**다.
     */
    googleClientId: string;
    /** Google OAuth2 클라이언트 시크릿(GOOGLE_CLIENT_SECRET). 로그에 절대 찍지 말 것. */
    googleClientSecret: string;
    /** iMessage 알림 사용 여부(macOS Messages.app osascript 발송). 기본 off. */
    imessage: boolean;
    /** iMessage 수신자(본인 전화번호 E.164 예: +8210… 또는 Apple ID 이메일). */
    imessageTo: string;
  };
}

export const config: AppConfig = {
  port: int(process.env.PORT, 7777),
  eventsCollectTime: process.env.EVENTS_COLLECT_TIME?.trim() || "10:00",
  newsCollectTimes: parseCollectTimes(
    process.env.NEWS_COLLECT_TIMES?.trim() || "08:00,17:00",
    "NEWS_COLLECT_TIMES"
  ),
  youtubeCollectTimes: parseCollectTimes(
    process.env.YOUTUBE_COLLECT_TIMES?.trim() || "08:30",
    "YOUTUBE_COLLECT_TIMES"
  ),
  stockKrCollectTimes: parseCollectTimes(
    process.env.STOCK_KR_COLLECT_TIMES?.trim() || "08:00",
    "STOCK_KR_COLLECT_TIMES"
  ),
  stockUsCollectTimes: parseCollectTimes(
    process.env.STOCK_US_COLLECT_TIMES?.trim() || "18:00",
    "STOCK_US_COLLECT_TIMES"
  ),
  stockFetchDelayMs: Math.max(0, int(process.env.STOCK_FETCH_DELAY_MS, 300)),
  stockPulseTimes: parseCollectTimes(
    process.env.STOCK_PULSE_TIMES?.trim() ||
      // 한국장(08~16) + 미국장(22~06). 06~08·16~22 는 새 재료가 거의 없는 구간이라 비운다.
      "08:00,09:00,10:00,11:00,12:00,13:00,14:00,15:00,16:00," +
        "22:00,23:00,00:00,01:00,02:00,03:00,04:00,05:00,06:00",
    "STOCK_PULSE_TIMES"
  ),
  // 기본 10분. 정시 간격(60분)의 1/6 이라 실행이 밀려도 다음 정시를 침범하지 않는다.
  stockPulseTimeoutMs: Math.max(60_000, int(process.env.STOCK_PULSE_TIMEOUT_MS, 600_000)),
  stockPulse: {
    perSymbolCap: Math.max(0, int(process.env.STOCK_PULSE_PER_SYMBOL_CAP, 3)),
    dailyCap: Math.max(0, int(process.env.STOCK_PULSE_DAILY_CAP, 10)),
    macroCap: Math.max(0, int(process.env.STOCK_PULSE_MACRO_CAP, 2)),
    dedupHours: Math.max(1, int(process.env.STOCK_PULSE_DEDUP_HOURS, 24)),
    threshold: pulseThreshold(process.env.STOCK_PULSE_THRESHOLD),
    quietStartHour: clampHour(int(process.env.STOCK_PULSE_QUIET_START, 23)),
    quietEndHour: clampHour(int(process.env.STOCK_PULSE_QUIET_END, 7)),
  },
  youtubeFreshDays: Math.max(1, int(process.env.YOUTUBE_FRESH_DAYS, 7)),
  youtubeWatchedExcludeDays: Math.max(1, int(process.env.YOUTUBE_WATCHED_EXCLUDE_DAYS, 7)),
  eventsNewGapDays: Math.max(1, int(process.env.EVENTS_NEW_GAP_DAYS, 7)),
  eventsNewShowDays: Math.max(1, int(process.env.EVENTS_NEW_SHOW_DAYS, 3)),
  // 기본 60분: 카테고리가 많으면 정상 수집도 오래 걸린다. 30분이던 값은 실제로 부족해져
  // (실측 2026-07-26: 정상 소요가 9~17분에서 30분 초과로 늘어 큐레이션이 연속 5회 잘림)
  // 매번 결과를 통째로 버리고 있었다. 무한 hang 차단이라는 원래 목적은 유지하되 여유를 준다.
  agentQueryTimeoutMs: Math.max(60_000, int(process.env.AGENT_QUERY_TIMEOUT_MS, 3_600_000)),
  // ── 탭별 큐레이션 타임아웃 ──
  // 기본값은 전부 **실측 정상 소요 기준**이다(2026-08-02 로그): 뉴스 7분 · 유튜브 3분 ·
  // 이벤트 4분. 여유 배수를 곱해 20분/20분/20분, 슬롯 민감도가 높은 증시 브리핑만 15분.
  // 하한 60초는 오타로 0 을 넣어 모든 수집이 즉시 잘리는 사고를 막는다(공용 상수와 같은 패턴).
  newsTimeoutMs: Math.max(60_000, int(process.env.NEWS_TIMEOUT_MS, 1_200_000)),
  youtubeTimeoutMs: Math.max(60_000, int(process.env.YOUTUBE_TIMEOUT_MS, 1_200_000)),
  eventsTimeoutMs: Math.max(60_000, int(process.env.EVENTS_TIMEOUT_MS, 1_200_000)),
  stockBriefTimeoutMs: Math.max(60_000, int(process.env.STOCK_BRIEF_TIMEOUT_MS, 900_000)),
  dbPath: process.env.DB_PATH?.trim() || path.join(repoRoot, "data", "price.db"),
  legacyHistoryJson:
    process.env.LEGACY_HISTORY_JSON?.trim() ||
    "/Users/daegun/Documents/Claude/Projects/자동화/daily-price-tracker/price_history.json",
  historyRetentionDays: int(process.env.HISTORY_RETENTION_DAYS, 90),
  verifyListingLinks: bool(process.env.VERIFY_LISTING_LINKS, true),
  naver: {
    clientId: process.env.NAVER_CLIENT_ID?.trim() || "",
    clientSecret: process.env.NAVER_CLIENT_SECRET?.trim() || "",
  },
  insaneEngine: {
    engineDir: process.env.INSANE_ENGINE_DIR?.trim() || path.join(repoRoot, "tools", "insane-engine"),
    python:
      process.env.INSANE_PYTHON?.trim() ||
      path.join(repoRoot, "tools", "insane-engine", ".venv", "bin", "python3"),
    // fetch 격자 시도 상한(차단 시 무한 에스컬레이션 방지)
    maxAttempts: int(process.env.INSANE_MAX_ATTEMPTS, 18),
  },
  eventsVerifyDates: bool(process.env.EVENTS_VERIFY_DATES, true),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || "",
  notify: {
    email: bool(process.env.NOTIFY_EMAIL, false),
    gmailAddress: process.env.GMAIL_ADDRESS?.trim() || "",
    googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() || "",
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || "",
    imessage: bool(process.env.NOTIFY_IMESSAGE, false),
    imessageTo: process.env.IMESSAGE_TO?.trim() || "",
  },
};

export const REPO_ROOT = repoRoot;

/** COLLECT_TIME → {hour, minute} */
export function parseCollectTime(t: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) throw new Error(`COLLECT_TIME 형식 오류: "${t}" (HH:mm 이어야 함)`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
    throw new Error(`COLLECT_TIME 범위 오류: "${t}"`);
  return { hour, minute };
}

/** 쉼표로 구분된 시간 목록 파싱 (예: "08:00,17:00"). label 은 오류 메시지에 쓸 env 키 이름. */
function parseCollectTimes(s: string, label: string): string[] {
  const times = s.split(",").map((t) => t.trim()).filter(Boolean);
  if (times.length === 0) throw new Error(`${label}: 최소 1개 시간 필요`);
  times.forEach((t) => parseCollectTime(t));
  return times;
}

/**
 * 필수 자격증명 검증.
 * - 수집에 반드시 필요한 값(네이버)이 없으면 throw (fail-fast).
 * - 선택 기능(에이전트, 알림) 미설정은 경고 목록으로만 반환.
 */
export function validateConfig(): { warnings: string[] } {
  const warnings: string[] = [];

  // 수집 시각 형식 검증
  parseCollectTime(config.eventsCollectTime);
  config.newsCollectTimes.forEach((t) => parseCollectTime(t));
  config.youtubeCollectTimes.forEach((t) => parseCollectTime(t));
  config.stockKrCollectTimes.forEach((t) => parseCollectTime(t));
  config.stockUsCollectTimes.forEach((t) => parseCollectTime(t));
  config.stockPulseTimes.forEach((t) => parseCollectTime(t));

  // 네이버 키는 이제 **팝업/전시 탭 전용**이다(webkr/blog 검색). 가격 수집이 쓰던 쇼핑 검색
  // API 는 2026-07-31 종료돼 그 경로 자체가 사라졌다.
  //
  // 기동을 막는 throw 가 아니라 경고로 알린다 — 나머지 6개 탭은 이 키 없이도 정상이라
  // 대시보드 전체를 세울 이유가 없다. 다만 팝업/전시에는 **선택 사항이 아니다**: 이 검색으로
  // 만드는 코퍼스가 LLM 큐레이터의 씨앗이자 환각 URL 을 거르는 링크 진실원이고 LLM 실패 시
  // 폴백 스냅샷이라, 키가 없으면 그 탭은 사실상 빈 화면이 된다. 문구로 그 차이를 드러낸다.
  if (!config.naver.clientId || !config.naver.clientSecret) {
    warnings.push(
      "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 미설정 → 팝업·전시 탭이 빈 화면이 됩니다(다른 탭은 정상)."
    );
  }

  // 발송은 2026-08-08 앱 비밀번호(SMTP)에서 OAuth2 + Gmail API 로 옮겼다. 계정 비밀번호를
  // 바꾸면 앱 비밀번호가 통째로 폐기되는데, 그때 코드가 조용히 실패해 사흘간 아무도 몰랐다.
  // 그래서 여기서 요구하는 것도 GMAIL_APP_PASSWORD 가 아니라 OAuth 클라이언트다.
  //
  // 다만 클라이언트가 있어도 **아직 연결 안 된** 상태가 따로 있다(리프레시 토큰 없음). 그건
  // 기동 시점의 정적 설정이 아니라 런타임 상태라 여기서 판정하지 않는다 — 대시보드 배너와
  // 발송 실패 시 iMessage 경고가 그 역할을 맡는다.
  if (config.notify.email) {
    if (!config.notify.gmailAddress) {
      warnings.push("NOTIFY_EMAIL=true 이지만 GMAIL_ADDRESS 미설정 → 이메일 알림을 건너뜁니다.");
    }
    if (!config.notify.googleClientId || !config.notify.googleClientSecret) {
      warnings.push(
        "NOTIFY_EMAIL=true 이지만 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 미설정 → 이메일 알림을 건너뜁니다. " +
          "Google Cloud Console 에서 OAuth 클라이언트를 발급한 뒤 대시보드에서 계정을 연결하세요."
      );
    }
  }

  return { warnings };
}
