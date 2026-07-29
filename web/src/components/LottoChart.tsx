import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  type TooltipProps,
} from "recharts";
import type { LottoScorePoint, LottoStrategy } from "@shared/lotto";

/**
 * 세대 전환 세로선 라벨이 겹치는 문제. 50회차마다 개정되고 최신 1234회차까지 걸으면
 * 세대가 최대 25개까지 늘어난다 — 그 수만큼 텍스트 라벨을 다 그리면 서로 겹쳐 읽을 수
 * 없으므로, 이 개수를 넘으면 라벨은 생략하고 세로 점선만 남긴다(팀 리드 지시).
 */
const MAX_GENERATION_LABELS = 10;

/** 회차 점수 / 누적 점수 차트가 함께 쓰는 툴팁. recharts 기본 포맷터는 계열마다 한 줄만 주고
 * 회차·추첨일·세대를 한 번에 못 묶어서, 원본 데이터 포인트를 그대로 읽는 커스텀 툴팁을 쓴다. */
function ScoreTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0]?.payload as LottoScorePoint | undefined;
  if (!p) return null;
  return (
    <div className="rounded-md border bg-card px-3 py-2 text-xs shadow-md">
      <div className="font-semibold">
        {p.round}회차 · {p.drawDate}
      </div>
      <div className="mt-1 space-y-0.5 text-muted-foreground">
        <div>회차 점수 {p.score > 0 ? "+" : ""}{p.score}</div>
        <div>누적 {p.cumScore > 0 ? "+" : ""}{p.cumScore}</div>
        <div>이동평균 {p.movingAvg.toFixed(2)}</div>
        <div>세대 v{p.version}</div>
      </div>
    </div>
  );
}

/** 세대 전환 지점마다 세로 점선을 긋는다. 1세대(v1)는 회차 1부터라 맨 왼쪽에 붙어 의미가
 * 없으므로 2세대부터만 그린다. */
function GenerationLines({ strategies }: { strategies: LottoStrategy[] }) {
  const transitions = strategies.slice(1);
  const showLabel = transitions.length <= MAX_GENERATION_LABELS;
  return (
    <>
      {transitions.map((s) => (
        <ReferenceLine
          key={s.version}
          x={s.fromRound}
          stroke="#7c3aed"
          strokeDasharray="4 4"
          strokeOpacity={0.5}
          label={
            showLabel
              ? { value: `v${s.version}`, position: "top", fontSize: 10, fill: "#7c3aed" }
              : undefined
          }
        />
      ))}
    </>
  );
}

/**
 * 회차 점수 추이. x축 = 회차(1200점 이상 들어오므로 dot 없이 선만, isAnimationActive=false로
 * 렌더 비용을 줄인다). 3개 계열:
 *  - 회차 점수: 산포를 보여주는 옅은 선(-60~+60 사이를 크게 흔든다)
 *  - 50회차 이동평균: 이 차트의 주인공, 굵은 선
 *  - 무작위 기준선: 점수의 유일한 판정 기준이므로 수평 점선 + 라벨로 항상 같이 보여준다
 */
export function LottoScoreChart({
  points,
  strategies,
  baselinePerRound,
}: {
  points: LottoScorePoint[];
  strategies: LottoStrategy[];
  baselinePerRound: number;
}) {
  if (!points.length) {
    return (
      <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
        아직 채점된 회차가 없습니다
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={points} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="round"
          type="number"
          domain={["dataMin", "dataMax"]}
          tick={{ fontSize: 11 }}
          stroke="hsl(var(--muted-foreground))"
        />
        <YAxis
          tick={{ fontSize: 11 }}
          stroke="hsl(var(--muted-foreground))"
          width={44}
          domain={["auto", "auto"]}
        />
        <Tooltip content={<ScoreTooltip />} />
        <ReferenceLine
          y={baselinePerRound}
          stroke="#94a3b8"
          strokeDasharray="6 3"
          label={{
            value: `무작위 기준선 ${baselinePerRound.toFixed(1)}`,
            position: "insideBottomRight",
            fontSize: 11,
            fill: "#64748b",
          }}
        />
        <GenerationLines strategies={strategies} />
        <Line
          type="monotone"
          dataKey="score"
          stroke="#c4b5fd"
          strokeWidth={1}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="movingAvg"
          stroke="#7c3aed"
          strokeWidth={2.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/**
 * 누적 점수 추이. **별도 차트로 분리한 이유**: 회차 점수는 -60~+60 사이를 오가지만 누적은
 * 회차 수에 비례해 수백~수만까지 쌓인다. 같은 축에 그리면 회차 점수의 산포가 0 근처로
 * 눌려 안 보이므로 스케일이 다른 두 지표는 처음부터 차트를 나눈다.
 *
 * 누적 기준선(baseline × 회차수)은 상수가 아니라 회차 수에 비례해 증가하므로 ReferenceLine
 * (수평선 전용)으로 못 그리고, points 인덱스를 '지금까지 채점한 회차 수'로 써서 데이터
 * 계열로 계산해 넣는다.
 */
export function LottoCumulativeChart({
  points,
  baselinePerRound,
}: {
  points: LottoScorePoint[];
  baselinePerRound: number;
}) {
  if (!points.length) {
    return (
      <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
        아직 채점된 회차가 없습니다
      </div>
    );
  }
  const data = points.map((p, i) => ({ ...p, baselineCum: baselinePerRound * (i + 1) }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="round"
          type="number"
          domain={["dataMin", "dataMax"]}
          tick={{ fontSize: 11 }}
          stroke="hsl(var(--muted-foreground))"
        />
        <YAxis
          tick={{ fontSize: 11 }}
          stroke="hsl(var(--muted-foreground))"
          width={56}
          domain={["auto", "auto"]}
        />
        <Tooltip content={<ScoreTooltip />} />
        <Line
          type="monotone"
          dataKey="baselineCum"
          stroke="#94a3b8"
          strokeDasharray="6 3"
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="cumScore"
          stroke="#7c3aed"
          strokeWidth={2.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
