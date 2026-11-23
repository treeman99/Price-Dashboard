import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { severityRank } from "../../shared/pulse.ts";
import type {
  DeepPartial,
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
 * 숫자 필드 허용 범위(키 = 점 경로). 화면이 응답의 numberRules 로 입력을 제한하고, 서버가 같은 표로
 * 다시 검증한다. 모두 **정수**만 받는다. 범위 근거(각 값의 쓰임새·사고 기록):
 */
export const NUMBER_RULES: Record<string, NumberRule> = {
  // 하한 1시간. 상한 720시간(30일): 시드인 채널 RSS 가 최신 15개만 줘서(src/youtube/channels.ts) 한 달을 넘는 창은 시드가 못 채운다.
  // 기본 24시간(사용자 결정 2026-11-23 "실행 시점 기준 24시간 이내로만").
  "youtube.freshHours": { min: 1, max: 720, unit: "시간" },
  // 하한 1 = config.ts 하한. 상한 30: 신선도 창(최대 30일) 이상 제외하면 그 영상은 이미 신선도에서 탈락해 더 길게 잡을 의미가 없다.
  "youtube.watchedExcludeDays": { min: 1, max: 30, unit: "일" },
  // 하한 1 = config.ts 하한. 상한 60: 등장 원장이 60일 넘게 안 보인 항목을 지운다(new-tracker.ts RETENTION_DAYS) — 그보다 긴 공백은 판정 근거가 없다.
  "events.newGapDays": { min: 1, max: 60, unit: "일" },
  // 하한 1 = config.ts 하한. 상한 30: 배지가 한 달 넘게 붙으면 목록 대부분이 '신규'가 돼 배지가 뜻을 잃는다.
  "events.newShowDays": { min: 1, max: 30, unit: "일" },
  // 0 = 종목 알림 끔(config.ts 하한 0). 상한 10 = 전체 일일 상한 기본값 — 한 종목이 하루 예산을 다 쓰는 데까지만 의미가 있다.
  "stockPulse.perSymbolCap": { min: 0, max: 10, unit: "건" },
  // 0 = 종목 알림 끔. 상한 30 = 인터뷰 확정값(10)의 3배 — 그 이상은 판정 기록이 소음이 된다(문자 발송은 2026-11-22 제거, 판정만 기록).
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
  "report.notifyEmail": "보고서 메일 받기",
  "report.notifyImessage": "보고서 문자 받기",
  "youtube.freshHours": "유튜브 최근 영상 기준(시간)",
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

/**
 * .env(config.ts) 기본값. 타임아웃은 ms → 분. 숫자는 NUMBER_RULES 범위로 자르고 정수로 반올림한다.
 *
 * 왜 자르는가: 기본값은 화면의 '기본값으로'와 sparse 저장(기본값과 같으면 키 삭제)의 기준이라
 * **언제나 저장·복원 가능**해야 한다. 규칙 밖이거나 분 환산이 비정수인 .env 값(NEWS_TIMEOUT_MS=90000
 * → 1.5분, HISTORY_RETENTION_DAYS=7)을 그대로 내보내면 엄격한 쓰기 검증에 걸려 기본값 재전송조차 400 이
 * 되고, 화면은 저장 때 그 탭의 숫자 칸을 모두 검증하므로 무관한 스케줄 저장까지 막혔다(2026-10-25 QA L1).
 * 읽기 경로(lenientLeaf)의 클램프 원칙과 같다. 대가로 그런 .env 값은 잘린 값으로 동작하며(1.5분 → 2분),
 * 기동 시 경고 1줄로 남긴다(warnClampedDefaults).
 *
 * @param clamped 넘기면 잘린 항목을 "키 원값→값" 으로 모은다.
 */
function defaults(clamped?: string[]): TabSettings {
  const min = (ms: number) => ms / 60_000;
  const out: TabSettings = {
    // 보고서 발송은 사용자가 시험 발송을 확인한 뒤 화면에서 켠다 — .env 전역 스위치가 켜져 있어도 기본은 꺼짐.
    report: { notifyEmail: false, notifyImessage: false },
    youtube: {
      freshHours: config.youtubeFreshHours,
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
  const sections = out as unknown as Record<string, Record<string, number>>;
  for (const [key, rule] of Object.entries(NUMBER_RULES)) {
    const [section, field] = key.split(".");
    const raw = sections[section][field];
    const v = Math.min(rule.max, Math.max(rule.min, Math.round(raw)));
    if (v !== raw) {
      sections[section][field] = v;
      clamped?.push(`${key} ${raw}→${v}`);
    }
  }
  return out;
}

/** 기동 시 1회: .env 기본값을 잘라 쓰는 항목이 있으면 경고 1줄(defaults 주석). */
function warnClampedDefaults(): void {
  const clamped: string[] = [];
  defaults(clamped);
  if (clamped.length) {
    log.warn(`운영 설정: .env 기본값이 허용 범위 밖·비정수 → 범위로 맞춰 사용 (${clamped.join(", ")})`);
  }
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
 * (탭별 메일·문자 알림 채널 notify 는 2026-11-22 제거 — 보내면 '알 수 없는 설정 항목'이다. 발송은 report 섹션만.)
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

    const target = nextSections[section];
    for (const [field, v] of Object.entries(value)) {
      if (!Object.hasOwn(target, field)) throw new Error(`알 수 없는 설정 항목: ${section}.${field}`);
      target[field] = strictLeaf(`${section}.${field}`, target[field], v);
    }
  }

  writeStored(mergeLegacy(readStored(), next, diffFromDefaults(next, def)));
  return getTabSettings();
}

/**
 * 저장 파일에 남은 '지금 스키마에 없는 값'(섹션 통째 또는 알려진 섹션 안의 예전 필드 — 예: youtube.freshDays)을
 * 새로 쓰는 값 옆에 그대로 남긴다. 기능을 바꿨다고 사용자의 기존 값을 저장 한 번에 날리지 않는다(되돌릴 근거).
 */
function mergeLegacy(stored: Record<string, unknown>, known: TabSettings, diff: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...legacySections(stored, known) };
  const k = known as unknown as Record<string, Record<string, unknown>>;
  for (const [section, raw] of Object.entries(stored)) {
    if (!Object.hasOwn(k, section) || !isPlainObject(raw)) continue;
    const legacy = Object.fromEntries(Object.entries(raw).filter(([f]) => !Object.hasOwn(k[section], f)));
    if (Object.keys(legacy).length) out[section] = legacy;
  }
  for (const [section, v] of Object.entries(diff)) {
    out[section] = { ...(out[section] as Record<string, unknown> | undefined), ...(v as Record<string, unknown>) };
  }
  return out;
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
      if (v !== dv) diff[field] = v;
    }
    if (Object.keys(diff).length) out[section] = diff;
  }
  return out;
}

/**
 * 지금 스키마에 없는 저장 섹션(예: 제거된 notify)은 **그대로 보존**한다. 기능을 지웠다고 사용자의
 * 기존 설정 파일 내용을 저장 한 번에 날리지 않는다(되돌릴 때 원래 값이 남아 있게).
 */
function legacySections(stored: Record<string, unknown>, known: TabSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored)) if (!Object.hasOwn(known, k)) out[k] = v;
  return out;
}

/** tmp → rename 으로 원자적으로 쓴다(중간에 죽어도 반쪽짜리 JSON 이 남지 않게). */
function writeStored(stored: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), "utf8");
  fs.renameSync(tmp, STORE_PATH);
}

/** GET/PUT /api/settings 응답. */
export function getTabSettingsResponse(): TabSettingsResponse {
  return {
    settings: getTabSettings(),
    defaults: defaults(),
    numberRules: NUMBER_RULES,
  };
}

/** 탭 타임아웃(분) → ms. 소비처가 호출 시점에 부른다. */
export function tabTimeoutMs(key: keyof TabSettings["timeouts"]): number {
  return Math.round(getTabSettings().timeouts[key] * 60_000);
}

warnClampedDefaults();
