import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLineChartPng } from "./chart.ts";

// 차트 생성 실패는 email.ts 가 warn 만 하고 메일을 그대로 보내므로
// 회귀가 나도 아무도 모른다. 경계 입력에서 throw 없이 PNG 가 나오는지를 고정한다.

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG

function assertPng(buf: Buffer) {
  assert.ok(Buffer.isBuffer(buf), "Buffer 가 아님");
  assert.ok(buf.length > 0, "빈 버퍼");
  assert.deepEqual(buf.subarray(0, 4), PNG_SIG, "PNG 시그니처 불일치");
}

/** naver = 네이버 최저가, compare = 가격비교 소스 최저가. 종합 최저가는 둘 중 최저. */
// ── renderLineChartPng (일반화된 진입점) ──

test("renderLineChartPng: labels 가 비면 안내 텍스트 PNG", () => {
  assertPng(renderLineChartPng({ labels: [], series: [], title: "빈 라벨" }));
});

test("renderLineChartPng: series 가 비면 안내 텍스트 PNG", () => {
  assertPng(renderLineChartPng({ labels: ["07-01", "07-02"], series: [], title: "시리즈 없음" }));
});

test("renderLineChartPng: 전부 null 이어도 PNG", () => {
  const png = renderLineChartPng({
    labels: ["07-01", "07-02"],
    series: [{ label: "종가", color: "#2E86DE", values: [null, null] }],
    title: "전부 null",
  });
  assertPng(png);
});

test("renderLineChartPng: 단일 포인트 PNG", () => {
  const png = renderLineChartPng({
    labels: ["07-01"],
    series: [{ label: "종가", color: "#2E86DE", values: [346_500] }],
    title: "단일",
  });
  assertPng(png);
});

test("renderLineChartPng: min===max 평탄 PNG", () => {
  const png = renderLineChartPng({
    labels: ["07-01", "07-02", "07-03"],
    series: [{ label: "종가", color: "#2E86DE", values: [346_500, 346_500, 346_500] }],
    title: "평탄",
  });
  assertPng(png);
});

test("renderLineChartPng: 값이 전부 0 이어도 PNG (range 0 나눗셈 방어)", () => {
  const png = renderLineChartPng({
    labels: ["07-01", "07-02"],
    series: [{ label: "종가", color: "#2E86DE", values: [0, 0] }],
    title: "전부 0",
  });
  assertPng(png);
});

test("renderLineChartPng: 음수 값도 PNG (등락률 시리즈 가정)", () => {
  const png = renderLineChartPng({
    labels: ["07-01", "07-02", "07-03"],
    series: [{ label: "등락률", color: "#E8833A", values: [-1.2, 0.4, -3.5] }],
    title: "음수",
    formatY: (v) => `${v.toFixed(1)}%`,
  });
  assertPng(png);
});

test("renderLineChartPng: values 가 labels 보다 길어도 PNG", () => {
  const png = renderLineChartPng({
    labels: ["07-01", "07-02"],
    series: [{ label: "종가", color: "#2E86DE", values: [100, 200, 300, 400] }],
    title: "길이 불일치",
  });
  assertPng(png);
});

test("renderLineChartPng: 커스텀 emptyText / width / height 적용", () => {
  const png = renderLineChartPng({
    labels: [],
    series: [],
    title: "커스텀",
    emptyText: "아직 시세 데이터가 없습니다",
    width: 720,
    height: 300,
  });
  assertPng(png);
});

test("renderLineChartPng: 시리즈 5개(범례 폭 계산) PNG", () => {
  const colors = ["#4A90D9", "#E8833A", "#2E86DE", "#7B68EE", "#3CB371"];
  const png = renderLineChartPng({
    labels: ["07-01", "07-02", "07-03"],
    series: colors.map((color, i) => ({
      label: `시리즈${i + 1}`,
      color,
      values: [100 + i, 120 + i, 90 + i],
    })),
    title: "다중 범례",
  });
  assertPng(png);
});

// 주식 탭이 실제로 부를 형태 — 이 호출이 컴파일·동작하는지가 일반화의 목적이다.
test("renderLineChartPng: 주식 호출 형태 (formatY 로 원 단위 그대로)", () => {
  const history = [
    { date: "20260615", close: 332_000 },
    { date: "20260616", close: 341_000 },
    { date: "20260617", close: 346_500 },
  ];
  const png = renderLineChartPng({
    labels: history.map((p) => p.date),
    series: [{ label: "종가", color: "#2E86DE", values: history.map((p) => p.close) }],
    title: "삼성전자 최근 20거래일",
    formatY: (v) => v.toLocaleString("ko-KR"),
  });
  assertPng(png);
});
