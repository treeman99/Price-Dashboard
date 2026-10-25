import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Loader2, PowerOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/page";
import { EventsBoard } from "@/components/EventsBoard";
import { NewsBoard } from "@/components/NewsBoard";
import { YoutubeBoard } from "@/components/YoutubeBoard";
import { StockBoard } from "@/components/StockBoard";
import { HoldingsBoard } from "@/components/HoldingsBoard";
import { LottoBoard } from "@/components/LottoBoard";
import { SkillsBoard } from "@/components/SkillsBoard";
import { FrontPage } from "@/components/FrontPage";
import { ScrollToTop } from "@/components/ScrollToTop";
import { failedTabs, loadFeeds, type Feeds } from "@/lib/feed";
import { ModelControl } from "@/components/ModelControl";
import { SettingsOverview } from "@/components/SettingsOverview";
import { localDay } from "@/components/SnapshotNotice";
import { MailAuthBanner } from "@/components/MailAuthBanner";
import {
  DowntimeBadge,
  DowntimeBanner,
  DowntimeHistoryPanel,
  readBannerAckedDay,
  rememberBannerAckedDay,
} from "@/components/DowntimeBanner";
import type { DowntimeEvent, DowntimeView } from "@shared/uptime";

interface TabDef {
  id: string;
  label: string;
  /** 탭 고유색(HEX). 헤더 상단 띠·탭 밑줄·색 사각형, 그리고 CSS 변수 --tab 으로 탭 내부 강조색에 쓴다 */
  color: string;
  /** null 이면 App 이 직접 그린다(1면 — 다른 탭의 정보·데이터를 넘겨받아야 해서). */
  content: ReactNode;
}

/**
 * Overview(코드·문서에서는 '1면'이라고도 부른다) — 지난번 본 뒤 각 지면에 새로 들어온 것을 추리는 첫 지면. 주소에 탭이 없으면(북마크) 여기로 연다.
 * 탭 고유색은 잉크다: 신문 1면에는 섹션 색이 없다.
 */
const FRONT_TAB_ID = "front";

/** 탭 내용 영역(role=tabpanel) id. 탭 버튼의 aria-controls 가 가리킨다. */
const TAB_PANEL_ID = "tab-panel";

// 새 게시판은 여기에 항목만 추가하면 탭이 늘어난다. color는 탭 고유색.
//
// ⚠️ 가격 대시보드 탭은 2026-08-01 제거했다. 네이버 쇼핑 검색 API 가 2026-07-31 부로
// 영구 종료(유예·대체 API 없음)되어 판매처별 가격 리스팅을 얻을 정식 경로가 사라졌고,
// 남은 경로는 robots·약관이 금지하는 크롤링뿐이라 기능을 접었다. 과거 가격 이력은
// DB(price_points/listings)에 그대로 보존돼 있다.
const TABS: TabDef[] = [
  { id: FRONT_TAB_ID, label: "Overview", color: "#1b1a17", content: null },
  { id: "news", label: "뉴스", color: "#d97706", content: <NewsBoard /> },
  { id: "youtube", label: "유튜브 소식", color: "#dc2626", content: <YoutubeBoard /> },
  { id: "skills", label: "스킬 랭킹", color: "#2563eb", content: <SkillsBoard /> },
  { id: "stock", label: "증시", color: "#059669", content: <StockBoard /> },
  { id: "events", label: "팝업·전시", color: "#db2777", content: <EventsBoard /> },
  // 보유 종목은 증시 탭 안의 한국장/미국장과 **별도 탭**이다(인터뷰 결정).
  { id: "holdings", label: "보유 주식", color: "#0d9488", content: <HoldingsBoard /> },
  { id: "lotto", label: "로또", color: "#7c3aed", content: <LottoBoard /> },
];

/** 화면이 서버에 가동 중단 상태를 물어보는 주기. 서버 하트비트(60초)와 같은 해상도로 맞춘다. */
const DOWNTIME_POLL_MS = 60_000;

/**
 * 1면·탭 줄 실패 점이 지면 데이터를 다시 읽는 주기. 수집은 하루 몇 번뿐이라 길게 두고,
 * 대신 탭을 바꿀 때와 창으로 돌아올 때 바로 다시 읽는다.
 */
const FEEDS_POLL_MS = 5 * 60_000;

/** 주소의 #탭id. 없거나 모르는 값이면 1면. */
function tabFromHash(): string {
  const id = decodeURIComponent(window.location.hash.slice(1));
  return TABS.some((t) => t.id === id) ? id : FRONT_TAB_ID;
}

export default function App() {
  const [active, setActive] = useState(tabFromHash);
  const activeTab = TABS.find((t) => t.id === active) ?? TABS[0];

  /**
   * 활성 탭을 주소(#news)에 남겨 새로고침·서비스 재시작 뒤에도 그 탭에 머문다. 1면은 주소를 비워 둔다
   * (북마크 = 1면). 탭 전환마다 방문 기록을 쌓지 않도록 replaceState 를 쓴다 — 뒤로 가기는 대시보드 이전 페이지로.
   */
  const selectTab = useCallback((id: string, opts?: { scrollTop?: boolean }) => {
    setActive(id);
    const { pathname, search } = window.location;
    window.history.replaceState(null, "", id === FRONT_TAB_ID ? pathname + search : `#${id}`);
    if (opts?.scrollTop) window.scrollTo({ top: 0 });
  }, []);

  /** 탭 줄 방향키(WAI-ARIA tabs, 자동 활성화): ←→ 이웃 탭, Home/End 처음·끝. 옮긴 탭으로 포커스도 옮긴다. */
  function onTabKeyDown(e: KeyboardEvent<HTMLElement>) {
    const i = TABS.findIndex((t) => t.id === active);
    const next =
      e.key === "ArrowRight" ? (i + 1) % TABS.length
      : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length
      : e.key === "Home" ? 0
      : e.key === "End" ? TABS.length - 1
      : null;
    if (next === null) return;
    e.preventDefault();
    selectTab(TABS[next].id);
    document.getElementById(`tab-${TABS[next].id}`)?.focus();
  }

  // 주소를 직접 고치거나 #링크(1면의 가운데 클릭 등)로 들어온 경우
  useEffect(() => {
    const onHash = () => setActive(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // ── 지면 데이터(1면 + 탭 줄 수집 실패 점) ─────────────────────────────────────
  // 1면이 아닐 때도 불러 둔다 — 탭 줄의 실패 점은 어느 탭에 있든 보여야 한다.
  const [feeds, setFeeds] = useState<Feeds | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      loadFeeds()
        .then((f) => {
          if (alive) setFeeds(f);
        })
        .catch(() => {}); // 지면별 실패는 loadFeeds 가 이미 접는다. 여기 오는 건 예상 밖이라 조용히 다음 주기로.
    void load();
    const t = setInterval(() => void load(), FEEDS_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active]);
  const failed = feeds ? failedTabs(feeds) : new Set<string>();
  const today = new Date().toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "long" });

  // 활성 탭 고유색을 CSS 변수로 노출한다(text-tab / bg-tab / border-tab). 다이얼로그는 body 포털이라
  // 래퍼 div 가 아니라 문서 루트에 걸어야 거기서도 같은 색을 쓴다.
  useEffect(() => {
    document.documentElement.style.setProperty("--tab", activeTab.color);
  }, [activeTab.color]);

  // 서비스 제거는 특정 탭이 아닌 전역 기능 → 헤더에 배치
  const [serviceInstalled, setServiceInstalled] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .serviceStatus()
      .then((s) => setServiceInstalled(s.installed))
      .catch(() => {});
  }, []);

  // ── 가동 중단 사후 보고 (절전·정전으로 자동 수집이 통째로 밀린 구간) ──────────
  //
  // 특정 탭이 아니라 **전역**이다. 맥이 잠들면 뉴스·유튜브·팝업·로또가 동시에 밀리는데,
  // 사용자는 "왜 뉴스가 비었지" 하며 뉴스 탭을 연다. 그래서 새 탭을 만들지 않고 헤더 배지와
  // 기존 전역 배너 슬롯에 붙인다.
  //
  // ★ 평상시에는 `view.current === null` · `unackedCount === 0` 이라 **아무것도 렌더링되지
  //   않는다.** 화면은 이 기능이 없던 때와 100% 동일하다. 이 성질이 깨지면 사용자가 배너를
  //   배경으로 학습해 버려서, 정작 진짜 사고 때 읽지 않는다.
  const [downtime, setDowntime] = useState<DowntimeView | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<DowntimeEvent[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [ackingId, setAckingId] = useState<string | null>(null);
  // 마지막으로 [확인했어요] 를 누른 로컬 날짜. 같은 날 두 번째 사건부터는 배너 대신 배지만 올린다.
  const [ackedDay, setAckedDay] = useState<string | null>(() => readBannerAckedDay());

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .downtime()
        .then((v) => {
          if (alive) setDowntime(v);
        })
        // 실패는 조용히 삼킨다. 이건 **사후 보고**지 대시보드의 본업이 아니라, 못 불러왔다고
        // 빨간 오류 줄을 띄우면 정작 보고할 사고가 없을 때도 화면이 시끄러워진다.
        // (구버전 서버에는 이 라우트가 아예 없어 404 가 난다 — 그때도 조용해야 한다.)
        .catch(() => {});
    void load();
    const t = setInterval(() => void load(), DOWNTIME_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryErr(null);
    try {
      setHistory((await api.downtimeHistory(50)).events);
    } catch (e) {
      setHistoryErr((e as Error).message);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  function toggleHistory() {
    const next = !historyOpen;
    setHistoryOpen(next);
    // 펼칠 때마다 다시 읽는다 — 목록이 길지 않고(최대 50건), 접었다 펴는 동작 자체가
    // "지금 상태가 궁금하다"는 뜻이라 캐시된 목록을 보여주면 그 의도를 배신한다.
    if (next) void loadHistory();
  }

  // 배너로 띄울 사건. 서버는 미확인 `사고` 중 최신 1건만 `current` 로 준다(§3.5 손실 게이트).
  const bannerEvent = downtime?.current ?? null;
  // 하루 1회 제한. 배지를 눌러 기록을 펼친 상태에서는 제한을 풀어 준다 — 그건 사용자가
  // 직접 "지금 보겠다"고 말한 것이라, 그때까지 숨기면 확인할 방법이 사라진다.
  const bannerVisible = bannerEvent != null && (historyOpen || ackedDay !== localDay());

  /**
   * [확인했어요] — 서버에 `ackedAt` 을 남기고 아직 안 보낸 알림을 취소한다.
   *
   * 서버 응답이 갱신된 `view` 를 함께 주므로 배지 숫자는 왕복 없이 즉시 맞는다.
   *
   * "오늘은 이미 봤다" 표식은 **배너로 떠 있던 사건을 확인했을 때만** 적는다. 지난 기록
   * 목록에서 옛 사건을 정리한 것까지 오늘의 1회로 세면, 정작 오늘 새로 난 사고의 배너가
   * 뜨지 못한다.
   */
  const ackDowntime = useCallback(
    async (id: string) => {
      const wasBanner = bannerVisible && id === bannerEvent?.id;
      setAckingId(id);
      try {
        const r = await api.ackDowntime(id);
        setDowntime(r.view);
        setHistory((h) => (h ? h.map((e) => (e.id === r.event.id ? r.event : e)) : h));
        if (wasBanner) {
          const today = localDay();
          rememberBannerAckedDay(today);
          setAckedDay(today);
        }
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setAckingId(null);
      }
    },
    [bannerVisible, bannerEvent]
  );

  async function uninstallService() {
    if (
      !confirm(
        "백그라운드 자동 수집 서비스를 제거할까요?\n제거하면 매일 자동 수집이 중단되고 이 서버도 종료됩니다.\n(저장된 데이터/이력은 보존됩니다)"
      )
    )
      return;
    setUninstalling(true);
    try {
      const r = await api.uninstallService();
      setNotice(`${r.message}\n다시 켜려면 터미널에서 ./service/install.sh 를 실행하세요.`);
      setServiceInstalled(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUninstalling(false);
    }
  }

  return (
    // overflow-x-clip: 화면 끝에 걸린 툴팁 같은 장식이 페이지 폭을 늘려 가로 스크롤을 만들지 않게 자른다.
    // (clip 은 스크롤 컨테이너를 만들지 않아 sticky 헤더가 그대로 동작한다)
    <div className="min-h-screen overflow-x-clip bg-background">
      <header className="sticky top-0 z-20 border-b border-foreground/15 bg-background/95 backdrop-blur-sm">
        {/* 활성 탭 고유색 띠. 탭 정체성은 이 띠·탭 밑줄·색 사각형으로만 드러내고 배경은 종이색 그대로 둔다. */}
        <div aria-hidden className="h-[3px] bg-tab transition-colors duration-300" />
        <div className="mx-auto flex max-w-[2400px] flex-wrap items-stretch gap-x-8 px-5 lg:px-8">
          <div className="flex shrink-0 items-baseline gap-3 py-3">
            <h1 className="font-serif text-[1.35rem] font-bold leading-none tracking-[-0.02em]">Daily Dashboard</h1>
            <span className="num hidden text-[13px] text-muted-foreground sm:inline">{today}</span>
          </div>

          {/* 게시판 탭 — 1480px 이상이면 제목 옆 한 줄(탭 8개 + 제목 + 우측 컨트롤 ≈ 1460px), 좁으면 아래 줄로 내려가 가로 스크롤 */}
          <nav
            className="order-last -mx-5 flex w-[calc(100%+2.5rem)] items-stretch gap-1 overflow-x-auto overflow-y-hidden border-t px-3 [scrollbar-width:none] lg:-mx-8 lg:w-[calc(100%+4rem)] lg:px-6 min-[1480px]:order-none min-[1480px]:mx-0 min-[1480px]:w-auto min-[1480px]:flex-1 min-[1480px]:border-t-0 min-[1480px]:px-0 [&::-webkit-scrollbar]:hidden"
            role="tablist"
            aria-label="게시판"
            onKeyDown={onTabKeyDown}
          >
            {TABS.map((t) => {
              const selected = active === t.id;
              const tabFailed = failed.has(t.id);
              return (
                <button
                  key={t.id}
                  id={`tab-${t.id}`}
                  role="tab"
                  aria-selected={selected}
                  aria-controls={TAB_PANEL_ID}
                  // 탭 줄은 Tab 키로 한 번만 들르고(선택된 탭), 그 안에서는 방향키로 옮긴다.
                  tabIndex={selected ? 0 : -1}
                  onClick={() => selectTab(t.id)}
                  className={cn(
                    "relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-sm px-3 py-3 text-[15px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    selected ? "font-semibold text-foreground" : "font-medium text-muted-foreground hover:text-foreground"
                  )}
                >
                  <span
                    aria-hidden
                    className={cn("h-2 w-2 rounded-[2px] transition-opacity", selected ? "opacity-100" : "opacity-40")}
                    style={{ backgroundColor: t.color }}
                  />
                  {t.label}
                  {/* 오늘 수집 실패 — 그 탭을 열면 경고 띠가 뜨는 경우와 같은 조건(lib/feed.ts). 평소엔 없다. */}
                  {tabFailed && (
                    <>
                      <span
                        aria-hidden
                        title="오늘 수집이 실패했습니다"
                        className="-ml-0.5 h-1.5 w-1.5 shrink-0 self-start rounded-full bg-tone-warn"
                      />
                      <span className="sr-only">(오늘 수집 실패)</span>
                    </>
                  )}
                  {selected && (
                    <span aria-hidden className="absolute inset-x-3 bottom-0 h-[2px]" style={{ backgroundColor: t.color }} />
                  )}
                </button>
              );
            })}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-2 py-2.5">
            {/* 확인하지 않은 가동 중단 기록. 0건이면 아예 렌더링되지 않는다(평상시 헤더 = 지금 그대로). */}
            <DowntimeBadge
              count={downtime?.unackedCount ?? 0}
              open={historyOpen}
              onToggle={toggleHistory}
            />
            {/* 수집·큐레이션 AI 모델 선택은 특정 탭이 아닌 전역 설정 → 헤더에 배치 */}
            <ModelControl />
            {/* 전 탭 자동 수집 스케줄·운영 설정·알림 한눈에 보기(+ 탭에 속하지 않는 가동 중단 알림) */}
            <SettingsOverview tabs={TABS} />
            {serviceInstalled && (
              <Button
                variant="ghost"
                size="sm"
                onClick={uninstallService}
                disabled={uninstalling}
                title="launchd 자동 수집 서비스 제거"
                className="hover:bg-tone-error/10 hover:text-tone-error"
              >
                {uninstalling ? <Loader2 className="h-4 w-4 animate-spin" /> : <PowerOff className="h-4 w-4" />}
                서비스 제거
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[2400px] px-5 pb-16 pt-5 lg:px-8">
        {notice && (
          <Notice tone="info" className="whitespace-pre-line">
            {notice}
          </Notice>
        )}
        {err && <Notice tone="error">{err}</Notice>}
        {/*
          메일 알림(Google) 연결 배너 — 전역 배너 중 **맨 위**다.

          아래 가동 중단 배너보다 앞에 두는 이유: 저건 이미 끝난 일의 사후 보고고(읽고 나면 할
          일이 없다), 이건 지금 이 순간 알림이 나가지 않고 있으니 **사용자가 눌러야 복구되는**
          유일한 배너다. 실제로 앱 비밀번호가 폐기됐을 때 3일간 아무 데도 표가 나지 않았고,
          그 침묵을 깨는 것이 이 자리다.

          평상시(정상 연결)에는 접힌 회색 한 줄만 남고, 상태를 못 읽으면 아무것도 그리지 않는다.
        */}
        <MailAuthBanner />
        {/*
          가동 중단 배너 — 기존 전역 배너 두 개(파란 안내 · 빨간 오류) 아래, 탭 내용 바로 위.
          새 탭을 만들지 않는 이유는 명세 §6.5 그대로다: 절전·정전은 여러 탭을 동시에 죽이는데
          사용자는 비어 있는 그 탭을 열지, "가동 기록" 탭을 찾아 들어가지 않는다.
        */}
        {bannerVisible && bannerEvent && (
          <DowntimeBanner
            event={bannerEvent}
            onAck={() => void ackDowntime(bannerEvent.id)}
            acking={ackingId === bannerEvent.id}
            onOpenHistory={historyOpen ? undefined : toggleHistory}
          />
        )}
        {historyOpen && (
          <DowntimeHistoryPanel
            events={history}
            loading={historyLoading}
            error={historyErr}
            onAck={(id) => void ackDowntime(id)}
            ackingId={ackingId}
            highlightedId={bannerVisible ? bannerEvent?.id : null}
          />
        )}
        <div role="tabpanel" id={TAB_PANEL_ID} aria-labelledby={`tab-${activeTab.id}`}>
          {activeTab.id === FRONT_TAB_ID ? (
            <FrontPage tabs={TABS} feeds={feeds} onOpenTab={(id) => selectTab(id, { scrollTop: true })} />
          ) : (
            activeTab.content
          )}
        </div>
      </main>

      {/* 모든 탭 공통: 아래로 스크롤하면 나타나는 '맨 위로' 버튼 */}
      <ScrollToTop color={activeTab.color} />
    </div>
  );
}
