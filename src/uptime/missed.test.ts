/**
 * `describeMissedSlots()` 회귀 테스트 — 명세 §10.2.
 *
 * ## 이 파일이 지키는 것
 * 사후 보고의 severity(사고/기록만/무시)는 **오직** 이 함수가 돌려주는 `evaluated:true` 건수로
 * 정해진다. 그래서 여기서 나는 오차는 곧바로 "안 놓친 걸 놓쳤다고 문자 보내기" 또는
 * "놓쳤는데 조용히 넘어가기"가 된다. 초안 설계가 실제로 저지른 오보 —
 *   "2026-08-02(일요일) 08:00 증시(한국장) 못 돌았습니다"  ← 그날 한국장은 휴장이었다
 * 를 1번 테스트가 못박는다.
 *
 * ## ★ 실제 data/ 를 건드리지 않는 방법
 * 이 모듈의 의존성(스냅샷·원장·휴장 원장)은 전부 `path.dirname(config.dbPath)` 아래를 읽는다.
 * `config.ts` 는 **import 시점에** `process.env.DB_PATH` 를 한 번 읽으므로, 정적 import 로는
 * 늦다(ESM 은 import 를 최상단 문장보다 먼저 평가한다). 그래서 아래처럼
 *   1) 임시 디렉터리를 만들고 `DB_PATH` 를 거기로 돌린 뒤
 *   2) `await import()` 로 대상 모듈을 **그때** 로드한다.
 * 이 순서를 뒤집으면 테스트가 사용자의 진짜 `data/price.db` 를 연다.
 *
 * ## 어디까지 진짜를 쓰는가
 * 스텁으로 덮으면 "내가 만든 가짜가 내 기대대로 동작한다"만 검증하게 된다. 그래서 이 기능의
 * 신뢰도를 실제로 결정하는 두 술어는 **진짜 구현을 통과시킨다**:
 *   · `isMarketClosed`  (1·2·3·6번) — 주말·공휴일 판정 자체가 검증 대상이다
 *   · `newsCoveredAt`   (4번)       — `source:"empty"` 를 커버로 치지 않는다는 계약
 * 나머지(스냅샷 유무·증시 원장·로또 상태)는 각자 자기 모듈의 테스트가 이미 못박고 있고,
 * 여기서 검증할 것은 "그 술어를 올바른 인자로 부르고 결과를 올바르게 해석하는가"다.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { countEvaluatedMissed, severityFor, type MissedSlot } from "../../shared/uptime.ts";
import type { MissedSlotDeps } from "./missed.ts"; // 타입 전용 import 는 런타임에 지워진다
import type { ScheduleSettings } from "../../shared/types.ts";

// ── ★ 반드시 대상 모듈 로드 **전에** ─────────────────────────────────────────
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-missed-"));
process.env.DB_PATH = path.join(TMP_DIR, "price.db");

// 4번 테스트용 뉴스 스냅샷을 미리 깔아 둔다. `getNewsSnapshot()` 은 첫 호출에서 디스크를
// 읽어 메모리에 캐시하므로, 모듈 로드 전에 파일이 있어야 한다.
const REAL_TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();
fs.writeFileSync(
  path.join(TMP_DIR, "news-latest.json"),
  JSON.stringify({
    date: REAL_TODAY,
    // ★ 계약의 핵심: LLM 큐레이션이 실패하면 뉴스는 이 폴백을 오늘 날짜로 저장한다.
    //   날짜만 보는 게이트는 이걸 '성공'으로 오인해 그날 뉴스를 통째로 포기했다.
    source: "empty",
    updatedAt: `${REAL_TODAY}T23:59:00.000Z`,
    items: [],
  })
);

const { describeMissedSlots, MAX_SCAN_DAYS } = await import("./missed.ts");

// ── 공용 픽스처 ─────────────────────────────────────────────────────────────

/** 실측 사고일. 2026-08-02 는 **일요일**이다(한국장·미국장 모두 휴장). */
const SUNDAY = "2026-08-02";
/** 평일 대조군. 2026-08-05 는 수요일이고 한국 공휴일이 아니다(광복절은 8/15). */
const WEDNESDAY = "2026-08-05";

const FULL_SCHEDULE: ScheduleSettings = {
  events: ["10:00"],
  news: ["08:00"],
  youtube: ["09:00"],
  stockKr: ["08:00"],
  stockUs: ["17:00"],
  // 펄스 시각은 다른 탭과 절대 겹치지 않게 둔다 — 5번 테스트가 "결과가 비어 있음"으로
  // 영구 제외를 증명할 수 있어야 하기 때문이다.
  stockPulse: ["13:00", "14:00", "15:00", "16:00"],
};

/** `YYYY-MM-DD` + `HH:mm` → 로컬 Date. */
function at(day: string, hhmm: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return new Date(y, m - 1, d, h, mi, 0, 0);
}

/**
 * 기본 스텁 묶음. **오늘**을 인자로 고정해 실행 요일에 따라 결과가 흔들리지 않게 한다
 * (이 테스트가 일요일에만 통과하거나 평일에만 통과하면 아무것도 지키지 못한다).
 *
 * 기본값은 전부 "커버되지 않음" = 손실이 최대로 잡히는 상태다. 각 테스트는 여기서 **빼는**
 * 조건만 추가한다 — 그래야 "왜 안 나왔는가"의 원인이 하나로 좁혀진다.
 */
function baseDeps(today: string, over: Partial<MissedSlotDeps> = {}): Partial<MissedSlotDeps> {
  return {
    now: () => at(today, "23:30"),
    schedule: () => FULL_SCHEDULE,
    pastTime: () => true,
    scheduledToday: (hhmm: string) => at(today, hhmm),
    eventsCoveredToday: () => false,
    newsCoveredAt: () => false,
    youtubeCoveredAt: () => false,
    hasStockSnapshotForSlot: () => false,
    slotHandled: () => false,
    lottoLastCycleAt: () => null,
    // isMarketClosed 는 **일부러 비워 둔다** — 진짜 구현이 들어간다.
    ...over,
  };
}

const tabsOf = (r: MissedSlot[]) => r.map((m) => m.tab);
const only = (r: MissedSlot[], tab: string) => r.filter((m) => m.tab === tab);

// ────────────────────────────────────────────────────────────────────────────
// 1. ★ 휴장일 회귀 방지 — 초안 설계가 실제로 낸 오보
// ────────────────────────────────────────────────────────────────────────────

test("일요일 공백에 한국장 08:00 이 들어 있어도 손실로 보고하지 않는다", async () => {
  // 2026-08-02 00:29 ~ 11:15 = 실측 사고 구간 그대로.
  const r = await describeMissedSlots(
    at(SUNDAY, "00:29"),
    at(SUNDAY, "11:15"),
    // isMarketClosed 는 넘기지 않는다 → 진짜 구현이 주말을 걸러야 한다.
    // 로또는 그 주 사이클이 이미 돈 상태로 둔다(6번이 따로 검증한다).
    baseDeps(SUNDAY, { lottoLastCycleAt: () => at(SUNDAY, "10:03").toISOString() })
  );

  assert.equal(only(r, "stockKr").length, 0, "일요일 한국장은 휴장이라 손실이 될 수 없다");
  assert.equal(only(r, "stockUs").length, 0, "미국장도 같다");
  // 대조군: 같은 구간의 뉴스·유튜브·팝업은 정상적으로 손실로 잡혀야 한다.
  // (이게 없으면 "전부 걸러져서 0건"인 상태와 구분되지 않는다.)
  assert.deepEqual(tabsOf(r), ["news", "youtube", "events"]);
  assert.ok(r.every((m) => m.evaluated), "오늘 날짜 슬롯은 전부 검증된 상태여야 한다");
});

// ────────────────────────────────────────────────────────────────────────────
// 2·3. 평일 증시 — 미커버는 잡고, 원장이 닫혀 있으면 안 잡는다
// ────────────────────────────────────────────────────────────────────────────

test("평일 한국장 슬롯이 미커버 + 원장 미기록이면 손실 1건", async () => {
  const r = await describeMissedSlots(
    at(WEDNESDAY, "07:00"),
    at(WEDNESDAY, "09:00"),
    baseDeps(WEDNESDAY)
  );

  const kr = only(r, "stockKr");
  assert.equal(kr.length, 1);
  assert.equal(kr[0].slot, "08:00");
  assert.equal(kr[0].date, WEDNESDAY);
  assert.equal(kr[0].label, "증시(한국장)");
  assert.equal(kr[0].evaluated, true);
  assert.equal(kr[0].note, null);
  // store.ts 와의 계약: 이 함수는 복구 여부를 판단하지 않는다(§8.5).
  assert.equal(kr[0].recovered, false);
  assert.equal(kr[0].recoveredAt, null);
  // 오프셋이 붙은 로컬 ISO 여야 한다. UTC(`Z`)면 사용자가 날짜를 하루 잘못 읽는다.
  assert.match(kr[0].scheduledAt, /^2026-08-05T08:00:00[+-]\d{2}:\d{2}$/);
});

test("평일 한국장 슬롯이 원장에 닫혀 있으면 손실이 아니다", async () => {
  const r = await describeMissedSlots(
    at(WEDNESDAY, "07:00"),
    at(WEDNESDAY, "09:00"),
    baseDeps(WEDNESDAY, {
      // 휴장 런·정상 런 모두 이 플래그로 슬롯을 닫는다(notify-ledger SLOT_HANDLED).
      slotHandled: (_date, market, slot) => market === "kr" && slot === "08:00",
    })
  );
  assert.equal(only(r, "stockKr").length, 0);
});

test("평일 한국장 슬롯 스냅샷이 이미 있으면 손실이 아니다", async () => {
  const r = await describeMissedSlots(
    at(WEDNESDAY, "07:00"),
    at(WEDNESDAY, "09:00"),
    baseDeps(WEDNESDAY, {
      hasStockSnapshotForSlot: (market, _date, slot) => market === "kr" && slot === "08:00",
    })
  );
  assert.equal(only(r, "stockKr").length, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// 4. 뉴스 커버 계약 — `source:"empty"` 는 커버가 아니다 (진짜 술어를 통과시킨다)
// ────────────────────────────────────────────────────────────────────────────

test("뉴스: 빈 스냅샷(source=empty)은 커버로 치지 않는다", async () => {
  // ★ `newsCoveredAt` 을 스텁하지 않는다. 이 계약이 깨지면(예: 날짜만 보는 게이트로 회귀)
  //   LLM 이 실패한 날의 손실이 통째로 사라져 사후 보고가 "아무 문제 없었습니다"가 된다.
  //   진짜 술어는 실제 '오늘'을 보므로, 이 테스트만 REAL_TODAY 로 돈다.
  const r = await describeMissedSlots(
    at(REAL_TODAY, "07:00"),
    at(REAL_TODAY, "09:00"),
    baseDeps(REAL_TODAY, {
      schedule: () => ({ ...FULL_SCHEDULE, stockKr: [], stockUs: [] }),
      newsCoveredAt: undefined, // 진짜 구현 사용
    })
  );

  const news = only(r, "news");
  assert.equal(news.length, 1, "빈 스냅샷은 커버가 아니므로 08:00 뉴스는 손실이다");
  assert.equal(news[0].evaluated, true);
});

test("뉴스: 커버된 슬롯은 목록에서 사라진다(= store 가 복구로 읽는 신호)", async () => {
  const r = await describeMissedSlots(
    at(WEDNESDAY, "07:00"),
    at(WEDNESDAY, "09:00"),
    baseDeps(WEDNESDAY, { newsCoveredAt: () => true })
  );
  assert.equal(only(r, "news").length, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// 5. ★ 증시 펄스 영구 제외
// ────────────────────────────────────────────────────────────────────────────

test("증시 펄스 시각이 공백 한복판에 있어도 결과에 절대 없다", async () => {
  // 12:30~16:30 안에는 펄스 4개(13·14·15·16시)만 들어 있고 다른 탭 슬롯은 없다.
  // 따라서 결과가 비어 있어야만 "펄스를 세지 않았다"가 증명된다.
  const r = await describeMissedSlots(
    at(WEDNESDAY, "12:30"),
    at(WEDNESDAY, "16:30"),
    baseDeps(WEDNESDAY)
  );
  assert.deepEqual(r, [], `펄스에는 catch-up 이 없다 — 보고하면 절전 1시간마다 4건씩 거짓 손실`);
});

// ────────────────────────────────────────────────────────────────────────────
// 6. 로또 — 주 1회, 요일이 맞아야 후보가 생긴다
// ────────────────────────────────────────────────────────────────────────────

test("로또: 일요일 10:00 이 공백에 있고 lastCycleAt 이 과거면 손실 1건", async () => {
  const r = await describeMissedSlots(
    at(SUNDAY, "09:30"),
    at(SUNDAY, "11:00"),
    baseDeps(SUNDAY, { lottoLastCycleAt: () => at("2026-07-26", "10:05").toISOString() })
  );
  const lotto = only(r, "lotto");
  assert.equal(lotto.length, 1);
  assert.equal(lotto[0].slot, "일요일 10:00");
  assert.equal(lotto[0].label, "로또");
  assert.equal(lotto[0].evaluated, true);
});

test("로또: 그 주 사이클이 이미 돌았으면 손실이 아니다", async () => {
  const r = await describeMissedSlots(
    at(SUNDAY, "09:30"),
    at(SUNDAY, "11:00"),
    baseDeps(SUNDAY, { lottoLastCycleAt: () => at(SUNDAY, "10:03").toISOString() })
  );
  assert.equal(only(r, "lotto").length, 0);
});

test("로또: 수요일 공백에는 후보 자체가 없다", async () => {
  const r = await describeMissedSlots(
    at(WEDNESDAY, "09:30"),
    at(WEDNESDAY, "11:00"),
    baseDeps(WEDNESDAY) // lastCycleAt = null 이라 '안 돌았음'이 최대인 상태인데도
  );
  assert.equal(only(r, "lotto").length, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// 7. 자정을 넘는 공백 (§8.4)
// ────────────────────────────────────────────────────────────────────────────

test("자정을 넘는 공백: 어제 슬롯은 evaluated:false + 안내 문구, severity 계산에서 빠진다", async () => {
  const r = await describeMissedSlots(
    at("2026-08-04", "22:00"),
    at(WEDNESDAY, "09:00"),
    baseDeps(WEDNESDAY, {
      // 어제 23:00 과 오늘 08:00, 두 슬롯만 남긴다.
      schedule: () => ({
        events: [],
        news: ["08:00", "23:00"],
        youtube: [],
        stockKr: [],
        stockUs: [],
        stockPulse: [],
      }),
    })
  );

  assert.equal(r.length, 2);
  // 예정 시각 오름차순이어야 한다(일지에 시간 역순으로 찍히면 사용자가 사건을 오독한다).
  assert.equal(r[0].date, "2026-08-04");
  assert.equal(r[0].slot, "23:00");
  assert.equal(r[0].evaluated, false, "어제 커버 여부는 검증할 수 없다");
  assert.equal(r[0].note, "지난 날짜라 보충 대상이 아닙니다");

  assert.equal(r[1].date, WEDNESDAY);
  assert.equal(r[1].slot, "08:00");
  assert.equal(r[1].evaluated, true);
  assert.equal(r[1].note, null);

  // ★ severity 는 검증된 건수만 센다 — 검증 못 한 것으로 등급을 올리지 않는다.
  assert.equal(countEvaluatedMissed(r), 1);
  assert.equal(severityFor("sleep", 11 * 60 * 60 * 1000, r), "사고");
  // 검증된 항목이 하나도 없으면 '사고'로 올라가지 않는다(6시간 이상이라 '기록만').
  assert.equal(severityFor("sleep", 11 * 60 * 60 * 1000, [r[0]]), "기록만");
});

test("자정을 넘는 공백: 어제 증시 슬롯도 원장이 닫혀 있으면 지운다", async () => {
  // 과거 날짜라 `evaluated` 는 올릴 수 없지만, 증시 알림 원장은 **날짜별 행**이라 과거도
  // 정확히 답한다. "확실히 돌았다"가 증명되는 항목까지 나열하면 그건 그냥 거짓 손실이다.
  const gapStart = at("2026-08-04", "07:00"); // 2026-08-04 는 화요일(개장)
  const gapEnd = at(WEDNESDAY, "07:00");
  const schedule = () => ({
    events: [],
    news: [],
    youtube: [],
    stockKr: ["08:00"],
    stockUs: [],
    stockPulse: [],
  });

  const before = await describeMissedSlots(gapStart, gapEnd, baseDeps(WEDNESDAY, { schedule }));
  assert.equal(before.length, 1, "8/4(화) 08:00 한국장 슬롯이 공백 안에 있다");
  assert.equal(before[0].evaluated, false);

  const after = await describeMissedSlots(
    gapStart,
    gapEnd,
    baseDeps(WEDNESDAY, { schedule, slotHandled: (date) => date === "2026-08-04" })
  );
  assert.deepEqual(after, []);
});

// ────────────────────────────────────────────────────────────────────────────
// 8. 방어선 — 명세에 없지만 이 기능이 서비스를 망가뜨리지 않게 하는 것들
// ────────────────────────────────────────────────────────────────────────────

test("비컨이 깨져 공백이 수십 년으로 읽혀도 나열이 폭주하지 않는다", async () => {
  // `uptime-beacon.json` 이 손상돼 atMs=0 으로 읽히는 경우. 상한이 없으면 1970년부터
  // 오늘까지 ≈2만 일 × 8슬롯 = 16만 건이 사건 원장 JSON 에 들어간다.
  const r = await describeMissedSlots(new Date(0), at(WEDNESDAY, "23:00"), baseDeps(WEDNESDAY));
  const days = new Set(r.map((m) => m.date));
  assert.ok(days.size <= MAX_SCAN_DAYS, `훑은 날짜 ${days.size}일 ≤ ${MAX_SCAN_DAYS}일`);
  // 잘라낸 쪽은 전부 과거 날짜라 severity 에는 영향이 없어야 한다.
  assert.ok(countEvaluatedMissed(r) <= 8);
});

test("잘못된 구간(끝 ≤ 시작, NaN)은 조용히 빈 목록", async () => {
  assert.deepEqual(await describeMissedSlots(at(WEDNESDAY, "09:00"), at(WEDNESDAY, "08:00")), []);
  assert.deepEqual(await describeMissedSlots(new Date(NaN), new Date(NaN)), []);
});

test("의존 술어가 던져도 throw 하지 않는다", async () => {
  // 이 기능은 절대 서비스를 망가뜨리면 안 된다. 사후 보고가 실패하는 것보다 나쁜 것은
  // 사후 보고 때문에 기동이 막히는 것이다.
  const r = await describeMissedSlots(
    at(WEDNESDAY, "07:00"),
    at(WEDNESDAY, "09:00"),
    baseDeps(WEDNESDAY, {
      schedule: () => {
        throw new Error("일부러 터뜨림");
      },
    })
  );
  assert.deepEqual(r, []);
});

test("휴장 판정이 실패하면 휴장으로 접어 거짓 손실을 만들지 않는다", async () => {
  const r = await describeMissedSlots(
    at(WEDNESDAY, "07:00"),
    at(WEDNESDAY, "09:00"),
    baseDeps(WEDNESDAY, {
      isMarketClosed: async () => {
        throw new Error("원장 읽기 실패");
      },
    })
  );
  assert.equal(only(r, "stockKr").length, 0, "모를 때는 조용한 편이 낫다(fail-open)");
  assert.equal(only(r, "news").length, 1, "다른 탭 판정까지 죽으면 안 된다");
});

test("시계가 뒤로 점프해 gapEnd 가 미래여도 아직 오지 않은 슬롯을 손실로 세지 않는다", async () => {
  // clockSuspect(§4.5) 상황. `pastTime` 이 마지막 방어선이다.
  const r = await describeMissedSlots(
    at(WEDNESDAY, "07:00"),
    at(WEDNESDAY, "23:00"),
    baseDeps(WEDNESDAY, {
      schedule: () => ({ ...FULL_SCHEDULE, stockKr: [], stockUs: [] }),
      // 아직 08:30 이다 → 09:00 유튜브·10:00 팝업은 아직 오지 않았다.
      pastTime: (hhmm) => hhmm < "08:30",
    })
  );
  assert.deepEqual(tabsOf(r), ["news"]);
});


// 테스트가 만든 임시 디렉터리를 지운다. 없으면 npm test 를 돌릴 때마다
// os.tmpdir() 에 uptime-* 디렉터리가 쌓인다(2026-08-02 검증에서 24개 관측).
after(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});
