// 실행(루트에서): npx tsx --test "web/src/**/*.test.ts"
// web 에는 node 타입(@types/node)이 없어 web/tsconfig.json 이 *.test.ts 를 뺀다. tsx 는 타입을 지우고
// 실행만 하므로, 고정 값(settingsFixture)은 `as never` 로 넘기고 값만 검사한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MANUAL_RUN_LABEL,
  TAB_CONFIG,
  buildSchedulePatch,
  buildSettingsPatch,
  formatWhen,
  getAtPath,
  mondayOf,
  parseNumberField,
  sameValue,
  setAtPath,
  weekDays,
  ymd,
} from "./tabConfig.ts";

/** 계약(shared/types.ts TabSettings) 모양 그대로의 고정 값. */
function settingsFixture() {
  return {
    notify: {
      events: { email: true, imessage: true },
      news: { email: true, imessage: true },
      youtube: { email: true, imessage: true },
      stock: { email: true, imessage: true },
      stockPulse: { email: false, imessage: true },
      skills: { email: true, imessage: true },
      uptime: { email: false, imessage: true },
    },
    youtube: { freshDays: 7, watchedExcludeDays: 7 },
    events: { newGapDays: 7, newShowDays: 3, verifyDates: true },
    stockPulse: {
      perSymbolCap: 3,
      dailyCap: 10,
      macroCap: 2,
      dedupHours: 24,
      threshold: "important",
      quietStartHour: 23,
      quietEndHour: 7,
    },
    stock: { historyRetentionDays: 90 },
    timeouts: {
      newsMin: 20,
      youtubeMin: 20,
      eventsMin: 20,
      stockBriefMin: 15,
      stockPulseMin: 10,
      skillsSummaryMin: 5,
      skillsBudgetMin: 20,
    },
  } as const;
}

test("TAB_CONFIG 의 모든 필드 경로가 TabSettings 에 실제로 있다(오타 방지)", () => {
  const s = settingsFixture();
  for (const [tab, def] of Object.entries(TAB_CONFIG)) {
    for (const f of def.fields) {
      assert.notEqual(getAtPath(s, f.path), undefined, `${tab}: ${f.path}`);
    }
    if (def.notify) assert.ok(getAtPath(s, `notify.${def.notify}`), `${tab}: notify.${def.notify}`);
  }
});

test("탭 ↔ 잡 매핑: 증시는 시장별 브리핑 2개, 로또는 운영 설정·알림 없음", () => {
  assert.deepEqual(TAB_CONFIG.stock.jobs, ["stockKr", "stockUs"]);
  assert.deepEqual(TAB_CONFIG.holdings.jobs, ["stockPulse"]);
  assert.equal(TAB_CONFIG.lotto.notify, null);
  assert.equal(TAB_CONFIG.lotto.fields.length, 0);
  // 8개 잡이 빠짐없이 어느 한 탭에 속한다.
  const all = Object.values(TAB_CONFIG).flatMap((d) => d.jobs).sort();
  assert.deepEqual(all, ["events", "lotto", "news", "skills", "stockKr", "stockPulse", "stockUs", "youtube"]);
});

test("MANUAL_RUN_LABEL: 스케줄 '꺼짐' 안내의 수동 실행 문구는 화면 버튼이 실제로 있는 잡에만", () => {
  // QA L2: 로또에는 화면 수동 실행이 없는데 "'지금 갱신'은 그대로 됩니다"가 떴다.
  // 스킬 랭킹은 2026-10-25 '지금 갱신'이 생겼다(회차가 기록돼 있으면 중간 점검).
  assert.equal(MANUAL_RUN_LABEL.lotto, undefined);
  assert.equal(MANUAL_RUN_LABEL.stockPulse, "지금 실행", "보유 주식 탭 버튼 문구");
  for (const id of ["events", "news", "youtube", "stockKr", "stockUs", "skills"] as const) {
    assert.equal(MANUAL_RUN_LABEL[id], "지금 갱신", id);
  }
});

test("setAtPath 는 원본을 바꾸지 않고 중간 객체를 만든다", () => {
  const src = { a: { b: 1, c: 2 } };
  const out = setAtPath(src, "a.b", 5);
  assert.deepEqual(src, { a: { b: 1, c: 2 } });
  assert.deepEqual(out, { a: { b: 5, c: 2 } });
  assert.deepEqual(setAtPath({}, "x.y.z", true), { x: { y: { z: true } } });
});

test("buildSettingsPatch: 바꾼 필드만 DeepPartial 로, 없으면 null", () => {
  const orig = settingsFixture();
  const def = TAB_CONFIG.holdings;
  assert.equal(buildSettingsPatch(orig as never, orig as never, def, ["imessage"]), null);

  let draft = setAtPath(orig, "stockPulse.dailyCap", 12);
  draft = setAtPath(draft, "stockPulse.threshold", "urgent");
  draft = setAtPath(draft, "notify.stockPulse.imessage", false);
  assert.deepEqual(buildSettingsPatch(orig as never, draft as never, def, ["imessage"]), {
    stockPulse: { dailyCap: 12, threshold: "urgent" },
    notify: { stockPulse: { imessage: false } },
  });
});

test("buildSettingsPatch: 그 탭에 없는 채널·다른 탭 필드는 본문에 넣지 않는다", () => {
  const orig = settingsFixture();
  let draft = setAtPath(orig, "notify.stockPulse.email", true); // 펄스엔 이메일 채널이 없다
  draft = setAtPath(draft, "timeouts.newsMin", 30); // 뉴스 탭 필드
  assert.equal(buildSettingsPatch(orig as never, draft as never, TAB_CONFIG.holdings, ["imessage"]), null);
});

test("buildSchedulePatch: 바뀐 잡만, 키 순서는 무시", () => {
  const job = { enabled: true, repeat: { kind: "daily" }, times: ["08:00"] };
  const orig = { news: job, events: job } as never;
  // 같은 값(키 순서만 다름) → 변경 없음
  assert.equal(
    buildSchedulePatch(orig, { news: { times: ["08:00"], repeat: { kind: "daily" }, enabled: true } } as never),
    null
  );
  const weekly = { enabled: true, repeat: { kind: "weekly", days: [1, 2, 3, 4, 5], intervalWeeks: 1 }, times: ["08:00", "17:00"] };
  assert.deepEqual(buildSchedulePatch(orig, { news: weekly, events: job } as never), { news: weekly });
});

test("sameValue: undefined 키는 없는 것과 같다", () => {
  assert.ok(sameValue({ a: 1, b: undefined }, { a: 1 }));
  assert.ok(!sameValue([1, 2], [2, 1]));
});

test("parseNumberField: 빈 값·범위 밖·소수는 사유, 정상은 숫자", () => {
  const rule = { min: 1, max: 30, unit: "일" };
  assert.deepEqual(parseNumberField(" 7 ", "최근 영상", rule), { ok: true, value: 7 });
  assert.deepEqual(parseNumberField("", "최근 영상", rule), { ok: false, error: "최근 영상: 숫자를 입력하세요." });
  assert.deepEqual(parseNumberField("31", "최근 영상", rule), {
    ok: false,
    error: "최근 영상: 1~30일 사이의 정수로 입력하세요.",
  });
  assert.equal(parseNumberField("1.5", "최근 영상", rule).ok, false);
  assert.deepEqual(parseNumberField("0", "상한", { min: 0, max: 10, unit: "건" }), { ok: true, value: 0 });
});

test("mondayOf / weekDays: 주는 월요일에 시작한다(일요일은 그 주의 마지막 날)", () => {
  const sun = new Date(2026, 9, 25, 18, 0); // 2026-10-25 일요일
  assert.equal(ymd(mondayOf(sun, 0)), "2026-10-19");
  assert.equal(ymd(mondayOf(sun, 1)), "2026-10-26");
  const mon = new Date(2026, 9, 26, 0, 0);
  assert.equal(ymd(mondayOf(mon, 0)), "2026-10-26");
  const days = weekDays(sun, 0).map(ymd);
  assert.equal(days.length, 7);
  assert.equal(days[0], "2026-10-19");
  assert.equal(days[6], "2026-10-25");
  // 월말을 넘는 주
  assert.equal(ymd(mondayOf(new Date(2026, 10, 1), 0)), "2026-10-26");
});

test("formatWhen: 오늘·내일은 말로, 그 밖은 날짜(요일), 해가 바뀌면 연도", () => {
  const now = new Date(2026, 9, 25, 18, 30);
  assert.equal(formatWhen(new Date(2026, 9, 25, 21, 0), now), "오늘 21:00");
  assert.equal(formatWhen(new Date(2026, 9, 26, 8, 0), now), "내일 08:00");
  assert.equal(formatWhen(new Date(2026, 9, 28, 9, 5), now), "10/28(수) 09:05");
  assert.equal(formatWhen(new Date(2027, 0, 1, 9, 0), now), "2027. 1/1(금) 09:00");
});
