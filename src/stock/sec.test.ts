import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  latestEarningsRelease,
  latestPeriodicAccession,
  latestQuarter,
  parseTickerMap,
  quarterRows,
  recentFilings,
  secTicker,
} from "./sec.ts";

/**
 * 픽스처는 전부 **실제 SEC 응답**을 잘라낸 것이다(2026-11-01 수집). 합성 JSON 으로만 검증하면
 * 실제 응답의 형태(items 가 "2.02,9.01" 문자열, 8-K/A, 파생 4분기의 기간 겹침)를 놓친다.
 * companyfacts 는 실적 계산에 쓰는 개념만, 2023-06 이후 사실만 남겨 크기를 줄였다.
 *
 * 실적 기대값은 원본 day-trader-skill 의 `trader-analyst/facts.py` 를 같은 픽스처에 돌린 출력이다 —
 * 옮긴 TypeScript 가 원본과 같은 숫자를 내는지가 이 테스트의 핵심이다.
 */
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__/sec");
const load = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));

const AAPL_CIK = 320193;
const AVGO_CIK = 1730168;

test("티커 표: 실제 company_tickers.json 에서 티커 → CIK, 클래스주는 하이픈으로 맞춘다", () => {
  const m = parseTickerMap(load("company-tickers.json"));
  assert.equal(m.get("AAPL"), AAPL_CIK);
  assert.equal(m.get("AVGO"), AVGO_CIK);
  assert.equal(m.get("SNDK"), 2023554);
  // 네이버는 "BRK.B", SEC 는 "BRK-B" 로 적는다.
  assert.equal(m.get(secTicker("brk.b")), 1067983);
});

test("8-K 목록: 기간 안의 8-K 만, 항목 분해·중요 표시·원문 링크", () => {
  const sub = load("submissions-avgo.json");
  const f = recentFilings(sub, AVGO_CIK, "2026-10-25");
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].items, ["2.03"]);
  assert.equal(f[0].important, false); // 신규 채무는 중요 항목이 아니다(원본 IMPORTANT_ITEMS)
  assert.equal(f[0].filingDate, "2026-10-27");
  assert.equal(
    f[0].url,
    "https://www.sec.gov/Archives/edgar/data/1730168/000119312526434271/d148323d8k.htm"
  );

  // 창을 넓히면 실적 발표(2.02)가 중요 항목으로 잡히고, 10-Q 는 섞이지 않는다.
  const wide = recentFilings(sub, AVGO_CIK, "2026-09-01");
  assert.deepEqual(
    wide.map((x) => [x.filingDate, x.items.join(","), x.important]),
    [
      ["2026-10-27", "2.03", false],
      ["2026-09-02", "2.02,8.01,9.01", true],
    ]
  );
  assert.ok(wide.every((x) => x.form.startsWith("8-K")));
});

test("8-K/A(정정)도 공시로 잡는다 — 애플 2026-09-01 임원 변동 정정", () => {
  const f = recentFilings(load("submissions-aapl.json"), AAPL_CIK, "2026-08-15");
  assert.equal(f.length, 1);
  assert.equal(f[0].form, "8-K/A");
  assert.deepEqual(f[0].items, ["5.02"]);
  assert.equal(f[0].important, true);
});

test("실적 표: 애플 최신 분기 = 원본 facts.py 출력과 동일", () => {
  assert.deepEqual(latestQuarter(load("companyfacts-aapl.json")), {
    periodEnd: "2026-06-27",
    fiscal: "Q3 2026",
    derived: false,
    form: "10-Q",
    filed: "2026-07-31",
    revenue: 109417000000,
    revenueYoy: 16.4,
    netIncome: 29789000000,
    netIncomeYoy: 27.1,
    epsDiluted: 2.02,
    epsYoy: 28.7,
    grossMargin: 50.1,
    operatingMargin: 32.6,
    netMargin: 27.2,
  });
});

test("실적 표: 브로드컴 최신 분기 = 원본 facts.py 출력과 동일", () => {
  const q = latestQuarter(load("companyfacts-avgo.json"));
  assert.equal(q?.fiscal, "Q3 2026");
  assert.equal(q?.periodEnd, "2026-08-02");
  assert.equal(q?.revenue, 29591000000);
  assert.equal(q?.revenueYoy, 85.5);
  assert.equal(q?.netIncomeYoy, 216.1);
  assert.equal(q?.epsDiluted, 2.68);
  assert.equal(q?.epsYoy, 215.3);
  assert.equal(q?.operatingMargin, 53.9);
});

test("파생 4분기: 10-K 연간 − 3개 분기 (애플 FY2025 Q4)", () => {
  const rows = quarterRows(load("companyfacts-aapl.json"), 4);
  assert.deepEqual(
    rows.map((r) => r.fiscal),
    ["Q3 2026", "Q2 2026", "Q1 2026", "Q4 2025"]
  );
  const q4 = rows[3];
  assert.equal(q4.derived, true);
  assert.equal(q4.form, "10-K");
  assert.equal(q4.revenue, 102466000000);
  assert.equal(q4.revenueYoy, 7.9);
  assert.equal(q4.netIncome, 27466000000);
  assert.equal(q4.netIncomeYoy, 86.4);
  assert.equal(q4.epsDiluted, 1.84);
  assert.equal(q4.epsYoy, 89.7);
  assert.equal(q4.operatingMargin, 31.6);
});

test("실적 발표 지연: 2.02 가 분기보고서보다 뒤면 감지 대상, 앞이면 아니다", () => {
  const sub = load("submissions-avgo.json");
  // 실제: 2.02(09-02) 다음에 10-Q(09-10) — 이미 반영됐다.
  assert.equal(latestEarningsRelease(sub, AVGO_CIK)?.filingDate, "2026-09-02");
  assert.equal(latestPeriodicAccession(sub), "0001730168-26-000080");

  // 실제 응답 맨 앞에 '10-Q 보다 뒤의 실적 발표'를 하나 끼워 넣는다(다음 분기 발표 직후 상황).
  const s = structuredClone(sub) as { filings: { recent: Record<string, string[]> } };
  const r = s.filings.recent;
  const row: Record<string, string> = {
    form: "8-K",
    filingDate: "2026-12-11",
    acceptanceDateTime: "2026-12-11T21:10:00.000Z",
    accessionNumber: "0001730168-26-000099",
    primaryDocument: "avgo-20261211.htm",
    items: "2.02,9.01",
    reportDate: "2026-12-11",
  };
  for (const k of Object.keys(r)) r[k].unshift(row[k] ?? "");
  assert.equal(latestEarningsRelease(s, AVGO_CIK)?.filingDate, "2026-12-11");
  // 분기보고서 키는 그대로다 — 실적 발표(8-K)는 companyfacts 를 다시 받을 이유가 아니다.
  assert.equal(latestPeriodicAccession(s), "0001730168-26-000080");
});

test("방어: 깨진 입력에는 빈 결과(throw 하지 않는다)", () => {
  assert.equal(parseTickerMap(null).size, 0);
  assert.deepEqual(recentFilings({}, 1, "2026-01-01"), []);
  assert.equal(latestEarningsRelease(undefined, 1), null);
  assert.equal(latestQuarter({ facts: {} }), null);
});
