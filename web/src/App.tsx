import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2, PowerOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { EventsBoard } from "@/components/EventsBoard";
import { NewsBoard } from "@/components/NewsBoard";
import { YoutubeBoard } from "@/components/YoutubeBoard";
import { StockBoard } from "@/components/StockBoard";
import { HoldingsBoard } from "@/components/HoldingsBoard";
import { LottoBoard } from "@/components/LottoBoard";
import { ScrollToTop } from "@/components/ScrollToTop";
import { ModelControl } from "@/components/ModelControl";
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
  /** 탭 고유색(HEX). 선택 시 배경, 비선택 시 글자/연한 배경에 사용 */
  color: string;
  content: ReactNode;
}

// 새 게시판은 여기에 항목만 추가하면 탭이 늘어난다. color는 탭 고유색.
//
// ⚠️ 가격 대시보드 탭은 2026-08-01 제거했다. 네이버 쇼핑 검색 API 가 2026-07-31 부로
// 영구 종료(유예·대체 API 없음)되어 판매처별 가격 리스팅을 얻을 정식 경로가 사라졌고,
// 남은 경로는 robots·약관이 금지하는 크롤링뿐이라 기능을 접었다. 과거 가격 이력은
// DB(price_points/listings)에 그대로 보존돼 있다.
const TABS: TabDef[] = [
  { id: "events", label: "팝업·전시", color: "#db2777", content: <EventsBoard /> },
  { id: "news", label: "뉴스", color: "#d97706", content: <NewsBoard /> },
  { id: "youtube", label: "유튜브 소식", color: "#dc2626", content: <YoutubeBoard /> },
  { id: "stock", label: "증시", color: "#059669", content: <StockBoard /> },
  // 보유 종목은 증시 탭 안의 한국장/미국장과 **별도 탭**이다(인터뷰 결정).
  { id: "holdings", label: "보유 주식", color: "#0d9488", content: <HoldingsBoard /> },
  { id: "lotto", label: "로또", color: "#7c3aed", content: <LottoBoard /> },
];

/** 화면이 서버에 가동 중단 상태를 물어보는 주기. 서버 하트비트(60초)와 같은 해상도로 맞춘다. */
const DOWNTIME_POLL_MS = 60_000;

export default function App() {
  const [active, setActive] = useState(TABS[0].id);
  const activeTab = TABS.find((t) => t.id === active) ?? TABS[0];

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
    <div
      className="min-h-screen bg-background transition-colors duration-300"
      // 선택된 탭 고유색을 아주 옅게(약 7%) 깔아 내용 영역 배경에 반영
      style={{ backgroundColor: `${activeTab.color}12` }}
    >
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto max-w-[1920px] px-4">
          <div className="flex items-center justify-between gap-6 pt-3">
            <h1 className="shrink-0 text-lg font-bold">📷 Daily Dashboard</h1>
            <div className="flex items-center gap-3">
              {/* 확인하지 않은 가동 중단 기록. 0건이면 아예 렌더링되지 않는다(평상시 헤더 = 지금 그대로). */}
              <DowntimeBadge
                count={downtime?.unackedCount ?? 0}
                open={historyOpen}
                onToggle={toggleHistory}
              />
              {/* 수집·큐레이션 AI 모델 선택은 특정 탭이 아닌 전역 설정 → 헤더에 배치 */}
              <ModelControl />
              {serviceInstalled && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={uninstallService}
                  disabled={uninstalling}
                  title="launchd 자동 수집 서비스 제거"
                >
                  {uninstalling ? <Loader2 className="h-4 w-4 animate-spin" /> : <PowerOff className="h-4 w-4" />}
                  서비스 제거
                </Button>
              )}
            </div>
          </div>
          {/* 게시판 탭 메뉴 — 전체폭, 탭 갯수만큼 균등분할, 탭별 고유색 */}
          <nav className="-mb-px flex w-full gap-2 pt-3" role="tablist">
            {TABS.map((t) => {
              const selected = active === t.id;
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActive(t.id)}
                  style={
                    selected
                      ? { backgroundColor: t.color, borderColor: t.color, color: "#fff" }
                      : { backgroundColor: `${t.color}14`, borderColor: `${t.color}33`, color: t.color }
                  }
                  className={cn(
                    "flex-1 rounded-t-lg border border-b-0 px-4 py-3 text-center text-[15px] font-semibold transition-all",
                    selected ? "shadow-sm" : "hover:brightness-95"
                  )}
                >
                  {t.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1920px] px-4 py-6">
        {notice && (
          <div className="mb-4 whitespace-pre-line rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            {notice}
          </div>
        )}
        {err && (
          <div className="mb-4 rounded-md border border-up/40 bg-up/10 px-4 py-3 text-sm text-up">{err}</div>
        )}
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
        {activeTab.content}
      </main>

      {/* 모든 탭 공통: 아래로 스크롤하면 나타나는 '맨 위로' 버튼 */}
      <ScrollToTop color={activeTab.color} />
    </div>
  );
}
