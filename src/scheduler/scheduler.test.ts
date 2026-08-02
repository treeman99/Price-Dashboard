import { test } from "node:test";
import assert from "node:assert/strict";
import { __setCaffeinateSpawnerForTest } from "../util/power.ts";
import { __testing } from "./scheduler.ts";

const {
  withLlmSlot,
  runLlmJob,
  createBackoff,
  backoffWaitMs,
  decideCatchup,
  shouldNoteBackoff,
  sleepGapMessage,
  formatDuration,
  attemptSucceededSince,
  CATCHUP_BACKOFF_BASE_MS,
  CATCHUP_BACKOFF_MAX_MS,
  LLM_QUEUE_WAIT_SCHEDULED_MS,
  LLM_QUEUE_WAIT_CATCHUP_MS,
} = __testing;

// 슬롯 획득이 전원 어서션(caffeinate)까지 함께 잡게 되면서, 테스트가 실제 caffeinate 프로세스를
// 띄우게 됐다. 가짜 스포너를 심어 그 부작용을 끊는다(어서션 자체는 power.test.ts 가 검증한다).
__setCaffeinateSpawnerForTest(
  () => ({ once: () => {}, unref: () => {}, kill: () => {} }) as never
);

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ── LLM 전역 세마포어 ─────────────────────────────────────────────────
//
// 2026-08-02 사고의 재발 방지선. 여기서 못박는 건 "겹치지 않는다" 하나뿐이지만, 그게 전부다 —
// 겹침은 로그에 실패로 남지 않고 '다들 조금씩 느려짐'으로만 나타나 사후 규명이 극도로 어렵다.

test("세마포어 — LLM 작업은 겹치지 않는다", async () => {
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];

  const job = (label: string, ms: number) =>
    withLlmSlot(label, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick(ms);
      order.push(label);
      active -= 1;
    });

  // 사고 재현: 세 탭이 같은 순간에 출발한다.
  await Promise.all([job("뉴스", 30), job("유튜브", 5), job("이벤트", 5)]);

  assert.equal(maxActive, 1, "동시에 도는 LLM 작업은 항상 1개여야 한다");
  // 큐는 FIFO 다. 유튜브가 6배 빨라도 뉴스를 앞지르지 못한다.
  assert.deepEqual(order, ["뉴스", "유튜브", "이벤트"]);
});

test("세마포어 — 작업이 실패해도 큐가 막히지 않는다", async () => {
  // 큐 해제를 finally 가 아닌 성공 경로에 두면, 실패 한 번으로 스케줄러의 모든 LLM 작업이
  // 영구히 멈춘다(재시작 전까지 복구 불가). 조용한 전면 정지라 반드시 못박는다.
  const boom = withLlmSlot("실패", async () => {
    throw new Error("의도된 실패");
  });
  await assert.rejects(boom, /의도된 실패/);

  let ran = false;
  await withLlmSlot("다음", async () => {
    ran = true;
  });
  assert.equal(ran, true, "앞 작업이 던져도 다음 작업은 슬롯을 얻어야 한다");
});

test("세마포어 — 재진입은 교착 대신 통과시킨다", async () => {
  // catchUpWeeklyCycle → runWeeklyCycle 처럼 안쪽에서 또 슬롯을 잡는 경로가 생기면
  // 자기 자신의 완료를 기다리는 교착이 된다. 통과시키고 경고만 남기는 쪽을 택했다.
  let inner = false;
  const done = await Promise.race([
    withLlmSlot("바깥", async () => {
      await withLlmSlot("안쪽", async () => {
        inner = true;
      });
      return "완료";
    }),
    tick(2000).then(() => "교착"),
  ]);
  assert.equal(done, "완료");
  assert.equal(inner, true);
});

test("세마포어 — 슬롯이 비어 있으면 즉시 실행된다", async () => {
  const started = Date.now();
  await withLlmSlot("단독", async () => {});
  assert.ok(Date.now() - started < 1000, "빈 큐에서 눈에 띄는 지연이 있으면 안 된다");
});

// ── 큐 대기 상한 ──────────────────────────────────────────────────────
//
// 직렬화의 두 번째 사고: 대기에 상한이 없으면 "느린 작업 1건"이 "스케줄러 전체 동결"이 된다.
// 08:30 누락 점검 스윕이 앞선 정시 런 뒤에 무한정 줄을 서서, 30분 틱이 6회 연속 스킵됐다.

test("큐 상한 — 앞 작업이 길면 이번 차례를 포기한다", async () => {
  let release!: () => void;
  const blocker = withLlmSlot("점유", () => new Promise<void>((r) => (release = r)));
  await tick(10); // 점유자가 슬롯을 실제로 쥐게 한다

  let ran = false;
  const started = Date.now();
  const r = await runLlmJob(
    "대기자",
    async () => {
      ran = true;
    },
    60
  );

  assert.equal(r.ran, false, "상한을 넘기면 실행하지 않고 빠져야 한다");
  assert.equal(ran, false, "포기한 작업의 본체는 절대 실행되면 안 된다");
  assert.ok(Date.now() - started < 2000, "상한만큼만 기다려야 한다");

  release();
  await blocker;
});

test("큐 상한 — 포기해도 큐가 끊기지 않는다", async () => {
  // ★ 이 테스트가 이 기능의 핵심 안전장치다. 포기하면서 큐 꼬리를 풀어 주지 않으면 이후 모든
  // LLM 수집이 영구히 멈춘다(재시작 전까지 복구 불가) — 무한 대기보다 나쁜 실패다.
  let release!: () => void;
  const blocker = withLlmSlot("점유", () => new Promise<void>((r) => (release = r)));
  await tick(10);

  const gaveUp = await runLlmJob("포기자", async () => {}, 60);
  assert.equal(gaveUp.ran, false);

  release();
  await blocker;

  let next = false;
  const done = await Promise.race([
    withLlmSlot("다음", async () => {
      next = true;
    }).then(() => "완료"),
    tick(2000).then(() => "교착"),
  ]);
  assert.equal(done, "완료", "포기한 작업이 큐 꼬리를 잡고 있으면 여기서 교착이다");
  assert.equal(next, true);
});

test("큐 상한 — 큐가 비어 있으면 상한 0 이어도 즉시 실행된다", async () => {
  // "할 일은 있는데 예산이 0 이라 아무것도 못 한다"는 상태를 만들지 않는다.
  // 이미 해소된 차례의 마이크로태스크가 setTimeout(0) 매크로태스크보다 항상 먼저 돈다.
  let ran = false;
  const r = await runLlmJob(
    "빈 큐",
    async () => {
      ran = true;
    },
    0
  );
  assert.equal(r.ran, true);
  assert.equal(ran, true);
});

test("큐 상한 — catch-up 상한이 정시 상한보다 짧고, 둘 다 30분 틱과 정합적이다", () => {
  // catch-up 은 30분마다 다시 오므로 오래 기다릴 이유가 없고, 정시 런은 앞의 한 건이 최악
  // (타임아웃 20분 + 폴백 20분)까지 걸려도 기다려 준 뒤에야 catch-up 에 넘긴다.
  assert.ok(LLM_QUEUE_WAIT_CATCHUP_MS < LLM_QUEUE_WAIT_SCHEDULED_MS);
  assert.ok(LLM_QUEUE_WAIT_CATCHUP_MS <= 30 * 60 * 1000, "catch-up 대기가 틱 간격을 넘으면 안 된다");
  assert.ok(LLM_QUEUE_WAIT_SCHEDULED_MS >= 40 * 60 * 1000, "정시 런이 최악 1건도 못 기다리면 회귀다");
});

// ── catch-up 백오프 ───────────────────────────────────────────────────

test("백오프 — 첫 실패부터 막고, 성공하면 즉시 해제한다", () => {
  const b = createBackoff("테스트", 1_000, 8_000);
  assert.equal(b.blocked(), false, "시도 전에는 막지 않는다");
  b.note(false);
  assert.equal(b.blocked(), true, "실패 직후에는 재시도를 미룬다");
  b.note(true);
  assert.equal(b.blocked(), false, "성공 한 번으로 즉시 해제");
});

test("백오프 — 대기가 지수적으로 늘되 상한을 넘지 않는다", async () => {
  // 대기 시간을 직접 읽을 수 없으므로, 상한을 아주 작게 잡고 '상한만큼 기다리면 풀리는가'로 본다.
  const b = createBackoff("테스트", 50, 100);
  b.note(false); //  50ms
  b.note(false); // 100ms
  b.note(false); // 200ms → 상한 100ms 로 잘림
  b.note(false); // 400ms → 상한 100ms 로 잘림
  await tick(160);
  // 상한이 없으면 여기서 아직 400ms 대기 중이라 막혀 있다. 상한이 있어야 풀린다.
  assert.equal(b.blocked(), false, "상한이 없으면 catch-up 이 사실상 하루 종일 막힌다");
});

test("백오프 — 성공은 연속 실패 카운터를 초기화한다", async () => {
  const b = createBackoff("테스트", 50, 100_000);
  b.note(false); //  50ms
  b.note(false); // 100ms
  b.note(true); // 정상화 → 카운터 리셋
  b.note(false); // 리셋됐다면 다시 50ms (아니면 200ms)
  await tick(120);
  assert.equal(b.blocked(), false, "리셋되지 않으면 정상화 이후에도 대기가 계속 길어진다");
});

// ── 유튜브 백오프 회귀 방어 ────────────────────────────────────────────
//
// 백오프는 원래 유튜브 전용이었고(반나절 8회 실패 실측), 나중에 3탭 공용으로 뽑아냈다.
// 그 뒤로도 원래 계약이 그대로 유지되는지를 **숫자로** 못박는다 — 직렬화·큐 상한·건너뜀 구분이
// 얹히면서 이 계약이 조용히 바뀌면, 사용자는 "가끔 유튜브 탭이 하루 종일 안 도네"로만 겪는다.

test("유튜브 백오프 — 30/60/120/240분으로 늘고 4시간에서 멈춘다", () => {
  const m = (ms: number) => ms / 60000;
  assert.equal(m(backoffWaitMs(1, CATCHUP_BACKOFF_BASE_MS, CATCHUP_BACKOFF_MAX_MS)), 30);
  assert.equal(m(backoffWaitMs(2, CATCHUP_BACKOFF_BASE_MS, CATCHUP_BACKOFF_MAX_MS)), 60);
  assert.equal(m(backoffWaitMs(3, CATCHUP_BACKOFF_BASE_MS, CATCHUP_BACKOFF_MAX_MS)), 120);
  assert.equal(m(backoffWaitMs(4, CATCHUP_BACKOFF_BASE_MS, CATCHUP_BACKOFF_MAX_MS)), 240);
  // 5회차부터는 상한(4시간)에 고정된다. 상한이 없으면 8회 실패 시 64시간이 되어 사실상 영구 정지다.
  assert.equal(m(backoffWaitMs(5, CATCHUP_BACKOFF_BASE_MS, CATCHUP_BACKOFF_MAX_MS)), 240);
  assert.equal(m(backoffWaitMs(9, CATCHUP_BACKOFF_BASE_MS, CATCHUP_BACKOFF_MAX_MS)), 240);
  assert.equal(m(CATCHUP_BACKOFF_MAX_MS), 240, "상한은 4시간이어야 한다");
});

test("유튜브 백오프 — 성공 한 번으로 즉시 해제된다", () => {
  const b = createBackoff("유튜브", CATCHUP_BACKOFF_BASE_MS, CATCHUP_BACKOFF_MAX_MS);
  b.note(false);
  b.note(false);
  b.note(false);
  assert.equal(b.blocked(), true, "3연속 실패면 2시간 대기 중이어야 한다");
  b.note(true);
  assert.equal(b.blocked(), false, "성공하면 남은 대기를 기다리지 않고 즉시 풀린다");
});

test("유튜브 백오프 — catch-up 만 막는다(정시·수동은 통과)", () => {
  const b = createBackoff("유튜브", CATCHUP_BACKOFF_BASE_MS, CATCHUP_BACKOFF_MAX_MS);
  b.note(false);

  // catch-up 경로는 이 게이트를 통과해야만 수집을 부른다 → 막힌다.
  assert.deepEqual(
    decideCatchup({
      running: false,
      blocked: b.blocked(),
      slots: ["08:30"],
      past: () => true,
      covered: () => false,
    }),
    { run: false, reason: "backoff" },
    "백오프 중에는 catch-up 이 발화하면 안 된다"
  );

  // 정시 cron 과 수동 '지금 갱신'은 이 게이트를 아예 타지 않는다(safeRefreshYoutube 직접 호출).
  // 그 사실을 여기서 확인할 수 있는 형태는 "게이트 입력이 catch-up 전용"이라는 것 — blocked 를
  // 빼면 같은 상황에서도 실행 판정이 난다.
  assert.deepEqual(
    decideCatchup({
      running: false,
      blocked: false,
      slots: ["08:30"],
      past: () => true,
      covered: () => false,
    }),
    { run: true, slot: "08:30" },
    "백오프만 빼면 실행 판정이어야 한다 — 즉 막는 주체는 백오프 하나뿐이다"
  );
});

// ── catch-up 게이트 판정 ──────────────────────────────────────────────

test("catch-up 게이트 — 우선순위는 진행 중 > 백오프 > 커버 여부", () => {
  const base = { slots: ["08:00"], past: () => true, covered: () => false };
  assert.deepEqual(decideCatchup({ ...base, running: true, blocked: true }), {
    run: false,
    reason: "running",
  });
  assert.deepEqual(decideCatchup({ ...base, running: false, blocked: true }), {
    run: false,
    reason: "backoff",
  });
});

test("catch-up 게이트 — 아직 오지 않은 시각은 누락이 아니다", () => {
  assert.deepEqual(
    decideCatchup({
      running: false,
      blocked: false,
      slots: ["23:50"],
      past: () => false,
      covered: () => false,
    }),
    { run: false, reason: "covered" }
  );
});

test("catch-up 게이트 — 지났고 커버되지 않은 첫 슬롯을 고른다", () => {
  const covered = new Set(["08:00"]);
  assert.deepEqual(
    decideCatchup({
      running: false,
      blocked: false,
      slots: ["08:00", "17:00"],
      past: () => true,
      covered: (t) => covered.has(t),
    }),
    { run: true, slot: "17:00" },
    "이미 커버된 슬롯을 다시 돌면 하루에 같은 알림이 두 번 나간다"
  );
});

// ── 건너뜀 vs 실패 ────────────────────────────────────────────────────
//
// 결함 ④ 의 재발 방지선. 수동 '지금 갱신'이 도는 중에 스케줄 런이 큐를 통과하면, 수집 모듈
// 안쪽 중복 가드에 막혀 **시도 기록 없이** 돌아온다. 그것을 실패로 세면 멀쩡한 탭에 30분
// 백오프가 걸린다(유튜브는 직렬화 도입 전에는 없던 회귀다).

test("건너뜀은 백오프 집계 대상이 아니다", () => {
  assert.equal(shouldNoteBackoff("attempted"), true, "실제로 시도한 런만 성패를 집계한다");
  assert.equal(
    shouldNoteBackoff("skipped-duplicate"),
    false,
    "수동 갱신 겹침으로 건너뛴 런을 실패로 세면 유령 백오프가 걸린다"
  );
  assert.equal(
    shouldNoteBackoff("skipped-queue"),
    false,
    "큐 대기 상한 초과는 '아직 못 했다'이지 '해봤는데 실패'가 아니다"
  );
});

test("건너뜀 — 실패로 오판했을 때 무엇이 깨지는지 재현", () => {
  // 오판 경로를 그대로 흉내 낸다: 건너뛴 런의 성패를 attemptSucceededSince 로 판정하면
  // 런 시작 이후 기록이 없으므로 반드시 false 가 나온다 → note(false) → 백오프.
  const runStartedAt = Date.now();
  const manualAttemptBefore = { ok: true, at: new Date(runStartedAt - 5 * 60_000).toISOString() };
  assert.equal(
    attemptSucceededSince(manualAttemptBefore, runStartedAt),
    false,
    "이 false 를 그대로 백오프에 넣던 것이 결함 ④ 다"
  );

  const b = createBackoff("유튜브", CATCHUP_BACKOFF_BASE_MS, CATCHUP_BACKOFF_MAX_MS);
  if (shouldNoteBackoff("skipped-duplicate")) b.note(false);
  assert.equal(b.blocked(), false, "건너뛴 런은 백오프를 걸지 않아야 한다");
});

// ── 이번 런의 성패 판정 ───────────────────────────────────────────────
//
// 시도 기록이 디스크에 남게 되면서 생긴 함정을 못박는다: 어제의 성공이 오늘의 실패를 덮으면
// 백오프가 영영 안 걸려, 30분마다 20분짜리 LLM 작업을 무한 재시도하는 원래 문제로 되돌아간다.

test("성패 판정 — 런 시작 이전의 성공 기록은 이번 런의 성공이 아니다", () => {
  const runStartedAt = Date.now();
  const yesterday = new Date(runStartedAt - 24 * 60 * 60 * 1000).toISOString();
  assert.equal(
    attemptSucceededSince({ ok: true, at: yesterday }, runStartedAt),
    false,
    "어제의 성공이 오늘의 실패를 덮으면 백오프가 영영 안 걸린다"
  );
});

test("성패 판정 — 런 시작 이후의 성공만 인정한다", () => {
  const runStartedAt = Date.now();
  const during = new Date(runStartedAt + 5_000).toISOString();
  assert.equal(attemptSucceededSince({ ok: true, at: during }, runStartedAt), true);
  assert.equal(attemptSucceededSince({ ok: false, at: during }, runStartedAt), false);
});

test("성패 판정 — 기록이 없거나 깨졌으면 실패로 접는다", () => {
  const now = Date.now();
  assert.equal(attemptSucceededSince(null, now), false, "기록 없음을 성공 처리하면 안 된다");
  assert.equal(attemptSucceededSince({ ok: true, at: "not-a-date" }, now), false);
});

test("성패 판정 — 밀리초 오차는 흡수한다", () => {
  // 런 시작 시각과 기록 시각은 다른 지점에서 찍히므로 수백 ms 어긋날 수 있다.
  // 그 오차로 성공을 실패로 뒤집으면 멀쩡한 수집에 백오프가 걸린다.
  const runStartedAt = Date.now();
  const justBefore = new Date(runStartedAt - 200).toISOString();
  assert.equal(attemptSucceededSince({ ok: true, at: justBefore }, runStartedAt), true);
});

// ── 절전(시간 점프) 감지 ──────────────────────────────────────────────

test("절전 감지 — 정상 간격에서는 아무 말도 하지 않는다", () => {
  const expected = 30 * 60 * 1000;
  assert.equal(sleepGapMessage(expected, expected), null);
  // 살짝 밀린 틱(타이머 지터·GC)까지 경고하면 로그가 늑대소년이 된다.
  assert.equal(sleepGapMessage(expected * 1.9, expected), null);
  assert.equal(sleepGapMessage(expected * 2, expected), null, "정확히 2배는 경계 밖");
});

test("절전 감지 — 10시간 45분 잠든 실제 사고를 재현한다", () => {
  const expected = 30 * 60 * 1000;
  const msg = sleepGapMessage(10 * 60 * 60 * 1000 + 45 * 60 * 1000, expected);
  assert.ok(msg, "2배를 넘는 간격은 반드시 로그로 남아야 한다");
  assert.match(msg, /시스템 절전 감지/);
  assert.match(msg, /약 615분 건너뜀/); // 645분 경과 - 정상 30분 = 615분이 통째로 사라졌다
  assert.match(msg, /실제 645분/);
});

// ── 로그 포맷 ─────────────────────────────────────────────────────────

test("소요 시간 표기", () => {
  assert.equal(formatDuration(0), "0초");
  assert.equal(formatDuration(1_500), "2초");
  assert.equal(formatDuration(60_000), "1분");
  assert.equal(formatDuration(92_000), "1분 32초");
  assert.equal(formatDuration(-5), "0초", "음수 델타(시계 역행)에도 깨지지 않아야 한다");
});
