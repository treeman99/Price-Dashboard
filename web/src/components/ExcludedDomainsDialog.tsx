import { useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import type { NewsExcludedDomain } from "@shared/types";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EmptyLine, Notice } from "@/components/ui/page";

/**
 * 보고서 탭 '수집 설정' — 뉴스 취합 제외 사이트 관리(2026-11-23).
 *
 * 보고서 뉴스 항목의 [이 사이트 제외]로 쌓이고, 여기서 직접 추가·해제한다. 세 모델 프롬프트에 알리고, 모델이 가져와도
 * 큐레이션 후처리와 보고서 통합 단계에서 다시 걸러낸다(하위 도메인 포함). 유튜브는 채널 차단을 쓴다.
 */
export function ExcludedDomainsDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const [list, setList] = useState<NewsExcludedDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [input, setInput] = useState("");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api
      .newsExcludedDomains()
      .then((l) => {
        setList(l);
        setErr(null);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [open]);

  async function add() {
    const v = input.trim();
    if (!v) return;
    setBusy("+");
    try {
      const r = await api.excludeNewsDomain(/^https?:\/\//i.test(v) ? { url: v } : { domain: v });
      setList(r.list);
      setInput("");
      setErr(null);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(domain: string) {
    setBusy(domain);
    try {
      const r = await api.unexcludeNewsDomain(domain);
      setList(r.list);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg p-4 sm:p-6">
        <DialogHeader className="pr-6">
          <DialogTitle>뉴스 취합 제외 사이트</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            이 사이트(하위 도메인 포함)의 기사는 세 모델이 조사·보고하지 않습니다. 해제하면 다음 실행부터 다시 포함됩니다.
          </DialogDescription>
        </DialogHeader>
        {err && <Notice tone="error">{err}</Notice>}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="예: example.com 또는 기사 주소" aria-label="제외할 사이트" />
          <Button type="submit" variant="outline" disabled={!input.trim() || busy === "+"}>
            {busy === "+" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} 추가
          </Button>
        </form>
        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> 불러오는 중…
          </p>
        ) : list.length === 0 ? (
          <EmptyLine>제외한 사이트가 없습니다.</EmptyLine>
        ) : (
          <ul className="divide-y border-y">
            {list.map((d) => (
              <li key={d.domain} className="flex items-center gap-2 py-2 text-[14px]">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{d.domain}</span>
                  {d.label && <span className="ml-1.5 text-[12.5px] text-muted-foreground">{d.label}</span>}
                </span>
                <Button size="sm" variant="outline" disabled={busy === d.domain} onClick={() => void remove(d.domain)}>
                  해제
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end pt-2">
          <Button variant="outline" onClick={onClose}>
            닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
