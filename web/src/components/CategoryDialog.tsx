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
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { NewsCategoryDef } from "@shared/types";

export interface CategoryDialogState {
  mode: "add" | "edit";
  cat?: NewsCategoryDef;
}

/** 보드 종류별 API/표시문구. CategoryDialog를 뉴스/유튜브가 공유한다. */
const KIND_CONFIG = {
  news: {
    noun: "뉴스",
    add: api.addNewsCategory,
    update: api.updateNewsCategory,
    guidePlaceholder: "예: 해외 축구·국내 프로야구·올림픽 등 스포츠 주요 뉴스",
    hasRegion: false,
  },
  youtube: {
    noun: "유튜브",
    add: api.addYoutubeCategory,
    update: api.updateYoutubeCategory,
    guidePlaceholder: "예: AI 코딩 도구 리뷰·튜토리얼 (원하는 세부 주제·갈래를 적으면 더 잘 찾습니다)",
    hasRegion: true, // 유튜브만 검색 범위(한국/해외)·추천 채널 노출
  },
} as const;

export type CategoryKind = keyof typeof KIND_CONFIG;

export function CategoryDialog({
  state,
  kind = "news",
  onClose,
  onSaved,
}: {
  state: CategoryDialogState | null;
  kind?: CategoryKind;
  onClose: () => void;
  onSaved: () => void;
}) {
  const cfg = KIND_CONFIG[kind];
  const editing = state?.mode === "edit";
  const [label, setLabel] = useState("");
  const [emoji, setEmoji] = useState("");
  const [description, setDescription] = useState("");
  const [region, setRegion] = useState<"kr" | "global">("kr");
  const [excludeKw, setExcludeKw] = useState("");
  const [recChannels, setRecChannels] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 다이얼로그가 열릴 때 초기값 채우기 (수정 모드면 기존 값)
  useEffect(() => {
    if (!state) return;
    setLabel(state.cat?.label ?? "");
    setEmoji(state.cat?.emoji ?? "");
    setDescription(state.cat?.description ?? "");
    setRegion(state.cat?.region === "global" ? "global" : "kr"); // 미지정=한국 전용
    setExcludeKw((state.cat?.excludeKeywords ?? []).join(", "));
    setRecChannels((state.cat?.recommendedChannels ?? []).join(", "));
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
      // 유튜브 전용 필드(검색 범위 + 제외 키워드). 쉼표로 구분 입력을 배열로.
      const ytFields = cfg.hasRegion
        ? {
            region,
            // 쉼표 또는 줄바꿈으로 구분(여러 줄 입력 지원)
            excludeKeywords: excludeKw
              .split(/[,\n]/)
              .map((s) => s.trim())
              .filter(Boolean),
            recommendedChannels: recChannels
              .split(/[,\n]/)
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : {};
      if (editing && state?.cat) {
        await cfg.update(state.cat.key, {
          label: label.trim(),
          emoji: emoji.trim(), // 빈 문자열 → 서버가 자동 재배정
          description: description.trim(),
          ...ytFields,
        });
      } else {
        await cfg.add({
          label: label.trim(),
          emoji: emoji.trim() || undefined,
          description: description.trim() || undefined,
          ...ytFields,
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
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "카테고리 수정" : `${cfg.noun} 카테고리 추가`}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {editing
              ? "변경 사항은 다음 수집부터 반영됩니다."
              : "추가한 카테고리는 다음 수집(또는 \"지금 갱신\")부터 채워집니다. 수집 가이드를 비우거나 짧게 적으면 AI가 상세 지침을 대신 작성합니다(십수 초 소요)."}
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
            <Label>
              {editing
                ? "수집 가이드 (선택) — 무엇을 원하는지"
                : "수집 가이드 (선택) — 짧게 적어도 AI가 상세 지침으로 확장합니다"}
            </Label>
            <Textarea
              className="min-h-[7.5rem]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={cfg.guidePlaceholder}
            />
          </div>
          {cfg.hasRegion && (
            <div className="space-y-1">
              <Label>검색 범위</Label>
              <div className="flex gap-2">
                {([
                  ["kr", "🇰🇷 한국 영상만"],
                  ["global", "🌐 해외 포함"],
                ] as const).map(([val, text]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setRegion(val)}
                    className={
                      "flex-1 rounded-md border px-3 py-2 text-sm transition-colors " +
                      (region === val
                        ? "border-primary bg-primary/10 font-medium text-foreground"
                        : "border-input text-muted-foreground hover:bg-muted")
                    }
                  >
                    {text}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                한국 영상만: 한국 채널·한국어 영상만 수집 · 해외 포함: 국가 제한 없이 수집(요약은 한국어)
              </p>
            </div>
          )}
          {cfg.hasRegion && (
            <div className="space-y-1">
              <Label>추천 채널 (선택, 쉼표로 구분)</Label>
              <Textarea
                value={recChannels}
                onChange={(e) => setRecChannels(e.target.value)}
                placeholder="예: 안될과학, @3blue1brown, Two Minute Papers"
              />
              <p className="text-xs text-muted-foreground">
                이 채널들의 최근 업로드를 우선 확인합니다. 채널명 또는 @핸들 (하드 필터가 아니라 우선순위 힌트).
              </p>
            </div>
          )}
          {cfg.hasRegion && (
            <div className="space-y-1">
              <Label>제외 키워드 (선택, 쉼표로 구분)</Label>
              <Textarea
                value={excludeKw}
                onChange={(e) => setExcludeKw(e.target.value)}
                placeholder="예: 자동차, 차량, SUV, 모빌리티, 시승"
              />
              <p className="text-xs text-muted-foreground">
                제목·채널명에 이 단어가 들어간 영상은 제외합니다(대소문자 무시).
              </p>
            </div>
          )}
          {err && <p className="text-sm text-up">{err}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {editing ? "저장" : busy ? "AI 지침 작성 중…" : "추가"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
