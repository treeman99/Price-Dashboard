import { useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { marketLabel } from "@shared/stock";
import { HORIZONS, horizonLabel, horizonDescription } from "@shared/holdings";
import type { StockHolding, StockHorizon, StockMarket } from "@shared/types";

/**
 * 보유 종목 추가.
 *
 * 종목 확정을 AddTickerDialog 처럼 '검색 → 후보 선택' 2단계로 하지 않는 이유:
 * 여기서는 수량·평단가·목표가까지 **함께** 입력해야 해서, 2단계로 나누면 후보를 고른 뒤
 * 폼이 다시 뜨는 흐름이 된다. 대신 서버(holdings.ts resolveCandidate)가 같은 시장 안에서
 * 심볼·이름 정확일치 또는 유일 후보일 때만 확정하고, 애매하면 **후보를 에러 메시지에 담아
 * 되돌려준다** — 사용자가 그걸 보고 정확한 코드를 다시 넣는다.
 */
export function AddHoldingDialog({
  market,
  onAdded,
}: {
  market: StockMarket;
  onAdded: (h: StockHolding) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [quantity, setQuantity] = useState("");
  const [avgPrice, setAvgPrice] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [horizon, setHorizon] = useState<StockHorizon>("mid");
  const [memo, setMemo] = useState("");

  function reset() {
    setQuery("");
    setQuantity("");
    setAvgPrice("");
    setTargetPrice("");
    setStopPrice("");
    setHorizon("mid");
    setMemo("");
    setErr(null);
  }

  async function submit() {
    if (!query.trim()) return setErr("종목명·종목코드·티커를 입력하세요.");
    if (!quantity.trim() || !avgPrice.trim()) return setErr("보유 수량과 평균 매입 단가는 필수입니다.");
    setSaving(true);
    setErr(null);
    try {
      const h = await api.addHolding({
        market,
        query: query.trim(),
        quantity: Number(quantity),
        avgPrice: Number(avgPrice),
        // 빈 문자열은 **null**(미설정)로 보낸다. Number("") 는 0 이라 그냥 넘기면
        // '목표가 0원'이라는 그럴듯한 거짓이 저장된다.
        targetPrice: targetPrice.trim() ? Number(targetPrice) : null,
        stopPrice: stopPrice.trim() ? Number(stopPrice) : null,
        horizon,
        memo: memo.trim(),
      });
      onAdded(h);
      setOpen(false);
      reset();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1">
          <Plus className="h-4 w-4" /> 보유 종목 추가
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{marketLabel(market)} 보유 종목 추가</DialogTitle>
          <DialogDescription>
            등록하면 {marketLabel(market)} 관심 종목에도 자동으로 들어가 일일 브리핑에 포함됩니다.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="hq">종목 *</Label>
            <Input
              id="hq"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={market === "kr" ? "삼성전자 또는 005930" : "NVDA 또는 엔비디아"}
              onKeyDown={(e) => e.key === "Enter" && !saving && submit()}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="hqty">보유 수량 *</Label>
              <Input
                id="hqty"
                type="number"
                step="any"
                min="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="10"
              />
            </div>
            <div>
              <Label htmlFor="havg">평균 매입 단가 *</Label>
              <Input
                id="havg"
                type="number"
                step="any"
                min="0"
                value={avgPrice}
                onChange={(e) => setAvgPrice(e.target.value)}
                placeholder={market === "kr" ? "70000" : "120.50"}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="htgt">목표가</Label>
              <Input
                id="htgt"
                type="number"
                step="any"
                min="0"
                value={targetPrice}
                onChange={(e) => setTargetPrice(e.target.value)}
                placeholder="비워두면 미설정"
              />
            </div>
            <div>
              <Label htmlFor="hstop">손절가</Label>
              <Input
                id="hstop"
                type="number"
                step="any"
                min="0"
                value={stopPrice}
                onChange={(e) => setStopPrice(e.target.value)}
                placeholder="비워두면 미설정"
              />
            </div>
          </div>

          <div>
            <Label>투자 기간 *</Label>
            <div className="mt-1 flex gap-2">
              {HORIZONS.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setHorizon(h)}
                  className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                    horizon === h
                      ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                      : "border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {horizonLabel(h)}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">{horizonDescription(horizon)}</p>
          </div>

          <div>
            <Label htmlFor="hmemo">보유 이유 / 메모</Label>
            <Textarea
              id="hmemo"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              rows={2}
              placeholder="예: HBM 수요 사이클 베팅. 2027년 증설 확정까지 보유."
            />
            <p className="mt-1 text-xs text-slate-500">
              적어두면 실시간 취합 에이전트가 “왜 샀는지”까지 반영해 영향도를 판정합니다.
            </p>
          </div>

          {err && (
            <p className="whitespace-pre-wrap rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
              {err}
            </p>
          )}
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            취소
          </Button>
          <Button onClick={submit} disabled={saving} className="gap-1">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} 추가
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
