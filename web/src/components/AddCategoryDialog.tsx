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
import { api } from "@/lib/api";

export function AddCategoryDialog({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [emoji, setEmoji] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setLabel("");
    setEmoji("");
    setDescription("");
    setErr(null);
  }

  async function submit() {
    if (!label.trim()) {
      setErr("카테고리 이름을 입력하세요.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.addNewsCategory({
        label: label.trim(),
        emoji: emoji.trim() || undefined,
        description: description.trim() || undefined,
      });
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
        <Button variant="outline">
          <Plus className="h-4 w-4" /> 카테고리 추가
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>뉴스 카테고리 추가</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            추가한 카테고리는 다음 수집(또는 "지금 갱신")부터 채워집니다.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>카테고리 이름</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="예: 스포츠, 게임, 바이오" />
          </div>
          <div className="space-y-1">
            <Label>이모지 (선택)</Label>
            <Input value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="예: ⚽ (비우면 📰)" />
          </div>
          <div className="space-y-1">
            <Label>수집 가이드 (선택) — 어떤 뉴스를 원하는지</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="예: 해외 축구·국내 프로야구·올림픽 등 스포츠 주요 뉴스"
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
            추가
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
