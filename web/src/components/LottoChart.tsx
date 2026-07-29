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
        {/* 대조군 차트지만 새 목표 지표도 한 줄 얹어 둔다 — 점수만 보고 "이 회차는 잘 됐다"로
            오독하지 않도록, 실제 목표 지표(3+ 적중) 결과를 항상 같이 보여준다. */}
        <div>{p.hit3 ? "🎯 3+ 적중" : "3+ 미적중"} · 최고 {p.bestMatch}개</div>
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
 * 가중 점수 차트 전용 툴팁. 이 회차의 가중 점수(0~15, weightedHitScore 결과)와 그 근거인
 * 3+ 여부·최고 적중 개수, 이동평균·누적, 세대를 한 번에 보여준다. 3+ 적중률(hit3Rate)도
 * 같이 보여줘 "가중 점수 대부분이 3+ 항에서 온다"는 걸 숫자로도 확인시킨다.
 */
function ObjectiveTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0]?.payload as LottoScorePoint | undefined;
  if (!p) return null;
  return (
    <div className="rounded-md border bg-card px-3 py-2 text-xs shadow-md">
      <div className="font-semibold">
        {p.round}회차 · {p.drawDate}
      </div>
      <div className="mt-1 space-y-0.5 text-muted-foreground">
        <div>
          가중 점수 {p.weighted}/15 · {p.hit3 ? "🎯 3+ 적중" : "3+ 미적중"} · 최고 {p.bestMatch}개
        </div>
        <div>200회차 이동평균 {p.weightedRate.toFixed(4)} (3+ 적중률 {(p.hit3Rate * 100).toFixed(1)}%)</div>
        <div>누적 {p.cumWeightedRate.toFixed(4)}</div>
        <div>세대 v{p.version}</div>
      </div>
    </div>
  );
}

/**
 * ⚠️ y축을 [0.30, 0.48] 로 고정한다. 무작위(0.3976)·천장(0.4298)·상한(0.4601) 세 기준선이
 * 전부 이 구간 안에 몰려 있고 서로 6.5%p 안쪽 차이다. recharts 자동 스케일(보통 0 근처부터
 * 시작)을 쓰면 이 좁은 차이가 축 전체의 몇 % 밖에 안 되는 구간으로 눌려 안 보이므로, 3+
 * 적중률 차트와 같은 이유로 고정한다(팀 리드 지시).
 */
const WEIGHTED_Y_DOMAIN: [number, number] = [0.3, 0.48];

/**
 * **가중 회차 점수 추이 — 이 실험의 주인공 차트.**
 * 3+ 적중률 단독 지표(과거 LottoHit3Chart)는 가중 점수의 구성 요소로 강등됐다 — 사용자 요청이
 * "3+ 는 많을수록, 4+/5+ 는 더 높은 점수"였기 때문이다. 계열 3개 + 기준선 3개:
 *  - weightedRate: 최근 LOTTO_HIT3_WINDOW(200)회차 가중 점수 이동평균 — 굵은 선, 주인공
 *  - cumWeightedRate: 1회차부터의 누적 평균 — 가는 선
 *  - hit3Rate: 3+ 적중률(200회차 이동평균) — 옅은 보조 계열. 가중 점수의 대부분이 3+ 항에서
 *    나온다는 것(4+/5+/6개는 희귀해서 기여가 작다)을 곡선 두 개가 거의 겹치는 모습으로 보여준다.
 *  - 기준선 3개: 무작위(weightedRandom, 점선) · 도달 가능 천장(weightedCeiling, 점선) ·
 *    수학적 상한(weightedBound). 상한은 최적화로도 절대 못 넘는 값이라 다른 둘과 다르게
 *    실선 + 진한 빨강으로 구분한다(팀 리드 지시).
 */
export function LottoObjectiveChart({
  points,
  strategies,
  weightedRandom,
  weightedCeiling,
  weightedBound,
}: {
  points: LottoScorePoint[];
  strategies: LottoStrategy[];
  weightedRandom: number;
  weightedCeiling: number;
  weightedBound: number;
}) {
  if (!points.length) {
    return (
      <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">
        아직 채점된 회차가 없습니다
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={300}>
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
          width={48}
          domain={WEIGHTED_Y_DOMAIN}
          tickFormatter={(v: number) => v.toFixed(2)}
        />
        <Tooltip content={<ObjectiveTooltip />} />
        <ReferenceLine
          y={weightedRandom}
          stroke="#94a3b8"
          strokeDasharray="6 3"
          label={{
            value: `무작위 ${weightedRandom.toFixed(4)}`,
            position: "insideBottomRight",
            fontSize: 11,
            fill: "#64748b",
          }}
        />
        <ReferenceLine
          y={weightedCeiling}
          stroke="#f59e0b"
          strokeDasharray="6 3"
          label={{
            value: `천장 ${weightedCeiling.toFixed(4)}`,
            position: "insideTopRight",
            fontSize: 11,
            fill: "#b45309",
          }}
        />
        {/* 상한선만 실선 + 두꺼운 진한 빨강 — 도달 가능/불가능의 경계가 아니라 수학적으로
            절대 넘을 수 없는 값이라, 점선 기준선 두 개와는 다른 무게감을 줘야 한다. */}
        <ReferenceLine
          y={weightedBound}
          stroke="#dc2626"
          strokeWidth={2}
          label={{
            value: `상한 ${weightedBound.toFixed(4)} — 넘을 수 없음`,
            position: "insideTopRight",
            fontSize: 11,
            fill: "#b91c1c",
          }}
        />
        <GenerationLines strategies={strategies} />
        {/* 보조 계열: 3+ 적중률. 옅고 가늘게 — 주인공(weightedRate)과 겹쳐 그려질수록 "가중
            점수 대부분이 3+ 에서 온다"는 게 시각적으로 드러난다. */}
        <Line
          type="monotone"
          dataKey="hit3Rate"
          stroke="#a7f3d0"
          strokeWidth={1}
          strokeDasharray="3 3"
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="cumWeightedRate"
          stroke="#ddd6fe"
          strokeWidth={1}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="weightedRate"
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
