// 실행(루트에서): npx tsx --test "web/src/**/*.test.ts"
// 읽음 기록 저장소(seen.ts)의 규칙만 검사한다. 훅(useNewMarks)의 머무름 타이머는 브라우저에서 확인한다.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

// node 에는 브라우저 localStorage 가 없다(있어도 파일 지정이 필요하다). 같은 모양의 메모리 저장소로 대신한다.
const mem = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  },
});

const { ensureBaseline, markSeen, readSeen, unseenIds } = await import("./seen.ts");

beforeEach(() => mem.clear());

test("기록이 없는 탭은 '신규'가 없고, 첫 기준 잡기 뒤에야 새 항목을 센다", () => {
  assert.equal(readSeen("news"), null);
  assert.deepEqual(unseenIds("news", ["a", "b"]), []); // 첫 실행 = 전부 신규로 뒤덮지 않는다
  assert.equal(ensureBaseline("news", ["a", "b"]), true);
  assert.equal(ensureBaseline("news", ["a", "b", "c"]), false); // 이미 기록이 있으면 덮지 않는다
  assert.deepEqual(unseenIds("news", ["c", "a", "d"]), ["c", "d"]); // 화면 순서 유지
});

test("본 것으로 기록하면 그 항목은 더 이상 신규가 아니고, 탭끼리는 따로 센다", () => {
  ensureBaseline("news", ["a"]);
  ensureBaseline("youtube", ["v1"]);
  markSeen("news", ["a", "b"]);
  assert.deepEqual(unseenIds("news", ["a", "b", "c"]), ["c"]);
  assert.deepEqual(unseenIds("youtube", ["v1", "b"]), ["b"]); // 뉴스에서 본 id 는 유튜브와 무관
});

test("보관 상한을 넘으면 오래된 id 부터 잊는다(최근에 본 것이 앞)", () => {
  const old = Array.from({ length: 800 }, (_, i) => `old-${i}`);
  markSeen("events", old);
  markSeen("events", ["fresh-1", "fresh-2"]);
  const seen = readSeen("events")!;
  assert.equal(seen.size, 800);
  assert.ok(seen.has("fresh-1") && seen.has("fresh-2"));
  assert.ok(!seen.has("old-799") && !seen.has("old-798")); // 가장 뒤(오래된) 둘이 밀려났다
  assert.ok(seen.has("old-0"));
});

test("저장소가 깨져 있어도 예외 없이 '기록 없음'으로 동작한다", () => {
  mem.set("dd.seen.v1", "{not json");
  assert.equal(readSeen("news"), null);
  assert.deepEqual(unseenIds("news", ["a"]), []);
  assert.equal(ensureBaseline("news", ["a"]), true);
  assert.deepEqual(unseenIds("news", ["a", "b"]), ["b"]);
});
