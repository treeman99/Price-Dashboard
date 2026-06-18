import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Minus, Trash2, RotateCcw, Star } from "lucide-react";
import type { ProductSummary, ProductHistory, PeriodDays } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PriceChart } from "./PriceChart";
import { api } from "@/lib/api";
import { cn, formatWon } from "@/lib/utils";

const PERIODS: PeriodDays[] = [7, 30, 90];

function ChangeBadge({ change }: { change: ProductSummary["change"] }) {
  if (change.amount == null || change.direction === "flat") {
    return (
      <Badge className="border-transparent bg-muted text-muted-foreground gap-1">
        <Minus className="h-3 w-3" /> 변동없음
      </Badge>
    );
  }
  const isDown = change.direction === "down";
  return (
    <Badge
      className="border-transparent gap-1 text-white"
      style={{ backgroundColor: isDown ? "#2ecc71" : "#e74c3c" }}
    >
      {isDown ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />}
      {Math.abs(change.amount).toLocaleString("ko-KR")}원
      {change.percent != null && ` (${Math.abs(change.percent).toFixed(1)}%)`}
    </Badge>
  );
}

export function ProductCard({
  summary,
  onChanged,
}: {
  summary: ProductSummary;
  onChanged: () => void;
}) {
  const { product, latest, change, topListings, reviews } = summary;
  const [days, setDays] = useState<PeriodDays>(30);
  const [history, setHistory] = useState<ProductHistory | null>(null);

  useEffect(() => {
    let alive = true;
    api.history(product.id, days).then((h) => {
      if (alive) setHistory(h);
    });
    return () => {
      alive = false;
    };
  }, [product.id, days]);

  async function handleDelete() {
    if (!confirm(`'${product.name}' 추적을 중지할까요? (이력은 보존됩니다)`)) return;
    await api.softDelete(product.id);
    onChanged();
  }
  async function handleReactivate() {
    await api.reactivate(product.id);
    onChanged();
  }

  return (
    <Card className={cn(!product.active && "opacity-60")}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            {product.name}
            {!product.active && (
              <Badge className="border-transparent bg-muted text-muted-foreground">추적중지</Badge>
            )}
          </CardTitle>
          {product.active ? (
            <Button variant="ghost" size="icon" onClick={handleDelete} title="추적 중지">
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : (
            <Button variant="ghost" size="icon" onClick={handleReactivate} title="추적 재개">
              <RotateCcw className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 가격 요약 */}
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <div className="text-xs text-muted-foreground">종합 최저가</div>
            <div className="text-2xl font-bold">
              {formatWon(latest?.overallLowest ?? null)}
              {latest?.lowestSource && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {latest.lowestSource}
                </span>
              )}
            </div>
          </div>
          <ChangeBadge change={change} />
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-md bg-muted/50 px-3 py-2">
            <div className="text-xs text-muted-foreground">쿠팡 최저가</div>
            <div className="font-medium">{formatWon(latest?.coupangLowest ?? null)}</div>
          </div>
          <div className="rounded-md bg-muted/50 px-3 py-2">
            <div className="text-xs text-muted-foreground">평균가</div>
            <div className="font-medium">{formatWon(latest?.avgPrice ?? null)}</div>
          </div>
        </div>

        {/* 기간 필터 + 차트 */}
        <div>
          <div className="mb-2 flex gap-1">
            {PERIODS.map((p) => (
              <Button
                key={p}
                size="sm"
                variant={days === p ? "default" : "outline"}
                onClick={() => setDays(p)}
              >
                {p}일
              </Button>
            ))}
          </div>
          <PriceChart points={history?.points ?? []} />
        </div>

        {/* Top3 */}
        {topListings.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold text-muted-foreground">Top 3 최저가</div>
            <ul className="space-y-1 text-sm">
              {topListings.map((l) => (
                <li key={l.rank} className="flex items-center justify-between">
                  <span className="truncate text-muted-foreground">
                    {l.rank}. {l.mall}
                  </span>
                  <span className="font-medium">
                    {l.link ? (
                      <a href={l.link} target="_blank" rel="noreferrer" className="hover:underline">
                        {formatWon(l.price)}
                      </a>
                    ) : (
                      formatWon(l.price)
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 리뷰 */}
        {reviews.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold text-muted-foreground">리뷰</div>
            <ul className="space-y-2">
              {reviews.slice(0, 3).map((r, i) => (
                <li key={i} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{r.source}</span>
                    {r.rating != null && (
                      <span className="inline-flex items-center gap-0.5">
                        <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                        {r.rating}
                      </span>
                    )}
                    {r.date && <span>· {r.date}</span>}
                  </div>
                  <p className="mt-1 line-clamp-3">
                    {r.link ? (
                      <a href={r.link} target="_blank" rel="noreferrer" className="hover:underline">
                        {r.summary}
                      </a>
                    ) : (
                      r.summary
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
