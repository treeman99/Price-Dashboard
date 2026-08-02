import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDeadline,
  createDeadlineWithClock,
  formatDeadlineBudget,
  suggestTickMs,
  systemAwakeMs,
  wallCeilingFor,
  type DeadlineClock,
} from "./deadline.ts";

/**
 * 가짜 시계. 실제로 재우지 않고 "절전 900초" 와 "이벤트 루프 900초 정체" 를 **구분해서**
 * 재현하기 위한 장치다. 이 구분이 이 파일의 핵심이다.
 *
 * - `advance(ms)`  : 정상 경과. 벽시계·awake 시계가 함께 흐르고 타이머는 **제때** 발화한다.
 * - `stall(ms)`    : 부하 지연. 벽시계·awake 시계가 함께 흐르지만(시스템은 깨어 있다) 이벤트
 *                    루프가 막혀 타이머가 **늦게 한 번** 발화한다. → 예산에서 전액 차감되어야 한다.
 * - `sleep(ms, darkWakeMs)`: 시스템 절전. 벽시계만 흐르고 awake 시계는 darkWakeMs 만큼만 는다.
 *                    타이머는 깨어난 뒤 늦게 한 번 발화한다. → 예산에서 차감되면 안 된다.
 * - `darkWake(ms)` : DarkWake 창. 타이머는 **제때** 발화하지만 awake 시계는 늘지 않는다
 *                    (실측: os.cpus() 누적 틱은 DarkWake 구간을 사실상 세지 않는다).
 *                    사고 재현의 핵심 — 이 구간에서 틱이 여러 번 발화해 예산을 갉아먹었다.
 *
 * `awakeClock: false` 로 만들면 깨어 있던 시간을 못 재는 환경(다른 OS 등)을 모사한다.
 */
class FakeClock implements DeadlineClock {
  private t = 0;
  private slept = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private readonly hasAwake: boolean;

  constructor(opts: { awakeClock?: boolean } = {}) {
    this.hasAwake = opts.awakeClock !== false;
  }

  now(): number {
    return this.t;
  }

  awakeMs(): number | null {
    return this.hasAwake ? this.t - this.slept : null;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get pending(): number {
    return this.timers.size;
  }

  private step(to: number, awake: boolean): void {
    const d = to - this.t;
    if (d <= 0) return;
    this.t = to;
    if (!awake) this.slept += d;
  }

  /** 예약 시각대로 하나씩 발화시키며 target 까지 시간을 흘린다. */
  advance(ms: number, awake = true): void {
    const target = this.t + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.step(Math.max(this.t, timer.at), awake);
      timer.fn();
    }
    this.step(target, awake);
  }

  /** DarkWake: 타이머는 제때 발화하지만 시스템 awake 시계는 늘지 않는다. */
  darkWake(ms: number): void {
    this.advance(ms, false);
  }

  /** 시계를 점프시키고 만기된 타이머를 **현재(=늦은) 시각에** 한 번 발화. */
  private jump(ms: number, sleptMs: number): void {
    this.t += ms;
    this.slept += sleptMs;
    const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.t);
    for (const [id] of due) this.timers.delete(id);
    for (const [, timer] of due) timer.fn();
  }

  /** 절전. darkWakeMs 만큼만 시스템이 깨어 있었다. */
  sleep(ms: number, darkWakeMs = 0): void {
    this.jump(ms, Math.max(0, ms - darkWakeMs));
  }

  /** 부하 지연: 시스템은 깨어 있었고 이벤트 루프만 막혔다. */
  stall(ms: number): void {
    this.jump(ms, 0);
  }
}

/** log.warn 은 console.warn 으로 나간다. 테스트 출력이 지저분해지지 않게 가로채 검증에 쓴다. */
function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => (console.warn = original) };
}

test("정상 경과는 벽시계와 유효 경과가 같다", () => {
  const clock = new FakeClock();
  const d = createDeadlineWithClock(300_000, clock, { tickMs: 30_000, label: "정상" });

  clock.advance(120_000);
  assert.equal(d.elapsedMs(), 120_000);
  assert.equal(d.wallElapsedMs(), 120_000);
  assert.equal(d.remainingMs(), 180_000);
  assert.equal(d.expired(), false);
  assert.equal(d.sleptMs?.(), 0);

  // 틱 사이(예: 10초 지점)에서 조회해도 계단으로 튀지 않고 그대로 메꿔진다.
  clock.advance(10_000);
  assert.equal(d.elapsedMs(), 130_000);
  d.dispose();
});

test("시스템 절전 시간은 예산에서 차감하지 않는다", () => {
  const clock = new FakeClock();
  const warn = captureWarn();
  const d = createDeadlineWithClock(300_000, clock, { tickMs: 30_000, label: "수집" });

  try {
    // 900초를 자고 깨어난다. 벽시계로는 예산 300초를 훌쩍 넘겼지만 실제로 일한 시간은 없다.
    clock.sleep(900_000);
    assert.equal(d.wallElapsedMs(), 900_000);
    // awake 시계가 "한 순간도 깨어 있지 않았다"고 말하므로 **한 톨도** 차감하지 않는다.
    // (awake 시계가 없던 시절에는 클램프 상한 60초를 그냥 깎았다 — 아래 fallback 테스트 참고.)
    assert.equal(d.elapsedMs(), 0);
    assert.equal(d.expired(), false);
    assert.equal(d.remainingMs(), 300_000);
    assert.equal(d.sleptMs?.(), 900_000);

    // DarkWake 로 20초 깨어 있었다면 그 20초만 차감된다.
    clock.sleep(900_000, 20_000);
    assert.equal(d.elapsedMs(), 20_000);
    assert.equal(d.wallElapsedMs(), 1_800_000);
    assert.equal(d.expired(), false);

    assert.equal(warn.lines.filter((l) => l.includes("시스템 절전 감지")).length, 2);
    assert.match(warn.lines[0], /900초 건너뜀\(예산 미차감\)/);
    assert.match(warn.lines[1], /880초 건너뜀\(예산 미차감\)/);
  } finally {
    warn.restore();
    d.dispose();
  }
});

test("★ 부하 지연은 절전과 달리 전액 차감된다(무한 hang 차단의 핵심)", () => {
  // 검증자 지적: `min(delta, tick×2)` 하나로는 "이벤트 루프가 바빠 틱이 밀린 것"과
  // "시스템 절전"을 구분 못 해, 진짜로 멈춘 프로세스가 예산을 거의 안 쓰고 살아남았다.
  const clock = new FakeClock();
  const warn = captureWarn();
  const d = createDeadlineWithClock(60_000, clock, { tickMs: 5_000, label: "부하" });

  try {
    // 30초 동안 이벤트 루프가 막혔다(시스템은 깨어 있었다). 클램프 상한은 10초지만,
    // 이건 우리가 실제로 쓴 시간이므로 30초 전액이 차감되어야 한다.
    clock.stall(30_000);
    assert.equal(d.elapsedMs(), 30_000);
    assert.equal(d.sleptMs?.(), 0, "시스템은 깨어 있었으므로 절전 0");
    assert.match(warn.lines[0], /틱 지연 30초 — 시스템은 깨어 있었으므로 전액 차감\(부하 지연\)/);

    // 같은 크기의 지연이라도 절전이면 차감하지 않는다 — 이 한 쌍이 구분 능력의 증거다.
    clock.sleep(30_000);
    assert.equal(d.elapsedMs(), 30_000, "절전 30초는 그대로 통과");

    // 부하 지연이 이어지면 예산은 정상적으로 소진된다(정지 감지가 살아 있다).
    clock.stall(30_000);
    assert.equal(d.expired(), true);
    assert.equal(d.expiryReason?.(), "budget");
  } finally {
    warn.restore();
    d.dispose();
  }
});

test("★ 벽시계 절대 상한 — 계속 자도 12시간이면 강제 만료된다", () => {
  const clock = new FakeClock();
  const warn = captureWarn();
  let expired = 0;
  const d = createDeadlineWithClock(3_600_000, clock, {
    tickMs: 5_000,
    label: "상한",
    onExpire: () => {
      expired += 1;
    },
  });

  try {
    assert.equal(wallCeilingFor(3_600_000), 12 * 3_600_000);
    // 1시간씩 11번 자도 유효 경과는 0이라 예산으로는 절대 안 죽는다.
    for (let i = 0; i < 11; i += 1) clock.sleep(3_600_000);
    assert.equal(d.elapsedMs(), 0);
    assert.equal(d.expired(), false);
    assert.equal(expired, 0);

    // 12시간째: 유효 예산이 3600초나 남았어도 벽시계 상한이 끊는다.
    clock.sleep(3_600_000);
    assert.equal(expired, 1);
    assert.equal(d.expired(), true);
    assert.equal(d.expiryReason?.(), "wall-ceiling");
    assert.equal(d.remainingMs(), 0);
    assert.equal(d.elapsedMs(), 0, "유효 경과는 정직하게 0으로 남는다(사고 규명용)");
    assert.match(warn.lines.at(-1)!, /벽시계 상한 43200초 초과 → 강제 만료\(무한 hang 차단\)/);

    // 더 자도 콜백은 다시 발화하지 않는다.
    clock.sleep(3_600_000);
    assert.equal(expired, 1);
  } finally {
    warn.restore();
    d.dispose();
  }
});

test("★ 틱 크기별 회귀 — 예산 부풀리기 상한이 지켜진다(30s/60s/900s)", () => {
  // 검증자 실측: "틱 30s/60s/900s 에서 60분 예산이 3배/6배/90배로 늘고 벽시계 상한이 전혀 없다."
  // 아래 두 축으로 상한을 고정한다.
  const budget = 3_600_000;
  const ceiling = wallCeilingFor(budget); // 12시간
  for (const tickMs of [30_000, 60_000, 900_000]) {
    // (1) 부하 지연만 계속되면 벽시계 ≒ 유효 경과다. 부풀림 배수는 1배 + 틱 하나(마지막 틱은
    //     쪼갤 수 없다)로 묶인다 — 3배/6배/90배 같은 확대는 더 이상 일어나지 않는다.
    {
      const clock = new FakeClock();
      const warn = captureWarn();
      const d = createDeadlineWithClock(budget, clock, { tickMs, label: `부하${tickMs}` });
      try {
        while (!d.expired() && clock.now() < ceiling) clock.stall(tickMs * 3);
        assert.equal(d.expiryReason?.(), "budget", `tick=${tickMs}: 예산으로 만료되어야 한다`);
        assert.ok(
          d.wallElapsedMs() <= budget + tickMs * 3,
          `tick=${tickMs}: 벽시계 ${d.wallElapsedMs()}ms 가 예산+틱1회(${budget + tickMs * 3}ms)를 넘었다`
        );
        assert.ok(d.wallElapsedMs() / budget < 2, `tick=${tickMs}: 부풀림 2배 미만이어야 한다`);
      } finally {
        warn.restore();
        d.dispose();
      }
    }

    // (2) 계속 자면 유효 예산으로는 안 죽지만, 벽시계 상한이 어떤 틱에서도 반드시 잡는다.
    for (const awakeClock of [true, false]) {
      const clock = new FakeClock({ awakeClock });
      const warn = captureWarn();
      const d = createDeadlineWithClock(budget, clock, { tickMs, label: `절전${tickMs}` });
      try {
        // 넉넉히 24시간까지 재우며 만료를 기다린다(상한이 없으면 여기서 안 죽는다).
        for (let i = 0; i < 24 && !d.expired(); i += 1) clock.sleep(3_600_000);
        assert.equal(d.expired(), true, `tick=${tickMs}, awake=${awakeClock}: 반드시 만료되어야 한다`);
        assert.ok(
          d.wallElapsedMs() <= ceiling,
          `tick=${tickMs}, awake=${awakeClock}: 벽시계 ${d.wallElapsedMs()}ms 가 상한 ${ceiling}ms 를 넘었다`
        );
      } finally {
        warn.restore();
        d.dispose();
      }
    }
  }
});

test("★ 로그인 확인(15초 예산)이 DarkWake 반복에 오판당하지 않는다", () => {
  // 결함 ③ 재현: Codex 로그인 확인 15초가 10.4분 절전 구간에 죽어, Codex 가 멀쩡한데도
  // 수집 전체가 Opus 로 폴백했다. 죽은 경로는 "긴 잠"이 아니라 **DarkWake 창 안에서 틱이
  // 여러 번 발화한 것**이다 — 벽시계로는 정상 간격이라 클램프에 걸리지 않는다.
  const scenario = (clock: FakeClock) => {
    // 10.4분 = 5분 잠 + 7초 DarkWake 를 3회 반복(실측 DarkWake 평균 6초, 최대 20초).
    for (let i = 0; i < 3; i += 1) {
      clock.sleep(300_000);
      clock.darkWake(7_000);
    }
  };

  // (1) 깨어 있던 시간을 못 재던 시절 = 사고 그대로 재현된다.
  {
    const clock = new FakeClock({ awakeClock: false });
    const warn = captureWarn();
    const d = createDeadlineWithClock(15_000, clock, { label: "login-legacy" });
    try {
      scenario(clock);
      assert.equal(d.expired(), true, "awake 시계가 없으면 15초 예산이 절전 구간에 소진된다(사고 재현)");
    } finally {
      warn.restore();
      d.dispose();
    }
  }

  // (2) 수정 후: DarkWake 구간의 틱은 예산을 갉아먹지 못한다.
  {
    const clock = new FakeClock();
    const warn = captureWarn();
    const d = createDeadlineWithClock(15_000, clock, { label: "login" });
    try {
      scenario(clock);
      assert.equal(d.elapsedMs(), 0);
      assert.equal(d.expired(), false, "절전 921초를 겪고도 15초 예산은 그대로 남아 있어야 한다");
      assert.equal(d.sleptMs?.(), 921_000);
      // 깨어나면 정상적으로 소진된다 — 슬립 내성이 "영원히 안 죽는다"가 되면 안 된다.
      clock.advance(20_000);
      assert.equal(d.expired(), true);
      assert.equal(d.expiryReason?.(), "budget");
    } finally {
      warn.restore();
      d.dispose();
    }
  }
});

test("awake 시계를 못 쓰는 환경에서는 기존 클램프로 안전하게 떨어진다", () => {
  const clock = new FakeClock({ awakeClock: false });
  const warn = captureWarn();
  const d = createDeadlineWithClock(300_000, clock, { tickMs: 30_000, label: "폴백" });
  try {
    // 판정 불가 → 절전으로 간주(클램프 상한 = 틱 × 2 = 60초)한다. 무한 hang 은 벽시계 상한이 막는다.
    clock.sleep(900_000);
    assert.equal(d.elapsedMs(), 60_000);
    assert.equal(d.sleptMs?.(), 0, "측정 불가면 절전 시간도 0으로 보고한다(추측하지 않는다)");
    // 부하 지연도 같은 클램프를 받는다 — 구분 근거가 없으면 슬립 내성 쪽으로 떨어진다(안전한 실패).
    clock.stall(900_000);
    assert.equal(d.elapsedMs(), 120_000);
  } finally {
    warn.restore();
    d.dispose();
  }
});

test("실제로 깨어 있던 시간만 쌓이면 정상적으로 만료된다", () => {
  const clock = new FakeClock();
  const warn = captureWarn();
  let expired = 0;
  const d = createDeadlineWithClock(60_000, clock, {
    tickMs: 5_000,
    label: "만료",
    onExpire: () => {
      expired += 1;
    },
  });

  try {
    // 깨어 있는 채로 예산을 다 쓰면 예정대로 만료된다 — 슬립 내성이 "영원히 안 죽는다"가
    // 되어 버리면 진짜 정지를 못 잡는다.
    clock.advance(90_000);
    assert.equal(expired, 1);
    assert.equal(d.expired(), true);
    assert.ok(d.remainingMs() <= 0);

    // 만료 후 시간이 더 흘러도 콜백은 다시 발화하지 않는다.
    clock.advance(600_000);
    assert.equal(expired, 1);
    // 유효 경과는 예산에서 얼어붙지만, 벽시계는 계속 흐른다(에러 메시지에 실을 값).
    assert.equal(d.elapsedMs(), 60_000);
    assert.equal(d.wallElapsedMs(), 690_000);
    assert.equal(warn.lines.filter((l) => l.includes("시스템 절전 감지")).length, 0);
  } finally {
    warn.restore();
    d.dispose();
  }
});

test("절전으로 예산이 늦게 소진되면 그때 한 번만 만료된다", () => {
  const clock = new FakeClock();
  const warn = captureWarn();
  let expired = 0;
  const d = createDeadlineWithClock(120_000, clock, {
    tickMs: 30_000,
    onExpire: () => {
      expired += 1;
    },
  });

  try {
    // DarkWake 로 60초씩 깨어 있었다면 회당 60초 차감 → 2회째에 120초 예산이 소진된다.
    clock.sleep(900_000, 60_000);
    assert.equal(expired, 0);
    clock.sleep(900_000, 60_000);
    assert.equal(expired, 1);
    clock.sleep(900_000, 60_000);
    assert.equal(expired, 1, "만료 콜백은 정확히 1회만");
  } finally {
    warn.restore();
    d.dispose();
  }
});

test("dispose 하면 타이머가 남지 않고 콜백도 발화하지 않는다", () => {
  const clock = new FakeClock();
  let expired = 0;
  const d = createDeadlineWithClock(60_000, clock, {
    tickMs: 5_000,
    onExpire: () => {
      expired += 1;
    },
  });

  clock.advance(20_000);
  d.dispose();
  assert.equal(clock.pending, 0, "dispose 후 예약된 타이머가 남아 있으면 프로세스가 안 죽는다");

  clock.advance(600_000);
  assert.equal(expired, 0);
  // 경과는 dispose 시점에 얼어붙는다(에러 메시지의 숫자가 흔들리지 않게).
  assert.equal(d.elapsedMs(), 20_000);
  assert.equal(d.wallElapsedMs(), 20_000);

  // 두 번 불러도 안전해야 한다(finally 중첩 호출).
  d.dispose();
  assert.equal(d.elapsedMs(), 20_000);
});

test("예산이 짧으면 틱도 짧아진다(측정 불가 환경의 슬립 내성)", () => {
  // 15초짜리 로그인 확인. awake 시계를 못 쓰는 환경에서는 클램프 상한(틱 × 2)이 유일한 방어라,
  // 30초 틱이면 상한이 60초가 되어 절전 한 번에 예산 전부가 날아간다. 그래서 틱을 예산에 맞춰 줄인다.
  const legacy = new FakeClock({ awakeClock: false });
  const warn = captureWarn();
  const d = createDeadlineWithClock(15_000, legacy, {});
  try {
    legacy.sleep(900_000);
    // 틱 = 15_000/10 = 1.5초 → 상한 3초. 예산 15초 중 3초만 차감된다.
    assert.equal(d.elapsedMs(), 3_000);
    assert.equal(d.expired(), false);
  } finally {
    warn.restore();
    d.dispose();
  }

  // 측정이 가능하면 추측 상한 대신 실측값을 쓴다 — DarkWake 로 실제 깨어 있던 10초만 차감.
  const clock = new FakeClock();
  const warn2 = captureWarn();
  const d2 = createDeadlineWithClock(15_000, clock, {});
  try {
    clock.sleep(900_000);
    assert.equal(d2.elapsedMs(), 0);
    clock.sleep(900_000, 10_000);
    assert.equal(d2.elapsedMs(), 10_000);
    assert.equal(d2.expired(), false);
  } finally {
    warn2.restore();
    d2.dispose();
  }
});

test("★ 대부분 깨어 있었던 구간은 짧은 절전이 섞여도 전액에 가깝게 차감된다", () => {
  // 진짜 정지(이벤트 루프가 500초 막힘) 중에 우연히 100초를 잤다면, 500초는 우리가 쓴 시간이다.
  // 여기에 클램프(틱×2=10초)를 덧씌우면 정지를 잡지 못하고 예산이 영원히 안 준다.
  const clock = new FakeClock();
  const warn = captureWarn();
  const d = createDeadlineWithClock(600_000, clock, { tickMs: 5_000, label: "혼합" });
  try {
    clock.sleep(600_000, 500_000); // 벽시계 600초 중 500초는 깨어 있었다
    assert.equal(d.elapsedMs(), 500_000);
    assert.equal(d.sleptMs?.(), 100_000);
    clock.sleep(600_000, 500_000);
    assert.equal(d.expired(), true, "정지가 이어지면 예산은 정상적으로 소진되어야 한다");
    assert.equal(d.expiryReason?.(), "budget");
  } finally {
    warn.restore();
    d.dispose();
  }
});

test("suggestTickMs — 절전이 잦은 실행용 틱 상한은 5초", () => {
  assert.equal(suggestTickMs(3_600_000), 5_000);
  assert.equal(suggestTickMs(600_000), 5_000);
  assert.equal(suggestTickMs(30_000), 3_000);
  assert.equal(suggestTickMs(15_000), 1_500);
  // 하한 1초 — 너무 짧은 예산에서도 클램프가 의미를 갖게.
  assert.equal(suggestTickMs(1_000), 1_000);
  assert.equal(suggestTickMs(0), 1_000);
});

test("wallCeilingFor — 예산 × 12, 최소 1시간, 최대 12시간", () => {
  assert.equal(wallCeilingFor(3_600_000), 12 * 3_600_000); // 60분 예산 → 12시간
  assert.equal(wallCeilingFor(600_000), 2 * 3_600_000); // 10분 예산 → 2시간
  assert.equal(wallCeilingFor(240_000), 3_600_000); // 4분 예산 → 하한 1시간
  assert.equal(wallCeilingFor(15_000), 3_600_000); // 로그인 확인 → 하한 1시간
  assert.equal(wallCeilingFor(6 * 3_600_000), 12 * 3_600_000); // 상한 12시간
  // 예산이 상한보다 크면 예산이 우선한다 — 자기 예산도 못 쓰고 죽으면 안 된다.
  assert.equal(wallCeilingFor(20 * 3_600_000), 20 * 3_600_000);
  // 실측된 최장 절전(10시간 45분 25초)은 60분 예산에서 상한에 걸리지 않는다.
  assert.ok(wallCeilingFor(3_600_000) > 10 * 3_600_000 + 45 * 60_000 + 25_000);
});

test("formatDeadlineBudget — 예산·벽시계·유효에 절전 실측치를 병기한다", () => {
  const clock = new FakeClock();
  const warn = captureWarn();
  const d = createDeadlineWithClock(3_600_000, clock, { tickMs: 30_000 });
  try {
    clock.sleep(3_900_000, 60_000);
    assert.equal(
      formatDeadlineBudget(3_600_000, d),
      "예산 3600s, 벽시계 3900s, 유효 60s, 절전 3840s"
    );
  } finally {
    warn.restore();
    d.dispose();
  }
});

test("formatDeadlineBudget — 벽시계 상한으로 죽은 경우 사유를 밝힌다", () => {
  const clock = new FakeClock();
  const warn = captureWarn();
  const d = createDeadlineWithClock(600_000, clock, { tickMs: 5_000 });
  try {
    clock.sleep(2 * 3_600_000); // 10분 예산의 상한 = 2시간
    assert.match(formatDeadlineBudget(600_000, d), /벽시계 상한 7200s 초과로 강제 만료/);
  } finally {
    warn.restore();
    d.dispose();
  }
});

test("systemAwakeMs — 이 환경에서 실제로 '깨어 있던 시간'을 잰다", async () => {
  const a0 = systemAwakeMs();
  assert.ok(a0 !== null && Number.isFinite(a0) && a0 > 0, "macOS/Linux 에서는 측정 가능해야 한다");
  const w0 = performance.now();
  await new Promise((r) => setTimeout(r, 300));
  const wall = performance.now() - w0;
  const awake = systemAwakeMs()! - a0;
  // 깨어 있는 동안에는 벽시계와 1:1 이어야 한다(실측 비율 0.992~0.997).
  // ★ 이 성질이 process.cpuUsage() 와의 결정적 차이다 — 유휴 대기 중에도 시스템 idle 틱이
  //   쌓이므로, "놀고 있는 프로세스"와 "자고 있는 시스템"이 섞이지 않는다.
  assert.ok(awake >= wall * 0.8, `유휴 대기 중에도 awake 시계가 흘러야 한다(awake=${awake}, wall=${wall})`);
  assert.ok(awake <= wall * 1.2 + 50, `awake 시계가 벽시계보다 빠르면 안 된다(awake=${awake}, wall=${wall})`);
});

test("실제 타이머로도 동작한다(운영 경로 스모크)", async () => {
  const d = createDeadline(80, { tickMs: 10, label: "스모크" });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(d.expired(), false);
  assert.ok(d.elapsedMs() >= 30);
  assert.equal(d.sleptMs?.(), 0, "깨어 있는 동안에는 절전 0 이어야 한다(오탐 방지)");
  d.dispose();
});
