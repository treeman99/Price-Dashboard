import { AlertTriangle, CalendarDays } from "lucide-react";
import type { CollectAttempt } from "@/lib/api";

/**
 * '지금 보고 있는 내용이 언제 것인지'를 사용자 말로 알려 주는 안내 배너 (뉴스 · 팝업/전시 공용).
 *
 * ── 왜 필요한가 ──
 * 수집이 실패하면 서버는 **직전(=어제) 스냅샷을 그대로 유지**한다. 데이터가 사라지지 않는 건
 * 좋지만, 화면이 어제와 똑같이 멀쩡해 보여서 사용자는 그걸 **오늘 것으로 착각**한다.
 * 실패를 스냅샷의 notes 에 적어 두긴 했으나 화면이 그 필드를 렌더링하지 않아, 보호를 넣기 전보다
 * 오히려 상황이 덜 보이게 됐다(그때는 화면이 비어서 최소한 이상하다는 건 알 수 있었다).
 *
 * ── 판정 근거 ──
 * notes 문자열을 파싱하지 않는다. 정상 수집분에도 notes 가 붙기 때문이다(큐레이터가 남기는
 * 선별 기준 메모 — 실측: "명시적 발행일 또는 24시간 미만 시각이 확인된 텍스트 자료만 채택했다…").
 * 그래서 구조적 신호 세 개만 본다:
 *   ① 스냅샷의 기준 날짜(date)가 오늘인가
 *   ② 스냅샷의 출처(source)가 정상 큐레이션("llm")인가
 *   ③ **마지막 수집 시도**(lastAttempt)가 오늘 있었고 성공했는가
 * ③ 이 있어야 "실패해서 어제 것"과 "아직 오늘 수집 시각 전"을 가를 수 있다. 둘 다 화면에는
 * 어제 내용이 떠 있지만, 사용자가 할 일이 다르다(다시 눌러 볼 것 vs 그냥 기다릴 것).
 */

/** 로컬 기준 YYYY-MM-DD. 대시보드는 수집 서버와 같은 맥에서 돌아 시간대가 항상 일치한다. */
export function localDay(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "2026-08-01" → "8월 1일". 연도는 뺀다 — 하루이틀 차이를 읽는 용도라 오히려 방해된다. */
function korDay(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return `${Number(m[2])}월 ${Number(m[3])}일`;
}

/** "오후 3:07" */
function korTime(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
}

export interface SnapshotHealth {
  /** warn = 뭔가 잘못됐다(호박색) · info = 정상이지만 오늘 것은 아니다(회색) */
  tone: "warn" | "info";
  message: string;
}

/** snapshotHealth 가 보는 스냅샷의 최소 형태. 뉴스·이벤트 스냅샷 둘 다 이 필드를 갖는다. */
export interface NoticeSnapshot {
  /** 내용의 기준 날짜 (YYYY-MM-DD, 로컬) */
  date: string;
  /** 큐레이션 출처. "llm" 이 정상이고, 그 외는 실패했거나 정리되지 않은 원본이다. */
  source: string;
}

/**
 * 안내가 필요한 상황이면 문구를, 정상이면 null 을 돌려준다.
 * 정상 = 오늘 날짜 + source "llm" + 오늘 시도가 실패로 남아 있지 않음.
 */
export function snapshotHealth(
  snap: NoticeSnapshot | null,
  lastAttempt: CollectAttempt | null | undefined,
  opts: { today?: string; collecting?: boolean } = {}
): SnapshotHealth | null {
  if (!snap) return null; // 스냅샷 자체가 없는 경우는 각 보드가 '아직 수집된 정보가 없습니다'로 안내한다
  const today = opts.today ?? localDay();

  const isOld = snap.date < today; // YYYY-MM-DD 는 사전순 = 시간순
  const brokenSource = snap.source !== "llm";
  // ⚠️ lastAttempt.at 은 ISO(UTC)다. 문자열 앞 10자를 그대로 자르면 한국 시간 오전 5시 시도가
  //    '어제'로 읽힌다. 반드시 로컬 날짜로 환산해서 비교한다.
  const failedToday =
    !!lastAttempt && !lastAttempt.ok && localDay(new Date(lastAttempt.at)) === today;
  const at = lastAttempt ? korTime(lastAttempt.at) : null;

  if (isOld && failedToday) {
    return {
      tone: "warn",
      message:
        `오늘 수집이 실패해서 ${korDay(snap.date)}에 모은 내용을 그대로 보여주고 있습니다.` +
        `${at ? ` (마지막 시도 ${at})` : ""} 잠시 후 '지금 갱신'을 눌러 다시 시도할 수 있습니다.`,
    };
  }

  if (isOld) {
    // 오늘 수집 시각이 아직 오지 않은 정상 상태. 지금 수집 중이면 파란 '수집 중' 배너가
    // 같은 말을 더 정확히 하고 있으므로 겹쳐 띄우지 않는다.
    if (opts.collecting) return null;
    // "아직 수집 전입니다"라고 단정하지 않는다 — 오늘 시도가 성공으로 기록됐는데도 스냅샷이
    // 어제인 어긋난 상태가 드물게 있을 수 있고, 그때도 이 문장은 참이어야 한다.
    return {
      tone: "info",
      message: `오늘 수집분이 아직 반영되지 않아, 아래 내용은 ${korDay(snap.date)}에 모은 것입니다.`,
    };
  }

  if (brokenSource) {
    return {
      tone: "warn",
      message:
        snap.source === "naver-raw"
          ? `오늘 수집이 제대로 되지 않아, 정리되지 않은 검색 결과를 그대로 보여주고 있습니다. 행사와 무관한 글이 섞여 있을 수 있습니다.`
          : `오늘 수집이 제대로 되지 않아 내용을 가져오지 못했습니다. '지금 갱신'을 눌러 다시 시도할 수 있습니다.`,
    };
  }

  if (failedToday) {
    // 화면 내용 자체는 오늘 것이라 문제없지만, 그 뒤 재시도가 실패했다.
    // "갱신을 눌렀는데 아무것도 안 바뀐다"의 이유가 여기 있다.
    return {
      tone: "warn",
      message:
        `오늘 내용을 다시 모으려던 시도가 실패했습니다.${at ? ` (마지막 시도 ${at})` : ""}` +
        ` 아래 내용은 그 전에 모은 ${korDay(snap.date)} 것으로, 최신이 아닐 수 있습니다.`,
    };
  }

  return null;
}

/**
 * 안내 배너. LottoBoard 의 `state.lastError` 호박색 박스와 같은 디자인 언어를 쓴다.
 * `notes` 를 주면 원문을 '자세히'로 접어 둔다 — 평소엔 안 보이지만, 이유를 더 알고 싶은
 * 사람이 펼쳐 볼 수 있다(수집기가 남긴 메모라 문장이 기술적일 수 있어 접어 둔다).
 */
export function SnapshotNotice({
  health,
  notes,
}: {
  health: SnapshotHealth | null;
  notes?: string | null;
}) {
  if (!health) return null;
  const warn = health.tone === "warn";
  return (
    <div
      className={`mb-4 flex items-start gap-2 rounded-md border px-4 py-3 text-sm ${
        warn
          ? "border-amber-300 bg-amber-50 text-amber-800"
          : "border-transparent bg-muted/50 text-muted-foreground"
      }`}
    >
      {warn ? (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      ) : (
        <CalendarDays className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      <div className="min-w-0">
        <span>{health.message}</span>
        {notes && (
          <details className="mt-1">
            <summary className="cursor-pointer select-none text-xs opacity-70 hover:opacity-100">
              자세히
            </summary>
            <p className="mt-1 whitespace-pre-line break-words text-xs opacity-80">{notes}</p>
          </details>
        )}
      </div>
    </div>
  );
}
