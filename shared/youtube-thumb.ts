// 유튜브 영상 ID·섬네일 주소 — 보고서 화면(보고서 탭·1면)과 보고서 메일이 같은 규칙을 쓴다.
//
// 섬네일 주소는 저장하지 않고 영상 ID 로 그때그때 만든다. 그래서 예전 실행 기록(report.json 에 videoId 가 없는
// 2026-11-22 실행 포함)에도 그대로 적용된다 — 영상 ID 는 videoId → 항목 키(yt:<ID>) → 영상 URL 순으로 찾는다.

/** YouTube 11자 영상 ID. 주소에 끼워 넣기 전에 이 형식만 통과시킨다(LLM·RSS 값이라 신뢰하지 않는다). */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function isYoutubeVideoId(id: string | null | undefined): id is string {
  return !!id && VIDEO_ID.test(id);
}

/** YouTube URL → 11자 영상 ID(watch?v=·youtu.be·shorts·embed·live). 없으면 null. */
export function youtubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m =
    /[?&]v=([A-Za-z0-9_-]{11})/.exec(url) ||
    /youtu\.be\/([A-Za-z0-9_-]{11})/.exec(url) ||
    /\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/.exec(url);
  return m ? m[1] : null;
}

/** 보고서 항목의 영상 ID: videoId → 항목 키 `yt:<ID>` → 영상 URL. 끝내 모르면 null. */
export function entryVideoId(e: { videoId?: string | null; key?: string | null; url?: string | null }): string | null {
  if (isYoutubeVideoId(e.videoId)) return e.videoId;
  const fromKey = e.key?.startsWith("yt:") ? e.key.slice(3) : null;
  if (isYoutubeVideoId(fromKey)) return fromKey;
  return youtubeId(e.url);
}

/**
 * 섬네일 크기 — 앞에서부터 시도한다. hqdefault(480×360, 4:3 — 16:9 영상은 위아래 검은 띠)가 모든 영상에 있는
 * 기본값이고, 못 받으면 mqdefault(320×180, 16:9) → default(120×90).
 */
export const YOUTUBE_THUMB_SIZES = ["hqdefault", "mqdefault", "default"] as const;
export type YoutubeThumbSize = (typeof YOUTUBE_THUMB_SIZES)[number];

export function youtubeThumbUrl(videoId: string | null | undefined, size: YoutubeThumbSize = "hqdefault"): string | null {
  return isYoutubeVideoId(videoId) ? `https://i.ytimg.com/vi/${videoId}/${size}.jpg` : null;
}

/** 화면의 섬네일 후보(큰 것부터). 영상 ID 가 없거나 형식이 틀리면 빈 배열. */
export function youtubeThumbCandidates(videoId: string | null | undefined): string[] {
  if (!isYoutubeVideoId(videoId)) return [];
  return YOUTUBE_THUMB_SIZES.map((s) => `https://i.ytimg.com/vi/${videoId}/${s}.jpg`);
}

/**
 * 섬네일이 없을 때 i.ytimg.com 은 404 와 함께 120×90 회색 자리표시 JPEG 를 준다. 브라우저에 따라 이 응답이
 * error 가 아니라 load 로 끝나므로, 큰 크기(hq·mq)를 요청했는데 120px 이하(0 = 그리지 못함 포함)가 오면 실패로 보고
 * 다음 크기로 넘어간다.
 */
export function isYoutubePlaceholderSize(naturalWidth: number): boolean {
  return naturalWidth <= 120;
}

/**
 * 후보 index 번째 섬네일을 받은 결과로 다음에 그릴 후보 위치를 정한다(화면 대체 순서, 순수 함수).
 * - 그대로 index 면 성공, index+1 이면 다음 크기로. 돌려준 값이 total 이상이면 모두 실패 → 자리표시를 그린다.
 * - 마지막 후보(default, 원래 120×90)는 자리표시 크기 판정을 하지 않는다 — 0(그리지 못함)일 때만 실패.
 */
export function nextThumbIndex(index: number, total: number, result: { error: true } | { naturalWidth: number }): number {
  if ("error" in result) return index + 1;
  const w = result.naturalWidth;
  const failed = w <= 0 || (index < total - 1 && isYoutubePlaceholderSize(w));
  return failed ? index + 1 : index;
}
