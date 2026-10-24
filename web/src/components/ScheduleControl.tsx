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
import { Tip } from "@/components/ui/tooltip";
import { Input, Label } from "@/components/ui/input";
import { Notice } from "@/components/ui/page";
import { api } from "@/lib/api";
import type { ScheduleSettings } from "@shared/types";

export type ScheduleKind =
  | "events"
  | "news"
  | "youtube"
  | "stockKr"
  | "stockUs"
  | "stockPulse";

const KIND_LABEL: Record<ScheduleKind, string> = {
  events: "팝업·전시",
  news: "뉴스",
  youtube: "유튜브",
  stockKr: "증시(한국)",
  stockUs: "증시(미국)",
  // 다른 탭은 하루 1~2회지만 펄스는 기본 16회다. 라벨에 성격을 박아 두지 않으면
  // 시각 목록이 길게 늘어선 것을 보고 오설정으로 오해한다.
  stockPulse: "실시간 취합(매시)",
};

// <input type="time"> 는 항상 zero-pad "HH:mm" 을 준다.
const HHMM = /^\d{2}:\d{2}$/;

/** 툴바에 그대로 늘어놓는 시각 수. 이보다 많으면 '외 N개'로 접는다. */
const VISIBLE_TIMES = 4;

/** kind 별 patch 구성(타입 안전). */
function patchFor(kind: ScheduleKind, times: string[]): Partial<ScheduleSettings> {
  switch (kind) {
    case "events":
      return { events: times };
    case "news":
      return { news: times };
    case "youtube":
      return { youtube: times };
    case "stockKr":
      return { stockKr: times };
    case "stockUs":
      return { stockUs: times };
    case "stockPulse":
      return { stockPulse: times };
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

  const times = schedule?.[kind] ?? null;
  // 실시간 취합처럼 시각이 많으면(기본 16~18개) 툴바 한 줄을 넘쳐 레이아웃을 깬다.
  // 앞 몇 개만 보이고 나머지는 '외 N개'로 줄이되, 전체는 title 과 다이얼로그에 그대로 있다.
  const shownTimes = times ? times.slice(0, VISIBLE_TIMES) : [];
  const hiddenCount = times ? times.length - shownTimes.length : 0;
  const fullList = times ? times.join(", ") : null;

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
          className="group inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={fullList ? `자동 수집 시간 변경 — ${fullList}` : "자동 수집 시간 변경"}
        >
          {/* hover 때 시계 자리에 연필을 겹쳐 보인다 — 뒤에 따로 두면 숨긴 아이콘이 툴바 간격을 벌린다. */}
          <span aria-hidden className="relative h-3.5 w-3.5 shrink-0">
            <Clock className="absolute inset-0 h-3.5 w-3.5 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0" />
            <Pencil className="absolute inset-0 h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          </span>
          <span>자동 수집</span>
          {times ? (
            <span className="num font-mono text-[12.5px] text-foreground">
              {shownTimes.join(", ")}
              {hiddenCount > 0 && (
                <span className="font-sans text-[13px] text-muted-foreground"> 외 {hiddenCount}개</span>
              )}
            </span>
          ) : (
            <span>{loadErr ? "불러오기 실패" : "…"}</span>
          )}
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
          <Notice
            tone="error"
            className="mb-0"
            action={
              <Button variant="outline" size="sm" onClick={load}>
                다시 시도
              </Button>
            }
          >
            스케줄을 불러오지 못했습니다.
          </Notice>
        ) : (
          <div className="space-y-2">
            <Label>
              수집 시간
              {rows.length > 1 && (
                <span className="num ml-1.5 font-mono text-[12px] font-normal text-muted-foreground">
                  {rows.length}
                </span>
              )}
            </Label>
            {/* 실시간 취합은 시각이 16개 이상이라 한 줄씩 쌓으면 다이얼로그가 화면보다 길어진다 → 두 칸으로 흘린다. */}
            <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {rows.map((t, i) => (
                <div key={i} className="flex items-center gap-1">
                  <Input
                    type="time"
                    value={t}
                    onChange={(e) => setRow(i, e.target.value)}
                    className="w-40"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="group/tt relative"
                    onClick={() => removeRow(i)}
                    disabled={rows.length <= 1}
                    aria-label="이 시간 삭제"
                  >
                    <X className="h-4 w-4" />
                    <Tip>이 시간 삭제</Tip>
                  </Button>
                </div>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={addRow}>
              <Plus className="h-4 w-4" /> 시간 추가
            </Button>
            {err && <p className="text-sm text-tone-error">{err}</p>}
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
