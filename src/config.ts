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

export interface AppConfig {
  port: number;
  collectTime: string; // HH:mm (가격 수집)
  eventsCollectTime: string; // HH:mm (팝업/전시 수집)
  newsCollectTimes: string[]; // HH:mm[] (뉴스 다이제스트 수집, 복수 시간 지원)
  youtubeCollectTimes: string[]; // HH:mm[] (유튜브 소식 수집, 복수 시간 지원)
  youtubeFreshDays: number; // 최근 N일 이내 게시 영상만 채택
  /** Agent SDK 큐레이션 1회 최대 대기(ms). 초과 시 중단(hang 방지). */
  agentQueryTimeoutMs: number;
  dbPath: string;
  legacyHistoryJson: string;
  historyRetentionDays: number;
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
    gmailAppPassword: string;
  };
}

export const config: AppConfig = {
  port: int(process.env.PORT, 7777),
  collectTime: process.env.COLLECT_TIME?.trim() || "09:00",
  eventsCollectTime: process.env.EVENTS_COLLECT_TIME?.trim() || "10:00",
  newsCollectTimes: parseCollectTimes(process.env.NEWS_COLLECT_TIMES?.trim() || "08:00,17:00"),
  youtubeCollectTimes: parseCollectTimes(process.env.YOUTUBE_COLLECT_TIMES?.trim() || "08:30"),
  youtubeFreshDays: Math.max(1, int(process.env.YOUTUBE_FRESH_DAYS, 7)),
  // 기본 30분: 카테고리가 많으면 정상 수집도 20분 넘게 걸릴 수 있어 넉넉히 두되, 무한 hang 은 차단
  agentQueryTimeoutMs: Math.max(60_000, int(process.env.AGENT_QUERY_TIMEOUT_MS, 1_800_000)),
  dbPath: process.env.DB_PATH?.trim() || path.join(repoRoot, "data", "price.db"),
  legacyHistoryJson:
    process.env.LEGACY_HISTORY_JSON?.trim() ||
    "/Users/daegun/Documents/Claude/Projects/자동화/daily-price-tracker/price_history.json",
  historyRetentionDays: int(process.env.HISTORY_RETENTION_DAYS, 90),
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
    gmailAppPassword: (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, ""),
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

/** 쉼표로 구분된 시간 목록 파싱 (예: "08:00,17:00") */
function parseCollectTimes(s: string): string[] {
  const times = s.split(",").map((t) => t.trim()).filter(Boolean);
  if (times.length === 0) throw new Error("NEWS_COLLECT_TIMES: 최소 1개 시간 필요");
  times.forEach((t) => parseCollectTime(t));
  return times;
}

/**
 * 필수 자격증명 검증.
 * - 수집에 반드시 필요한 값(네이버)이 없으면 throw (fail-fast).
 * - 선택 기능(Agent SDK, 알림) 미설정은 경고 목록으로만 반환.
 */
export function validateConfig(opts: { forCollect?: boolean } = {}): {
  warnings: string[];
} {
  const warnings: string[] = [];

  // 수집 시각 형식 검증
  parseCollectTime(config.collectTime);
  parseCollectTime(config.eventsCollectTime);
  config.newsCollectTimes.forEach((t) => parseCollectTime(t));
  config.youtubeCollectTimes.forEach((t) => parseCollectTime(t));

  if (opts.forCollect) {
    if (!config.naver.clientId || !config.naver.clientSecret) {
      throw new Error(
        "[설정 오류] NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 가 .env 에 없습니다. " +
          "네이버 쇼핑 API 없이는 1차 가격 수집이 불가능합니다."
      );
    }
    if (!config.anthropicApiKey) {
      warnings.push(
        "ANTHROPIC_API_KEY 미설정 → Agent SDK 웹리서치(비교가/쿠팡/리뷰)를 건너뛰고 네이버 결과만으로 수집합니다."
      );
    }
  }

  if (config.notify.email) {
    if (!config.notify.gmailAddress || !config.notify.gmailAppPassword) {
      warnings.push(
        "NOTIFY_EMAIL=true 이지만 GMAIL_ADDRESS / GMAIL_APP_PASSWORD 미설정 → 이메일 알림을 건너뜁니다."
      );
    }
  }

  return { warnings };
}
