import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import {
  __setCaffeinateSpawnerForTest,
  buildCaffeinateArgs,
  wakeLockState,
  withWakeLock,
} from "./power.ts";

/**
 * caffeinate 대역. 실제 바이너리를 띄우면 테스트가 느려질 뿐 아니라
 * "실패해도 작업은 계속된다" 같은 경로를 재현할 수 없어서 스포너를 주입한다.
 */
class FakeCaffeinate extends EventEmitter {
  killed: string[] = [];
  unrefCount = 0;
  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
  unref(): void {
    this.unrefCount += 1;
  }
}

/** 생성된 대역들을 기록하는 스포너를 설치하고, 기록 배열을 돌려준다. */
function installFakeSpawner(): { spawned: FakeCaffeinate[]; args: string[][] } {
  const spawned: FakeCaffeinate[] = [];
  const args: string[][] = [];
  __setCaffeinateSpawnerForTest((_bin, a) => {
    args.push(a);
    const fake = new FakeCaffeinate();
    spawned.push(fake);
    return fake as unknown as ChildProcess;
  });
  return { spawned, args };
}

test("caffeinate 인자는 -i/-m/-s + 자기 pid 감시 + 누수 상한을 모두 건다", () => {
  const args = buildCaffeinateArgs(4242);
  assert.ok(args.includes("-i"), "유휴 시스템 절전 방지");
  assert.ok(args.includes("-m"), "디스크 절전 방지");
  assert.ok(args.includes("-s"), "AC 한정 시스템 절전 방지");
  // -w 는 앱이 죽어도 어서션이 남지 않게 하는 핵심 장치다. 값이 감시 대상 pid 여야 한다.
  assert.equal(args[args.indexOf("-w") + 1], "4242");
  // -t 는 finally 가 못 돌았을 때의 최후 방어선. 없으면 데몬 특성상 영구 누수가 가능하다.
  assert.ok(args.includes("-t"));
  assert.ok(Number(args[args.indexOf("-t") + 1]) > 0);
  // 화면을 켜는 옵션은 백그라운드 수집에 불필요하므로 절대 들어가면 안 된다.
  assert.ok(!args.includes("-d"));
  assert.ok(!args.includes("-u"));
});

test("정상 실행: 작업 중에는 어서션을 잡고, 끝나면 반드시 놓는다", async () => {
  const { spawned } = installFakeSpawner();

  const result = await withWakeLock("정상", async () => {
    assert.deepEqual(wakeLockState(), { refCount: 1, active: true });
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(wakeLockState(), { refCount: 0, active: false });
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].killed, ["SIGTERM"]);
  // node 정상 종료를 막지 않도록 이벤트 루프에서 떼어야 한다.
  assert.equal(spawned[0].unrefCount, 1);
});

test("fn 이 throw 해도 어서션은 해제된다 (누수 = 맥이 영원히 안 잠)", async () => {
  const { spawned } = installFakeSpawner();

  await assert.rejects(
    withWakeLock("실패", async () => {
      throw new Error("수집 실패");
    }),
    /수집 실패/
  );

  assert.deepEqual(wakeLockState(), { refCount: 0, active: false });
  assert.deepEqual(spawned[0].killed, ["SIGTERM"]);
});

test("spawn 이 던져도(caffeinate 없음) 작업은 정상 진행된다", async () => {
  __setCaffeinateSpawnerForTest(() => {
    throw new Error("spawn ENOENT /usr/bin/caffeinate");
  });

  let ran = false;
  const result = await withWakeLock("비 macOS", async () => {
    ran = true;
    return 42;
  });

  assert.equal(ran, true, "어서션을 못 잡아도 수집은 돌아야 한다");
  assert.equal(result, 42);
  assert.deepEqual(wakeLockState(), { refCount: 0, active: false });
});

test("spawn 후 'error' 이벤트가 와도 작업은 정상 진행되고 상태가 정리된다", async () => {
  const { spawned } = installFakeSpawner();

  const result = await withWakeLock("error 이벤트", async () => {
    // ENOENT 류는 spawn() 이 던지지 않고 비동기 'error' 로 온다.
    spawned[0].emit("error", new Error("ENOENT"));
    assert.equal(wakeLockState().active, false, "죽은 자식은 참조에서 비워져야 한다");
    return "계속";
  });

  assert.equal(result, "계속");
  assert.deepEqual(wakeLockState(), { refCount: 0, active: false });
  // 이미 죽은 자식에게 kill 을 쏘지 않는다.
  assert.deepEqual(spawned[0].killed, []);
});

test("중첩 호출은 참조 카운트로 묶여 caffeinate 를 하나만 띄우고 마지막에 한 번만 놓는다", async () => {
  const { spawned } = installFakeSpawner();

  await withWakeLock("바깥", async () => {
    assert.equal(wakeLockState().refCount, 1);

    await withWakeLock("안쪽", async () => {
      assert.deepEqual(wakeLockState(), { refCount: 2, active: true });
    });

    // 핵심 회귀: 안쪽이 끝났다고 어서션을 놓아버리면 바깥 작업이 보호를 잃는다.
    assert.deepEqual(wakeLockState(), { refCount: 1, active: true });
    assert.equal(spawned.length, 1, "중첩이어도 caffeinate 는 하나뿐");
    assert.deepEqual(spawned[0].killed, [], "바깥이 살아 있는 동안은 죽이지 않는다");
  });

  assert.deepEqual(wakeLockState(), { refCount: 0, active: false });
  assert.deepEqual(spawned[0].killed, ["SIGTERM"]);
});

test("병렬 호출도 어서션 하나를 공유하고 모두 끝난 뒤에 해제된다", async () => {
  const { spawned } = installFakeSpawner();

  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((r) => {
    releaseSlow = r;
  });

  const slow = withWakeLock("느린 작업", async () => {
    await slowGate;
    return "slow";
  });
  const fast = await withWakeLock("빠른 작업", async () => "fast");

  assert.equal(fast, "fast");
  // 빠른 쪽이 끝나도 느린 쪽이 남아 있으므로 어서션은 유지돼야 한다.
  assert.deepEqual(wakeLockState(), { refCount: 1, active: true });
  assert.equal(spawned.length, 1);

  releaseSlow();
  assert.equal(await slow, "slow");
  assert.deepEqual(wakeLockState(), { refCount: 0, active: false });
  assert.deepEqual(spawned[0].killed, ["SIGTERM"]);
});

test("해제 후 다시 획득하면 새 caffeinate 를 띄운다", async () => {
  const { spawned } = installFakeSpawner();

  await withWakeLock("1회차", async () => "a");
  await withWakeLock("2회차", async () => "b");

  assert.equal(spawned.length, 2, "배치마다 새로 잡아야 한다");
  assert.deepEqual(spawned[1].killed, ["SIGTERM"]);
  assert.deepEqual(wakeLockState(), { refCount: 0, active: false });

  // 다른 테스트 파일에 대역이 새지 않도록 실제 구현으로 되돌린다.
  __setCaffeinateSpawnerForTest(null);
});
