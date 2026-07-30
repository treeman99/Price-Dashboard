import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronUp,
  ChevronDown,
  Loader2,
  Minus,
  Trash2,
  Star,
} from "lucide-react";
import type { ProductSummary, ProductHistory, PeriodDays } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { PriceChart } from "./PriceChart";
import { SourceLinkDialog } from "./SourceLinkDialog";
import { EditProductDialog } from "./EditProductDialog";
import { api } from "@/lib/api";
import { cn, formatWon } from "@/lib/utils";
import { sourceLabel, isDegradedSource } from "@/lib/sources";
import { safeHref } from "@shared/url";

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

/** 가격 출처(소스) 배지. LLM 검색 degrade는 은근히 앰버 톤으로 구분. */
function SourceBadge({ source }: { source: string }) {
  const label = sourceLabel(source);
  if (!label) return null;
  const degraded = isDegradedSource(source);
  return (
    <Badge
      className={cn(
        "px-1.5 py-0 text-[10px] font-normal",
        degraded
          ? "border-amber-200 bg-amber-100 text-amber-700"
          : "border-transparent bg-muted text-muted-foreground"
      )}
      title={
        degraded
          ? "확정된 pcode 연결이 없어 LLM 검색으로 수집된 가격입니다"
          : `가격 출처: ${label}`
      }
    >
      {label}
    </Badge>
  );
}

export function ProductCard({
  summary,
  onChanged,
  collecting = false,
  canUp,
  canDown,
  onMove,
}: {
  summary: ProductSummary;
  onChanged: () => void;
  /**
   * 이 상품의 즉시수집(추가 직후 1차 수집 / 재수집)이 백그라운드로 진행 중.
   * 수집은 1~2분 걸리므로 그동안 카드에 아직 값이 없거나 낡은 값이 보인다 — 그 이유를 배지로 알린다.
   */
  collecting?: boolean;
  /** 목록에서 앞으로 이동 가능(첫 카드가 아님) */
  canUp: boolean;
  /** 목록에서 뒤로 이동 가능(마지막 카드가 아님) */
  canDown: boolean;
  /** 카드 표시 순서 조정. dir="up"=앞으로, "down"=뒤로 */
  onMove: (summary: ProductSummary, dir: "up" | "down") => void;
}) {
  const { product, latest, change, topListings, reviews } = summary;
  const [days, setDays] = useState<PeriodDays>(30);
  const [history, setHistory] = useState<ProductHistory | null>(null);

  // 종합 최저가 표시용: 판매처(lowestMall)가 더 구체적이면 우선, 없으면 기존 lowestSource.
  const mallText = latest?.lowestMall ?? latest?.lowestSource ?? null;

  // 종합 최저가 링크는 반드시 '그 금액이 적힌 페이지'(lowestUrl)로만 건다.
  // 예전엔 네이버 Top1(topListings[0])로 고정해서, 가격비교 소스가 최저가일 때
  // 표시 금액과 착지 페이지 금액이 어긋났다. lowestUrl 이 없으면 링크를 걸지 않는다.
  const lowestHref = safeHref(latest?.lowestUrl ?? null);

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
    if (
      !confirm(
        `'${product.name}'을(를) 영구 삭제할까요?\n가격 이력까지 모두 삭제되며 복구할 수 없습니다.`
      )
    )
      return;
    await api.deleteProduct(product.id, product.name);
    onChanged();
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {product.name}
            {collecting && (
              <Badge
                className="gap-1 border-blue-200 bg-blue-50 px-1.5 py-0 text-[10px] font-normal text-blue-700"
                title="가격·리뷰를 수집하는 중입니다. 1~2분 걸리며 완료되면 자동으로 반영됩니다."
              >
                <Loader2 className="h-3 w-3 animate-spin" /> 수집 중…
              </Badge>
            )}
          </CardTitle>
          <div className="flex shrink-0 items-center">
            <Button
              variant="ghost"
              size="icon"
              className="group/tt relative"
              onClick={() => onMove(summary, "up")}
              disabled={!canUp}
              aria-label="순서 앞으로"
            >
              <ChevronUp className="h-4 w-4" />
              <Tip>순서 앞으로</Tip>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="group/tt relative"
              onClick={() => onMove(summary, "down")}
              disabled={!canDown}
              aria-label="순서 뒤로"
            >
              <ChevronDown className="h-4 w-4" />
              <Tip>순서 뒤로</Tip>
            </Button>
            <EditProductDialog product={product} onChanged={onChanged} />
            <SourceLinkDialog
              productId={product.id}
              productName={product.name}
              onChanged={onChanged}
            />
            <Button
              variant="ghost"
              size="icon"
              className="group/tt relative"
              onClick={handleDelete}
              aria-label="영구 삭제"
            >
              <Trash2 className="h-4 w-4" />
              <Tip>영구 삭제</Tip>
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 가격 요약 */}
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <div className="text-xs text-muted-foreground">종합 최저가</div>
            <div className="text-2xl font-bold">
              {latest?.overallLowest != null && lowestHref ? (
                <a
                  href={lowestHref}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                  title="최저가 판매처로 이동"
                >
                  {formatWon(latest.overallLowest)}
                </a>
              ) : (
                formatWon(latest?.overallLowest ?? null)
              )}
              {mallText && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">{mallText}</span>
              )}
            </div>
            {latest?.source && (
              <div className="mt-1">
                <SourceBadge source={latest.source} />
              </div>
            )}
          </div>
          <ChangeBadge change={change} />
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-md bg-muted/50 px-3 py-2">
            <div className="text-xs text-muted-foreground">네이버 최저가</div>
            <div className="font-medium">{formatWon(latest?.naverLowest ?? null)}</div>
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
              {topListings.map((l) => {
                const href = safeHref(l.link);
                return (
                  <li key={l.rank} className="flex items-center justify-between">
                    <span className="truncate text-muted-foreground">
                      {l.rank}. {l.mall}
                    </span>
                    <span className="font-medium">
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer" className="hover:underline">
                          {formatWon(l.price)}
                        </a>
                      ) : (
                        formatWon(l.price)
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* 리뷰 */}
        {reviews.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold text-muted-foreground">리뷰</div>
            <ul className="space-y-2">
              {reviews.slice(0, 3).map((r, i) => {
                const href = safeHref(r.link);
                return (
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
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer" className="hover:underline">
                          {r.summary}
                        </a>
                      ) : (
                        r.summary
                      )}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
