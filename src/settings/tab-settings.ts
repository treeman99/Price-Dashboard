import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { isMailConfigured } from "../notify/mailer.ts";
import { isIMessageConfigured } from "../notify/imessage.ts";
import { severityRank } from "../../shared/pulse.ts";
import type {
  DeepPartial,
  NotifyChannel,
  NotifyTabId,
  NumberRule,
  PulseSeverity,
  TabSettings,
  TabSettingsResponse,
} from "../../shared/types.ts";

/**
 * 탭별 운영 설정 — 지금까지 `.env` 에서만 바꿀 수 있던 값들(docs/customization-contract.md §2).
 *
 * 저장: `data/tab-settings.json` 에 **기본값과 다른 필드만** sparse 로 둔다. 나머지는 계속
 * `.env`(config.ts) 를 따른다. 경로는 schedule.json 과 같은 방식(DB_PATH 의 디렉터리)이라
 * 테스트·임시 서버가 DB_PATH 하나로 실데이터와 격리된다.
 *
 * ★ 소비처는 `getTabSettings()` 를 **호출 시점마다** 읽어야 한다. 모듈 로드 시 상수로 잡아 두면
 *   대시보드에서 저장해도 재시작 전까지 반영되지 않는다 — '저장 즉시 반영'이 이 기능의 계약이다.
 *
 * 읽기는 관대하다(깨진 파일·타입 오류 → 기본값, 범위 밖 숫자 → 범위로 자름): 설정 파일 하나가
 * 깨졌다고 수집·알림이 멈추면 안 된다. 쓰기는 엄격하다(범위·타입 오류 → throw → 라우트 400):
 * 화면이 잘못 보낸 값을 조용히 접어 저장하면 사용자는 저장이 됐다고 믿는다.
 */

/** 저장 위치(카테고리·스케줄 설정과 같은 data 디렉터리). */
const STORE_PATH = path.join(path.dirname(config.dbPath), "tab-settings.json");

/**
 * 탭별로 **실제로 존재하는** 알림 채널. 추측이 아니라 발송 코드에서 확인한 목록이다:
 * - events·news·youtube·skills: `src/notify/<탭>-email.ts` 의 send<탭>Email + send<탭>IMessage
 * - stock(브리핑): `src/notify/stock-email.ts` sendStockEmail + sendStockIMessage(src/stock/stock.ts 가 둘 다 호출)
 * - stockPulse: 문자만(docs/stock-agent-v2.md §6 '채널' — 펄스 이메일은 보내지 않는다)
 * - uptime: 문자만(src/uptime/notify.ts — iMessage 게이트)
 */
export const NOTIFY_CHANNELS: Record<NotifyTabId, NotifyChannel[]> = {
  events: ["email", "imessage"],
  news: ["email", "imessage"],
  youtube: ["email", "imessage"],
  stock: ["email", "imessage"],
  stockPulse: ["imessage"],
  skills: ["email", "imessage"],
  uptime: ["imessage"],
};

const NOTIFY_TABS = Object.keys(NOTIFY_CHANNELS) as NotifyTabId[];
const ALL_CHANNELS: NotifyChannel[] = ["email", "imessage"];

/**
 * 숫자 필드 허용 범위(키 = 점 경로). 화면이 응답의 numberRules 로 입력을 제한하고, 서버가 같은 표로
 * 다시 검증한다. 모두 **정수**만 받는다. 범위 근거(각 값의 쓰임새·사고 기록):
 */
export const NUMBER_RULES: Record<string, NumberRule> = {
  // 하한 1 = config.ts 하한. 상한 30: 시드인 채널 RSS 가 최신 15개만 줘서(src/youtube/channels.ts) 한 달을 넘는 창은 시드가 못 채우고 '소식' 탭 성격도 잃는다.
  "youtube.freshDays": { min: 1, max: 30, unit: "일" },
  // 하한 1 = config.ts 하한. 상한 30: 신선도 창(최대 30일) 이상 제외하면 그 영상은 이미 신선도에서 탈락해 더 길게 잡을 의미가 없다.
  "youtube.watchedExcludeDays": { min: 1, max: 30, unit: "일" },
  // 하한 1 = config.ts 하한. 상한 60: 등장 원장이 60일 넘게 안 보인 항목을 지운다(new-tracker.ts RETENTION_DAYS) — 그보다 긴 공백은 판정 근거가 없다.
  "events.newGapDays": { min: 1, max: 60, unit: "일" },
  // 하한 1 = config.ts 하한. 상한 30: 배지가 한 달 넘게 붙으면 목록 대부분이 '신규'가 돼 배지가 뜻을 잃는다.
  "events.newShowDays": { min: 1, max: 30, unit: "일" },
  // 0 = 종목 알림 끔(config.ts 하한 0). 상한 10 = 전체 일일 상한 기본값 — 한 종목이 하루 예산을 다 쓰는 데까지만 의미가 있다.
  "stockPulse.perSymbolCap": { min: 0, max: 10, unit: "건" },
  // 0 = 종목 알림 끔. 상한 30 = 인터뷰 확정값(10)의 3배 — 문자가 유일 채널이라 그 이상은 알림 피로로 채널을 통째로 끄게 된다(src/uptime/notify.ts 머리 주석).
  "stockPulse.dailyCap": { min: 0, max: 30, unit: "건" },
  // 0 = 거시·섹터 알림 끔. 상한 10: 종목 상한과 별도 예산이라(pulse-gate.ts decide) 종목 상한 상한과 맞춘다.
  "stockPulse.macroCap": { min: 0, max: 10, unit: "건" },
  // 하한 1 = config.ts 하한. 상한 168(7일): 중복 억제는 그날의 소음을 줄이는 장치지 사건을 영구 차단하는 장치가 아니다(repo.ts recentPulseAlerts 주석).
  "stockPulse.dedupHours": { min: 1, max: 168, unit: "시간" },
  // 0~23: config.ts clampHour 원칙 — 범위 밖 시각은 `hour >= 25` 처럼 영원히 거짓이 돼 야간 억제가 조용히 꺼진다.
  "stockPulse.quietStartHour": { min: 0, max: 23, unit: "시" },
  "stockPulse.quietEndHour": { min: 0, max: 23, unit: "시" },
  // 하한 30: 차트·메일이 최근 20거래일(≈한 달) + 20일 이평을 그린다(stock.ts HISTORY_DAYS) — 그보다 짧으면 차트가 잘린다. 상한 3650(10년): 그 이상은 화면이 쓰지 않는 원장만 불린다.
  "stock.historyRetentionDays": { min: 30, max: 3650, unit: "일" },
  // 하한 1분 = config.ts 하한 60_000ms. 상한 60분 = 옛 공용 상한(agentQueryTimeoutMs) — 그 이상 붙들면 다음 정시·catch-up 을 밀어낸다(2026-08-02 사고).
  "timeouts.newsMin": { min: 1, max: 60, unit: "분" },
  "timeouts.youtubeMin": { min: 1, max: 60, unit: "분" },
  "timeouts.eventsMin": { min: 1, max: 60, unit: "분" },
  // 하한 1분 = config.ts 하한. 상한 60분: 08:00 결산 브리핑이 09:00 개장 전에 끝나야 가치가 있다(agent.ts timeoutFor 주석 — 늦은 브리핑은 값이 급락).
  "timeouts.stockBriefMin": { min: 1, max: 60, unit: "분" },
  // 하한 1분 = config.ts 하한. 상한 30분 = 정시 간격(60분)의 절반 — 넘기면 다음 정시와 겹쳐 동시 실행 가드에 그 시각이 날아간다(agent.ts timeoutFor ⚠️).
  "timeouts.stockPulseMin": { min: 1, max: 30, unit: "분" },
  // 하한 1분(config.ts 하한 30초를 분 단위로 올림). 상한 20분 = 전체 예산 기본값 — 배치 1회가 전체 예산보다 길 수는 없다(curate.ts 가 남은 예산으로 자른다).
  "timeouts.skillsSummaryMin": { min: 1, max: 20, unit: "분" },
  // 하한 1분 = config.ts 하한 60_000ms. 상한 60분 = 옛 공용 상한과 같은 이유.
  "timeouts.skillsBudgetMin": { min: 1, max: 60, unit: "분" },
};

/** 오류 문구용 한국어 이름. */
const FIELD_LABEL: Record<string, string> = {
  "youtube.freshDays": "유튜브 신선도",
  "youtube.watchedExcludeDays": "유튜브 본영상 제외 기간",
  "events.newGapDays": "팝업·전시 신규 판정 공백",
  "events.newShowDays": "팝업·전시 신규 배지 유지",
  "events.verifyDates": "팝업·전시 날짜 검증",
  "stockPulse.perSymbolCap": "펄스 종목당 일일 상한",
  "stockPulse.dailyCap": "펄스 전체 일일 상한",
  "stockPulse.macroCap": "펄스 거시·섹터 일일 상한",
  "stockPulse.dedupHours": "펄스 중복 억제 시간",
  "stockPulse.threshold": "펄스 문자 문턱",
  "stockPulse.quietStartHour": "펄스 조용 시간 시작",
  "stockPulse.quietEndHour": "펄스 조용 시간 끝",
  "stock.historyRetentionDays": "증시 시계열 보존 기간",
  "timeouts.newsMin": "뉴스 타임아웃",
  "timeouts.youtubeMin": "유튜브 타임아웃",
  "timeouts.eventsMin": "팝업·전시 타임아웃",
  "timeouts.stockBriefMin": "증시 브리핑 타임아웃",
  "timeouts.stockPulseMin": "펄스 타임아웃",
  "timeouts.skillsSummaryMin": "스킬 요약 배치 타임아웃",
  "timeouts.skillsBudgetMin": "스킬 요약 전체 예산",
};

const SEVERITIES: PulseSeverity[] = ["urgent", "important", "info"];

/** .env(config.ts) 기본값. 타임아웃은 ms → 분(반올림하지 않는다 — 기본값은 .env 그대로여야 한다). */
function defaults(): TabSettings {
  const notify = {} as TabSettings["notify"];
  for (const tab of NOTIFY_TABS) {
    // 현재 동작과 같게 '모두 켜짐' — 실제 on/off 는 전역 .env 스위치가 결정한다.
    // 그 탭에 없는 채널은 false 로 고정(화면이 원값을 보여 줘도 오해가 없게).
    notify[tab] = { email: NOTIFY_CHANNELS[tab].includes("email"), imessage: NOTIFY_CHANNELS[tab].includes("imessage") };
  }
  const min = (ms: number) => ms / 60_000;
  return {
    notify,
    youtube: {
      freshDays: config.youtubeFreshDays,
      watchedExcludeDays: config.youtubeWatchedExcludeDays,
    },
    events: {
      newGapDays: config.eventsNewGapDays,
      newShowDays: config.eventsNewShowDays,
      verifyDates: config.eventsVerifyDates,
    },
    stockPulse: { ...config.stockPulse },
    stock: { historyRetentionDays: config.historyRetentionDays },
    timeouts: {
      newsMin: min(config.newsTimeoutMs),
      youtubeMin: min(config.youtubeTimeoutMs),
      eventsMin: min(config.eventsTimeoutMs),
      stockBriefMin: min(config.stockBriefTimeoutMs),
      stockPulseMin: min(config.stockPulseTimeoutMs),
      skillsSummaryMin: min(config.skillsSummaryTimeoutMs),
      skillsBudgetMin: min(config.skillsSummaryBudgetMs),
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 저장 파일 원본(바꾼 필드만). 없거나 깨졌으면 빈 객체. */
function readStored(): Record<string, unknown> {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
      if (isPlainObject(raw)) return raw;
      log.warn("tab-settings.json 형식 오류(객체 아님) → 기본값 사용");
    }
  } catch (e) {
    log.warn(`tab-settings.json 읽기 실패 → 기본값 사용: ${(e as Error).message}`);
  }
  return {};
}

/**
 * 깨진 문턱의 폴백 — **덜 보내는 쪽**(config.ts pulseThreshold 주석). 기본값과 'important' 중
 * 더 엄격한 쪽을 쓴다. 파일이 깨졌다는 이유로 'info' 로 떨어지면 참고 등급까지 전부 문자로 나간다.
 */
function stricterThreshold(def: PulseSeverity): PulseSeverity {
  return severityRank(def) >= severityRank("important") ? def : "important";
}

function clampToRule(n: number, rule: NumberRule): number {
  return Math.min(rule.max, Math.max(rule.min, Math.trunc(n)));
}

/** 읽기 경로 리프 1개: 타입이 맞으면 쓰고(숫자는 범위로 자름), 아니면 기본값. throw 안 함. */
function lenientLeaf(key: string, def: unknown, raw: unknown): unknown {
  if (raw === undefined) return def;
  if (key === "stockPulse.threshold") {
    return SEVERITIES.includes(raw as PulseSeverity) ? raw : stricterThreshold(def as PulseSeverity);
  }
  if (typeof def === "boolean") return typeof raw === "boolean" ? raw : def;
  if (typeof def === "number") {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return def;
    const rule = NUMBER_RULES[key];
    // 범위 밖 숫자는 버리지 않고 자른다 — 규칙이 좁아진 뒤에도 사용자 의도에 가장 가까운 값이고,
    // 조용 시간은 config.ts clampHour 와 같은 0~23 클램프 원칙이다.
    return rule ? clampToRule(raw, rule) : def;
  }
  return def;
}

/**
 * 현재 유효 설정(.env 기본값 + 저장분). 파일이 없거나 깨져도 항상 유효한 값을 돌려준다.
 * 호출 시점마다 파일을 읽는다(수 KB 미만 — schedule-store 와 같은 방식).
 */
export function getTabSettings(): TabSettings {
  return mergeOnto(defaults(), readStored());
}

function mergeOnto(def: TabSettings, stored: Record<string, unknown>): TabSettings {
  const out = structuredClone(def);
  const sections = out as unknown as Record<string, Record<string, unknown>>;
  for (const [section, defSection] of Object.entries(sections)) {
    const rawSection = stored[section];
    if (!isPlainObject(rawSection)) continue;
    if (section === "notify") {
      for (const tab of NOTIFY_TABS) {
        const rawTab = rawSection[tab];
        if (!isPlainObject(rawTab)) continue;
        for (const ch of NOTIFY_CHANNELS[tab]) {
          if (typeof rawTab[ch] === "boolean") out.notify[tab][ch] = rawTab[ch] as boolean;
        }
      }
      continue;
    }
    for (const field of Object.keys(defSection)) {
      defSection[field] = lenientLeaf(`${section}.${field}`, defSection[field], rawSection[field]);
    }
  }
  return out;
}

/** 쓰기 경로 리프 1개: 엄격 검증. 실패 시 throw Error(한국어 사유). */
function strictLeaf(key: string, def: unknown, v: unknown): unknown {
  const label = FIELD_LABEL[key] ?? key;
  if (key === "stockPulse.threshold") {
    if (!SEVERITIES.includes(v as PulseSeverity)) {
      throw new Error(`${label}: urgent / important / info 중 하나여야 합니다.`);
    }
    return v;
  }
  if (typeof def === "boolean") {
    if (typeof v !== "boolean") throw new Error(`${label}: true/false 여야 합니다.`);
    return v;
  }
  const rule = NUMBER_RULES[key];
  if (!rule) throw new Error(`${label}: 변경할 수 없는 항목입니다.`);
  if (typeof v !== "number" || !Number.isInteger(v) || v < rule.min || v > rule.max) {
    throw new Error(`${label}: ${rule.min}~${rule.max}${rule.unit} 사이의 정수여야 합니다.`);
  }
  return v;
}

/**
 * 부분 수정 저장. 전달된 필드만 검증해 반영하고 최종(병합) 설정을 돌려준다.
 * 알 수 없는 항목·타입 오류·범위 밖 값은 throw(→ 400) — 조용히 버리면 화면은 저장된 줄 안다.
 * 예외: 탭에 없는 알림 채널(예: stockPulse.email)은 타입만 확인하고 무시한다(계약 §2).
 *
 * 저장은 **기본값과 다른 필드만**(sparse) 남긴다. 기본값과 같은 값을 보내면 저장분에서 빠져
 * 다시 .env 를 따른다 — 화면의 '기본값으로 되돌리기'가 별도 API 없이 이 경로로 된다.
 */
export function saveTabSettings(patch: DeepPartial<TabSettings>): TabSettings {
  if (!isPlainObject(patch)) throw new Error("설정 본문은 객체여야 합니다.");
  const def = defaults();
  const next = getTabSettings();
  const nextSections = next as unknown as Record<string, Record<string, unknown>>;

  for (const [section, value] of Object.entries(patch as Record<string, unknown>)) {
    // hasOwn: `in` 은 "constructor"·"__proto__" 같은 프로토타입 키까지 참으로 본다.
    if (!Object.hasOwn(nextSections, section)) throw new Error(`알 수 없는 설정 항목: ${section}`);
    if (!isPlainObject(value)) throw new Error(`${section}: 객체여야 합니다.`);

    if (section === "notify") {
      for (const [tab, chans] of Object.entries(value)) {
        if (!NOTIFY_TABS.includes(tab as NotifyTabId)) throw new Error(`알 수 없는 알림 탭: ${tab}`);
        if (!isPlainObject(chans)) throw new Error(`notify.${tab}: 객체여야 합니다.`);
        for (const [ch, on] of Object.entries(chans)) {
          if (!ALL_CHANNELS.includes(ch as NotifyChannel)) {
            throw new Error(`알 수 없는 알림 채널: notify.${tab}.${ch}`);
          }
          if (typeof on !== "boolean") throw new Error(`notify.${tab}.${ch}: true/false 여야 합니다.`);
          if (!NOTIFY_CHANNELS[tab as NotifyTabId].includes(ch as NotifyChannel)) continue;
          next.notify[tab as NotifyTabId][ch as NotifyChannel] = on;
        }
      }
      continue;
    }

    const target = nextSections[section];
    for (const [field, v] of Object.entries(value)) {
      if (!Object.hasOwn(target, field)) throw new Error(`알 수 없는 설정 항목: ${section}.${field}`);
      target[field] = strictLeaf(`${section}.${field}`, target[field], v);
    }
  }

  writeStored(diffFromDefaults(next, def));
  return getTabSettings();
}

/** 기본값과 다른 리프만 남긴 sparse 객체. 빈 섹션은 뺀다. */
function diffFromDefaults(next: TabSettings, def: TabSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const n = next as unknown as Record<string, Record<string, unknown>>;
  const d = def as unknown as Record<string, Record<string, unknown>>;
  for (const section of Object.keys(n)) {
    const diff: Record<string, unknown> = {};
    for (const [field, v] of Object.entries(n[section])) {
      const dv = d[section][field];
      if (section === "notify") {
        const tabDiff: Record<string, boolean> = {};
        for (const ch of ALL_CHANNELS) {
          const on = (v as Record<NotifyChannel, boolean>)[ch];
          if (on !== (dv as Record<NotifyChannel, boolean>)[ch]) tabDiff[ch] = on;
        }
        if (Object.keys(tabDiff).length) diff[field] = tabDiff;
      } else if (v !== dv) {
        diff[field] = v;
      }
    }
    if (Object.keys(diff).length) out[section] = diff;
  }
  return out;
}

/** tmp → rename 으로 원자적으로 쓴다(중간에 죽어도 반쪽짜리 JSON 이 남지 않게). */
function writeStored(stored: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), "utf8");
  fs.renameSync(tmp, STORE_PATH);
}

/** 전역 채널 상태(.env 스위치 + 수신자/자격증명). */
function globalChannels(): Record<NotifyChannel, boolean> {
  return { email: isMailConfigured(), imessage: isIMessageConfigured() };
}

/** GET/PUT /api/settings 응답. */
export function getTabSettingsResponse(): TabSettingsResponse {
  return {
    settings: getTabSettings(),
    defaults: defaults(),
    numberRules: NUMBER_RULES,
    channels: NOTIFY_CHANNELS,
    globalChannels: globalChannels(),
  };
}

/**
 * 이 탭이 이 채널로 보내도 되는가 = 탭에 그 채널이 있고 AND 전역 .env 스위치(+수신자/자격증명)가
 * 켜져 있고 AND 탭 스위치가 켜져 있다. 전역이 꺼져 있으면 탭에서 켜도 나가지 않는다.
 *
 * 메일의 전역 판정은 `isMailConfigured()` 다 — '연결됨'까지는 요구하지 않는다(그 함수 주석:
 * 미연결을 여기서 접으면 조용히 건너뛰는 2026-08-05 실패 모드가 된다).
 */
export function isTabNotifyEnabled(tab: NotifyTabId, channel: NotifyChannel): boolean {
  if (!NOTIFY_CHANNELS[tab]?.includes(channel)) return false;
  const globalOn = channel === "email" ? isMailConfigured() : isIMessageConfigured();
  if (!globalOn) return false;
  return getTabSettings().notify[tab][channel];
}

/** 탭 타임아웃(분) → ms. 소비처가 호출 시점에 부른다. */
export function tabTimeoutMs(key: keyof TabSettings["timeouts"]): number {
  return Math.round(getTabSettings().timeouts[key] * 60_000);
}
