import { db } from "../db/index.ts";
import { log } from "../util/log.ts";
import type { LottoDraw } from "../../shared/lotto.ts";
import { LOTTO_MAX_NUMBER, LOTTO_PICK } from "../../shared/lotto.ts";

/**
 * 동행복권 회차 수집기.
 *
 * ## 왜 예전 API 를 쓰지 않는가
 * 널리 알려진 `common.do?method=getLottoNumber&drwNo=N` 은 **더 이상 동작하지 않는다.**
 * 2026-07-29 실측: 어떤 헤더·쿠키 조합으로도 302 → /error.html 로 튕긴다(WAF). 이 사실을
 * 남겨 두지 않으면 다음 사람이 헤더를 바꿔 가며 반나절을 태운다.
 *
 * 현재 살아 있는 경로는 아래 `LIST_URL` 이며, **한 번에 10회차씩** 내려준다. 1234회차 전체를
 * 124회 요청으로 받을 수 있어 회차당 1요청(1234회)보다 10배 싸다.
 *
 * robots.txt 확인(2026-07-29): Disallow 는 `/resources/`, `/winImages/` 뿐이고 이 경로는 허용된다.
 */

/**
 * 회차 목록 JSON.
 *
 * ⚠️ `srchDir=center` 는 이름 그대로 **요청 회차를 가운데 두고** 위아래를 함께 준다:
 * `srchLtEpsd=R` → 대략 `R+4 … R-5` 의 10건(내림차순). 양 끝에서는 잘린 만큼 반대쪽으로
 * 늘어난다 — R=10 이면 14~5, R=1 이면 10~1, R=최신이면 최신~최신-9.
 * R > 최신이면 빈 목록이다(최신 회차 탐색이 이 성질을 쓴다).
 *
 * 실측(2026-07-29)으로 확인한 동작이다. "R 부터 아래로 10건"으로 착각하면 백필이 1~4회차를
 * 조용히 빠뜨린다(실제로 그렇게 만들었다가 잡았다). 그래서 아래 syncDraws 는 창의 모양을
 * 가정하지 않고 **받은 회차를 지워 나가는 방식**으로 되어 있다.
 */
const LIST_URL = "https://www.dhlottery.co.kr/lt645/selectPstLt645InfoNew.do";

/** 1회차 추첨일. 최신 회차 추정의 기준점이다. */
const ROUND1_DATE = Date.UTC(2002, 11, 7);

/** 서버를 두드리는 간격. 124회 연속 요청이라 최소한의 예의는 지킨다. */
const REQUEST_GAP_MS = 150;

const HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-language": "ko-KR,ko;q=0.9",
  "user-agent": "daily-price-dashboard/0.1 (personal lotto backtest)",
};

interface RawItem {
  ltEpsd: number;
  tm1WnNo: number;
  tm2WnNo: number;
  tm3WnNo: number;
  tm4WnNo: number;
  tm5WnNo: number;
  tm6WnNo: number;
  bnsWnNo: number;
  /** YYYYMMDD */
  ltRflYmd: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "20260725" → "2026-07-25". 형식이 어긋나면 null(그 회차만 버린다). */
function parseYmd(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{8}$/.test(v)) return null;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

/**
 * 원본 항목 → LottoDraw. **여기서 거른 것은 저장되지 않는다.**
 * 실험의 정답지가 오염되면 점수 전체가 무의미해지므로, 번호 범위·중복·보너스 충돌까지 본다.
 */
export function normalizeItem(raw: unknown): LottoDraw | null {
  const r = raw as Partial<RawItem>;
  const round = Number(r?.ltEpsd);
  if (!Number.isInteger(round) || round < 1) return null;

  const drawDate = parseYmd(r?.ltRflYmd);
  if (!drawDate) return null;

  const numbers = [r?.tm1WnNo, r?.tm2WnNo, r?.tm3WnNo, r?.tm4WnNo, r?.tm5WnNo, r?.tm6WnNo].map(
    Number
  );
  const bonus = Number(r?.bnsWnNo);

  const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= LOTTO_MAX_NUMBER;
  if (numbers.length !== LOTTO_PICK || !numbers.every(inRange) || !inRange(bonus)) return null;
  if (new Set(numbers).size !== LOTTO_PICK) return null;
  if (numbers.includes(bonus)) return null; // 보너스는 본번호와 겹칠 수 없다

  return { round, drawDate, numbers: [...numbers].sort((a, b) => a - b), bonus };
}

/** 회차 목록 1페이지. 네트워크/파싱 실패는 throw — 호출부가 재시도를 판단한다. */
export async function fetchPage(round: number): Promise<LottoDraw[]> {
  const url = `${LIST_URL}?srchDir=center&srchLtEpsd=${round}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`동행복권 응답 ${res.status} (회차 ${round})`);
  const payload = (await res.json()) as { data?: { list?: unknown[] } };
  const list = payload?.data?.list;
  if (!Array.isArray(list)) throw new Error(`동행복권 응답 형식 오류 (회차 ${round})`);
  return list.map(normalizeItem).filter((d): d is LottoDraw => d !== null);
}

/** 오늘 기준으로 있을 법한 최신 회차. 이분탐색의 상한을 잡는 용도라 넉넉해도 된다. */
export function estimateLatestRound(now: Date = new Date()): number {
  const weeks = Math.floor((now.getTime() - ROUND1_DATE) / (7 * 24 * 3600 * 1000));
  return Math.max(1, weeks + 1);
}

/**
 * 실제로 존재하는 최신 회차. 추정치 주변을 이분탐색한다(약 5요청).
 *
 * 최신 회차를 HTML 페이지에서 긁지 않는 이유: HTML 은 개편마다 깨지지만 이 JSON 은
 * '없는 회차면 빈 목록'이라는 성질만 쓰므로 마크업 변경에 영향을 받지 않는다.
 */
export async function findLatestRound(now: Date = new Date()): Promise<number> {
  const exists = async (r: number): Promise<boolean> => {
    const page = await fetchPage(r);
    return page.some((d) => d.round === r);
  };

  let lo = 1; // 1회차는 항상 존재한다(2002-12-07)
  let hi = estimateLatestRound(now) + 10; // 추정이 뒤처져도 덮이도록 여유를 둔다
  let probed = false; // 탐색 중 한 번이라도 '존재함'을 확인했는가
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    await sleep(REQUEST_GAP_MS);
    if (await exists(mid)) {
      lo = mid;
      probed = true;
    } else {
      hi = mid - 1;
    }
  }

  // ⚠️ **결과를 반드시 검증한다.** 이 탐색은 '빈 목록 = 없는 회차' 라는 한 가지 신호에만
  // 기대는데, 그 신호는 API 가 바뀌거나(파라미터 규격·필드명) 소프트 차단되면 **전 구간에서**
  // 빈 목록으로 나온다. 그러면 모든 mid 가 false 가 되어 검증 없는 lo=1 이 그대로 반환되고,
  // 호출부는 "최신은 1회차" 라는 거짓을 정상 결과로 받아 조용히 아무것도 하지 않는다.
  // 실패는 조용한 no-op 이 아니라 예외여야 한다.
  if (!probed) {
    await sleep(REQUEST_GAP_MS);
    if (!(await exists(1))) {
      throw new Error(
        "동행복권에서 어떤 회차도 확인되지 않았습니다(엔드포인트 변경 또는 차단 가능성)."
      );
    }
  }

  // 회차는 되돌아가지 않는다. 이미 가진 것보다 작게 나왔다면 그것도 응답이 이상하다는 신호다.
  const known = drawRange().latest;
  if (known !== null && lo < known) {
    throw new Error(`최신 회차 탐색 결과(${lo})가 이미 저장된 회차(${known})보다 작습니다.`);
  }

  return lo;
}

// ── 저장 ──

/**
 * 회차는 불변이라 INSERT OR IGNORE 로 충분하다.
 * ⚠️ UPDATE 를 쓰면 안 된다 — 이미 채점이 끝난 회차의 정답이 나중에 바뀌면 과거 점수가
 * 거짓이 되는데, 그 사실이 아무 데도 남지 않는다.
 */
export function saveDraws(draws: LottoDraw[]): number {
  if (draws.length === 0) return 0;
  const stmt = db().prepare(
    `INSERT OR IGNORE INTO lotto_draws (round, draw_date, n1, n2, n3, n4, n5, n6, bonus, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  let added = 0;
  for (const d of draws) {
    const r = stmt.run(
      d.round,
      d.drawDate,
      d.numbers[0],
      d.numbers[1],
      d.numbers[2],
      d.numbers[3],
      d.numbers[4],
      d.numbers[5],
      d.bonus,
      now
    );
    added += Number(r.changes ?? 0);
  }
  return added;
}

interface DrawRow {
  round: number;
  draw_date: string;
  n1: number;
  n2: number;
  n3: number;
  n4: number;
  n5: number;
  n6: number;
  bonus: number;
}

function toDraw(r: DrawRow): LottoDraw {
  return {
    round: r.round,
    drawDate: r.draw_date,
    numbers: [r.n1, r.n2, r.n3, r.n4, r.n5, r.n6],
    bonus: r.bonus,
  };
}

/** 회차 오름차순 전체. 1200여 행이라 통째로 읽어도 부담이 없다(실험이 매번 전 이력을 본다). */
export function listDraws(): LottoDraw[] {
  const rows = db()
    .prepare(`SELECT * FROM lotto_draws ORDER BY round ASC`)
    .all() as unknown as DrawRow[];
  return rows.map(toDraw);
}

export function getDraw(round: number): LottoDraw | null {
  const row = db()
    .prepare(`SELECT * FROM lotto_draws WHERE round = ?`)
    .get(round) as unknown as DrawRow | undefined;
  return row ? toDraw(row) : null;
}

/** DB 가 가진 회차 범위. 비어 있으면 둘 다 null. */
export function drawRange(): { first: number | null; latest: number | null; count: number } {
  const row = db()
    .prepare(`SELECT MIN(round) AS lo, MAX(round) AS hi, COUNT(*) AS n FROM lotto_draws`)
    .get() as unknown as { lo: number | null; hi: number | null; n: number };
  return { first: row?.lo ?? null, latest: row?.hi ?? null, count: Number(row?.n ?? 0) };
}

/** 이미 저장된 회차 번호 집합. 백필이 '건너뛸 페이지'를 판단하는 데 쓴다. */
function savedRounds(): Set<number> {
  const rows = db().prepare(`SELECT round FROM lotto_draws`).all() as unknown as Array<{
    round: number;
  }>;
  return new Set(rows.map((r) => r.round));
}

export interface SyncResult {
  latest: number;
  added: number;
  pages: number;
  errors: number;
}

/**
 * 없는 회차를 모두 채운다. 첫 실행은 1~최신 전량(≈124요청), 이후는 새 회차만(보통 0~1페이지).
 *
 * 페이지가 이미 전부 DB 에 있으면 요청 자체를 건너뛴다 — 매주 동기화가 124요청을 반복하면
 * 그건 수집이 아니라 크롤링 부하다.
 */
/**
 * ⚠️ 동시 실행 가드는 여기 없다 — 호출부(`cycle.ts`)의 사이클 플래그가 유일한 진입점을
 * 지키고 있고, 그 함수가 이것을 `await` 한다. 예전에는 '동기화 중'을 노출해 실험 시작 버튼이
 * 반쯤 찬 이력을 읽는 것을 막았지만, 버튼이 없어져 그 경로 자체가 사라졌다.
 */
export async function syncDraws(opts: { force?: boolean } = {}): Promise<SyncResult> {
  const latest = await findLatestRound();
  const have = opts.force ? new Set<number>() : savedRounds();

  let added = 0;
  let pages = 0;
  let errors = 0;

  // 아직 없는 회차 목록. 응답 창의 모양을 가정하지 않고, **가장 큰 미보유 회차를 중심으로**
  // 요청한 뒤 받은 것을 지운다. 창이 위로 치우치든 아래로 치우치든 언젠가 비고, 페이징 규칙이
  // 바뀌어도 빠뜨리지 않는다.
  const wanted = new Set<number>();
  for (let r = 1; r <= latest; r++) if (!have.has(r)) wanted.add(r);

  // 무한 루프 방지: 한 회차당 최대 1회 요청이면 충분하고도 남는다(정상은 그 1/10).
  let budget = wanted.size + 10;

  while (wanted.size > 0 && budget > 0) {
    budget -= 1;
    const anchor = Math.max(...wanted);
    try {
      await sleep(REQUEST_GAP_MS);
      const page = await fetchPage(anchor);
      pages += 1;
      added += saveDraws(page);
      let progressed = false;
      for (const d of page) {
        have.add(d.round);
        if (wanted.delete(d.round)) progressed = true;
      }
      if (!progressed) {
        // 요청한 회차 주변을 하나도 못 받았다 — 더 두드려도 같은 결과다.
        wanted.delete(anchor);
        errors += 1;
        log.warn(`로또 회차 ${anchor} 응답에 원하는 회차가 없음 — 건너뜀`);
      }
    } catch (e) {
      wanted.delete(anchor); // 이 회차는 이번 동기화에서 포기(다음 실행에서 다시 시도된다)
      errors += 1;
      log.warn(`로또 회차 ${anchor} 주변 수집 실패: ${(e as Error).message}`);
    }
  }

  if (added > 0 || errors > 0) {
    log.info(`로또 회차 동기화: 최신 ${latest}회차, 신규 ${added}건, 요청 ${pages}회, 실패 ${errors}회`);
  }
  return { latest, added, pages, errors };
}
