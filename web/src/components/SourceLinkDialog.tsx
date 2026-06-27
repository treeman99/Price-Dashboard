import { useEffect, useState } from "react";
import {
  Link2,
  Loader2,
  ExternalLink,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Search,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { sourceLabel } from "@/lib/sources";
import type { ProductSource, ResolveCandidate } from "@shared/types";

/**
 * 소스 연결 / pcode 확정 다이얼로그 (문서 §7, 사람 검수 필수).
 * - 현재 연결된 소스 + 확정 여부 배지 + 해제
 * - 다나와 후보 resolve → 사람이 직접 1건 선택 → confirmed:true 로 확정
 * - 자동 선택 금지(드리프트 방지).
 */
export function SourceLinkDialog({
  productId,
  productName,
  onChanged,
}: {
  productId: number;
  productName: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<ProductSource[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [candidates, setCandidates] = useState<ResolveCandidate[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function loadSources() {
    setLoadingSources(true);
    setErr(null);
    try {
      setSources(await api.listSources(productId));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingSources(false);
    }
  }

  // 열 때마다 현재 상태 동기화 + 이전 후보/안내 초기화.
  useEffect(() => {
    if (!open) return;
    setCandidates(null);
    setNote(null);
    setErr(null);
    void loadSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function resolve() {
    setResolving(true);
    setErr(null);
    setCandidates(null);
    setNote(null);
    try {
      const res = await api.resolveSource(productId, "danawa");
      setCandidates(res.candidates);
      setNote(res.note);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setResolving(false);
    }
  }

  async function confirmCandidate(c: ResolveCandidate) {
    const key = c.refId ?? c.url;
    setConfirmingKey(key);
    setErr(null);
    try {
      await api.upsertSource(productId, {
        source: c.source,
        refId: c.refId,
        url: c.url,
        confirmed: true,
      });
      await loadSources();
      setCandidates(null);
      setNote(null);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setConfirmingKey(null);
    }
  }

  async function removeSource(source: string) {
    const label = sourceLabel(source) ?? source;
    if (!window.confirm(`'${label}' 소스 연결을 해제할까요?`)) return;
    setDeleting(source);
    setErr(null);
    try {
      await api.deleteSource(productId, source);
      await loadSources();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" title="소스 연결 / pcode 확정">
          <Link2 className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4" /> 소스 연결 · pcode 확정
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {productName} — 다나와 후보 중 정확한 상품을 직접 골라 확정합니다. (자동 선택하지 않습니다)
          </DialogDescription>
        </DialogHeader>

        {/* 현재 연결된 소스 */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground">연결된 소스</h3>
          {loadingSources ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 불러오는 중…
            </div>
          ) : sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              연결된 소스가 없습니다. 아래에서 다나와 후보를 찾아 확정하세요. (확정 전에는 LLM/네이버 폴백으로만 수집됩니다)
            </p>
          ) : (
            <ul className="max-h-40 space-y-1.5 overflow-y-auto">
              {sources.map((s) => (
                <li
                  key={s.source}
                  className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{sourceLabel(s.source) ?? s.source}</span>
                      {s.confirmed ? (
                        <Badge
                          className="border-transparent gap-1 text-white"
                          style={{ backgroundColor: "#2ecc71" }}
                        >
                          <CheckCircle2 className="h-3 w-3" /> 확정
                        </Badge>
                      ) : (
                        <Badge className="border-transparent bg-muted text-muted-foreground">
                          미확정
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      {s.refId && <span>pcode {s.refId}</span>}
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5 hover:underline"
                      >
                        링크 <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="연결 해제"
                    disabled={deleting === s.source}
                    onClick={() => removeSource(s.source)}
                  >
                    {deleting === s.source ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 다나와 후보 찾기 */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-muted-foreground">다나와 후보</h3>
            <Button variant="outline" size="sm" onClick={resolve} disabled={resolving}>
              {resolving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              {candidates ? "다시 찾기" : "후보 찾기"}
            </Button>
          </div>

          {resolving && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 다나와 검색 중… (외부 호출이라 다소 느릴 수
              있어요)
            </div>
          )}

          {!resolving && note && (
            <div className="flex items-start gap-2 rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{note}</span>
            </div>
          )}

          {!resolving && candidates && candidates.length > 0 && (
            <ul className="max-h-60 space-y-1.5 overflow-y-auto">
              {candidates.map((c) => {
                const key = c.refId ?? c.url;
                return (
                  <li
                    key={key}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium" title={c.title}>
                        {c.title}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        {c.refId && <span>pcode {c.refId}</span>}
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 hover:underline"
                        >
                          다나와 <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      disabled={confirmingKey !== null}
                      onClick={() => confirmCandidate(c)}
                      title="이 상품으로 확정"
                    >
                      {confirmingKey === key ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4" />
                      )}
                      확정
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          {!resolving && candidates && candidates.length === 0 && !note && (
            <p className="text-sm text-muted-foreground">후보가 없습니다.</p>
          )}
        </section>

        {err && <p className="text-sm text-up">{err}</p>}
      </DialogContent>
    </Dialog>
  );
}
