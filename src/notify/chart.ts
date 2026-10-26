import { createCanvas } from "@napi-rs/canvas";
import { HAIRLINE, INK, MUTED, PAPER } from "./email-kit.ts";

const W = 540;
const H = 200;
const PAD = { top: 28, right: 14, bottom: 26, left: 56 };

// 메일 지면과 같은 인상(DESIGN.md Stock Chart · web/src/components/StockChart.tsx):
// 신문지 바탕에 잉크 선 하나, 가로 격자만 헤어라인, 축 눈금은 Mono 11px 흐린 잉크.
// 글꼴은 이 맥에 있는 이름을 앞에 둔다 — 캔버스는 웹폰트를 못 읽어서 목록 뒤쪽 일반 글꼴로 떨어진다.
const TICK_FONT = "11px Menlo, 'SF Mono', Courier, monospace";
const TITLE_FONT = "600 13px 'Apple SD Gothic Neo', sans-serif";
const TEXT_FONT = "13px 'Apple SD Gothic Neo', sans-serif";
const LEGEND_FONT = "11px 'Apple SD Gothic Neo', sans-serif";

/** 기본 y축 라벨. 원 단위 값은 "만" 으로 축약해야 눈금이 읽힌다. */
function manLabel(v: number): string {
  return `${Math.round(v / 10000).toLocaleString("ko-KR")}만`;
}

export interface ChartSeries {
  label: string;
  /** 선 색. 비우면 잉크 — 메일 차트의 선은 잉크 한 가지다. 여러 계열을 나눠야 할 때만 지정한다. */
  color?: string;
  /** 마지막 값 점 하나에만 칠할 색(증시 상승·하락). 비우면 끝점을 찍지 않는다. */
  endColor?: string;
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
  /** 픽셀 배율. 기본 2 — 레티나 화면에서 흐리지 않게 2배로 그리고, 메일 본문 img 의 width 로 원래 크기에 맞춘다. */
  scale?: number;
}): Buffer {
  const {
    labels,
    series,
    title,
    formatY = manLabel,
    emptyText = "아직 가격 데이터가 없습니다",
    width = W,
    height = H,
    scale = 2,
  } = opts;

  const canvas = createCanvas(Math.round(width * scale), Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale); // 아래 좌표는 전부 논리 크기(width×height) 기준

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);

  const n = labels.length;
  // values 가 labels 보다 길어도 x축 밖이라 무시한다.
  const drawable = series.filter((s) => s.values.slice(0, n).some((v) => v != null));
  const allVals = drawable
    .flatMap((s) => s.values.slice(0, n))
    .filter((v): v is number => v != null);

  if (n === 0 || allVals.length === 0) {
    ctx.fillStyle = INK;
    ctx.font = TITLE_FONT;
    ctx.fillText(title, PAD.left, 18);
    ctx.fillStyle = MUTED;
    ctx.font = TEXT_FONT;
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
  ctx.font = TICK_FONT;
  const yLabels = Array.from({ length: GRID + 1 }, (_, g) => formatY(min + (range * g) / GRID));
  const maxLabelW = Math.max(...yLabels.map((t) => ctx.measureText(t).width));
  const padLeft = Math.max(PAD.left, Math.ceil(maxLabelW) + 12);

  const plotW = width - padLeft - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const x0 = padLeft;
  const y0 = PAD.top;

  ctx.fillStyle = INK;
  ctx.font = TITLE_FONT;
  ctx.fillText(title, x0, 18);

  const xAt = (i: number) => (n === 1 ? x0 + plotW / 2 : x0 + (plotW * i) / (n - 1));
  const yAt = (v: number) => y0 + plotH - ((v - min) / range) * plotH;

  // 가로 격자(헤어라인) + y 라벨. 세로 격자는 없다.
  ctx.strokeStyle = HAIRLINE;
  ctx.lineWidth = 1;
  ctx.font = TICK_FONT;
  yLabels.forEach((text, g) => {
    // 0.5 오프셋 — 1px 선이 두 픽셀에 번져 회색 2px 로 보이지 않게 픽셀 격자에 맞춘다.
    const y = Math.round(yAt(min + (range * g) / GRID)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + plotW, y);
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.fillText(text, x0 - 6 - ctx.measureText(text).width, y + 4);
  });

  // x 라벨 (시작/끝)
  ctx.fillStyle = MUTED;
  ctx.fillText(labels[0], x0, height - 8);
  if (n > 1) {
    const last = labels[n - 1];
    ctx.fillText(last, x0 + plotW - ctx.measureText(last).width, height - 8);
  }

  // 라인 (null 구간은 건너뛰되 연결). 점은 찍지 않고, 끝점 하나만 endColor 로 칠한다.
  for (const s of drawable) {
    ctx.strokeStyle = s.color ?? INK;
    ctx.lineWidth = 1.75;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    let started = false;
    let lastIdx = -1;
    ctx.beginPath();
    s.values.slice(0, n).forEach((v, i) => {
      if (v == null) return;
      lastIdx = i;
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
    const lastVal = lastIdx >= 0 ? s.values[lastIdx] : null;
    if (s.endColor && lastVal != null) {
      ctx.fillStyle = s.endColor;
      ctx.beginPath();
      ctx.arc(xAt(lastIdx), yAt(lastVal), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 범례: 계열이 둘 이상일 때만 — 하나면 제목이 곧 설명이다. 우측 정렬, 실제 폭을 재서 배치한다.
  if (drawable.length > 1) {
    const SWATCH = 10;
    const SWATCH_GAP = 4;
    const ENTRY_GAP = 12;
    ctx.font = LEGEND_FONT;
    const entryW = (s: ChartSeries) => SWATCH + SWATCH_GAP + ctx.measureText(s.label).width;
    const legendW =
      drawable.reduce((sum, s) => sum + entryW(s), 0) + ENTRY_GAP * (drawable.length - 1);
    let lx = x0 + plotW - legendW;
    for (const s of drawable) {
      ctx.fillStyle = s.color ?? INK;
      ctx.fillRect(lx, 8, SWATCH, SWATCH);
      ctx.fillStyle = MUTED;
      ctx.fillText(s.label, lx + SWATCH + SWATCH_GAP, 17);
      lx += entryW(s) + ENTRY_GAP;
    }
  }

  return canvas.toBuffer("image/png");
}
