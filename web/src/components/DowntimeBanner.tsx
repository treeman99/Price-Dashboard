import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { localDay } from "@/components/SnapshotNotice";
import {
  DOWNTIME_CAUSE_LABEL,
  DOWNTIME_MENTAL_MODEL_NOTE,
  type DowntimeEvent,
  type MissedSlot,
} from "@shared/uptime";

/**
 * 가동 중단 사후 보고 배너 — "왜 아침에 아무것도 안 들어와 있었는지"를 화면에서 바로 알려 준다.
 *
 * ── 왜 필요한가 ──
 * 2026-08-02 새벽 0시 29분부터 오전 11시 15분까지 맥북이 덮개를 닫은 채 잠들어 뉴스·유튜브·
 * 팝업 수집이 통째로 밀렸는데, 화면에는 어제 내용이 그대로 떠 있고 로그에는 "응답 시간 초과"만
 * 남아 **LLM 장애로 오진**했다. 원인을 찾는 데 조사 에이전트 세 개가 들었다. 그 사고를 두 번
 * 겪지 않기 위한 화면이다.
 *
 * ── 이 파일이 하지 않는 일 (중요) ──
 * **한국어 문장을 만들지 않는다.** headline / body / reasonLine 은 서버가 완성해서 내려준다.
 * 절전 사유·부팅 시각·배터리 잔량 같은 판정 재료는 서버만 알고, 그 재료로 만든 같은 문장이
 * 일지 파일(`data/downtime.log`) · iMessage · 이 화면 **세 곳에 똑같이** 나가야 하기 때문이다.
 * 화면이 따로 조립하기 시작하면 셋이 조용히 갈라지고, 그때부터는 어느 쪽이 참인지 알 수 없다.
 *
 * ── 디자인 언어 ──
 * 저장소의 기존 경고 표현을 그대로 쓴다: `border-amber-300 bg-amber-50 text-amber-800` +
 * `AlertTriangle` (LottoBoard 의 `lastError` 호박색 박스, SnapshotNotice 와 동일). 판정근거를
 * `<details>` 로 접어 두는 것도 SnapshotNotice 의 '자세히' 와 같은 전례를 따른 것이다 —
 * 평소엔 안 보이고, 판정을 의심하는 사람만 펼쳐서 반증할 수 있어야 한다.
 *
 * ── ★ 정상일 때는 아무것도 뜨지 않아야 한다 ──
 * 이게 깨지면 사용자는 배너를 영구히 무시하게 되고, 정작 진짜 사고 때 읽지 않는다.
 * 방어선은 세 겹이다:
 *   ① 서버 `getDowntimeView().current` 가 미확인 `사고` 가 없으면 null 을 준다(§3.5 손실 게이트)
 *   ② 이 컴포넌트가 `severity !== "사고"` 를 다시 걸러낸다(아래 2차 게이트)
 *   ③ App 이 "하루 1회" 로 제한한다(같은 날 두 번째부터는 배지 숫자만 올린다)
 */

// ────────────────────────────────────────────────────────────────────────────
// 시각 표기
// ────────────────────────────────────────────────────────────────────────────

/**
 * ISO → `11시 21분`. 대시보드는 수집 서버와 **같은 맥**에서 돌아 시간대가 항상 일치하므로
 * 브라우저 로컬 시각이 곧 KST 다(SnapshotNotice 의 `localDay` 와 같은 전제).
 *
 * 명세 §6.5 의 `✓ 뉴스  아침 8시  →  11시 21분에 받아옴` 표기를 그대로 맞춘다. 오전/오후를
 * 붙이지 않는 이유도 그 예시 그대로다 — 보충 시각은 배너를 보고 있는 "방금 전"이라
 * 오전·오후를 다시 말할 필요가 없고, 짧을수록 목록이 읽힌다.
 */
function korHm(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getHours()}시 ${String(d.getMinutes()).padStart(2, "0")}분`;
}

/** "2026-08-02" → "8월 2일". 연도는 뺀다(SnapshotNotice 와 같은 판단 — 하루이틀 차이를 읽는 용도). */
function korDay(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${Number(m[2])}월 ${Number(m[3])}일` : ymd;
}

/** `판정근거: …` 접두사를 벗긴다 — 접기 제목이 이미 "판정근거" 라 두 번 말하게 된다. */
function reasonBody(reasonLine: string): string {
  return reasonLine.startsWith("판정근거:") ? reasonLine.slice("판정근거:".length).trim() : reasonLine;
}

// ────────────────────────────────────────────────────────────────────────────
// 하루 1회 제한 (명세 §6.5 알림 피로 방지)
// ────────────────────────────────────────────────────────────────────────────

const BANNER_DAY_KEY = "downtime.bannerAckedDay";

/**
 * 배너를 **하루 1회로 제한**하는 표식. 사용자가 [확인했어요] 를 누른 로컬 날짜를 적어 둔다.
 *
 * ## 왜 서버가 아니라 localStorage 인가
 * 서버에 남는 `ackedAt` 은 **사건 하나**를 확인했다는 사실이고, 여기 적히는 것은 **오늘은
 * 이미 한 번 봤다**는 화면 쪽 사정이다. 둘은 다른 값이다 — 아침에 A 를 확인했는데 낮잠
 * 절전으로 B 가 새로 생기면, B 는 미확인(`ackedAt: null`)이 맞지만 배너를 또 띄우면 안 된다.
 *
 * ## 왜 "배너를 띄운 날"이 아니라 "확인한 날"을 적는가
 * 띄운 순간 적으면, 사용자가 읽기 전에 새로고침만 해도 그날 배너가 영영 사라진다. 첫 통지를
 * 삼키는 쪽이 훨씬 나쁜 실패라, 사용자가 실제로 닫은 순간에만 적는다.
 *
 * 저장 실패(사파리 프라이빗 등)는 삼킨다. 실패하면 "제한이 걸리지 않는" 쪽으로 열화되는데,
 * 그건 정보를 더 보여주는 방향이라 안전하다.
 */
export function readBannerAckedDay(): string | null {
  try {
    return localStorage.getItem(BANNER_DAY_KEY);
  } catch {
    return null;
  }
}

export function rememberBannerAckedDay(day: string = localDay()): void {
  try {
    localStorage.setItem(BANNER_DAY_KEY, day);
  } catch {
    /* 무시 — 제한이 안 걸릴 뿐이고, 그건 덜 나쁜 방향이다 */
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 놓친 슬롯 목록
// ────────────────────────────────────────────────────────────────────────────

/**
 * `✓ 뉴스 08:00 → 11시 21분에 받아옴` 한 줄(§6.5).
 *
 * 시각을 `08:00` 그대로 두는 것은 서버 일지와 **같은 표기**를 쓰기 위해서다. "아침 8시" 로
 * 바꿔 부르면 화면과 `data/downtime.log` 를 나란히 놓고 볼 때 같은 슬롯인지 확신할 수 없다.
 *
 * `evaluated: false` 는 "자정을 넘긴 공백의 어제치라 커버 여부를 검증하지 못했다"는 뜻이다.
 * 손실로 단정하지 않고 서버가 준 note 를 그대로 보여준다 — 이 목록이 한 번이라도 틀리면
 * 사용자는 다시 읽지 않는다.
 */
function MissedRow({ m }: { m: MissedSlot }) {
  const at = korHm(m.recoveredAt);
  const tail = m.recovered
    ? at
      ? `→ ${at}에 받아옴`
      : "→ 다시 받아왔습니다"
    : m.evaluated
      ? "→ 아직 받아오지 못했습니다"
      : `→ ${m.note ?? "지난 날짜라 보충 대상이 아닙니다"}`;

  return (
    <li className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <span aria-hidden className={m.recovered ? "text-emerald-700" : "opacity-50"}>
        {m.recovered ? "✓" : "·"}
      </span>
      <span className="font-medium">{m.label}</span>
      <span className="opacity-70">{m.slot}</span>
      <span className={m.recovered ? "text-emerald-800" : "opacity-80"}>{tail}</span>
    </li>
  );
}

function MissedList({ missed }: { missed: MissedSlot[] }) {
  if (missed.length === 0) return null;
  return (
    <ul className="mt-2 space-y-0.5 text-[13px] leading-relaxed">
      {missed.map((m) => (
        <MissedRow key={`${m.tab}|${m.date}|${m.slot}`} m={m} />
      ))}
    </ul>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 배너
// ────────────────────────────────────────────────────────────────────────────

export interface DowntimeBannerProps {
  event: DowntimeEvent;
  /** [확인했어요]. 서버에 `ackedAt` 을 남긴다. */
  onAck: () => void;
  /** 확인 요청 진행 중(버튼 스피너). */
  acking: boolean;
  /** '지난 기록 보기' 토글. 넘기지 않으면 그 버튼을 그리지 않는다. */
  onOpenHistory?: () => void;
}

export function DowntimeBanner({ event, onAck, acking, onOpenHistory }: DowntimeBannerProps) {
  // ★ 2차 손실 게이트(§3.5). 서버가 이미 `사고` 만 `current` 로 내려보내지만, 여기서 한 번 더
  //   막는다. 배너가 켜지는 등급은 `사고` 하나뿐이고, `기록만`·`무시` 가 배너로 새어 나오는
  //   순간 "평상시엔 아무것도 뜨지 않는다"는 약속이 깨져 사용자가 배너를 배경으로 학습한다.
  if (event.severity !== "사고") return null;

  const stillMissing = event.missed.some((m) => m.evaluated && !m.recovered);

  return (
    <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-amber-900">{event.headline}</p>

          {/* 서버가 완성한 본문. 절전 사고에는 "이 구간의 '응답 시간 초과' 오류는 LLM 장애가
              아니라 위 절전 때문입니다" 한 줄이 들어 있는데, 이번 오진을 막는 문장이 바로 그것이다. */}
          <p className="mt-1 whitespace-pre-line leading-relaxed">{event.body}</p>

          <MissedList missed={event.missed} />

          {/* 아직 보충 중이면 한 줄만 안심시킨다 — 목록이 전부 '아직 받아오지 못했습니다' 인
              화면은 그 자체로 불안하고, 실제로는 몇 분 뒤 자동으로 채워진다(서버가 사건 직후
              5·15·45분에 다시 확인한다). 그 밖의 상태는 위 ✓ 목록이 이미 다 말하고 있다. */}
          {event.recoveryState === "복구중" && stillMissing && (
            <p className="mt-2 flex items-center gap-1.5 text-[13px] opacity-80">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              자동으로 보충하는 중입니다 — 화면이 비어 있어도 잠시 뒤 채워집니다.
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <details className="min-w-0 flex-1">
              <summary className="cursor-pointer select-none text-xs opacity-70 hover:opacity-100">
                판정근거
              </summary>
              <p className="mt-1 whitespace-pre-line break-words text-xs leading-relaxed opacity-80">
                {reasonBody(event.reasonLine)}
              </p>
            </details>

            <div className="flex shrink-0 items-center gap-2">
              {onOpenHistory && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onOpenHistory}
                  className="text-amber-800 hover:bg-amber-100 hover:text-amber-900"
                >
                  지난 기록 보기
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={onAck}
                disabled={acking}
                className="border-amber-300 bg-white/70 text-amber-900 hover:bg-white hover:text-amber-900"
                title="이 기록을 확인 처리합니다. 아직 안 보낸 알림도 함께 취소됩니다."
              >
                {acking ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                확인했어요
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 지난 기록 목록
// ────────────────────────────────────────────────────────────────────────────

export interface DowntimeHistoryPanelProps {
  events: DowntimeEvent[] | null;
  loading: boolean;
  error: string | null;
  onAck: (id: string) => void;
  ackingId: string | null;
  /** 배너로 이미 크게 보여주고 있는 사건 — 목록에서는 접어 둔다(같은 화면에 두 번 쓰지 않는다). */
  highlightedId?: string | null;
}

/**
 * 헤더 배지를 눌렀을 때 펼쳐지는 지난 기록.
 *
 * ## 왜 배너만으로는 부족한가 (명세에서 한 발 나간 부분이라 근거를 남긴다)
 * 배너가 켜지는 등급은 `사고`(놓친 수집 ≥ 1건) 뿐인데, 배지 숫자는 `기록만` 까지 센다(§3.5).
 * `기록만` = "손실은 없었지만 반드시 기록해야 하는 것" = 진짜 전원 차단·배터리 방전·커널
 * 패닉·프로그램 비정상 종료, 그리고 6시간 이상의 긴 공백이다. 즉 **사용자가 애초에 요청한
 * "전원이 뽑혔서 안 돌았어요"가 정확히 이 등급**이다(§12.3).
 *
 * 이 목록이 없으면 그 사건들은 배너로 뜨지도, 확인할 수도 없어 배지 숫자가 영원히 남는다.
 * 지울 수 없는 배지는 사흘이면 배경이 되고, 그러면 배지 전체가 무의미해진다.
 *
 * 색을 호박색으로 하지 않는 것도 의도다 — 여기 담기는 것은 대부분 "알아 두시라" 이지
 * "조치하시라" 가 아니라서, 경고색을 쓰면 배너의 호박색이 값싸진다.
 */
export function DowntimeHistoryPanel({
  events,
  loading,
  error,
  onAck,
  ackingId,
  highlightedId,
}: DowntimeHistoryPanelProps) {
  // 원장에는 `무시` 등급까지 남지만(나중에 "이 기능이 오탐하고 있나"를 반증하기 위해서다),
  // 화면에 늘어놓지는 않는다. 90초짜리 배포 재기동까지 목록에 뜨면 진짜 사고가 묻힌다.
  const shown = (events ?? []).filter((e) => e.severity !== "무시");

  return (
    <div className="mb-4 rounded-md border bg-muted/40 px-4 py-3 text-sm">
      <p className="font-semibold">가동이 멈췄던 기록</p>

      {loading && !events && (
        <p className="mt-2 flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> 불러오는 중…
        </p>
      )}
      {error && <p className="mt-2 text-muted-foreground">불러오지 못했습니다 — {error}</p>}
      {!loading && !error && shown.length === 0 && (
        <p className="mt-2 text-muted-foreground">
          기록이 없습니다. 지금까지 자동 수집이 멈춘 적이 없었어요.
        </p>
      )}

      {shown.length > 0 && (
        <ul className="mt-2 divide-y">
          {shown.map((e) => {
            const acked = e.ackedAt != null;
            return (
              <li key={e.id} className="py-2">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-x-1.5">
                      <span className="text-xs text-muted-foreground">{korDay(e.date)}</span>
                      <span className="font-medium">{DOWNTIME_CAUSE_LABEL[e.cause]}</span>
                      {e.confidence !== "확실" && (
                        <span className="text-xs text-muted-foreground">({e.confidence})</span>
                      )}
                    </p>
                    <p
                      className={`mt-0.5 leading-relaxed ${acked ? "text-muted-foreground" : ""} ${
                        e.id === highlightedId ? "opacity-60" : ""
                      }`}
                    >
                      {e.headline}
                    </p>
                    <details className="mt-1">
                      <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">
                        판정근거
                      </summary>
                      <p className="mt-1 whitespace-pre-line break-words text-xs leading-relaxed text-muted-foreground">
                        {reasonBody(e.reasonLine)}
                      </p>
                    </details>
                  </div>
                  <div className="shrink-0">
                    {acked ? (
                      <span className="text-xs text-muted-foreground">확인함</span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onAck(e.id)}
                        disabled={ackingId === e.id}
                      >
                        {ackingId === e.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Check className="h-4 w-4" />
                        )}
                        확인했어요
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/*
        ★ 멘탈모델 교정 문장(§6.4). 명세가 "P0 = 일지 헤더 / P1 = 이력 화면 하단" 이라고
        위치까지 지정한 문장이고, 일지 파일 헤더와 **한 글자도 갈라지지 않도록** shared 상수를
        그대로 쓴다. 이 문장이 없으면 사용자는 영원히 안 뜨는 "전원 뽑힘" 배너를 기다린다 —
        실제로 이 맥에서 수집이 멈춘 원인은 14일 관측 내내 100% 절전이었다.
      */}
      <p className="mt-3 whitespace-pre-line border-t pt-3 text-xs leading-relaxed text-muted-foreground">
        {DOWNTIME_MENTAL_MODEL_NOTE}
      </p>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 헤더 배지
// ────────────────────────────────────────────────────────────────────────────

/**
 * 헤더의 호박색 pill. **0건이면 아무것도 렌더링하지 않는다** — 평상시 헤더는 지금과 100% 동일해야 한다.
 *
 * 누르면 지난 기록이 펼쳐진다. 배너를 "하루 1회" 로 제한한 대가로 오늘 두 번째 사건은 배지
 * 숫자로만 나타나는데, 그때 사용자가 내용을 볼 통로가 여기 말고는 없다.
 */
export function DowntimeBadge({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title="자동 수집이 멈췄던 기록 보기"
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100"
    >
      <AlertTriangle className="h-3.5 w-3.5" />
      중단 {count}건
    </button>
  );
}
