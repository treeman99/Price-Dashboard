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
  dbPath: string;
  legacyHistoryJson: string;
  historyRetentionDays: number;
  naver: { clientId: string; clientSecret: string };
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
  dbPath: process.env.DB_PATH?.trim() || path.join(repoRoot, "data", "price.db"),
  legacyHistoryJson:
    process.env.LEGACY_HISTORY_JSON?.trim() ||
    "/Users/daegun/Documents/Claude/Projects/자동화/daily-price-tracker/price_history.json",
  historyRetentionDays: int(process.env.HISTORY_RETENTION_DAYS, 90),
  naver: {
    clientId: process.env.NAVER_CLIENT_ID?.trim() || "",
    clientSecret: process.env.NAVER_CLIENT_SECRET?.trim() || "",
  },
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
