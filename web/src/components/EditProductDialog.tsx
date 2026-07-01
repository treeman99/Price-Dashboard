import { useEffect, useState } from "react";
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
import { api } from "@/lib/api";
import type { Product, UpdateProductInput } from "@shared/types";

// ── 파서 (AddProductDialog 와 동일 규칙) ──
/** "루나|Luna, 울트라|Ultra" → [["루나","Luna"],["울트라","Ultra"]] */
function parseIncludeGroups(s: string): string[][] {
  return s
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) => g.split("|").map((t) => t.trim()).filter(Boolean));
}

/** "Slim, 슬림" → ["Slim","슬림"] */
function parseTokens(s: string): string[] {
  return s.split(",").map((t) => t.trim()).filter(Boolean);
}

// ── 역직렬화 (기존 값 → 입력창 표시용 문자열) ──
/** [["루나","Luna"],["울트라","Ultra"]] → "루나|Luna, 울트라|Ultra" */
function serializeIncludeGroups(groups: string[][]): string {
  return groups.map((g) => g.join("|")).join(", ");
}

/** ["Slim","슬림"] → "Slim, 슬림" */
function serializeTokens(tokens: string[]): string {
  return tokens.join(", ");
}

/** 700000(원) → "70"(만원), 0/없음 → "" */
function serializeMan(minPrice: number): string {
  return minPrice ? String(minPrice / 10000) : "";
}

/**
 * 상품 정보 수정 다이얼로그. 추가 다이얼로그와 같은 4개 필드(검색어/포함/제외/최소가)를
 * 현재 값으로 채워 수정한다. 매칭 규칙 변경은 다음 수집부터 반영된다.
 */
export function EditProductDialog({
  product,
  onChanged,
}: {
  product: Product;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(product.name);
  const [include, setInclude] = useState(serializeIncludeGroups(product.mustInclude));
  const [exclude, setExclude] = useState(serializeTokens(product.mustExclude));
  const [minMan, setMinMan] = useState(serializeMan(product.minPrice));
  const [pending, setPending] = useState<null | "save" | "recollect">(null);
  const busy = pending !== null;
  const [err, setErr] = useState<string | null>(null);

  // 열려 있는 동안 현재 상품 값으로 폼 동기화. 저장 직후 목록 재조회로 product 가 갱신되면
  // (닫힘 상태에선 early-return, 열림 상태에선) 최신 값으로 맞춘다.
  // 대시보드는 폴링이 없고 모달이 다른 조작을 막으므로 편집 중 값이 지워질 일은 없다.
  useEffect(() => {
    if (!open) return;
    setName(product.name);
    setInclude(serializeIncludeGroups(product.mustInclude));
    setExclude(serializeTokens(product.mustExclude));
    setMinMan(serializeMan(product.minPrice));
    setErr(null);
  }, [open, product]);

  // 검색어(name)를 바꾸면 이미 확정된 가격비교(pcode) 소스가 이전 상품을 가리킬 수 있다.
  const nameChanged = name.trim() !== product.name;

  async function submit(recollect: boolean) {
    if (!name.trim()) {
      setErr("상품명을 입력하세요.");
      return;
    }
    const patch: UpdateProductInput = {
      name: name.trim(),
      mustInclude: parseIncludeGroups(include),
      mustExclude: parseTokens(exclude),
      minPrice: Math.max(0, Math.round((Number(minMan) || 0) * 10000)),
    };
    setPending(recollect ? "recollect" : "save");
    setErr(null);
    try {
      await api.updateProduct(product.id, patch);
    } catch (e) {
      // 저장 자체 실패 → 다이얼로그 유지, 에러 표시.
      setErr((e as Error).message);
      setPending(null);
      return;
    }
    // 저장 성공 — 재수집 성패와 무관하게 목록/카드를 즉시 갱신.
    onChanged();
    if (recollect) {
      try {
        // 매칭 규칙을 바로 반영해 오늘 가격을 정정하려면 이 상품만 즉시 재수집.
        await api.collectProduct(product.id);
      } catch (e) {
        setErr(`저장은 완료됐지만 재수집에 실패했습니다: ${(e as Error).message}`);
        onChanged();
        setPending(null);
        return;
      }
      onChanged();
    }
    setOpen(false);
    setPending(null);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" title="상품 정보 수정" aria-label="상품 정보 수정">
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>상품 정보 수정</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            검색어·매칭 규칙 변경은 다음 수집부터 반영됩니다. (가격 이력은 유지)
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>상품명 (검색어)</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 드리미 X60 Ultra" />
            {nameChanged && (
              <p className="text-xs text-amber-600">
                검색어를 바꾸면 확정된 가격비교(pcode) 연결이 이전 상품을 가리킬 수 있어요. 다른 제품으로
                바꾼 경우 소스 연결(🔗)에서 다시 확정하세요.
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label>포함 조건 (쉼표=필수 그룹, | =동의어)</Label>
            <Input
              value={include}
              onChange={(e) => setInclude(e.target.value)}
              placeholder="예: X60, 울트라|Ultra"
            />
          </div>
          <div className="space-y-1">
            <Label>제외 키워드 (쉼표 구분)</Label>
            <Input
              value={exclude}
              onChange={(e) => setExclude(e.target.value)}
              placeholder="예: X50, X40, Pro"
            />
          </div>
          <div className="space-y-1">
            <Label>최소가 (만원) — 액세서리 제외용</Label>
            <Input
              type="number"
              min={0}
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
          <Button
            variant="outline"
            onClick={() => submit(true)}
            disabled={busy}
            title="저장한 뒤 이 상품만 즉시 다시 수집해 오늘 가격을 정정합니다"
          >
            {pending === "recollect" && <Loader2 className="h-4 w-4 animate-spin" />}
            저장 후 재수집
          </Button>
          <Button onClick={() => submit(false)} disabled={busy}>
            {pending === "save" && <Loader2 className="h-4 w-4 animate-spin" />}
            저장
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
