import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { NewsCategoryDef } from "@shared/types";

export interface CategoryDialogState {
  mode: "add" | "edit";
  cat?: NewsCategoryDef;
}

export function CategoryDialog({
  state,
  onClose,
  onSaved,
}: {
  state: CategoryDialogState | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = state?.mode === "edit";
  const [label, setLabel] = useState("");
  const [emoji, setEmoji] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 다이얼로그가 열릴 때 초기값 채우기 (수정 모드면 기존 값)
  useEffect(() => {
    if (!state) return;
    setLabel(state.cat?.label ?? "");
    setEmoji(state.cat?.emoji ?? "");
    setDescription(state.cat?.description ?? "");
    setErr(null);
  }, [state]);

  async function submit() {
    if (!label.trim()) {
      setErr("카테고리 이름을 입력하세요.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (editing && state?.cat) {
        await api.updateNewsCategory(state.cat.key, {
          label: label.trim(),
          emoji: emoji.trim(), // 빈 문자열 → 서버가 자동 재배정
          description: description.trim(),
        });
      } else {
        await api.addNewsCategory({
          label: label.trim(),
          emoji: emoji.trim() || undefined,
          description: description.trim() || undefined,
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!state} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "카테고리 수정" : "뉴스 카테고리 추가"}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {editing
              ? "변경 사항은 다음 수집부터 반영됩니다."
              : "추가한 카테고리는 다음 수집(또는 \"지금 갱신\")부터 채워집니다."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>카테고리 이름</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="예: 스포츠, 게임, 바이오" />
          </div>
          <div className="space-y-1">
            <Label>이모지 (선택 — 비우면 이름에 맞춰 자동 배정)</Label>
            <Input value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="예: ⚽ (비우면 자동)" />
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
          <Button variant="outline" onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {editing ? "저장" : "추가"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
