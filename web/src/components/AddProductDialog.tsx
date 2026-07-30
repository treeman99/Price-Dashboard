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
import type { CreateProductInput } from "@shared/types";

/** "루나|Luna, 울트라|Ultra" → [["루나","Luna"],["울트라","Ultra"]] (쉼표·줄바꿈으로 그룹 구분) */
function parseIncludeGroups(s: string): string[][] {
  return s
    .split(/[,\n]/)
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) => g.split("|").map((t) => t.trim()).filter(Boolean));
}

/** "Slim, 슬림" → ["Slim","슬림"] (쉼표·줄바꿈으로 구분) */
function parseTokens(s: string): string[] {
  return s.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
}

export function AddProductDialog({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [minMan, setMinMan] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setName("");
    setInclude("");
    setExclude("");
    setMinMan("");
    setErr(null);
  }

  async function submit() {
    if (!name.trim()) {
      setErr("상품명을 입력하세요.");
      return;
    }
    const input: CreateProductInput = {
      name: name.trim(),
      mustInclude: parseIncludeGroups(include),
      mustExclude: parseTokens(exclude),
      minPrice: Math.round((Number(minMan) || 0) * 10000),
    };
    setBusy(true);
    setErr(null);
    try {
      await api.addProduct(input);
      setOpen(false);
      reset();
      onAdded();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" /> 상품 추가
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>관심 상품 추가</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            추가하면 곧바로 목록에 나타나고, 1차 수집(가격·리뷰)은 백그라운드로 1~2분 진행됩니다.
            카드의 '수집 중' 배지가 사라지면 완료입니다.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>상품명 (검색어)</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 드리미 X60 Ultra" />
          </div>
          <div className="space-y-1">
            <Label>포함 조건 (쉼표·줄바꿈=필수 그룹, | =동의어)</Label>
            <Textarea
              value={include}
              onChange={(e) => setInclude(e.target.value)}
              placeholder={"예: X60, 울트라|Ultra\n(그룹마다 줄바꿈으로 나눠도 됩니다)"}
            />
          </div>
          <div className="space-y-1">
            <Label>제외 키워드 (쉼표·줄바꿈 구분)</Label>
            <Textarea
              value={exclude}
              onChange={(e) => setExclude(e.target.value)}
              placeholder="예: X50, X40, Pro"
            />
          </div>
          <div className="space-y-1">
            <Label>최소가 (만원) — 액세서리 제외용</Label>
            <Input
              type="number"
              value={minMan}
              onChange={(e) => setMinMan(e.target.value)}
              placeholder="예: 70"
            />
          </div>
          {err && <p className="text-sm text-up">{err}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            취소
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            추가 + 수집
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
