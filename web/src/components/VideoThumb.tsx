import { useState, type MouseEventHandler } from "react";
import { CirclePlay } from "lucide-react";
import { nextThumbIndex, youtubeThumbCandidates } from "@shared/youtube-thumb";
import { cn } from "@/lib/utils";

/**
 * 유튜브 영상 섬네일(16:9 상자). 영상 ID 로 표준 섬네일 주소를 만들어 hqdefault → mqdefault → default 순으로
 * 시도하고(로드 실패·YouTube 의 120×90 회색 자리표시면 다음 크기), 모두 안 되거나 영상 ID 를 모르면 재생 아이콘
 * 자리표시를 그린다 — 유튜브 항목은 늘 같은 자리에 섬네일 칸이 선다. hqdefault 는 4:3(16:9 영상은 위아래 검은 띠)이라
 * object-cover 로 띠를 잘라 16:9 상자에 채운다.
 *
 * 저장된 섬네일 주소를 쓰지 않으므로 예전 실행 기록에도 그대로 적용된다(shared/youtube-thumb.ts).
 */
export function VideoThumb({
  videoId,
  href,
  onOpen,
  className,
}: {
  videoId: string | null | undefined;
  /** 섬네일을 누르면 열 영상 주소(safeHref 를 거친 값). 없으면 링크 없이 그린다. */
  href?: string | null;
  onOpen?: MouseEventHandler<HTMLAnchorElement>;
  /** 폭은 호출부가 정한다(예: "w-24", 그리드 칸에 넣으면 "w-full"). 높이는 16:9 로 따라간다. */
  className?: string;
}) {
  const candidates = youtubeThumbCandidates(videoId);
  // 영상이 바뀌면(행 재사용) 처음 후보부터 — 상태에 어떤 영상의 진행인지 같이 둔다.
  const [step, setStep] = useState<{ id: string | null | undefined; index: number }>({ id: videoId, index: 0 });
  const index = step.id === videoId ? step.index : 0;
  const src = candidates[index] ?? null;
  const advance = (next: number) => {
    if (next !== index) setStep({ id: videoId, index: next });
  };

  const box = cn("relative block aspect-video shrink-0 self-start overflow-hidden rounded-[3px] bg-muted", className);
  const inner = src ? (
    <img
      key={src}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      className="h-full w-full object-cover"
      onLoad={(ev) => advance(nextThumbIndex(index, candidates.length, { naturalWidth: ev.currentTarget.naturalWidth }))}
      onError={() => advance(nextThumbIndex(index, candidates.length, { error: true }))}
    />
  ) : (
    <span className="flex h-full w-full items-center justify-center" data-thumb-fallback="">
      <CirclePlay className="h-6 w-6 text-muted-foreground/60" aria-hidden />
    </span>
  );

  if (!href) return <span className={box}>{inner}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer" onClick={onOpen} className={box} tabIndex={-1} aria-hidden>
      {inner}
    </a>
  );
}
