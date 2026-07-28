import { createCanvas } from "@napi-rs/canvas";
import type { PricePoint } from "../../shared/types.ts";

const W = 540;
const H = 200;
const PAD = { top: 28, right: 14, bottom: 26, left: 56 };

const NAVER = "#4A90D9";
/** 종합 최저가 선(구 쿠팡 선 자리). 대시보드 recharts 와 같은 색을 쓴다. */
const OVERALL = "#E8833A";

/** 기본 y축 라벨. 가격 탭은 원 단위라 "만" 으로 축약해야 눈금이 읽힌다. */
function manLabel(v: number): string {
  return `${Math.round(v / 10000).toLocaleString("ko-KR")}만`;
}

export interface ChartSeries {
  label: string;
  color: string;
  /** labels 와 같은 인덱스로 대응. 결측은 null(선은 끊지 않고 이어 붙인다). */
  values: (number | null)[];
}

/**
 * 이메일 첨부용 라인 차트 PNG 생성. 데이터가 없으면 안내 텍스트만 그린다.
 * 값이 하나도 없는 시리즈는 선도 범례도 그리지 않는다 — 빈 범례가 "수집됐는데 0"으로 오해된다.
 */
export function renderLineChartPng(opts: {
  labels: string[];
  series: ChartSeries[];
  title: string;
  formatY?: (v: number) => string;
  emptyText?: string;
  width?: number;
  height?: number;
}): Buffer {
  const {
    labels,
    series,
    title,
    formatY = manLabel,
    emptyText = "아직 가격 데이터가 없습니다",
    width = W,
    height = H,
  } = opts;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const n = labels.length;
  // values 가 labels 보다 길어도 x축 밖이라 무시한다.
  const drawable = series.filter((s) => s.values.slice(0, n).some((v) => v != null));
  const allVals = drawable
    .flatMap((s) => s.values.slice(0, n))
    .filter((v): v is number => v != null);

  if (n === 0 || allVals.length === 0) {
    ctx.fillStyle = "#222222";
    ctx.font = "bold 14px sans-serif";
    ctx.fillText(title, PAD.left, 18);
    ctx.fillStyle = "#999999";
    ctx.font = "13px sans-serif";
    ctx.fillText(emptyText, PAD.left, height / 2);
    return canvas.toBuffer("image/png");
  }

  let min = Math.min(...allVals);
  let max = Math.max(...allVals);
  if (min === max) {
    // 평평한 경우 약간의 여백. 값이 0 이면 비율 여백도 0 이라 range 0 → 좌표가 NaN 이 된다.
    const gap = Math.abs(min) * 0.02 || 1;
    min -= gap;
    max += gap;
  }
  const range = max - min;

  // y 라벨을 먼저 재서 좌측 여백을 정한다. formatY 가 긴 문자열("1,990,000")을 내면
  // 고정 여백으로는 라벨이 플롯 영역을 침범한다.
  const GRID = 3;
  ctx.font = "11px sans-serif";
  const yLabels = Array.from({ length: GRID + 1 }, (_, g) => formatY(min + (range * g) / GRID));
  const maxLabelW = Math.max(...yLabels.map((t) => ctx.measureText(t).width));
  const padLeft = Math.max(PAD.left, Math.ceil(maxLabelW) + 12);

  const plotW = width - padLeft - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const x0 = padLeft;
  const y0 = PAD.top;

  ctx.fillStyle = "#222222";
  ctx.font = "bold 14px sans-serif";
  ctx.fillText(title, x0, 18);

  const xAt = (i: number) => (n === 1 ? x0 + plotW / 2 : x0 + (plotW * i) / (n - 1));
  const yAt = (v: number) => y0 + plotH - ((v - min) / range) * plotH;

  // 가로 그리드 + y 라벨
  ctx.strokeStyle = "#eeeeee";
  ctx.lineWidth = 1;
  ctx.font = "11px sans-serif";
  yLabels.forEach((text, g) => {
    const y = yAt(min + (range * g) / GRID);
    ctx.strokeStyle = "#eeeeee";
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + plotW, y);
    ctx.stroke();
    ctx.fillStyle = "#999999";
    ctx.fillText(text, x0 - 6 - ctx.measureText(text).width, y + 4);
  });

  // x 라벨 (시작/끝)
  ctx.fillStyle = "#999999";
  ctx.fillText(labels[0], x0, height - 8);
  if (n > 1) {
    const last = labels[n - 1];
    ctx.fillText(last, x0 + plotW - ctx.measureText(last).width, height - 8);
  }

  // 라인 (null 구간은 건너뛰되 연결)
  for (const s of drawable) {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = 2;
    let started = false;
    ctx.beginPath();
    s.values.slice(0, n).forEach((v, i) => {
      if (v == null) return;
      const x = xAt(i);
      const y = yAt(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
    s.values.slice(0, n).forEach((v, i) => {
      if (v == null) return;
      ctx.beginPath();
      ctx.arc(xAt(i), yAt(v), 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // 범례: 우측 정렬. 라벨 길이가 제각각이라 실제 폭을 재서 배치한다.
  const SWATCH = 10;
  const SWATCH_GAP = 4;
  const ENTRY_GAP = 12;
  ctx.font = "11px sans-serif";
  const entryW = (s: ChartSeries) => SWATCH + SWATCH_GAP + ctx.measureText(s.label).width;
  const legendW =
    drawable.reduce((sum, s) => sum + entryW(s), 0) + ENTRY_GAP * (drawable.length - 1);
  let lx = x0 + plotW - legendW;
  for (const s of drawable) {
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, 8, SWATCH, SWATCH);
    ctx.fillStyle = "#666";
    ctx.fillText(s.label, lx + SWATCH + SWATCH_GAP, 17);
    lx += entryW(s) + ENTRY_GAP;
  }

  return canvas.toBuffer("image/png");
}

/**
 * 이메일용 가격 추이 라인 차트 PNG (네이버=파랑, 종합 최저가=주황).
 * recharts 대시보드와 동일한 색/구성.
 * (쿠팡 선은 2026-07-28 쿠팡 수집 제거와 함께 종합 최저가 선으로 대체됐다.)
 */
export function renderPriceChartPng(points: PricePoint[], title: string): Buffer {
  return renderLineChartPng({
    labels: points.map((p) => p.date.slice(5)),
    series: [
      { label: "네이버", color: NAVER, values: points.map((p) => p.naverLowest) },
      { label: "종합 최저가", color: OVERALL, values: points.map((p) => p.overallLowest) },
    ],
    title,
  });
}
