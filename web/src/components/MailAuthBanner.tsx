import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * 메일 발송용 Google 계정 연결 상태 배너 — "알림이 조용히 죽어 있었다"를 두 번 겪지 않기 위한 화면.
 *
 * ── 왜 필요한가 ──
 * Gmail 앱 비밀번호가 계정 비밀번호 변경으로 폐기되면서 메일 알림이 **3일 동안 조용히** 죽어
 * 있었다. 수집은 정상이었고 화면도 멀쩡했으며, 죽은 것은 "보내는 통로" 하나뿐이라 어디에도
 * 표가 나지 않았다. OAuth2 로 바꿔도 토큰은 언젠가 또 끊긴다(비밀번호 변경·권한 회수·
 * 장기 미사용). 그래서 이 배너의 목적은 "끊기지 않게 하는 것"이 아니라 **끊긴 사실을 사용자가
 * 즉시 알고, 클릭 두 번으로 되살리는 것**이다.
 *
 * ── 디자인 언어 ──
 * 새 언어를 만들지 않는다. 경고는 DowntimeBanner 와 똑같이
 * `border-amber-300 bg-amber-50 text-amber-800` + `AlertTriangle`,
 * 낮은 강도 안내는 SnapshotNotice 의 info 톤(`bg-muted/50 text-muted-foreground`),
 * 자세한 오류는 두 파일 모두가 쓰는 `<details>` 접기다.
 *
 * ── ★ 정상일 때는 배너가 뜨지 않아야 한다 ──
 * DowntimeBanner 와 같은 이유다. 평시에도 뭔가 떠 있으면 사용자는 이 자리를 배경으로 학습하고,
 * 정작 진짜로 끊긴 날 읽지 않는다. 정상 연결 상태는 배너가 아니라 **접힌 한 줄**로만 남긴다.
 *
 * ── 서버가 아직 없어도 깨지지 않는다 ──
 * `/api/google/*` 는 지금 백엔드에서 만들어지는 중이라 404 가 날 수 있다. 조회 실패는 전부
 * 삼키고 아무것도 렌더링하지 않는다 — 메일 연결 상태를 못 읽은 것은 대시보드의 본업이 아니고,
 * 빨간 오류 줄로 화면을 시끄럽게 만들 값어치가 없다.
 */

// ────────────────────────────────────────────────────────────────────────────
// 서버 계약
// ────────────────────────────────────────────────────────────────────────────

/** `GET /api/google/status` 응답. */
export interface GoogleMailStatus {
  /** OAuth 클라이언트(.env)가 준비돼 있는가. false 면 애초에 연결을 시도할 수도 없다. */
  configured: boolean;
  /** 지금 유효한 토큰이 있는가. */
  connected: boolean;
  /** 연결된 계정. 어느 계정으로 붙었는지가 재인증 때 유일하게 헷갈리는 지점이다. */
  email: string | null;
  /** ★ 사용자가 손을 대야 하는 상태. 이 값 하나가 이 컴포넌트의 존재 이유다. */
  needsReauth: boolean;
  /** 마지막 실패 사유(서버가 완성한 문장 또는 원문 오류). */
  lastError: string | null;
  /** 마지막으로 메일이 실제로 나간 시각(ISO). */
  lastSuccessAt: string | null;
}

/**
 * 서버 응답을 **믿지 않고** 최소 형태만 확인한다.
 *
 * 구버전 서버·프록시 오류 페이지·다른 라우트의 응답이 200 으로 흘러들어올 수 있는데, 그때
 * `needsReauth` 가 undefined 면 falsy 라 조용히 "정상"으로 읽힌다. 즉 **알림이 죽었는데 배너가
 * 안 뜨는** 바로 그 실패로 되돌아간다. 형태가 아니면 상태 자체를 버리는 편이 낫다.
 */
function parseStatus(v: unknown): GoogleMailStatus | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.configured !== "boolean" || typeof o.connected !== "boolean") return null;
  if (typeof o.needsReauth !== "boolean") return null;
  return {
    configured: o.configured,
    connected: o.connected,
    email: typeof o.email === "string" ? o.email : null,
    needsReauth: o.needsReauth,
    lastError: typeof o.lastError === "string" ? o.lastError : null,
    lastSuccessAt: typeof o.lastSuccessAt === "string" ? o.lastSuccessAt : null,
  };
}

/**
 * 상태 폴링 주기. App 의 가동 중단 폴링(`DOWNTIME_POLL_MS`)과 같은 60초를 쓴다 —
 * 둘 다 "평소엔 아무 일도 없고, 사고가 나면 1분 안에 알면 되는" 같은 성격의 신호다.
 */
const POLL_MS = 60_000;

// ────────────────────────────────────────────────────────────────────────────
// 시각 표기
// ────────────────────────────────────────────────────────────────────────────

/** ISO → "8월 8일 오후 3:07". 대시보드는 서버와 같은 맥에서 돌아 로컬 시각이 곧 KST 다. */
function korDayTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("ko-KR", {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ────────────────────────────────────────────────────────────────────────────
// OAuth 복귀 처리 (?google=ok / ?google=error&reason=…)
// ────────────────────────────────────────────────────────────────────────────

type Callback = { kind: "ok" } | { kind: "error"; reason: string } | null;

/**
 * 주소창의 복귀 표식을 읽는다. **첫 렌더에서 한 번만** 부른다 — 아래 정리 effect 가 곧바로
 * 쿼리스트링을 지우기 때문에, 렌더마다 읽으면 두 번째 렌더에서 결과가 사라진다.
 *
 * reason 은 서버가 넣는 값이지만 주소창은 사용자가 직접 고칠 수 있는 자리라 길이를 자른다.
 * (React 가 텍스트를 이스케이프하므로 스크립트 위험은 없고, 여기서 막는 것은 레이아웃이다.)
 */
function readCallback(): Callback {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  const v = q.get("google");
  if (v === "ok") return { kind: "ok" };
  if (v === "error") return { kind: "error", reason: (q.get("reason") ?? "").slice(0, 200) };
  return null;
}

/**
 * 복귀 표식만 주소에서 지운다. 다른 쿼리는 건드리지 않는다 — 이 대시보드는 지금 쿼리를 쓰지
 * 않지만, 나중에 누가 `?tab=news` 같은 걸 붙였을 때 이 코드가 그걸 조용히 날려먹으면 안 된다.
 *
 * `replaceState` 라 뒤로가기 이력에 남지 않는다. 새로고침만 해도 성공 문구가 다시 뜨는 것을
 * 막는 것이 목적이다(이미 끝난 일을 두 번 알리지 않는다).
 */
function stripCallbackFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("google") && !url.searchParams.has("reason")) return;
    url.searchParams.delete("google");
    url.searchParams.delete("reason");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* 주소 정리는 편의 기능이다. 실패해도 배너 동작에는 영향이 없다. */
  }
}

/** 흔한 OAuth 오류 코드만 사람 말로 바꾸고, 모르는 값은 서버가 준 그대로 보여준다. */
function reasonText(reason: string): string {
  if (!reason) return "사유가 전달되지 않았습니다.";
  const known: Record<string, string> = {
    access_denied: "Google 계정에서 권한 허용을 취소했습니다.",
    invalid_grant: "인증 코드가 만료되었거나 이미 사용되었습니다. 다시 시도해 주세요.",
    state_mismatch: "인증 요청과 응답이 짝이 맞지 않습니다. 처음부터 다시 시도해 주세요.",
    missing_code: "Google 이 인증 코드를 돌려주지 않았습니다. 다시 시도해 주세요.",
  };
  return known[reason] ?? reason;
}

// ────────────────────────────────────────────────────────────────────────────
// 배너
// ────────────────────────────────────────────────────────────────────────────

/** 성공 표시를 자동으로 거두는 시간. 끝난 일이라 자리를 계속 차지할 이유가 없다. */
const OK_VISIBLE_MS = 10_000;

export function MailAuthBanner() {
  const [status, setStatus] = useState<GoogleMailStatus | null>(null);
  // 복귀 표식은 첫 렌더에서 붙잡아 둔다(정리 effect 가 곧 주소에서 지운다).
  const [callback, setCallback] = useState<Callback>(() => readCallback());
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const load = useCallback(async (): Promise<GoogleMailStatus | null> => {
    try {
      const res = await fetch("/api/google/status");
      if (!res.ok) return null;
      return parseStatus(await res.json());
    } catch {
      // 서버가 아직 이 라우트를 모르거나(404) 재기동 중(연결 실패)일 수 있다. 조용히 넘어간다.
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      void load().then((s) => {
        if (alive) setStatus(s);
      });
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [load]);

  // 복귀 표식 정리. 성공은 잠시 뒤 스스로 사라지고, 실패는 사용자가 조치할 때까지 남는다.
  useEffect(() => {
    if (!callback) return;
    stripCallbackFromUrl();
    if (callback.kind !== "ok") return;
    const t = setTimeout(() => setCallback(null), OK_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [callback]);

  /**
   * [Google 재로그인] — 서버에서 동의 화면 주소를 받아 그리로 이동한다.
   *
   * 주소를 서버가 만드는 이유는 client_id·redirect_uri·state 가 전부 서버 소관이기 때문이다.
   * 화면이 조립하면 서버가 검증할 state 와 갈라진다.
   *
   * 받은 문자열이 http(s) 인지 확인하고 넘어간다 — 응답이 뒤집힌 상황에서 `javascript:` 같은
   * 스킴으로 이동하는 것까지 화면이 대신해 줄 이유는 없다.
   */
  async function startAuth() {
    setStarting(true);
    setStartErr(null);
    try {
      const res = await fetch("/api/google/auth-url");
      const body = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
      if (!res.ok) {
        throw new Error(
          typeof body.error === "string" ? body.error : `인증 주소를 받지 못했습니다 (${res.status})`
        );
      }
      const url = typeof body.url === "string" ? body.url : "";
      if (!/^https?:\/\//i.test(url)) throw new Error("서버가 올바른 인증 주소를 주지 않았습니다.");
      // 이동하므로 starting 을 되돌리지 않는다 — 페이지가 떠날 때까지 버튼은 눌린 채여야 한다.
      window.location.assign(url);
    } catch (e) {
      setStartErr((e as Error).message);
      setStarting(false);
    }
  }

  /** 연결 해제. 접힌 곳에만 두는 이유는 되돌리려면 다시 Google 동의를 거쳐야 하기 때문이다. */
  async function disconnect() {
    if (!confirm("메일 발송용 Google 연결을 해제할까요?\n해제하면 알림 메일이 나가지 않습니다.")) return;
    setDisconnecting(true);
    try {
      await fetch("/api/google/disconnect", { method: "POST" });
    } catch {
      /* 실패해도 아래에서 상태를 다시 읽어 오므로 화면은 참을 말한다. */
    } finally {
      setStatus(await load());
      setDisconnecting(false);
    }
  }

  const okLine = callback?.kind === "ok" && (
    <div className="mb-4 flex items-start gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
      <Check className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        Google 계정을 연결했습니다. 이제 알림 메일이 다시 발송됩니다
        {status?.email ? ` (${status.email})` : ""}.
      </span>
    </div>
  );

  // ── 어떤 상태를 크게 알릴 것인가 ────────────────────────────────────────────
  //
  // 재인증 실패(복귀 오류)와 `needsReauth` 는 사용자가 할 일이 **똑같다**(다시 로그인). 둘을
  // 각각 배너로 띄우면 같은 말을 하는 호박색 상자가 두 개 쌓이므로, 하나로 합치고 방금 일어난
  // 실패 쪽 문구를 우선한다.
  const callbackFailed = callback?.kind === "error";
  const needsReauth = status?.needsReauth === true;

  if (callbackFailed || needsReauth) {
    return (
      <>
        {okLine}
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-amber-900">
                {callbackFailed
                  ? "Google 재로그인이 완료되지 않았습니다"
                  : "메일 알림이 멈춰 있습니다 — Google 재로그인이 필요합니다"}
              </p>
              <p className="mt-1 leading-relaxed">
                {callbackFailed
                  ? reasonText((callback as { kind: "error"; reason: string }).reason)
                  : "인증이 만료되어 알림 메일이 나가지 않고 있습니다. 아래 버튼으로 다시 로그인하면 즉시 복구됩니다."}
                {status?.email ? ` (연결했던 계정: ${status.email})` : ""}
              </p>

              {startErr && <p className="mt-2 leading-relaxed">{startErr}</p>}

              <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
                {/* 서버가 남긴 원문 오류. 평소엔 접어 둔다 — 조치에는 필요 없고, 의심할 때만 본다. */}
                <div className="min-w-0 flex-1">
                  {status?.lastError && (
                    <details>
                      <summary className="cursor-pointer select-none text-xs opacity-70 hover:opacity-100">
                        자세한 오류
                      </summary>
                      <p className="mt-1 whitespace-pre-line break-words text-xs leading-relaxed opacity-80">
                        {status.lastError}
                      </p>
                    </details>
                  )}
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void startAuth()}
                  disabled={starting}
                  className="shrink-0 border-amber-300 bg-white/70 text-amber-900 hover:bg-white hover:text-amber-900"
                  title="Google 동의 화면으로 이동합니다."
                >
                  {starting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Mail className="h-4 w-4" />
                  )}
                  Google 재로그인
                </Button>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  // ── 아직 설정되지 않음 ────────────────────────────────────────────────────
  //
  // 경고가 아니다. 끊긴 게 아니라 애초에 켜 본 적이 없는 상태라 사용자가 당장 할 일이 없다.
  // SnapshotNotice 의 info 톤을 그대로 써서 호박색 경고와 확실히 구분한다.
  if (status && !status.configured) {
    return (
      <>
        {okLine}
        <div className="mb-4 flex items-start gap-2 rounded-md border border-transparent bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          <Mail className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            메일 발송이 설정되지 않았습니다. 알림 메일이 나가지 않으며, 대시보드의 다른 기능은
            그대로 동작합니다.
          </span>
        </div>
      </>
    );
  }

  // ── 설정은 됐지만 아직 연결 전 ─────────────────────────────────────────────
  //
  // 연결한 적이 없거나, 방금 연결을 해제한 상태다. 메일이 안 나가는 것은 사실이지만 **사용자가
  // 선택한 상태**일 수 있어 경고색을 쓰지 않는다. 다만 다시 켤 버튼은 반드시 있어야 한다 —
  // 해제한 뒤 돌아올 길이 없으면 그 순간 이 기능이 영구히 죽는다.
  if (status?.configured && !status.connected) {
    return (
      <>
        {okLine}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-transparent bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          <span className="flex min-w-0 items-start gap-2">
            <Mail className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Google 계정이 연결되어 있지 않아 알림 메일이 나가지 않습니다.
              {startErr ? ` ${startErr}` : ""}
            </span>
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void startAuth()}
            disabled={starting}
            className="shrink-0"
          >
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            Google 로그인
          </Button>
        </div>
      </>
    );
  }

  // ── 정상 연결 ─────────────────────────────────────────────────────────────
  //
  // ★ 배너를 띄우지 않는다. 접힌 한 줄만 남겨 "어느 계정으로, 언제 마지막으로 나갔는지"를
  //   확인할 통로를 열어 둔다. 연결 해제도 여기 안에만 둔다(잘못 누를 자리에 두지 않는다).
  if (status?.connected) {
    const last = korDayTime(status.lastSuccessAt);
    return (
      <>
        {okLine}
        <details className="mb-3 text-xs text-muted-foreground">
          <summary className="inline-flex cursor-pointer select-none items-center gap-1.5 hover:text-foreground">
            <Mail className="h-3.5 w-3.5" />
            메일 알림 연결됨{status.email ? ` · ${status.email}` : ""}
          </summary>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-5">
            <span>마지막 발송 {last ?? "기록 없음"}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void disconnect()}
              disabled={disconnecting}
              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              {disconnecting && <Loader2 className="h-3 w-3 animate-spin" />}
              연결 해제
            </Button>
          </div>
        </details>
      </>
    );
  }

  // 여기까지 왔다면 상태를 아직/영영 못 읽은 것이다(서버 미구현 404 · 재기동 중 · 형태 불일치).
  // 아무것도 그리지 않는다 — 모르는 것을 아는 척하느니 조용한 쪽이 낫다.
  return <>{okLine}</>;
}
