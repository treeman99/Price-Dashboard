import { createCanvas } from "@napi-rs/canvas";
import type { PricePoint } from "../../shared/types.ts";

const W = 540;
const H = 200;
const PAD = { top: 28, right: 14, bottom: 26, left: 56 };

const NAVER = "#4A90D9";
const COUPANG = "#E8833A";

function niceLabel(v: number): string {
  return `${Math.round(v / 10000).toLocaleString("ko-KR")}만`;
}

/**
 * 이메일용 가격 추이 라인 차트 PNG 생성 (네이버=파랑, 쿠팡=주황).
 * recharts 대시보드와 동일한 색/구성. 데이터 부족 시 안내 텍스트.
 */
export function renderPriceChartPng(points: PricePoint[], title: string): Buffer {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // 배경
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // 제목
  ctx.fillStyle = "#222222";
  ctx.font = "bold 14px sans-serif";
  ctx.fillText(title, PAD.left, 18);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x0 = PAD.left;
  const y0 = PAD.top;

  const naver = points.map((p) => p.naverLowest);
  const coupang = points.map((p) => p.coupangLowest);
  const allVals = [...naver, ...coupang].filter((v): v is number => v != null);

  if (points.length === 0 || allVals.length === 0) {
    ctx.fillStyle = "#999999";
    ctx.font = "13px sans-serif";
    ctx.fillText("아직 가격 데이터가 없습니다", PAD.left, H / 2);
    return canvas.toBuffer("image/png");
  }

  let min = Math.min(...allVals);
  let max = Math.max(...allVals);
  if (min === max) {
    // 평평한 경우 약간의 여백
    min = min * 0.98;
    max = max * 1.02;
  }
  const range = max - min;

  const n = points.length;
  const xAt = (i: number) => (n === 1 ? x0 + plotW / 2 : x0 + (plotW * i) / (n - 1));
  const yAt = (v: number) => y0 + plotH - ((v - min) / range) * plotH;

  // 가로 그리드 + y 라벨 (3단계)
  ctx.strokeStyle = "#eeeeee";
  ctx.fillStyle = "#999999";
  ctx.font = "11px sans-serif";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 3; g++) {
    const v = min + (range * g) / 3;
    const y = yAt(v);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + plotW, y);
    ctx.stroke();
    ctx.fillText(niceLabel(v), 6, y + 4);
  }

  // x 라벨 (시작/끝 날짜)
  ctx.fillStyle = "#999999";
  ctx.fillText(points[0].date.slice(5), x0, H - 8);
  if (n > 1) {
    const last = points[n - 1].date.slice(5);
    ctx.fillText(last, x0 + plotW - ctx.measureText(last).width, H - 8);
  }

  // 라인 그리기 (null 구간은 건너뛰되 연결)
  const drawLine = (vals: (number | null)[], color: string) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    let started = false;
    ctx.beginPath();
    vals.forEach((v, i) => {
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
    // 점
    vals.forEach((v, i) => {
      if (v == null) return;
      ctx.beginPath();
      ctx.arc(xAt(i), yAt(v), 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  drawLine(naver, NAVER);
  if (coupang.some((v) => v != null)) drawLine(coupang, COUPANG);

  // 범례
  ctx.font = "11px sans-serif";
  let lx = x0 + plotW - 150;
  ctx.fillStyle = NAVER;
  ctx.fillRect(lx, 8, 10, 10);
  ctx.fillStyle = "#666";
  ctx.fillText("네이버", lx + 14, 17);
  lx += 60;
  if (coupang.some((v) => v != null)) {
    ctx.fillStyle = COUPANG;
    ctx.fillRect(lx, 8, 10, 10);
    ctx.fillStyle = "#666";
    ctx.fillText("쿠팡", lx + 14, 17);
  }

  return canvas.toBuffer("image/png");
}
