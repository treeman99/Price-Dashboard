import { useEffect, useState } from "react";
import { Loader2, Ban, RotateCcw, Youtube } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { BlockedChannel } from "@shared/types";

export function BlockedChannelsDialog({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  /** 차단 해제 등으로 목록이 바뀌었을 때(보드가 스냅샷을 다시 불러오도록). */
  onChanged: () => void;
}) {
  const [list, setList] = useState<BlockedChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setList(await api.youtubeBlocklist());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) load();
  }, [open]);

  async function unblock(b: BlockedChannel) {
    setBusyId(b.id);
    try {
      await api.unblockYoutubeChannel(b.id);
      setList((prev) => prev.filter((x) => x.id !== b.id));
      onChanged(); // 보드 스냅샷 갱신 → 해제된 채널 영상 즉시 복원
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ban className="h-4 w-4" /> 조사 제외 채널 관리
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            여기 있는 채널은 유튜브 소식 조사에서 제외됩니다. '해제'를 누르면 다시 조사에 포함되고,
            현재 목록에 남아 있던 해당 채널 영상도 즉시 다시 보입니다.
          </DialogDescription>
        </DialogHeader>

        {err && <p className="text-sm text-up">{err}</p>}

        {loading ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 불러오는 중…
          </div>
        ) : list.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <Youtube className="h-8 w-8" />
            <p>제외한 채널이 없습니다.</p>
            <p className="text-xs">각 영상 카드의 '채널 제외' 버튼으로 추가할 수 있어요.</p>
          </div>
        ) : (
          <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
            {list.map((b) => (
              <div
                key={b.id}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{b.channel}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {b.handle ? `${b.handle} · ` : ""}
                    {new Date(b.blockedAt).toLocaleString("ko-KR")} 제외
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => unblock(b)}
                  disabled={busyId === b.id}
                  className="shrink-0"
                >
                  {busyId === b.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCcw className="h-4 w-4" />
                  )}
                  해제
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
