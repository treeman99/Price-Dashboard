import os from "node:os";
import { log } from "./log.ts";

/**
 * **슬립 내성 데드라인.** `setTimeout(budgetMs)` 한 방으로 예산을 재던 방식을 대체한다.
 *
 * 왜 필요한가 (2026-08-02 실측 사고):
 * 맥북 덮개를 닫고 배터리로 두자 Deep Idle 수면에 들어가 10시간 45분 동안 DarkWake(2~20초)만
 * 반복했다. 서비스 프로세스는 16시간 46분 중 CPU 를 **27.8초**만 받았다. 그런데 `setTimeout` 은
 * 벽시계 기준이라, 실제로는 수십 초밖에 돌지 못한 작업에 3600s/600s/240s 예산이 그대로 만료되어
 * 전 탭이 동시에 "응답 시간 초과"로 죽었다. 하루치 수집이 통째로 날아갔다.
 *
 * 해결 방식: 긴 타이머 하나 대신 **짧은 틱을 돌며 유효 경과만 누적**한다. 틱 간 실제 델타가
 * 벌어졌을 때 그 시간을 예산에서 뺄지 말지는 **시스템이 깨어 있었는지**로 판정한다
 * (`systemAwakeMs` 주석 참고). 즉 "잔 시간은 일한 시간이 아니다".
 *
 * ⚠️ 시간 소스로 단조 시계(`performance.now()`)를 쓰지만, **단조 시계도 macOS 슬립 중에 멈추지
 * 않는다.** 그래서 슬립 방어의 본질은 시계 선택이 아니라 **깨어 있던 시간의 측정**이다. 단조
 * 시계는 시스템 시각 변경(NTP 보정·수동 변경)에 예산이 흔들리지 않게 하는 용도로만 쓴다.
 *
 * ⚠️ 그리고 슬립 내성은 **무한 hang 차단을 대체하지 않는다.** 유효 예산만 보면 진짜로 멈춘
 * 프로세스가 며칠씩 살아남을 수 있으므로, 아래 `wallCeilingFor` 의 벽시계 절대 상한을 함께 둔다.
 */

/**
 * 기본 틱 간격. 예산이 짧으면 이보다 촘촘하게 줄인다(normalizeTick 참고).
 *
 * 30초로 잡은 이유: 틱 자체는 아무 일도 하지 않는 콜백이라 비용이 없지만, 절전 구간에서 한 틱이
 * 인정하는 상한이 `틱 × 2` 라서 틱이 길수록 절전 1회당 깎이는 예산도 커진다. 30초면 절전 900초가
 * 흘러도 최대 60초만 차감된다.
 */
const DEFAULT_TICK_MS = 30_000;

/** 자동 산출 시 틱이 무한정 짧아지지 않게 하는 하한. */
const MIN_AUTO_TICK_MS = 1_000;

/**
 * **절전이 잦은 실행**(수집 에이전트 호출)에 권장하는 틱 간격.
 *
 * 실측 근거: 이번 사고의 DarkWake 창은 2~20초였다. 30초 틱은 그 창 안에서 최대 한 번만
 * 발화하므로, 실제로 깨어 있던 5초를 "60초(=틱×2) 썼다"로 과대계상한다. 절전 100회면
 * 실제 500초를 6000초로 세어 3600초 예산이 그대로 터진다 — 클램프를 넣고도 같은 사고가 난다.
 * 5초 틱이면 20초짜리 DarkWake 창 안에서 여러 번 발화해 유효 경과가 실제 깨어 있던 시간에
 * 훨씬 가까워진다. 콜백은 no-op 이라 1시간에 720회 발화해도 비용은 무시할 수준이다.
 */
const SLEEP_SENSITIVE_TICK_MS = 5_000;

/**
 * **벽시계 절대 상한**(hard ceiling) = `clamp(예산 × 12, 1시간, 12시간)`.
 *
 * 왜 필요한가: 유효 예산만으로는 상한이 없다. 시스템이 계속 자면 유효 경과가 거의 쌓이지 않아
 * **진짜로 멈춘 프로세스가 며칠씩 살아 있을 수 있고**(사고 당시의 절전 패턴을 그대로 적용하면
 * 60분 예산이 벽시계 38시간까지 늘어난다), 그동안 호출부의 `running` 플래그도 잠긴 채다.
 * 그러면 타임아웃을 둔 원래 목적(무한 hang 차단)이 사라진다.
 *
 * 값의 근거:
 * - **배수 12** — 60분 예산이 12시간이 된다. 실측된 최장 절전 구간(2026-08-02, 10시간 45분 25초)을
 *   통과하면서(여유 1시간 14분) 하룻밤 절전은 그대로 견딘다. 12시간이 넘도록 못 끝낸 수집은
 *   이미 다음 슬롯이 지나 결과가 쓸모없으므로, 살려 두는 것보다 죽이고 폴백을 태우는 편이 낫다.
 * - **하한 1시간** — 15초짜리 로그인 확인에 배수를 그대로 곱하면 상한이 3분이 되어, 10분짜리
 *   DarkWake 구간 하나에 확인이 죽는다(그게 바로 이번에 고치는 결함 ③이다). 짧은 예산일수록
 *   벽시계 상한은 예산이 아니라 "절전 창 하나"의 크기로 잡아야 한다.
 * - **상한 12시간** — 어떤 예산이든 반나절을 넘겨 슬롯을 붙잡지 않는다. 하루 주기 대시보드에서
 *   "오늘 시작한 작업이 내일 같은 슬롯까지 살아 있는" 상태를 원천 차단하는 값이다.
 *
 * 예산 자체가 상한보다 크면(설정 실수 방지) 예산을 하한으로 쓴다 — 상한 때문에 자기 예산도 못
 * 쓰고 죽는 일은 없어야 한다.
 */
const WALL_CEILING_FACTOR = 12;
const WALL_CEILING_MIN_MS = 60 * 60_000;
const WALL_CEILING_MAX_MS = 12 * 60 * 60_000;

/**
 * 절전 판정의 잡음 여유. `벽시계 - 깨어 있던 시간` 이 이 값 이하면 "안 잤다"로 본다.
 *
 * 실측(아래 systemAwakeMs 주석): 깨어 있는 동안 5초 창에서 뒤처지는 양이 약 20ms(0.4%)이고,
 * 부팅 이후 111시간 누적으로는 오히려 51초(0.014%) 앞섰다. 즉 오차는 **읽을 때마다 붙는 수십 ms
 * 수준의 상수**에 가깝다. 200ms 하한은 그 10배 여유이고, 2% 비율은 긴 구간의 누적 오차를 덮는다.
 *
 * ⚠️ 하한을 크게 잡으면(예: 1초) DarkWake 창의 짧은 틱들이 "잡음"으로 분류돼 예산을 갉아먹는다 —
 * 15초짜리 로그인 확인이 절전 구간에 죽던 결함 ③ 이 정확히 그 경로였다. 반대로 너무 작게 잡으면
 * 정상 구간을 절전으로 오인해 예산이 안 줄어든다. 실측 잡음의 10배가 그 사이의 값이다.
 */
const SLEEP_NOISE_FLOOR_MS = 200;
const SLEEP_NOISE_RATIO = 0.02;

export interface Deadline {
  /** 남은 유효 예산. 0 이하면 만료. 벽시계 상한에 걸리면 유효 예산이 남아 있어도 0 이다. */
  remainingMs(): number;
  expired(): boolean;
  /** 유효 경과(슬립 제외). */
  elapsedMs(): number;
  /** 벽시계 경과. 사고 원인 규명 시 유효 경과와의 격차가 곧 절전 시간이다. */
  wallElapsedMs(): number;
  /**
   * 이 데드라인이 사는 동안 **시스템이 자고 있던** 벽시계 시간. 측정 불가·잡음 수준이면 0.
   * 호출부가 "이 실패는 절전 탓일 수 있다"를 판단하는 근거다(codex-query 로그인 확인 참고).
   */
  sleptMs?(): number;
  /** 만료 사유. 아직 만료 전이면 null. */
  expiryReason?(): "budget" | "wall-ceiling" | null;
  dispose(): void;
}

export interface DeadlineOptions {
  tickMs?: number;
  onExpire?: () => void;
  label?: string;
}

/**
 * 시간 소스와 타이머 주입 지점. **테스트 전용 확장점**이다.
 * 운영 코드는 `createDeadline` 만 쓰고, 테스트는 `createDeadlineWithClock` 으로 가짜 시계를
 * 넣어 "절전 900초" 와 "이벤트 루프 900초 정체" 를 결정론적으로 구분해 재현한다.
 */
export interface DeadlineClock {
  /** 단조 증가 밀리초(절전 중에도 흐른다). */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /**
   * 시스템이 깨어 있던 누적 밀리초(절전 중에는 멈춘다). 제공하지 않으면 절전/부하 구분을
   * 포기하고 기존 클램프만 쓴다 — 구분 없이도 안전한 쪽(절전으로 간주)으로 떨어진다.
   */
  awakeMs?(): number | null;
}

/**
 * **시스템이 깨어 있던 누적 시간(ms).** 절전(및 DarkWake 대부분) 동안에는 증가하지 않는다.
 * `os.cpus()` 의 코어별 누적 틱(user+nice+sys+idle+irq)을 코어 수로 나눈 값이다.
 *
 * ── 왜 이게 절전 판별에 쓸 수 있나 (2026-08-02 이 맥에서 직접 측정) ─────────────────────────
 * 1. **절전 중 정지**: 부팅 후 벽시계 111h25m27s vs 이 값 100h40m4s → 격차 **10h45m23s**.
 *    같은 구간의 `pmset -g log` 실측은 순수 Sleep 10h38m20s + DarkWake 7m54s = 10h46m14s 로,
 *    격차와 **51초(0.014%)** 밖에 차이가 없다. 즉 이 시계는 절전은 물론 DarkWake 도 거의
 *    세지 않는다 — 사고 구간에서 "실제로 일할 수 있었던 시간"과 정확히 같은 것을 잰다.
 * 2. **깨어 있을 때는 벽시계와 1:1**: 유휴 5초 × 3회 = 비율 0.9955/0.9961/0.9969,
 *    CPU 부하 3초 × 2회 = 0.9959/0.9969. 100ms~5s 어느 창에서도 1에 붙는다.
 * 3. ★ **`process.cpuUsage()` 의 함정을 피한다.** 프로세스 CPU 소비율로 절전을 판별하려 하면,
 *    자식 프로세스를 기다리며 놀고 있는 정상 상태와 절전이 똑같이 "CPU 안 씀"으로 보인다
 *    (검증자 반례: 사고 구간 duty 0.046% vs 정상 유휴 0.0057% 로 **사고 쪽이 오히려 8배 높았다**).
 *    반면 이 값은 **시스템 전체의 idle 틱까지 포함**하므로, 우리 프로세스가 놀고 있어도 시스템이
 *    깨어 있으면 벽시계와 1:1 로 증가한다. 판별 대상이 "우리가 일했는가"가 아니라
 *    "시스템이 깨어 있었는가"인 것이 핵심이다.
 * 4. **비용**: 1회 호출 16.7µs(12코어 실측). 5초 틱이면 무시할 수준이다.
 *
 * 측정할 수 없는 환경(다른 OS·빈 배열 등)에서는 null 을 돌려주고, 호출부는 기존 클램프로 떨어진다.
 */
export function systemAwakeMs(): number | null {
  try {
    const cpus = os.cpus();
    if (!Array.isArray(cpus) || cpus.length === 0) return null;
    let total = 0;
    for (const cpu of cpus) {
      const t = cpu?.times;
      if (!t) return null;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    return Number.isFinite(total) ? total / cpus.length : null;
  } catch {
    return null;
  }
}

const systemClock: DeadlineClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // 데드라인 타이머가 이벤트 루프를 붙잡아 프로세스가 안 죽는 사고를 막는다.
    // 감시 대상(자식 프로세스·스트림)이 루프를 잡고 있는 동안에만 의미가 있는 타이머다.
    t.unref?.();
    return t;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  awakeMs: systemAwakeMs,
};

const sec = (ms: number): number => Math.round(ms / 1000);

/** 절전으로 인정할 최소 격차. 이하는 측정 잡음으로 본다. */
const sleepNoiseMs = (spanMs: number): number =>
  Math.max(SLEEP_NOISE_FLOOR_MS, spanMs * SLEEP_NOISE_RATIO);

/**
 * 예산에 어울리는 틱 간격. 절전이 잦은 장시간 실행(수집 에이전트)에서 쓴다.
 *
 * 예산의 1/10 을 기준으로 하되 5초를 넘기지 않는다 — 상한 근거는 SLEEP_SENSITIVE_TICK_MS 주석 참고.
 * 하한 1초는 15초짜리 로그인 확인처럼 짧은 예산에서 "절전 한 번에 예산 전부 소진"을 막기 위한 값이다.
 */
export function suggestTickMs(budgetMs: number): number {
  const scaled = Math.floor(Math.max(0, budgetMs) / 10);
  return Math.max(MIN_AUTO_TICK_MS, Math.min(SLEEP_SENSITIVE_TICK_MS, scaled));
}

/** 이 예산에 적용되는 벽시계 절대 상한. 근거는 WALL_CEILING_* 상수 주석 참고. */
export function wallCeilingFor(budgetMs: number): number {
  const budget = Math.max(0, budgetMs);
  const scaled = Math.min(
    WALL_CEILING_MAX_MS,
    Math.max(WALL_CEILING_MIN_MS, budget * WALL_CEILING_FACTOR)
  );
  return Math.max(budget, scaled);
}

/**
 * 명시값이 없을 때의 틱 산출.
 *
 * 기본은 30초지만 **예산이 5분 미만이면 예산의 1/10(최소 1초)로 줄인다.** 절전 구간의 인정 상한이
 * `틱 × 2` 이므로, 15초짜리 로그인 확인에 30초 틱을 쓰면 절전 한 번(=60초 차감)에 예산이
 * 통째로 날아가 슬립 내성이 0 이 된다 — 짧은 예산일수록 틱도 짧아야 한다.
 */
function normalizeTick(budgetMs: number, explicit: number | undefined): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.floor(explicit));
  }
  const scaled = Math.floor(Math.max(0, budgetMs) / 10);
  return Math.min(DEFAULT_TICK_MS, Math.max(MIN_AUTO_TICK_MS, scaled));
}

export function createDeadline(budgetMs: number, opts: DeadlineOptions = {}): Deadline {
  return createDeadlineWithClock(budgetMs, systemClock, opts);
}

/** 시계를 주입하는 형태. 테스트에서만 직접 호출한다(운영 경로는 createDeadline). */
export function createDeadlineWithClock(
  budgetMs: number,
  clock: DeadlineClock,
  opts: DeadlineOptions = {}
): Deadline {
  const label = opts.label ?? "deadline";
  const tickMs = normalizeTick(budgetMs, opts.tickMs);
  /**
   * **깨어 있던 시간을 못 재는 환경에서만** 쓰는 클램프 상한(한 틱이 깎을 수 있는 최대치).
   *
   * 측정이 가능하면 이 값은 쓰지 않는다 — 추측으로 자른 상한보다 실측값이 언제나 낫고,
   * 클램프를 계속 씌우면 "시스템은 깨어 있는데 우리가 멈춰 있는" 진짜 정지까지 잘라 내
   * 무한 hang 차단이 무력해진다(검증자가 지적한 바로 그 결함이다).
   */
  const cap = tickMs * 2;
  /** 이보다 큰 델타는 원인(절전/부하)을 로그로 남긴다. */
  const sleepThresholdMs = tickMs * 3;
  const wallCeilingMs = wallCeilingFor(budgetMs);

  const startedAt = clock.now();
  const readAwake = (): number | null => {
    const v = clock.awakeMs?.();
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const awakeAtStart = readAwake();

  let lastTickAt = startedAt;
  let lastAwakeAt = awakeAtStart;
  /** 누적 유효 경과. 마지막 틱까지의 확정분만 들어 있다. */
  let effectiveMs = 0;
  /** 틱이 예산을 계속 적립하는 중인지. 만료·dispose 하면 false 로 얼어붙는다. */
  let accruing = true;
  let disposed = false;
  let frozenWallMs = 0;
  let frozenSleptMs = 0;
  let expireFired = false;
  /** 벽시계 절대 상한에 걸려 강제 만료됐는지. 오류 메시지에서 사유를 구분하는 근거다. */
  let ceilingHit = false;
  let handle: unknown = null;

  const rawWallMs = (): number => Math.max(0, clock.now() - startedAt);
  const wallElapsedMs = (): number => (disposed ? frozenWallMs : rawWallMs());

  /** 지금까지 시스템이 자고 있던 벽시계 시간(잡음 이하면 0). */
  const rawSleptMs = (): number => {
    const awakeNow = readAwake();
    if (awakeAtStart === null || awakeNow === null) return 0;
    const wall = rawWallMs();
    const slept = wall - Math.max(0, awakeNow - awakeAtStart);
    return slept > sleepNoiseMs(wall) ? Math.min(slept, wall) : 0;
  };
  const sleptMs = (): number => (disposed ? frozenSleptMs : rawSleptMs());

  /**
   * 한 구간(delta)에서 **예산에서 실제로 깎을 시간**.
   *
   * 이 함수가 이번 수정의 핵심이다. 예전에는 `min(delta, cap)` 하나로 끝내서, 이벤트 루프가
   * 바빠 틱이 밀린 것(=우리가 쓴 시간, 전액 차감해야 함)과 시스템 절전(=쓰지 못한 시간,
   * 차감하면 안 됨)을 똑같이 취급했다. 그래서 진짜로 멈춘 프로세스도 예산을 거의 안 쓰고
   * 영원히 살 수 있었다.
   */
  const creditFor = (delta: number, awakeDelta: number | null): number => {
    // 깨어 있던 시간을 못 재는 환경 → 판정 불가. 보수적으로 기존 클램프(슬립 내성 우선)를 쓰고,
    // 무한 hang 은 벽시계 절대 상한이 대신 막는다.
    if (awakeDelta === null) return Math.min(delta, cap);
    const slept = Math.max(0, delta - awakeDelta);
    // 시스템이 이 구간 내내 깨어 있었다 = 지연의 원인은 절전이 아니라 부하(이벤트 루프 정체,
    // 스케줄링 지연). 그 시간은 우리가 실제로 쓴 시간이므로 **전액 차감**한다.
    if (slept <= sleepNoiseMs(delta)) return delta;
    // 절전이 섞인 구간 → **깨어 있던 만큼만** 차감한다. 여기에 cap 을 덧씌우지 않는 이유:
    // 실측상 이 시계는 DarkWake 구간을 사실상 세지 않아(사고 구간 10시간 45분에서 awake 증가분이
    // 51초 수준) 이미 CPU 기아가 반영된 값이다. 여기에 cap 을 더 씌우면 "대부분 깨어 있었는데
    // 잠깐 잔" 구간(=진짜 정지)까지 틱×2 로 잘려 예산이 안 줄어든다.
    return awakeDelta;
  };

  /** lastAwakeAt 기준 이번 구간의 '깨어 있던 시간'. 측정 불가면 null. */
  const awakeDeltaSince = (delta: number): number | null => {
    if (lastAwakeAt === null) return null;
    const awakeNow = readAwake();
    if (awakeNow === null) return null;
    return Math.min(Math.max(0, awakeNow - lastAwakeAt), delta);
  };

  /**
   * 마지막 틱 이후 아직 확정되지 않은 경과. 틱 사이에 조회해도 값이 계단으로 튀지 않게
   * 여기서 메꾼다. 틱과 **동일한 판정**을 적용해야 "조회 시점에는 만료, 틱이 돌면 미만료"
   * 같은 모순이 생기지 않는다.
   */
  const pendingMs = (): number => {
    if (!accruing) return 0;
    const delta = Math.max(0, clock.now() - lastTickAt);
    return creditFor(delta, awakeDeltaSince(delta));
  };

  const elapsedMs = (): number => effectiveMs + pendingMs();
  /** 벽시계 절대 상한에 걸렸는지. 틱이 늦게 발화하는 절전 상황에서도 조회 즉시 판정된다. */
  const hitWallCeiling = (): boolean => ceilingHit || wallElapsedMs() >= wallCeilingMs;
  const remainingMs = (): number => (hitWallCeiling() ? 0 : budgetMs - elapsedMs());
  const expiryReason = (): "budget" | "wall-ceiling" | null => {
    if (hitWallCeiling()) return "wall-ceiling";
    return budgetMs - elapsedMs() <= 0 ? "budget" : null;
  };

  const schedule = (): void => {
    if (!accruing) return;
    // 남은 예산(또는 남은 벽시계 상한)이 틱보다 적으면 그 시점에 정확히 깨어나 onExpire 를
    // 제때 발화시킨다. 고정 30초 간격이면 15초짜리 예산이 30초에야 만료된다.
    const delay = Math.max(
      1,
      Math.min(tickMs, budgetMs - effectiveMs, wallCeilingMs - rawWallMs())
    );
    handle = clock.setTimeout(onTick, delay);
  };

  const stopAccruing = (): void => {
    accruing = false;
    if (handle !== null) {
      clock.clearTimeout(handle);
      handle = null;
    }
  };

  const expire = (): void => {
    stopAccruing();
    if (expireFired) return;
    expireFired = true;
    opts.onExpire?.();
  };

  function onTick(): void {
    handle = null;
    if (!accruing) return;

    const now = clock.now();
    const delta = Math.max(0, now - lastTickAt);
    const awakeNow = readAwake();
    const awakeDelta =
      lastAwakeAt !== null && awakeNow !== null
        ? Math.min(Math.max(0, awakeNow - lastAwakeAt), delta)
        : null;
    const credited = creditFor(delta, awakeDelta);

    if (delta > sleepThresholdMs) {
      // 이 한 줄이 다음 사고 때 1분 만에 원인을 짚게 해준다. 없으면 "왜 예산이 안 줄었지"
      // 또는 "왜 갑자기 죽었지"를 로그 어디에서도 설명할 수 없다(이번 사고의 실제 경험).
      // 절전인지 부하인지까지 남겨야 "슬립 내성이 과했나"를 사후에 판정할 수 있다.
      const cause =
        credited >= delta
          ? `틱 지연 ${sec(delta)}초 — 시스템은 깨어 있었으므로 전액 차감(부하 지연)`
          : `시스템 절전 감지 — ${sec(delta - credited)}초 건너뜀(예산 미차감)`;
      log.warn(
        `${label}: ${cause}. ` +
          `유효 ${sec(effectiveMs + credited)}초 / 예산 ${sec(budgetMs)}초, 벽시계 ${sec(now - startedAt)}초`
      );
    }
    effectiveMs += credited;
    lastTickAt = now;
    if (awakeNow !== null) lastAwakeAt = awakeNow;

    // 벽시계 절대 상한이 유효 예산보다 먼저 걸릴 수 있다(절전으로 유효 경과가 거의 안 쌓인 채
    // 반나절이 지난 경우). 슬립 내성이 "영원히 안 죽는다"가 되지 않게 하는 마지막 방어선이다.
    if (rawWallMs() >= wallCeilingMs) {
      ceilingHit = true;
      log.warn(
        `${label}: 벽시계 상한 ${sec(wallCeilingMs)}초 초과 → 강제 만료(무한 hang 차단). ` +
          `유효 ${sec(effectiveMs)}초 / 예산 ${sec(budgetMs)}초, 절전 ${sec(rawSleptMs())}초`
      );
      expire();
      return;
    }
    if (effectiveMs >= budgetMs) {
      expire();
      return;
    }
    schedule();
  }

  schedule();

  return {
    remainingMs,
    expired: () => remainingMs() <= 0,
    elapsedMs,
    wallElapsedMs,
    sleptMs,
    expiryReason,
    dispose: () => {
      if (disposed) return;
      // 값을 얼려 둔다. 호출부는 대개 `finally { dispose() }` 직후에 오류 메시지를 만들면서
      // 경과를 읽는데, 그때 숫자가 계속 움직이면 로그와 실제가 어긋난다.
      effectiveMs = elapsedMs();
      frozenSleptMs = rawSleptMs();
      frozenWallMs = rawWallMs();
      disposed = true;
      stopAccruing();
    },
  };
}

/**
 * "예산 3600s, 벽시계 3931s, 유효 50s, 절전 3880s" — 타임아웃 로그·에러 메시지의 표준 세트.
 *
 * 이번 사고에서 메시지에 벽시계만 있고 유효 경과가 없어 "3600초를 다 썼다"로 읽혔고,
 * 실제로는 50초밖에 못 돌았다는 사실을 며칠 뒤 전원 관리 로그를 뒤져서야 알았다.
 * 숫자를 나란히 두면 격차 자체가 절전의 증거가 되고, 절전이 실제로 측정된 경우에는 그 값을
 * 덧붙여 추측을 없앤다. 벽시계 상한에 걸려 죽은 경우도 여기서 구분해 준다 — 그 둘은 대응이
 * 다르다(예산 부족 vs 절전 중 방치).
 */
export function formatDeadlineBudget(budgetMs: number, deadline: Deadline): string {
  const parts = [
    `예산 ${sec(budgetMs)}s`,
    `벽시계 ${sec(deadline.wallElapsedMs())}s`,
    `유효 ${sec(deadline.elapsedMs())}s`,
  ];
  const slept = deadline.sleptMs?.() ?? 0;
  if (slept > 0) parts.push(`절전 ${sec(slept)}s`);
  if (deadline.expiryReason?.() === "wall-ceiling") {
    parts.push(`벽시계 상한 ${sec(wallCeilingFor(budgetMs))}s 초과로 강제 만료`);
  }
  return parts.join(", ");
}
