import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 탭별 운영 설정 저장소(src/settings/tab-settings.ts) + 소비처 즉시 반영.
 * (예전 탭별 알림 채널 설정 notify 는 2026-11-22 없앴다 — 아래 '제거된 notify' 참고. 2026-11-23 증시·팝업/전시·스킬 랭킹
 *  메일만 되살리면서 <탭>.notifyEmail 로 옮겼고, 예전 notify.<탭>.email 값이 파일에 있으면 그대로 따른다.)
 *
 * ★ 실제 data/ 를 건드리지 않는다. config 는 import 시점에 DB_PATH 와 .env 를 읽으므로 모듈을
 *   불러오기 **전에** 임시 경로와 표식값을 심는다(dotenv 는 이미 있는 env 를 덮지 않는다).
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-tab-settings-"));
process.env.DB_PATH = path.join(tmpDir, "price.db");
process.env.YOUTUBE_FRESH_HOURS = "36"; // 표식값
process.env.STOCK_PULSE_THRESHOLD = "info"; // 깨진 값 폴백이 '덜 보내는 쪽'인지 보려고 가장 느슨한 값
process.env.STOCK_PULSE_DEDUP_HOURS = "24";
process.env.NEWS_TIMEOUT_MS = "900000"; // 15분

const { config } = await import("../config.ts");
const ts = await import("./tab-settings.ts");
const { pulseThreshold, PULSE_CAPS } = await import("../stock/pulse-policy.ts");

const STORE = path.join(tmpDir, "tab-settings.json");

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(STORE, { force: true });
});

const readStore = () => JSON.parse(fs.readFileSync(STORE, "utf8"));

// ── 기본값 = .env ──

test("기본값은 .env(config.ts) 값이다 — 파일이 없으면 settings 와 defaults 가 같다", () => {
  const r = ts.getTabSettingsResponse();
  assert.deepEqual(r.settings, r.defaults);
  assert.equal(r.settings.youtube.freshHours, 36);
  assert.equal(r.settings.stockPulse.threshold, "info");
  assert.equal(r.settings.timeouts.newsMin, 15);
  assert.equal(r.settings.timeouts.youtubeMin, config.youtubeTimeoutMs / 60_000);
  assert.equal(r.settings.stock.historyRetentionDays, config.historyRetentionDays);
  assert.equal(r.settings.events.verifyDates, config.eventsVerifyDates);
  assert.deepEqual(r.settings.stockPulse, config.stockPulse);
  assert.equal(r.numberRules, ts.NUMBER_RULES);
  // 메일·문자 알림 제거: 응답에 알림 채널 정보가 없다.
  assert.equal("notify" in r.settings, false);
  assert.deepEqual(Object.keys(r).sort(), ["defaults", "numberRules", "settings"]);
});

test("모든 숫자 필드에 범위 규칙이 있다(필드를 늘리고 규칙을 빠뜨리면 저장이 불가능해진다)", () => {
  const d = ts.getTabSettingsResponse().defaults as unknown as Record<string, Record<string, unknown>>;
  for (const [section, fields] of Object.entries(d)) {
    for (const [field, v] of Object.entries(fields)) {
      if (typeof v === "number") assert.ok(ts.NUMBER_RULES[`${section}.${field}`], `${section}.${field}`);
    }
  }
});

// ── sparse 저장 / 병합 ──

test("바꾼 필드만 sparse 저장하고, 나머지는 계속 기본값을 따른다", () => {
  const s1 = ts.saveTabSettings({ youtube: { freshHours: 48 } });
  assert.equal(s1.youtube.freshHours, 48);
  assert.equal(s1.youtube.watchedExcludeDays, config.youtubeWatchedExcludeDays);
  assert.deepEqual(readStore(), { youtube: { freshHours: 48 } });

  const s2 = ts.saveTabSettings({ stockPulse: { dedupHours: 12 } });
  assert.equal(s2.youtube.freshHours, 48, "앞서 저장한 값이 유지된다");
  assert.equal(s2.stockPulse.dedupHours, 12);
  assert.deepEqual(readStore(), {
    youtube: { freshHours: 48 },
    stockPulse: { dedupHours: 12 },
  });
});

test("기본값과 같은 값을 보내면 저장분에서 빠져 다시 .env 를 따른다('기본값으로 되돌리기')", () => {
  ts.saveTabSettings({ youtube: { freshHours: 48 }, timeouts: { newsMin: 30 } });
  ts.saveTabSettings({ youtube: { freshHours: 36 } });
  assert.deepEqual(readStore(), { timeouts: { newsMin: 30 } });
  assert.equal(ts.getTabSettings().youtube.freshHours, 36);
  assert.equal(ts.tabTimeoutMs("newsMin"), 30 * 60_000);
});

test(".env 기본값이 규칙 밖·분 환산 비정수여도 기본값은 저장·복원 가능하다(범위로 자르고 반올림)", () => {
  // QA L1: NEWS_TIMEOUT_MS=90000(1.5분)·HISTORY_RETENTION_DAYS=7(규칙 30~3650)이면 기본값 재전송이 400 이었고,
  // 화면은 저장 때 그 탭의 숫자 칸을 모두 보내므로 무관한 스케줄 저장까지 막혔다.
  const saved = { news: config.newsTimeoutMs, retention: config.historyRetentionDays };
  config.newsTimeoutMs = 90_000;
  config.historyRetentionDays = 7;
  try {
    const d = ts.getTabSettingsResponse().defaults;
    assert.equal(d.timeouts.newsMin, 2, "분은 정수로 반올림");
    assert.equal(d.stock.historyRetentionDays, 30, "하한으로 자른다");
    assert.deepEqual(ts.getTabSettings(), d);

    // '기본값으로'(기본값 재전송) → 통과하고 sparse 저장에서 빠진다.
    ts.saveTabSettings({ timeouts: { newsMin: d.timeouts.newsMin }, stock: { historyRetentionDays: 30 } });
    assert.deepEqual(readStore(), {});
    // 화면이 탭 숫자 칸을 통째로 보내는 저장도 통과한다.
    ts.saveTabSettings(d);
    assert.deepEqual(readStore(), {});
    assert.equal(ts.tabTimeoutMs("newsMin"), 2 * 60_000, "소비처도 자른 값을 쓴다");
  } finally {
    config.newsTimeoutMs = saved.news;
    config.historyRetentionDays = saved.retention;
  }
});

// ── 제거된 notify: 기존 저장분은 보존, 새 저장은 거부 ──

test("제거된 notify 섹션이 저장 파일에 남아 있으면 읽을 때 무시하고, 다른 값을 저장해도 지우지 않는다", () => {
  // 사용자의 기존 설정 파일을 기능 제거 때문에 바꾸지 않는다(되돌릴 때 원래 값이 남아 있게).
  fs.writeFileSync(STORE, JSON.stringify({ notify: { news: { imessage: false } }, youtube: { freshHours: 48 } }));
  const s = ts.getTabSettings();
  assert.equal("notify" in s, false);
  assert.equal(s.youtube.freshHours, 48);
  ts.saveTabSettings({ timeouts: { newsMin: 30 } });
  assert.deepEqual(readStore(), {
    notify: { news: { imessage: false } },
    youtube: { freshHours: 48 },
    timeouts: { newsMin: 30 },
  });
});

test("예전 youtube.freshDays(일 단위)는 읽지 않고(기본 24시간 적용) 저장 파일에는 그대로 보존한다(2026-11-23)", () => {
  // 운영 파일 그대로의 모양: { report: …, youtube: { freshDays: 2 } }
  fs.writeFileSync(STORE, JSON.stringify({ report: { notifyEmail: true }, youtube: { freshDays: 2 } }));
  const s = ts.getTabSettings();
  assert.equal(s.youtube.freshHours, 36, "예전 일 단위 값은 시간으로 옮기지 않는다 — 기본값(.env 표식 36)을 쓴다");
  assert.equal("freshDays" in s.youtube, false);
  ts.saveTabSettings({ youtube: { watchedExcludeDays: 5 } });
  assert.deepEqual(readStore(), {
    report: { notifyEmail: true },
    youtube: { freshDays: 2, watchedExcludeDays: 5 },
  }, "같은 섹션의 예전 필드도 지우지 않는다");
  ts.saveTabSettings({ youtube: { freshHours: 24 } });
  assert.deepEqual(readStore().youtube, { freshDays: 2, watchedExcludeDays: 5, freshHours: 24 });
});

test("세 탭 '메일로 받기'는 기본 켜짐이고, 예전 notify.<탭>.email 이 있으면 따른다(파일은 그대로, 2026-11-23)", () => {
  // 파일이 없으면 기본값(PR #2 이전 기본 = 켜짐).
  const d = ts.getTabSettings();
  assert.deepEqual([d.stock.notifyEmail, d.events.notifyEmail, d.skills.notifyEmail], [true, true, true]);
  assert.equal(fs.existsSync(STORE), false, "읽기만으로 파일을 만들지 않는다");

  const legacy = { notify: { stock: { email: false, imessage: true }, skills: { email: true } } };
  fs.writeFileSync(STORE, JSON.stringify(legacy));
  const s = ts.getTabSettings();
  assert.equal(s.stock.notifyEmail, false, "예전 증시 메일 꺼짐을 따른다");
  assert.equal(s.events.notifyEmail, true, "예전 값이 없는 탭은 기본값");
  assert.equal(s.skills.notifyEmail, true);
  assert.deepEqual(readStore(), legacy, "읽기는 파일을 바꾸지 않는다");

  // 대시보드에서 다시 켜면(=기본값과 같아도) 새 필드를 명시 저장해 예전 값보다 우선한다. 예전 섹션은 보존.
  ts.saveTabSettings({ stock: { notifyEmail: true } });
  assert.equal(ts.getTabSettings().stock.notifyEmail, true);
  const after1 = readStore();
  assert.deepEqual(after1.notify, legacy.notify, "예전 notify 섹션은 지우지 않는다");
  assert.equal(after1.stock.notifyEmail, true);

  // 끄기도 그대로 반영.
  ts.saveTabSettings({ events: { notifyEmail: false } });
  assert.equal(ts.getTabSettings().events.notifyEmail, false);
});

test("notify 를 저장하려 하면 '알 수 없는 설정 항목'으로 거부한다", () => {
  assert.throws(() => ts.saveTabSettings({ notify: { news: { imessage: true } } } as never), /알 수 없는 설정 항목: notify/);
});

// ── 깨진 파일: 관대 읽기 ──

test("깨진 JSON·배열·스칼라 파일은 통째로 기본값", () => {
  const def = ts.getTabSettingsResponse().defaults;
  for (const body of ["{not json", "[1,2]", "42", "null"]) {
    fs.writeFileSync(STORE, body);
    assert.deepEqual(ts.getTabSettings(), def, body);
  }
});

test("필드 단위 관대 읽기: 타입 오류→기본값, 범위 밖 숫자→범위로 자름, 깨진 문턱→덜 보내는 쪽", () => {
  fs.writeFileSync(
    STORE,
    JSON.stringify({
      youtube: { freshHours: "abc", watchedExcludeDays: 5 },
      events: { verifyDates: "yes" },
      stockPulse: { quietStartHour: 30, quietEndHour: -3, threshold: "infoo", dailyCap: 7.9 },
      timeouts: { newsMin: 999 },
      unknown: { x: 1 },
    })
  );
  const s = ts.getTabSettings();
  assert.equal(s.youtube.freshHours, 36, "타입 오류 → 기본값");
  assert.equal(s.youtube.watchedExcludeDays, 5, "정상 값은 그대로");
  assert.equal(s.events.verifyDates, config.eventsVerifyDates);
  assert.equal(s.stockPulse.quietStartHour, 23, "0~23 클램프(config.ts clampHour 원칙)");
  assert.equal(s.stockPulse.quietEndHour, 0);
  // 기본값이 info 여도 깨진 값은 important 로 접는다 — info 로 떨어지면 참고 등급까지 문자로 나간다.
  assert.equal(s.stockPulse.threshold, "important");
  assert.equal(s.stockPulse.dailyCap, 7, "정수로 자른다");
  assert.equal(s.timeouts.newsMin, 60, "상한으로 자른다");
});

// ── 엄격 쓰기: 거부 ──

test("범위 밖·정수 아님·타입 오류·알 수 없는 항목은 throw 하고 파일을 바꾸지 않는다", () => {
  ts.saveTabSettings({ youtube: { freshHours: 48 } });
  const before = fs.readFileSync(STORE, "utf8");
  const bad: unknown[] = [
    { youtube: { freshHours: 0 } },
    { youtube: { freshHours: 721 } },
    { youtube: { freshHours: 2.5 } },
    { youtube: { freshHours: "7" } },
    { stockPulse: { quietStartHour: 24 } },
    { stockPulse: { threshold: "high" } },
    { stockPulse: { threshold: "Urgent" } },
    { events: { verifyDates: "true" } },
    { timeouts: { stockPulseMin: 31 } },
    { timeouts: { newsMin: 0 } },
    { stock: { historyRetentionDays: 7 } },
    { notify: { news: { imessage: true } } },
    { youtube: { unknownField: 1 } },
    { secrets: { gmailAddress: "x" } },
    { youtube: 5 },
    JSON.parse('{"__proto__":{"polluted":true}}'),
    JSON.parse('{"youtube":{"__proto__":{"freshHours":1}}}'),
    { constructor: {} },
    [],
  ];
  for (const b of bad) {
    assert.throws(() => ts.saveTabSettings(b as never), Error, JSON.stringify(b));
  }
  assert.equal(fs.readFileSync(STORE, "utf8"), before);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("거부 사유는 한국어 이름과 허용 범위를 담는다", () => {
  assert.throws(() => ts.saveTabSettings({ youtube: { freshHours: 999 } }), /유튜브 최근 영상 기준\(시간\): 1~720시간 사이의 정수/);
  assert.throws(() => ts.saveTabSettings({ stockPulse: { threshold: "x" as never } }), /urgent \/ important \/ info/);
});

// ── 저장 직후 소비처가 새 값을 쓴다 ──

test("펄스 문턱·상한은 저장 직후 다음 호출부터 새 값", () => {
  assert.equal(pulseThreshold(), "info");
  ts.saveTabSettings({ stockPulse: { threshold: "urgent", dailyCap: 3, perSymbolCap: 1, macroCap: 0 } });
  assert.equal(pulseThreshold(), "urgent");
  assert.deepEqual(PULSE_CAPS(), { perSymbolCap: 1, dailyCap: 3, macroCap: 0 });
});
