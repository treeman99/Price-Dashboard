import { spawn, type ChildProcess } from "node:child_process";
import { log } from "./log.ts";

/**
 * 작업이 도는 동안 시스템 절전을 막는 어서션(wake lock).
 *
 * ── 왜 필요한가 (2026-08-02 사고 실측) ──
 * 덮개를 닫고 배터리로 두자 00:29:10 'Clamshell Sleep' 진입 → 11:14:35 덮개 열림까지
 * **10시간 45분간 FullWake 0회**였다. 그동안 맥은 DarkWake 로 20여 회 깨어났지만
 * 지속시간이 2~20초(중앙값 7초)뿐이라 수집 작업이 붙을 틈이 없었다.
 * 결과적으로 수집 프로세스는 ELAPSED 16h58m 동안 CPU TIME 31.6초만 썼다(가동률 0.05%).
 *
 * ── ★ 이 함수가 못 하는 일 (과대평가 금지) ──
 * `caffeinate` 는 **클램셸 슬립(덮개 닫기)을 막지 못한다.** 덮개를 닫으면 macOS 는
 * 유휴 슬립이 아니라 'Clamshell Sleep' 이라는 별도 경로로 잠드는데, 이건 어서션 대상이 아니다.
 * 실측 근거: 2026-07-29 18:46:04 로그에 `Entering Sleep state due to 'Clamshell Sleep' ... Using AC`
 * — **AC 를 꽂아도** 덮개를 닫으면 클램셸 슬립이 걸린다.
 * 즉 **이번 사고는 이 함수만으로는 막지 못했을 것이다.** 다음 사람이 잘못된 안심을 하지 않도록 명시한다.
 *
 * ── 그래서 이 함수의 실제 효용은 두 가지뿐이다 ──
 *  (a) **덮개가 열린 채** 유휴 슬립 방지. 배터리 설정이 `sleep 1`(유휴 1분!)이라 이게 은근히 크다.
 *  (b) 어떤 이유로든 깨어난 뒤(기상 예약·네트워크 등) 작업이 끝날 때까지 다시 잠들지 않게 붙잡기.
 * 진짜 재발 방지는 코드의 슬립 내성(벽시계 기반 재개)이며, 이 어서션은 보조 수단이다.
 * 전체 대응층과 한계는 docs/sleep-resilience.md 참고.
 */

/** `man caffeinate` LOCATION 절이 명시한 고정 경로. launchd 의 PATH 에 의존하지 않으려고 절대경로를 쓴다. */
const CAFFEINATE_BIN = "/usr/bin/caffeinate";

/**
 * 어서션 누수 최후 방어선(초). `-t` 만료 시 caffeinate 가 스스로 어서션을 놓고 종료한다.
 *
 * 해제 경로는 3중이다: ①정상 종료 시 finally 의 kill ②앱 프로세스 사망 시 `-w` ③그래도 남으면 `-t`.
 * ①②로 대부분 덮이지만, finally 가 돌지 못하는 버그가 생기면 이 앱은 launchd `KeepAlive` 로
 * 상시 떠 있는 데몬이라 `-w` 도 영원히 안 터진다 → 맥이 영영 안 자게 된다. 그건 사고보다 나쁘다.
 * 그래서 어떤 수집 배치보다도 훨씬 긴 2시간을 상한으로 둔다(정상 배치는 분 단위라 기능 손실 없음).
 */
const MAX_HOLD_SECONDS = 7200;

/**
 * caffeinate 플래그 선택 근거 (`man caffeinate` 원문 기준):
 * - `-i` 유휴 시스템 절전 방지(PreventUserIdleSystemSleep). 이 함수의 주력. 배터리 `sleep 1` 을 상쇄한다.
 * - `-m` 디스크 유휴 절전 방지. 설정이 `disksleep 10` 이라 긴 작업 중 디스크가 내려가 SQLite I/O 가
 *        튀는 걸 막는다.
 * - `-s` 시스템 절전 방지(PreventSystemSleep). man 이 "valid only when system is running on AC power"
 *        라고 못박은 **AC 전용** 옵션이다. 배터리에선 무해하게 무시되므로 항상 붙이고,
 *        AC 일 때만 이득을 본다. 유휴가 아닌 슬립까지 겨냥하는 유일한 어서션이라 포기할 이유가 없다.
 * - `-w <pid>` 감시 대상이 종료되면 어서션 자동 해제. **자기 자신의 pid** 를 넘겨 앱이 죽어도
 *        어서션이 살아남지 않게 한다. man 의 "This option is ignored when used with utility option"
 *        조건에 걸리지 않도록 utility 인자는 넘기지 않는다.
 * - `-t` 위 MAX_HOLD_SECONDS 주석 참고.
 *
 * 일부러 **뺀** 것:
 * - `-d`(디스플레이 절전 방지)·`-u`(사용자 활동 선언) — 백그라운드 수집에 화면을 켤 이유가 없다.
 *   배터리만 축내고, `-u` 는 꺼진 화면을 되레 켜버린다.
 */
export function buildCaffeinateArgs(watchPid: number): string[] {
  return ["-i", "-m", "-s", "-w", String(watchPid), "-t", String(MAX_HOLD_SECONDS)];
}

type Spawner = (bin: string, args: string[]) => ChildProcess;

const defaultSpawner: Spawner = (bin, args) => spawn(bin, args, { stdio: "ignore" });

let spawner: Spawner = defaultSpawner;
let spawnerInjected = false;

/**
 * 테스트 전용 스포너 주입. `null` 을 주면 실제 caffeinate 로 되돌린다.
 * 스포너가 주입된 동안에는 플랫폼 게이트(darwin 검사)를 건너뛰어 어느 OS 에서도 테스트가 돈다.
 */
export function __setCaffeinateSpawnerForTest(fn: Spawner | null): void {
  spawner = fn ?? defaultSpawner;
  spawnerInjected = fn !== null;
  refCount = 0;
  child = null;
  warned = false;
}

/** 현재 몇 개의 작업이 잠금을 잡고 있는지. 0 이면 어서션이 없어야 한다. */
let refCount = 0;
/** 살아 있는 caffeinate 자식. 잠금이 없으면 null. */
let child: ChildProcess | null = null;
/** caffeinate 를 못 쓰는 상황은 사실상 영구적이라, 배치마다 같은 경고를 도배하지 않도록 1회만 알린다. */
let warned = false;

/** 테스트·진단용 상태 조회(읽기 전용). */
export function wakeLockState(): { refCount: number; active: boolean } {
  return { refCount, active: child !== null };
}

function warnOnce(label: string, reason: string): void {
  if (warned) return;
  warned = true;
  log.warn(`절전 방지 어서션 없이 진행 [${label}]: ${reason} (작업 자체는 계속한다)`);
}

/**
 * 참조 카운트를 올리고, 첫 번째 획득이면 caffeinate 를 띄운다.
 * spawn() 은 동기 반환이라 refCount 증가와 자식 생성 사이에 await 가 없다 → 동시 호출 레이스 없음.
 */
function acquire(label: string): void {
  refCount += 1;
  if (refCount > 1) return; // 이미 누군가 잡고 있다. 어서션은 하나면 충분하다.

  if (!spawnerInjected && process.platform !== "darwin") {
    warnOnce(label, `caffeinate 는 macOS 전용인데 현재 플랫폼은 ${process.platform}`);
    return;
  }

  try {
    const c = spawner(CAFFEINATE_BIN, buildCaffeinateArgs(process.pid));
    // ENOENT 등은 spawn() 이 던지지 않고 'error' 이벤트로 온다. 핸들러가 없으면 프로세스가 죽는다.
    c.once("error", (e: Error) => {
      if (child === c) child = null;
      warnOnce(label, `caffeinate 실행 실패: ${e.message}`);
    });
    // 외부에서 죽거나 -t 가 만료되면 참조를 비워 둔다(죽은 pid 에 kill 을 쏘지 않도록).
    c.once("exit", () => {
      if (child === c) child = null;
    });
    // 잠금이 잡힌 채로도 node 가 정상 종료할 수 있게 이벤트 루프에서 뗀다.
    // 앱이 죽으면 -w 가 어서션을 회수하므로 unref 해도 누수되지 않는다.
    c.unref?.();
    child = c;
  } catch (e) {
    warnOnce(label, `caffeinate 실행 실패: ${(e as Error).message}`);
  }
}

/**
 * 참조 카운트를 내리고, 마지막 해제면 caffeinate 를 종료한다.
 *
 * 자식이 중간에 죽어 child 가 null 이 된 경우 **일부러 재생성하지 않는다.**
 * 재생성 로직은 누수 경로를 하나 더 만드는데, 여기서 최우선 불변식은
 * "refCount 가 0 이면 어서션도 0" 이다. 보호가 잠깐 끊기는 편이 영원히 안 자는 것보다 낫다.
 */
function release(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) return;

  const c = child;
  child = null;
  if (!c) return;
  try {
    c.kill("SIGTERM");
  } catch {
    // 이미 종료된 자식. 어서션은 프로세스와 함께 사라졌으므로 할 일이 없다.
  }
}

/** 작업이 도는 동안 시스템 절전을 막는다. 실패해도 작업 자체는 계속 진행한다. */
export async function withWakeLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  acquire(label);
  try {
    return await fn();
  } finally {
    // 어서션은 반드시 여기서 놓는다. 여기가 새면 맥이 영원히 안 잔다.
    release();
  }
}
