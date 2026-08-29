import { useState } from "react";
import { Pencil, Loader2 } from "lucide-react";
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
import { HORIZONS, horizonLabel, horizonDescription } from "@shared/holdings";
import type { StockHolding, StockHorizon, UpdateStockHoldingInput } from "@shared/types";

/** 빈 칸이면 null(해제), 값이 있으면 숫자. 숫자로 못 읽으면 undefined — 호출부가 에러로 막는다. */
function parseOptional(raw: string): number | null | undefined {
  if (!raw.trim()) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 보유 종목 수정.
 *
 * 종목 자체(심볼·시장)는 바꾸지 않는다 — 종목이 달라지면 그건 다른 포지션이고,
 * 시세 시계열·펄스 판정 이력이 엉킨다. 바꾸려면 삭제 후 다시 추가하는 게 맞다.
 * 여기서 고치는 건 **수량·평단·목표가·손절가·투자기간·메모**뿐이다.
 *
 * ⚠️ PATCH 계약 (`api.updateHolding` → `PATCH /api/stock/holdings/:id`):
 *   - 키를 **아예 빼면 유지**, `null` 을 보내면 **해제**(목표가·손절가).
 *   - 그래서 여기서는 폼을 현재 값으로 미리 채워두고, **바뀐 키만** 담아 보낸다.
 *     · 목표가 칸을 비웠다  → 원래 값이 있었으니 변경으로 잡혀 `null`(해제)이 간다.
 *     · 목표가를 안 건드렸다 → 값이 같으니 키 자체가 안 실려 서버 값이 유지된다.
 *   - 빈 칸을 `Number("")` 로 넘기면 **0** 이 되어 '목표가 0원'이라는 그럴듯한 거짓이
 *     저장되므로, 빈 문자열은 반드시 먼저 걸러 `null` 로 만든다(AddHoldingDialog 와 같은 규칙).
 *   - 숫자로 읽을 수 없는 입력(예: "abc")은 보내지 않고 막는다. JSON 은 `NaN` 을 `null` 로
 *     직렬화하기 때문에, 그냥 넘기면 **오타가 목표가 해제로 둔갑한다.**
 */
export function EditHoldingDialog({
  h,
  onSaved,
}: {
  h: StockHolding;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [quantity, setQuantity] = useState("");
  const [avgPrice, setAvgPrice] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [horizon, setHorizon] = useState<StockHorizon>("mid");
  const [memo, setMemo] = useState("");

  /** 현재 저장값으로 폼을 채운다. 열 때마다 다시 부른다 — 목록이 갱신됐으면 그 값이 기준이다. */
  function seed() {
    setQuantity(String(h.quantity));
    setAvgPrice(String(h.avgPrice));
    setTargetPrice(h.targetPrice == null ? "" : String(h.targetPrice));
    setStopPrice(h.stopPrice == null ? "" : String(h.stopPrice));
    setHorizon(h.horizon);
    setMemo(h.memo ?? "");
    setErr(null);
  }

  async function submit() {
    const qty = Number(quantity);
    if (!quantity.trim() || !Number.isFinite(qty) || qty <= 0)
      return setErr("보유 수량은 0보다 큰 숫자여야 합니다.");
    const avg = Number(avgPrice);
    if (!avgPrice.trim() || !Number.isFinite(avg) || avg <= 0)
      return setErr("평균 매입 단가는 0보다 큰 숫자여야 합니다.");

    // 목표가·손절가는 양수 검사를 하지 않는다(수량·평단과 다른 지점). 추가 경로와 서버
    // (shared/holdings.ts optionalNumber)가 0·음수를 허용하므로, 여기서만 막으면 이미 목표가 0으로
    // 저장된 종목은 수량만 고치려 해도 저장이 봉쇄된다. 막는 건 '숫자로 못 읽는 입력'뿐이다.
    const nextTarget = parseOptional(targetPrice);
    if (nextTarget === undefined) return setErr("목표가는 숫자이거나 비어 있어야 합니다.");
    const nextStop = parseOptional(stopPrice);
    if (nextStop === undefined) return setErr("손절가는 숫자이거나 비어 있어야 합니다.");

    const nextMemo = memo.trim();

    // 바뀐 키만 담는다 — 위 주석의 '유지 vs 해제' 계약을 지키는 지점이다.
    const patch: UpdateStockHoldingInput = {};
    if (qty !== h.quantity) patch.quantity = qty;
    if (avg !== h.avgPrice) patch.avgPrice = avg;
    if (nextTarget !== h.targetPrice) patch.targetPrice = nextTarget;
    if (nextStop !== h.stopPrice) patch.stopPrice = nextStop;
    if (horizon !== h.horizon) patch.horizon = horizon;
    if (nextMemo !== (h.memo ?? "")) patch.memo = nextMemo;

    if (Object.keys(patch).length === 0) {
      setOpen(false);
      return;
    }

    setSaving(true);
    setErr(null);
    try {
      await api.updateHolding(h.id, patch);
      setOpen(false);
      // 목록 전체를 다시 읽는다 — 평단·수량이 바뀌면 손익·평가금액도 서버가 다시 계산해야 한다.
      onSaved();
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
        if (v) seed();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="보유 내용 수정">
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {h.name} <span className="text-sm font-normal text-slate-400">{h.symbol}</span>
          </DialogTitle>
          <DialogDescription>
            수량·평단을 고치면 손익률이 다시 계산됩니다. 종목 자체는 바꿀 수 없습니다.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor={`eqty-${h.id}`}>보유 수량 *</Label>
              <Input
                id={`eqty-${h.id}`}
                type="number"
                step="any"
                min="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor={`eavg-${h.id}`}>평균 매입 단가 *</Label>
              <Input
                id={`eavg-${h.id}`}
                type="number"
                step="any"
                min="0"
                value={avgPrice}
                onChange={(e) => setAvgPrice(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor={`etgt-${h.id}`}>목표가</Label>
              <Input
                id={`etgt-${h.id}`}
                type="number"
                step="any"
                min="0"
                value={targetPrice}
                onChange={(e) => setTargetPrice(e.target.value)}
                placeholder="비우면 해제"
              />
            </div>
            <div>
              <Label htmlFor={`estop-${h.id}`}>손절가</Label>
              <Input
                id={`estop-${h.id}`}
                type="number"
                step="any"
                min="0"
                value={stopPrice}
                onChange={(e) => setStopPrice(e.target.value)}
                placeholder="비우면 해제"
              />
            </div>
          </div>
          <p className="text-xs text-slate-500">
            목표가·손절가는 <strong>칸을 비우면 해제</strong>됩니다. 그대로 두면 지금 값이 유지됩니다.
          </p>

          <div>
            <Label>투자 기간 *</Label>
            <div className="mt-1 flex gap-2">
              {HORIZONS.map((x) => (
                <button
                  key={x}
                  type="button"
                  onClick={() => setHorizon(x)}
                  className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                    horizon === x
                      ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                      : "border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {horizonLabel(x)}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">{horizonDescription(horizon)}</p>
          </div>

          <div>
            <Label htmlFor={`ememo-${h.id}`}>보유 이유 / 메모</Label>
            <Textarea
              id={`ememo-${h.id}`}
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
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} 저장
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
