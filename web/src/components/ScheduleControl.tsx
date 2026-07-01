import { useCallback, useEffect, useRef, useState } from "react";
import { Clock, Loader2, Pencil, Plus, X } from "lucide-react";
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
import type { ScheduleSettings } from "@shared/types";

export type ScheduleKind = "price" | "events" | "news" | "youtube";

const KIND_LABEL: Record<ScheduleKind, string> = {
  price: "가격",
  events: "팝업·전시",
  news: "뉴스",
  youtube: "유튜브",
};

// <input type="time"> 는 항상 zero-pad "HH:mm" 을 준다.
const HHMM = /^\d{2}:\d{2}$/;

/** kind 별 patch 구성(타입 안전). */
function patchFor(kind: ScheduleKind, times: string[]): Partial<ScheduleSettings> {
  switch (kind) {
    case "price":
      return { price: times };
    case "events":
      return { events: times };
    case "news":
      return { news: times };
    case "youtube":
      return { youtube: times };
  }
}

/**
 * 탭별 자동 수집 시각을 보여주고 그 자리에서 +/-로 추가·삭제하는 인라인 컨트롤.
 * 각 보드 헤더에 <ScheduleControl kind="..." /> 한 줄로 삽입한다.
 */
export function ScheduleControl({ kind }: { kind: ScheduleKind }) {
  const [schedule, setSchedule] = useState<ScheduleSettings | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seededRef = useRef(false);

  const load = useCallback(() => {
    setLoadErr(false);
    api
      .schedule()
      .then(setSchedule)
      .catch(() => setLoadErr(true));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const display = schedule ? schedule[kind].join(", ") : loadErr ? "불러오기 실패" : "…";

  // 열릴 때 현재 값으로 rows 를 1회만 seed. ref 가드로 늦게 도착한 schedule 이나
  // 재렌더가 사용자가 편집 중인 입력을 덮어쓰지 않게 한다.
  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      return;
    }
    if (seededRef.current || !schedule) return;
    setRows(schedule[kind].length ? [...schedule[kind]] : [""]);
    setErr(null);
    seededRef.current = true;
  }, [open, schedule, kind]);

  function setRow(i: number, v: string) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? v : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, ""]);
  }
  function removeRow(i: number) {
    setRows((rs) => (rs.length <= 1 ? rs : rs.filter((_, idx) => idx !== i)));
  }

  async function save() {
    const times = rows.map((t) => t.trim()).filter(Boolean);
    if (times.length === 0) {
      setErr("시간을 최소 1개 입력하세요.");
      return;
    }
    const bad = times.find((t) => !HHMM.test(t));
    if (bad) {
      setErr(`시간 형식 오류: "${bad}" — HH:mm 로 입력하세요.`);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      setSchedule(await api.updateSchedule(patchFor(kind, times)));
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const cannotEdit = loadErr && !schedule;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
          title="자동 수집 시간 변경"
        >
          <Clock className="h-3 w-3" />
          <span>자동 수집 {display}</span>
          <Pencil className="h-3 w-3 opacity-60" />
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{KIND_LABEL[kind]} 자동 수집 시간</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            매일 지정한 시각마다 자동으로 수집합니다. + 로 시간을 추가하고, − 로 지웁니다.
          </DialogDescription>
        </DialogHeader>

        {cannotEdit ? (
          <div className="flex items-center justify-between gap-2 rounded-md border border-up/40 bg-up/10 px-3 py-2 text-sm text-up">
            <span>스케줄을 불러오지 못했습니다.</span>
            <Button variant="outline" size="sm" onClick={load}>
              다시 시도
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Label>수집 시간</Label>
            {rows.map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  type="time"
                  value={t}
                  onChange={(e) => setRow(i, e.target.value)}
                  className="w-40"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeRow(i)}
                  disabled={rows.length <= 1}
                  title="이 시간 삭제"
                  aria-label="이 시간 삭제"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={addRow}>
              <Plus className="h-4 w-4" /> 시간 추가
            </Button>
            {err && <p className="text-sm text-up">{err}</p>}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            취소
          </Button>
          <Button onClick={save} disabled={busy || cannotEdit}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            저장
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
