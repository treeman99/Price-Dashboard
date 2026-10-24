import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { StockPoint } from "@shared/types";
import { formatPrice, changeTone } from "@shared/stock";

/**
 * 축 눈금 표기. 만원 단위 축약은 주가에 못 쓴다 —
 * 애플 $295 를 만원 단위로 나누면 "0만"이 되어 눈금이 전부 뭉갠다.
 * KRW 는 천단위 구분만(원 표시는 눈금에서 생략해 폭을 아낀다), USD 는 $ + 소수 2자리.
 */
function formatTick(v: number, currency: string): string {
  if (!Number.isFinite(v)) return "";
  if (currency === "KRW") return Math.round(v).toLocaleString("ko-KR");
  if (currency === "USD")
    return `$${v.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, monospace';
const AXIS_TICK = { fontSize: 11, fill: "hsl(var(--muted-foreground))", fontFamily: MONO };

/**
 * 종목 20거래일 종가 추이.
 * 선은 잉크색 한 가지로 그리고, 구간 등락(첫 종가 → 마지막 종가)은 마지막 점 하나에만
 * 한국 증시 관례로 칠한다: 상승 빨강 / 하락 파랑 / 보합 회색.
 */
export function StockChart({ points, height = 220 }: { points: StockPoint[]; height?: number }) {
  if (!points || points.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
        아직 시세 데이터가 없습니다
      </div>
    );
  }

  // 통화는 점마다 같지만, 값이 빈 점이 섞일 수 있어 실제 값이 있는 점에서 집는다.
  const currency = points.find((p) => p.currency)?.currency ?? "KRW";

  const closes = points.filter((p) => p.close != null).map((p) => p.close as number);
  const first = closes[0];
  const last = closes[closes.length - 1];
  // 구간 등락률로 톤을 정한다. 종가가 1개 이하면 비교 대상이 없어 보합(회색).
  const tone =
    first != null && last != null && closes.length > 1 && first !== 0
      ? changeTone(((last - first) / first) * 100)
      : "flat";
  const endFill = tone === "up" ? "fill-up" : tone === "down" ? "fill-stock-down" : "fill-muted-foreground";

  const data = points.map((p) => ({
    date: p.date.slice(5), // MM-DD
    close: p.close,
  }));
  // 눈금 글씨(mono 11px)가 잘리지 않게 Y축 폭을 가장 긴 눈금에 맞춘다. 자동 눈금이 최댓값보다
  // 한 자리 길어질 수 있어(99,800 → 100,000) 한 글자를 여유로 둔다.
  const longest = closes.reduce((n, c) => Math.max(n, formatTick(c, currency).length), 0);
  const yWidth = Math.max(48, Math.ceil((longest + 1) * 6.7) + 6);
  // 마지막으로 값이 있는 점 — 빈 점이 끝에 붙어 있으면 그 앞 점이 '현재'다.
  let lastIdx = -1;
  data.forEach((d, i) => {
    if (d.close != null) lastIdx = i;
  });

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
        <XAxis
          dataKey="date"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: "hsl(var(--border))" }}
          minTickGap={16}
        />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          width={yWidth}
          tickFormatter={(v) => (typeof v === "number" ? formatTick(v, currency) : "")}
          domain={["auto", "auto"]}
        />
        <Tooltip
          formatter={(v) => [formatPrice(typeof v === "number" ? v : null, currency), "종가"]}
          cursor={{ stroke: "hsl(var(--foreground) / 0.25)" }}
          contentStyle={{
            fontSize: 12,
            borderRadius: 4,
            padding: "6px 10px",
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            boxShadow: "none",
            color: "hsl(var(--foreground))",
          }}
          labelStyle={{ color: "hsl(var(--muted-foreground))", fontFamily: MONO, marginBottom: 2 }}
          itemStyle={{ color: "hsl(var(--foreground))", padding: 0 }}
        />
        <Line
          type="monotone"
          dataKey="close"
          stroke="hsl(var(--foreground))"
          strokeWidth={1.5}
          dot={(props: { cx?: number; cy?: number; index?: number }) =>
            props.index === lastIdx && props.cx != null && props.cy != null ? (
              <circle key="end" cx={props.cx} cy={props.cy} r={3} className={endFill} stroke="none" />
            ) : (
              <g key={`d${props.index}`} />
            )
          }
          activeDot={{ r: 3, fill: "hsl(var(--foreground))", stroke: "hsl(var(--background))" }}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
