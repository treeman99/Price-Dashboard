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

/**
 * 종목 20거래일 종가 추이.
 * 선 색은 구간 등락(첫 종가 → 마지막 종가)을 한국 증시 관례로 칠한다: 상승 빨강 / 하락 파랑 / 보합 회색.
 */
export function StockChart({ points }: { points: StockPoint[] }) {
  if (!points || points.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
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
  const stroke = tone === "up" ? "#e74c3c" : tone === "down" ? "#2563eb" : "#94a3b8";

  const data = points.map((p) => ({
    date: p.date.slice(5), // MM-DD
    close: p.close,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
        <YAxis
          tick={{ fontSize: 11 }}
          stroke="hsl(var(--muted-foreground))"
          width={60}
          tickFormatter={(v) => (typeof v === "number" ? formatTick(v, currency) : "")}
          domain={["auto", "auto"]}
        />
        <Tooltip
          formatter={(v) => [formatPrice(typeof v === "number" ? v : null, currency), "종가"]}
          contentStyle={{ fontSize: 12, borderRadius: 8 }}
        />
        <Line
          type="monotone"
          dataKey="close"
          stroke={stroke}
          strokeWidth={2}
          dot={{ r: 2 }}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
