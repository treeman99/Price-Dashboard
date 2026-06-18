import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { PricePoint } from "@shared/types";
import { formatMan, formatWon } from "@/lib/utils";

export function PriceChart({ points }: { points: PricePoint[] }) {
  if (!points || points.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
        아직 가격 데이터가 없습니다
      </div>
    );
  }

  const data = points.map((p) => ({
    date: p.date.slice(5), // MM-DD
    naver: p.naverLowest,
    coupang: p.coupangLowest,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
        <YAxis
          tick={{ fontSize: 11 }}
          stroke="hsl(var(--muted-foreground))"
          width={48}
          tickFormatter={(v) => (typeof v === "number" ? formatMan(v) : "")}
          domain={["auto", "auto"]}
        />
        <Tooltip
          formatter={(v, name) => [
            formatWon(typeof v === "number" ? v : null),
            name === "naver" ? "네이버" : "쿠팡",
          ]}
          contentStyle={{ fontSize: 12, borderRadius: 8 }}
        />
        <Legend
          formatter={(v) => (v === "naver" ? "네이버 최저가" : "쿠팡 최저가")}
          wrapperStyle={{ fontSize: 12 }}
        />
        <Line
          type="monotone"
          dataKey="naver"
          stroke="#4A90D9"
          strokeWidth={2}
          dot={{ r: 2 }}
          connectNulls
        />
        <Line
          type="monotone"
          dataKey="coupang"
          stroke="#E8833A"
          strokeWidth={2}
          dot={{ r: 2 }}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
