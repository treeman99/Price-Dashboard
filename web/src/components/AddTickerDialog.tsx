import { useState } from "react";
import { Plus, Loader2, Search, CheckCircle2 } from "lucide-react";
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
import { api } from "@/lib/api";
import { marketLabel } from "@shared/stock";
import type { StockMarket, StockSearchCandidate } from "@shared/types";

/**
 * 종목 추가 — 검색 → 후보 선택 → 확정 (SourceLinkDialog 의 사람 확정 패턴).
 * 자동 선택하지 않는다: "엔비디아" 같은 질의는 후보가 여러 개고, 잘못 고르면 엉뚱한 종목을 매일 추적한다.
 */
export function AddTickerDialog({
  market,
  onAdded,
}: {
  market: StockMarket;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<StockSearchCandidate[] | null>(null);
  const [addingSymbol, setAddingSymbol] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setQuery("");
    setCandidates(null);
    setAddingSymbol(null);
    setErr(null);
  }

  async function search() {
    if (!query.trim()) {
      setErr("종목명·종목코드·티커를 입력하세요.");
      return;
    }
    setSearching(true);
    setErr(null);
    setCandidates(null);
    try {
      setCandidates(await api.searchTickers(market, query.trim()));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSearching(false);
    }
  }

  async function add(c: StockSearchCandidate) {
    setAddingSymbol(c.symbol);
    setErr(null);
    try {
      // 사람이 고른 후보의 심볼로 확정 — 원래 질의("엔비디아")를 그대로 넘기면 서버가 다시 추측하게 된다.
      await api.addTicker(market, { query: c.symbol });
      setOpen(false);
      reset();
      onAdded();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setAddingSymbol(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" /> 종목 추가
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{marketLabel(market)} 관심 종목 추가</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            종목을 검색한 뒤 후보 중 정확한 종목을 직접 골라 추가합니다. (자동 선택하지 않습니다)
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>종목 검색</Label>
            <div className="flex items-center gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") search();
                }}
                placeholder={market === "kr" ? "예: 삼성전자 · 005930" : "예: 엔비디아 · NVDA"}
              />
              <Button variant="outline" onClick={search} disabled={searching}>
                {searching ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                검색
              </Button>
            </div>
          </div>

          {searching && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 검색 중…
            </div>
          )}

          {!searching && candidates && candidates.length > 0 && (
            <ul className="max-h-60 space-y-1.5 overflow-y-auto">
              {candidates.map((c) => (
                <li
                  key={`${c.market}:${c.symbol}`}
                  className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium" title={c.name}>
                      {c.name}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{c.symbol}</span>
                      {c.exchange && <span>· {c.exchange}</span>}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    disabled={addingSymbol !== null}
                    onClick={() => add(c)}
                    title="이 종목으로 추가"
                  >
                    {addingSymbol === c.symbol ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                    추가
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {!searching && candidates && candidates.length === 0 && (
            <p className="text-sm text-muted-foreground">검색 결과가 없습니다. 다른 표기로 찾아보세요.</p>
          )}

          {err && <p className="text-sm text-up">{err}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={addingSymbol !== null}>
            닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
