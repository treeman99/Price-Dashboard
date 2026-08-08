import { Router } from "express";
import type { Request } from "express";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, validateConfig } from "../config.ts";
import { getStockPoints, upsertStockPoints } from "../db/repo.ts";
import {
  getEventsSnapshot,
  refreshEvents,
  isEventsCollecting,
  getEventsLastAttempt,
} from "../events/events.ts";
import {
  getNewsSnapshot,
  refreshNews,
  isNewsCollecting,
  getNewsLastAttempt,
} from "../news/news.ts";
import {
  loadCategories,
  addCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
} from "../news/categories.ts";
import {
  getYoutubeSnapshot,
  refreshYoutube,
  isYoutubeCollecting,
  getYoutubeLastAttempt,
  moveYoutubeVideo,
} from "../youtube/youtube.ts";
import {
  loadCategories as ytLoadCategories,
  addCategory as ytAddCategory,
  updateCategory as ytUpdateCategory,
  deleteCategory as ytDeleteCategory,
  reorderCategories as ytReorderCategories,
} from "../youtube/categories.ts";
import {
  loadBlocklist,
  addBlock,
  removeBlock,
  removeBlocksForCategory,
  applyBlocklist,
} from "../youtube/blocklist.ts";
import { addRecommendedChannel, removeRecommendedChannel } from "../../shared/youtube.ts";
import { markWatched, unmarkWatched, activeWatched, annotateWatched } from "../youtube/watched.ts";
import {
  loadDismissed,
  addDismiss,
  setDismissReason,
  removeDismiss,
  applyDismissed,
} from "../youtube/dismissed.ts";
import { applyRegionFilter, applyYoutubeDedup } from "../youtube/curate.ts";
import { getStockSnapshot, refreshStock, isStockCollecting } from "../stock/stock.ts";
import {
  listStocks,
  getStock,
  createStock,
  updateStock,
  deleteStock,
  reorderStocks,
} from "../stock/tickers.ts";
import { searchTicker, fetchHistory } from "../stock/quote.ts";
import {
  createHolding,
  deleteHolding,
  getHolding,
  listHoldings,
  reorderHoldings,
  summarizeHoldings,
  updateHolding,
} from "../stock/holdings.ts";
import { runPulse, isPulseRunning, getLastPulseRun } from "../stock/pulse.ts";
import {
  getSnapshot as getLottoSnapshot,
  isCycleRunning as isLottoCycleRunning,
  runWeeklyCycle as runLottoWeeklyCycle,
} from "../lotto/cycle.ts";
import { isPulseNotifyEnabled } from "../notify/pulse-imessage.ts";
import { allRecentPulseAlerts } from "../db/repo.ts";
import { getSchedule, saveSchedule } from "../scheduler/schedule-store.ts";
import { getModelSettings, saveAgentModel } from "../util/model-store.ts";
import { rescheduleAll, withLlmSlot } from "../scheduler/scheduler.ts";
// 가동 중단 사후 보고(§11 P1). 화면 상태는 **합성 루트**가 감싼 getDowntimeView() 만 쓴다 —
// 그쪽이 원장 파손 시에도 throw 하지 않고 빈 뷰를 돌려주기 때문이다. 목록·확인은 저장 계층 직행.
import { getDowntimeView } from "../uptime/index.ts";
import { ackDowntimeEvent, listDowntimeEvents } from "../uptime/store.ts";
import { generateCategoryDescription, shouldAutoDescribe } from "../util/category-describe.ts";
import { sendIMessage, isIMessageConfigured } from "../notify/imessage.ts";
import {
  buildAuthUrl,
  disconnect as disconnectGoogle,
  exchangeCode,
  getGoogleAuthStatus,
} from "../notify/google-auth.ts";
import { log } from "../util/log.ts";
import type { ScheduleSettings, StockMarket } from "../../shared/types.ts";

export const api = Router();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LAUNCHD_LABEL = "com.daegun.dailyprice";
const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

// ── 수동 '지금 갱신' — 전역 LLM 슬롯 경유 ─────────────────────────────────────
//
// 2026-08-02 실측 결함: 수동 갱신 라우트들이 refreshX() 를 **직접** 불러 스케줄러의 전역 LLM
// 세마포어(withLlmSlot)와 전원 어서션(withWakeLock)을 통째로 우회했다. 그 결과
//   · 사용자가 누른 갱신과 정시 catch-up 이 겹쳐 **LLM 세션 2개가 동시에** 떴고,
//   · 큐를 정상적으로 통과한 스케줄 런은 이미 돌고 있는 수동 런의 탭별 running 가드에 막혀
//     아무 일도 하지 않고 즉시 반환됐는데, 스케줄러는 그 빈손을 '실패'로 읽어 백오프를 걸었다.
// 그래서 수동 갱신도 스케줄러와 **같은 슬롯**을 타야 한다. 공개 진입점 withLlmSlot 하나만
// 통과하면 ①전역 동시 1개 직렬화 ②큐 통과 뒤 전원 어서션 ③재진입 교착 회피가 함께 보장되므로,
// 이 파일이 caffeinate 를 따로 잡을 일은 없다(잡으면 줄만 서 있는 작업이 맥을 깨워 둔다).
//
// ★ 막는 것은 **동시 실행뿐**이다. catch-up 연속 실패 백오프는 여전히 타지 않는다 — 그 게이트는
//   스케줄러 내부(safeRefreshX)에만 있고 이 파일은 refreshX 를 직접 부르므로 구조적으로
//   우회된다. 사용자가 직접 누른 갱신까지 백오프로 막으면 그게 진짜 먹통이다.
//
// ★ 슬롯이 점유돼 있으면 **줄 서지 않고 즉시 409** 를 준다. withLlmSlot 은 무한 대기열이라
//   그냥 태우면 유튜브 정시 수집(최대 20분) 뒤에 조용히 줄을 서게 되는데, 그동안
//   `/xxx/status` 의 collecting 은 false 라 화면에는 "아무 일도 안 일어남"으로 보이고,
//   사용자는 같은 버튼을 반복해 눌러 대기열만 늘린다. 하염없이 기다리게 하느니 "지금은 A
//   수집 중"이라고 말해 주는 편이 정직하고, 언제 다시 누를지 사용자가 정할 수 있다.
//   (모든 대상 라우트가 원래 202 fire-and-forget 이라, 이 판별에 드는 시간도 1ms 미만이다.)

/** 수동으로 시작해 지금 슬롯을 쥐고 있는 작업. 경과 시간을 안내하기 위한 것. */
let manualHolder: { label: string; since: number } | null = null;

/**
 * 지금 전역 LLM 슬롯을 쥐고 있을 법한 수집의 표시명.
 *
 * 슬롯 보유자를 스케줄러가 직접 알려주지는 않으므로(내보내는 것은 withLlmSlot 하나뿐),
 * 슬롯 대상 작업들의 '수집 중' 플래그로 되짚는다. 펄스는 슬롯을 타지 않으므로 제외한다.
 */
function llmBusyLabel(): string | null {
  if (isNewsCollecting()) return "뉴스";
  if (isYoutubeCollecting()) return "유튜브";
  if (isEventsCollecting()) return "팝업/전시";
  if (isStockCollecting("kr")) return "국내 증시";
  if (isStockCollecting("us")) return "미국 증시";
  if (isLottoCycleRunning()) return "로또";
  return null;
}

/** "3분 12초" 처럼 사람이 읽는 경과. */
function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분 ${sec % 60}초`;
}

/** 슬롯 점유로 시작하지 못했을 때의 409 본문. 기술 용어 없이 상황만 전한다. */
function llmBusyBody(): { error: string; busy: true; collecting: false } {
  const held = manualHolder;
  const label = held?.label ?? llmBusyLabel();
  const elapsed = held ? `(${formatElapsed(Date.now() - held.since)} 경과) ` : "";
  return {
    error: `${label ? `${label} ` : "다른 "}수집이 진행 중입니다 ${elapsed}— 끝난 뒤 다시 눌러 주세요.`,
    busy: true,
    // 이 탭 자체는 수집 중이 아니다. 화면이 '수집 중' 배너를 띄우고 폴링하지 않도록 명시한다.
    collecting: false,
  };
}

/**
 * 수동 갱신 1건을 전역 LLM 슬롯 위에서 시작한다.
 * 반환 false = **아무것도 시작하지 않았다**(슬롯 점유 중) → 호출부가 409 로 안내한다.
 *
 * 점유 판별 방법: withLlmSlot 은 "지금 비었나?"를 알려주지 않고 큐잉만 한다. 그래서 일단
 * 줄을 세운 뒤 **한 매크로태스크 안에 실행에 들어갔는지**로 판별한다 — 큐가 비어 있으면
 * withLlmSlot 은 이미 settled 된 꼬리를 await 할 뿐이라 마이크로태스크 몇 개 만에 fn 에
 * 진입하고, setImmediate 는 마이크로태스크 큐를 전부 비운 뒤에야 발화한다. 그때까지도
 * 진입하지 못했다면 앞에 누군가 있다는 뜻이므로 대기표를 버린다(차례가 와도 즉시 반환).
 *
 * ⚠️ 앞 작업이 **바로 그 순간** 슬롯을 놓는 중이면 드물게 '점유 중'으로 볼 수 있다.
 *    최악값이 "잠시 후 다시" 한 번이라 감수한다. 반대 방향(동시 실행 허용)의 오판은 없다 —
 *    실제로 슬롯을 얻은 뒤에만 본작업이 시작되기 때문이다.
 *
 * ⚠️ 이 함수는 **절대 reject 하지 않는다**(기다리는 대상이 resolve 전용 프라미스뿐이고, 본작업의
 *    예외는 위 catch 가 삼킨다). Express 4 는 async 핸들러의 rejection 을 잡지 못해 요청이 그대로
 *    매달리므로, 호출부가 try/catch 없이 await 할 수 있으려면 이 성질이 유지되어야 한다.
 */
async function startManualLlmJob(display: string, fn: () => Promise<unknown>): Promise<boolean> {
  const label = `${display}[수동]`;
  let phase: "waiting" | "running" | "dropped" = "waiting";

  void withLlmSlot(label, async () => {
    if (phase === "dropped") return; // 호출부가 이미 409 로 답했다 → 슬롯을 그대로 반납
    phase = "running";
    manualHolder = { label: display, since: Date.now() };
    try {
      // 전원 어서션(caffeinate)은 withLlmSlot 안에서 이미 잡힌다 — 여기서 또 잡지 않는다.
      return await fn();
    } finally {
      manualHolder = null;
    }
  }).catch((e: unknown) => log.warn(`${display} 수동 수집 예외: ${(e as Error).message}`));

  // 마이크로태스크가 전부 빠질 때까지 양보한다(두 번이면 넉넉하다 — 큐 꼬리는 프라미스 두어 겹).
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
  if (phase === "waiting") {
    phase = "dropped";
    log.info(`${display} 수동 갱신 거절 — 다른 LLM 수집이 슬롯을 점유 중`);
    return false;
  }
  return true;
}

api.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ── 가동 중단 사후 보고 (명세 §11 P1-12) ─────────────────────────────────────
//
// 특정 탭이 아니라 **전역**이라 /health 옆에 둔다. 절전·정전은 뉴스·유튜브·팝업·로또를 동시에
// 죽이는데, 사용자는 "왜 뉴스가 비었지" 하며 뉴스 탭을 연다(§6.5). 그래서 화면에서도 탭이
// 아니라 헤더/전역 배너에 붙고, 라우트도 그 구조를 그대로 따른다.
//
// ★ 이 세 라우트는 **가볍다.** 판정·수집·문구 생성은 전부 P0 쪽(하트비트 틱·기동 부검)에서
//   이미 끝나 원장 JSON 에 완성된 한국어로 들어 있다. 여기서 하는 일은 그 JSON 을 읽어
//   내려보내는 것과 ackedAt 한 필드를 적는 것뿐이다. 라우트가 무거워지면 사후 보고 화면
//   하나 때문에 대시보드 응답이 느려지는데, 그건 이 기능이 진단하려던 것보다 큰 사고다.

/**
 * 화면이 60초마다 폴링하는 상태. `{ current, unackedCount }`.
 *
 * - `current`      = 배너 1건(미확인 `사고` 중 최신). 평상시엔 **null** 이라 화면은 지금과 동일.
 * - `unackedCount` = 헤더 배지 숫자(미확인 `사고` + `기록만`. `무시` 는 세지 않는다).
 *
 * `getDowntimeView()` 는 원장이 깨져도 throw 하지 않고 빈 뷰를 준다 — try/catch 가 없는 것은
 * 빠뜨린 게 아니라 그쪽 계약이다(`src/uptime/index.ts` 주석 참조).
 */
api.get("/downtime", (_req, res) => {
  res.json(getDowntimeView());
});

/** 한 번에 내려보낼 수 있는 사건 수 상한. 원장 회전 상한(100건)과 같은 값으로 맞춘다. */
const DOWNTIME_HISTORY_MAX = 100;
const DOWNTIME_HISTORY_DEFAULT = 50;

/**
 * 지난 기록(최신순). 화면의 '지난 기록 보기'가 쓴다.
 *
 * ⚠️ `severity: "무시"` 인 사건도 그대로 내려간다. 원장에는 "안 보여준 것"까지 남긴다는 게
 *    §3.5 의 결정이고("이 기능이 오탐하고 있나"를 나중에 반증하려면 필요하다), 무엇을
 *    가려서 보여줄지는 **화면 쪽 규칙**이다. 서버가 미리 걸러 버리면 화면에서 다시 못 본다.
 */
api.get("/downtime/history", (req, res) => {
  const raw = Number(req.query.limit);
  const limit =
    Number.isFinite(raw) && raw > 0
      ? Math.min(Math.floor(raw), DOWNTIME_HISTORY_MAX)
      : DOWNTIME_HISTORY_DEFAULT;
  try {
    res.json({ events: listDowntimeEvents(limit) });
  } catch (e) {
    // 원장 파일이 깨진 경우. 500 을 주면 화면이 "불러오지 못했습니다"만 띄우고 끝나는데,
    // 그 사실은 store 가 이미 `.broken` 사본 + 경고 로그로 남겼다. 화면은 빈 목록이면 된다.
    log.warn(`가동 중단 이력 조회 실패 — 빈 목록으로 응답합니다: ${(e as Error).message}`);
    res.json({ events: [] });
  }
});

/**
 * [확인했어요] — `ackedAt` 기록 + 미발송 알림 취소.
 *
 * 닫기를 서버에 저장하는 이유(§6.5): 기존 두 배너(수집 실패·스냅샷 노후)는 다음 수집이
 * 성공하면 저절로 사라지지만, 사후 보고는 **과거의 사실**이라 저절로 사라질 조건이 없다.
 *
 * 알림 취소는 `ackDowntimeEvent()` 안에서 함께 일어난다 — `queuedUntil` 을 지우고, 이후
 * `decideDowntimeNotify()` 가 `ackedAt` 을 보고 skip 한다(§7-4). 조용시간에 보류된 문자가
 * 아침 7시에 뒤늦게 도착해 **이미 확인한 사고**를 다시 알리는 것을 막는 조항이다.
 *
 * ★ 일지(`data/downtime.log`) 재작성은 **일부러 하지 않는다.** 내레이터 배선은 합성 루트
 *   (`src/uptime/index.ts`)의 소유이고, HTTP 핸들러가 200항목짜리 텍스트 파일을 통째로 다시
 *   쓰는 것은 "라우트에서 무거운 일을 하지 않는다"는 이 블록의 원칙에 어긋난다. 원장이 정본이고
 *   일지는 다음 재작성 때 따라온다(store.ts `markDowntimeNotified` 주석의 같은 계약).
 *
 * ★ 응답에 갱신된 `view` 를 함께 담는다. 화면이 확인 직후 배지 숫자를 고치려고 곧바로
 *   `GET /api/downtime` 을 한 번 더 부르는 왕복을 없앤다(이 상태는 화면에서 즉시 바뀌어야 한다).
 */
api.post("/downtime/:id/ack", (req, res) => {
  // id 는 `2026-08-02T00:29:10+09:00` 같은 로컬 ISO 다. `:` `+` 가 들어 있지만 경로 구분자(`/`)는
  // 없어 한 세그먼트에 담기고, Express 가 디코드해 준다(화면은 encodeURIComponent 로 보낸다).
  const id = String(req.params.id ?? "");
  if (!id) return res.status(400).json({ error: "사건 id 가 필요합니다." });
  try {
    const event = ackDowntimeEvent(id);
    if (!event) return res.status(404).json({ error: "그런 가동 중단 기록이 없습니다." });
    res.json({ ok: true, event, view: getDowntimeView() });
  } catch (e) {
    log.warn(`가동 중단 확인 처리 실패 (사건 ${id}): ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message });
  }
});

api.get("/config", (_req, res) => {
  const { warnings } = validateConfig();
  res.json({
    port: config.port,
    notify: { email: config.notify.email, imessage: isIMessageConfigured() },
    warnings,
  });
});

/**
 * [PoC] iMessage 테스트 발송 — 실행 중인 launchd 서비스가 osascript 로 본인에게 1건 보낸다.
 * 이 경로의 목적은 '백그라운드 서비스의 TCC(자동화) 권한이 실제로 뚫리는지' 확인이다.
 * (내 셸에서 보내면 책임 프로세스가 달라 위양성 — 반드시 서비스 프로세스가 보내야 유효한 검증)
 * 최초 호출 시 macOS '…이(가) Messages를 제어하려고 합니다' 승인 프롬프트가 뜰 수 있다.
 */
api.post("/notify/imessage/test", async (_req, res) => {
  if (!config.notify.imessage)
    return res.status(400).json({ error: "NOTIFY_IMESSAGE 가 꺼져 있습니다 (.env 에서 켜고 서비스 재시작)." });
  if (!config.notify.imessageTo)
    return res.status(400).json({ error: "IMESSAGE_TO(수신자) 미설정 (.env)." });
  const now = new Date().toLocaleString("ko-KR");
  try {
    await sendIMessage(`[Daily Dashboard] iMessage 연동 테스트 — ${now}\n이 메시지가 보이면 자동 알림 연동이 가능합니다. 📈`);
    log.info("iMessage 테스트 발송 성공");
    res.json({ ok: true, sentTo: config.notify.imessageTo });
  } catch (e) {
    log.warn(`iMessage 테스트 발송 실패: ${(e as Error).message}`);
    // stderr(-1743 미승인 등)를 그대로 내려 진단 가능하게.
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── 메일 발송용 Google 계정 연결 (OAuth2) ────────────────────────────────────
//
// 2026-08-05 계정 비밀번호를 바꾸자 Gmail 앱 비밀번호가 **조용히** 폐기돼 메일 알림이 3일간
// 죽어 있었다. 그 사실을 화면까지 끌어올리고 클릭 두 번으로 되살리기 위한 라우트 4개다 —
// 상태 조회 · 동의 화면 주소 발급 · 콜백 수신 · 연결 해제.
//
// 토큰의 저장·갱신·폐기는 전부 `src/notify/google-auth.ts` 소유다. 이 블록이 하는 일은
// HTTP 껍데기와 **state(CSRF 대기표) 관리**뿐이다 — 인증 흐름의 상태를 두 곳에서 들고 있으면
// 어느 쪽이 정본인지 곧 알 수 없게 된다.
//
// ⚠️ 이 블록에는 `:param` 라우트가 없어 등록 순서 함정(/stock/search vs /stock/:market)이 없다.
//    나중에 `/google/:something` 을 추가한다면 반드시 아래 네 개보다 **뒤에** 둘 것.

/** 콜백 경로. 이 문자열은 Google Console 의 '승인된 리디렉션 URI' 와 같아야 한다. */
const GOOGLE_CALLBACK_PATH = "/api/google/callback";

/**
 * 동의 후 돌아올 주소.
 *
 * 포트는 .env(PORT)로 바뀔 수 있어 **요청의 Host 에서 가져오고**, 스킴·호스트이름은
 * `http://localhost` 로 못 박는다. Google 은 등록된 리디렉션 URI 와 문자열이 **정확히 같을 때만**
 * 코드를 내주는데, 같은 서버를 `127.0.0.1` 이나 LAN IP 로 열어 두고 눌렀다는 이유로 주소가
 * 갈라지면 그 주소들은 Console 에 등록돼 있지도 않아 redirect_uri_mismatch 로 끝난다.
 * (Host 에 포트가 없으면 이 서버가 실제로 듣고 있는 포트를 쓴다.)
 */
function googleRedirectUri(req: Request): string {
  const port = /:(\d{1,5})$/.exec(String(req.headers.host ?? ""))?.[1] ?? String(config.port);
  return `http://localhost:${port}${GOOGLE_CALLBACK_PATH}`;
}

/**
 * 발급한 state 의 유효 시간. 동의 화면에서 계정을 고르고 권한을 확인하기엔 넉넉하고,
 * 주소만 받아 두고 방치한 대기표가 오래 남지는 않을 만큼 짧다.
 */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** 동시에 살아 있을 수 있는 대기표 수. 버튼을 연타해도 메모리가 늘지 않게 하는 상한. */
const OAUTH_STATE_MAX = 8;

/**
 * 발급했지만 아직 돌아오지 않은 state → 그때 쓴 redirect_uri.
 *
 * **CSRF 방어가 목적이다.** 콜백은 브라우저가 여는 GET 이라 남이 만든 주소를 어디에든 걸어 둘 수
 * 있고, 대조가 없으면 공격자가 받아 둔 code 로 이 대시보드가 **남의 Google 계정에 연결**된다
 * (로그인 CSRF — 그 뒤 알림 메일이 전부 그 계정에서 나간다). 대조에 성공한 표는 그 자리에서
 * 지운다. 1회용이라 같은 code 를 다시 밀어 넣는 재생도 함께 막힌다.
 *
 * redirect_uri 를 함께 기억하는 이유: 토큰 교환의 redirect_uri 가 동의 요청 때와 **한 글자라도
 * 다르면** Google 이 거절한다. 콜백 요청의 Host 로 다시 계산하지 않고 발급 시점 값을 그대로 쓴다.
 *
 * 서버가 재시작되면 비는데, 그게 맞다 — 진행 중이던 동의는 무효로 보는 편이 안전하다.
 */
const pendingOauthStates = new Map<string, { redirectUri: string; issuedAt: number }>();

/** 대기표 발급. 만료분을 먼저 걷어내고, 그래도 넘치면 가장 오래된 것부터 버린다. */
function rememberOauthState(state: string, redirectUri: string): void {
  const now = Date.now();
  for (const [k, v] of pendingOauthStates) {
    if (now - v.issuedAt > OAUTH_STATE_TTL_MS) pendingOauthStates.delete(k);
  }
  // Map 은 삽입 순서를 지키므로 첫 키가 가장 오래된 대기표다.
  while (pendingOauthStates.size >= OAUTH_STATE_MAX) {
    const oldest = pendingOauthStates.keys().next().value;
    if (oldest === undefined) break;
    pendingOauthStates.delete(oldest);
  }
  pendingOauthStates.set(state, { redirectUri, issuedAt: now });
}

/** 대조 + 소비(1회용). 모르는 값이거나 만료됐으면 null → 호출부가 state_mismatch 로 되돌린다. */
function consumeOauthState(state: string): { redirectUri: string } | null {
  const entry = pendingOauthStates.get(state);
  if (!entry) return null;
  pendingOauthStates.delete(state);
  return Date.now() - entry.issuedAt > OAUTH_STATE_TTL_MS ? null : entry;
}

/**
 * 화면(MailAuthBanner)이 문장으로 풀어 주거나, 최소한 사람이 검색할 수 있는 OAuth 오류 코드들.
 * 여기 없는 값은 코드가 아니라 임의 문자열일 수 있으므로 주소창으로 흘려보내지 않는다.
 */
const OAUTH_ERROR_CODES = [
  "access_denied",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "invalid_scope",
  "unauthorized_client",
];

/**
 * 리디렉션에 실을 사유 코드.
 *
 * ⚠️ 예외 메시지를 그대로 주소창에 싣지 않는다. google-auth 가 비밀값을 메시지에 담지는 않지만,
 *    주소창·브라우저 이력·스크린샷으로 새어 나가는 자리라 **화이트리스트에 있는 코드만** 내보낸다.
 *    자세한 사연은 상태의 lastError(화면의 '자세한 오류')로 이미 회수된다.
 */
function oauthErrorReason(e: unknown): string {
  const msg = (e as Error)?.message ?? "";
  return OAUTH_ERROR_CODES.find((c) => msg.includes(c)) ?? "exchange_failed";
}

/**
 * 지금 메일을 보낼 수 있는 상태인가. 화면이 60초마다 폴링한다(MailAuthBanner).
 * 토큰 파일이 깨져도 getGoogleAuthStatus 는 throw 하지 않고 '미연결'을 돌려준다(그쪽 계약).
 */
api.get("/google/status", (_req, res) => {
  res.json(getGoogleAuthStatus());
});

/**
 * 동의 화면 주소 발급. 화면은 받은 url 로 그대로 이동한다.
 * .env 에 클라이언트가 없으면 400 — 화면이 body.error 를 그대로 보여 준다.
 */
api.get("/google/auth-url", (req, res) => {
  const redirectUri = googleRedirectUri(req);
  // 128비트 난수. Google 이 그대로 되돌려 주므로 추측·충돌로는 대조를 통과할 수 없다.
  const state = crypto.randomBytes(16).toString("hex");
  try {
    // 주소를 실제로 내려보낼 수 있을 때만 대기표를 남긴다(미설정이면 여기서 throw).
    const url = buildAuthUrl(redirectUri, state);
    rememberOauthState(state, redirectUri);
    res.json({ url });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * 동의 후 Google 이 브라우저를 돌려보내는 자리.
 *
 * **사람의 브라우저**가 여는 주소라 JSON 이 아니라 대시보드로 302 한다
 * (`/?google=ok` · `/?google=error&reason=…`). 화면이 그 표식을 읽어 결과를 알리고 주소에서
 * 지운다(MailAuthBanner). 여기서 JSON 을 주면 사용자는 대시보드가 아니라 날것의 본문을 본다.
 */
api.get("/google/callback", async (req, res) => {
  const back = (reason?: string) =>
    res.redirect(reason ? `/?google=error&reason=${encodeURIComponent(reason)}` : "/?google=ok");

  // state 대조가 가장 먼저다. Google 이 거절한 경우(error=access_denied)에도 state 는 함께
  // 오므로, 어느 경로로 들어오든 대기표는 한 번만 쓰이고 사라진다.
  const pending = consumeOauthState(typeof req.query.state === "string" ? req.query.state : "");
  if (!pending) {
    log.warn("Google 콜백 state 불일치 — 이 요청은 버립니다.");
    return back("state_mismatch");
  }

  const denied = typeof req.query.error === "string" ? req.query.error : "";
  if (denied) {
    const reason = OAUTH_ERROR_CODES.includes(denied) ? denied : "auth_failed";
    log.warn(`Google 계정 연결이 완료되지 않았습니다 — ${reason}`);
    return back(reason);
  }

  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) {
    log.warn("Google 콜백에 code 가 없습니다 — 연결하지 못했습니다.");
    return back("missing_code");
  }

  try {
    await exchangeCode(code, pending.redirectUri);
    back();
  } catch (e) {
    // ⚠️ code·client_secret·토큰은 어디에도 찍지 않는다. 예외 메시지에 실리는 것은 Google 이
    //    준 error/error_description 뿐이다(google-auth.ts describe()).
    log.warn(`Google 계정 연결 실패: ${(e as Error).message}`);
    back(oauthErrorReason(e));
  }
});

/**
 * 연결 해제(로컬 토큰 폐기).
 *
 * **POST 전용이다.** 이 대시보드는 localhost 전용이지만 라우트는 열려 있어, GET 이면 남이 걸어
 * 둔 `<img>` 한 장이나 브라우저의 선반입만으로도 메일 알림이 끊긴다 — 부수효과가 있는 동작을
 * GET 에 두지 않는다. GET 으로 오면 이 경로에 등록된 핸들러가 없어 404 다.
 */
api.post("/google/disconnect", (_req, res) => {
  disconnectGoogle();
  // 진행 중이던 동의 대기표도 함께 버린다. 해제 직후 뒤늦게 돌아온 콜백이 연결을 되살리면
  // 사용자가 방금 누른 '해제' 가 조용히 뒤집힌다.
  pendingOauthStates.clear();
  res.json({ ok: true });
});

// ── 탭별 자동 수집 시각 (스케줄) ──

/** 현재 유효 스케줄(.env 기본값 + 사용자 변경 병합). */
api.get("/schedule", (_req, res) => {
  res.json(getSchedule());
});

/**
 * 스케줄 부분 수정. 전달된 탭(price/events/news/youtube/stockKr/stockUs)만 갱신하고
 * 영구 저장한 뒤, 재시작 없이 cron 을 즉시 재등록한다. HH:mm 형식 오류면 400.
 *
 * ⚠️ 탭을 늘리면 이 화이트리스트에도 반드시 추가할 것. 빠뜨리면 UI 저장이
 *    에러 없이 조용히 무시된다(saveSchedule 이 모르는 필드를 그냥 버림).
 */
api.put("/schedule", (req, res) => {
  try {
    const body = (req.body ?? {}) as Partial<ScheduleSettings>;
    const patch: Partial<ScheduleSettings> = {};
    if (body.events !== undefined) patch.events = body.events;
    if (body.news !== undefined) patch.news = body.news;
    if (body.youtube !== undefined) patch.youtube = body.youtube;
    if (body.stockKr !== undefined) patch.stockKr = body.stockKr;
    if (body.stockUs !== undefined) patch.stockUs = body.stockUs;
    if (body.stockPulse !== undefined) patch.stockPulse = body.stockPulse;
    const updated = saveSchedule(patch);
    rescheduleAll();
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ── 수집·큐레이션 AI 모델 (Agent SDK) ──

/** 현재 선택된 수집·큐레이션 에이전트 + 선택 가능 목록. */
api.get("/model", (_req, res) => {
  res.json(getModelSettings());
});

/**
 * 모델 선택 변경. body: { model: string }. 허용 목록 밖이면 400.
 * 저장 즉시 반영되며(파일에서 매 수집마다 새로 읽음) 서버 재시작 없이 다음 수집/큐레이션부터 적용된다.
 */
api.put("/model", (req, res) => {
  try {
    const model = (req.body ?? {}).model;
    res.json(saveAgentModel(model));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

api.get("/service/status", (_req, res) => {
  res.json({ installed: fs.existsSync(plistPath), label: LAUNCHD_LABEL });
});

/**
 * launchd 서비스 제거. 이 서버 자신이 그 서비스이므로,
 * uninstall.sh 를 detached로 띄워 부모(=이 프로세스)가 bootout 되어도 스크립트가 끝까지 실행되게 한다.
 */
api.post("/service/uninstall", (_req, res) => {
  if (!fs.existsSync(plistPath)) {
    return res.status(409).json({ error: "등록된 서비스가 없습니다." });
  }
  const script = path.join(repoRoot, "service", "uninstall.sh");
  // 먼저 응답을 보내 flush 한 뒤(자기 자신 종료 대비) 분리 실행
  res.json({
    ok: true,
    message: "백그라운드 서비스를 제거합니다. 잠시 후 이 서버가 종료됩니다.",
  });
  setTimeout(() => {
    const child = spawn("/bin/bash", [script], { detached: true, stdio: "ignore" });
    child.unref();
  }, 600);
});

// ── 팝업 · 전시 게시판 ──

/** 최신 팝업/전시 스냅샷 */
api.get("/events", (_req, res) => {
  res.json(getEventsSnapshot());
});

/**
 * 지금 갱신 (수동). 수집은 수 분 걸릴 수 있어 **백그라운드로 시작**하고 즉시 202를 반환한다.
 * 프론트는 /events/status 를 폴링해 '수집 중'을 표시하고, 완료되면 /events 를 다시 불러온다.
 * 이미 수집 중이면(수동/정시 무관) 409로 안내. 수동 갱신은 이메일을 보내지 않음(중복 방지).
 * 다른 탭이 LLM 슬롯을 쥐고 있어도 409 — 파일 상단 '수동 지금 갱신' 주석 참고.
 */
api.post("/events/refresh", async (_req, res) => {
  if (isEventsCollecting()) {
    return res.status(409).json({ error: "이미 팝업/전시 수집이 진행 중입니다.", collecting: true });
  }
  const started = await startManualLlmJob("팝업/전시", () =>
    refreshEvents({ trigger: "manual", notify: false })
  );
  if (!started) return res.status(409).json(llmBusyBody());
  res.status(202).json({ started: true, collecting: true });
});

/**
 * 팝업/전시 수집 진행 상태(프론트 폴링용).
 * lastAttempt 는 '갱신을 눌러도 화면이 그대로'인 상황을 설명하기 위한 것 — 유튜브 상태와 같은
 * 계약이다. 실패해도 기존(=어제) 스냅샷이 남으므로 updatedAt 만으로는 실패를 알 수 없다.
 */
api.get("/events/status", (_req, res) => {
  const snap = getEventsSnapshot();
  res.json({
    collecting: isEventsCollecting(),
    updatedAt: snap?.updatedAt ?? null,
    lastAttempt: getEventsLastAttempt(),
  });
});

// ── 데일리 뉴스 다이제스트 ──

/** 최신 뉴스 스냅샷 */
api.get("/news", (_req, res) => {
  res.json(getNewsSnapshot());
});

/**
 * 지금 갱신 (수동). 수집은 1~3분 걸릴 수 있어 **백그라운드로 시작**하고 즉시 202를 반환한다.
 * 프론트는 /news/status 를 폴링해 '수집 중'을 표시하고, 완료되면 /news 를 다시 불러온다.
 * 이미 수집 중이면(수동/정시 무관) 409로 안내. 수집한 내용은 이메일로도 발송(0건이면 생략).
 * 다른 탭이 LLM 슬롯을 쥐고 있어도 409 — 파일 상단 '수동 지금 갱신' 주석 참고.
 */
api.post("/news/refresh", async (_req, res) => {
  if (isNewsCollecting()) {
    return res.status(409).json({ error: "이미 뉴스 수집이 진행 중입니다.", collecting: true });
  }
  const started = await startManualLlmJob("뉴스", () =>
    refreshNews({ trigger: "manual", notify: true })
  );
  if (!started) return res.status(409).json(llmBusyBody());
  res.status(202).json({ started: true, collecting: true });
});

/**
 * 뉴스 수집 진행 상태(프론트 폴링용).
 * lastAttempt 는 '갱신을 눌러도 화면이 그대로'인 상황을 설명하기 위한 것 — 수집이 실패하면
 * 직전(=어제) 스냅샷을 유지하므로 updatedAt 만으로는 실패를 구분할 수 없다.
 */
api.get("/news/status", (_req, res) => {
  const snap = getNewsSnapshot();
  res.json({
    collecting: isNewsCollecting(),
    updatedAt: snap?.updatedAt ?? null,
    lastAttempt: getNewsLastAttempt(),
  });
});

/** 뉴스 카테고리 목록 */
api.get("/news/categories", (_req, res) => {
  res.json(loadCategories());
});

/** 카테고리 추가 — 설명이 없거나 짧으면 LLM이 수집 지침을 대신 작성(실패 시 입력값 유지) */
api.post("/news/categories", async (req, res) => {
  try {
    const { label, emoji, color, description } = req.body ?? {};
    let cat = addCategory({ label, emoji, color, description });
    if (shouldAutoDescribe(description)) {
      const generated = await generateCategoryDescription({
        kind: "news",
        label: cat.label,
        hint: typeof description === "string" ? description : undefined,
      });
      if (generated) cat = updateCategory(cat.key, { description: generated });
    }
    res.json(cat);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 카테고리 순서 변경 (전체 key 순서 전달) */
api.put("/news/categories/order", (req, res) => {
  try {
    const keys = (req.body?.keys ?? []) as string[];
    const cats = reorderCategories(keys);
    res.json(cats);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 카테고리 수정 */
api.patch("/news/categories/:key", (req, res) => {
  try {
    const { label, emoji, color, description } = req.body ?? {};
    const cat = updateCategory(req.params.key, { label, emoji, color, description });
    res.json(cat);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 카테고리 삭제 */
api.delete("/news/categories/:key", (req, res) => {
  try {
    const ok = deleteCategory(req.params.key);
    if (!ok) return res.status(404).json({ error: "카테고리를 찾을 수 없습니다." });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ── 유튜브 소식 ──

/**
 * 최신 유튜브 스냅샷. 읽기 시점 필터: 차단 채널 제외(해제 시 즉시 복원) +
 * 제외한 개별 영상 제외(카드의 [제외] 버튼, 해제 시 즉시 복원) +
 * kr 카테고리의 해외 영상 제외(카테고리 검색범위 반영 → 재수집 없이 즉시 정리).
 */
api.get("/youtube", (_req, res) => {
  const snap = applyDismissed(applyBlocklist(getYoutubeSnapshot()));
  res.json(annotateWatched(applyYoutubeDedup(applyRegionFilter(snap, ytLoadCategories()))));
});

/**
 * 지금 갱신 (수동). 수집은 수 분~수십 분 걸리므로 **백그라운드로 시작**하고 즉시 202를 반환한다.
 * 프론트는 /youtube/status 를 폴링해 '수집 중'을 표시하고, 완료되면 /youtube 를 다시 불러온다.
 * 이미 수집 중이면 새로 시작하지 않고 409로 안내(중복 수집 방지).
 * 다른 탭이 LLM 슬롯을 쥐고 있어도 409 — 파일 상단 '수동 지금 갱신' 주석 참고.
 */
api.post("/youtube/refresh", async (_req, res) => {
  if (isYoutubeCollecting()) {
    return res.status(409).json({ error: "이미 유튜브 수집이 진행 중입니다.", collecting: true });
  }
  // 응답을 막지 않도록 완료를 기다리지 않고 시작(내부에서 running 가드/이메일/저장 처리).
  const started = await startManualLlmJob("유튜브", () =>
    refreshYoutube({ trigger: "manual", notify: true })
  );
  if (!started) return res.status(409).json(llmBusyBody());
  res.status(202).json({ started: true, collecting: true });
});

/**
 * 유튜브 수집 진행 상태(프론트 폴링용).
 * lastAttempt 는 '갱신을 눌러도 화면이 그대로'인 상황을 설명하기 위한 것 — 수집이 실패하면
 * 기존 스냅샷을 유지하므로 updatedAt 만으로는 실패를 구분할 수 없다.
 */
api.get("/youtube/status", (_req, res) => {
  const snap = getYoutubeSnapshot();
  res.json({
    collecting: isYoutubeCollecting(),
    updatedAt: snap?.updatedAt ?? null,
    lastAttempt: getYoutubeLastAttempt(),
  });
});

/**
 * 카드(영상)를 다른 카테고리로 이동. 스냅샷을 즉시 갱신하고, 이동 사례를 재분류 기록에 남겨
 * 다음 수집 프롬프트가 학습하게 한다. 응답은 읽기 필터(차단/제외 영상/지역)를 적용한 최신 스냅샷.
 */
api.post("/youtube/move", (req, res) => {
  try {
    const { videoId, fromKey, toKey } = req.body ?? {};
    if (!videoId || !fromKey || !toKey) {
      return res.status(400).json({ error: "videoId, fromKey, toKey 가 모두 필요합니다." });
    }
    // 수집 중 이동은 완료 시점 스냅샷 덮어쓰기로 유실되므로 거부(재분류 기록도 남기지 않음).
    if (isYoutubeCollecting()) {
      return res
        .status(409)
        .json({ error: "수집이 진행 중입니다. 완료된 뒤 카드를 이동해 주세요.", collecting: true });
    }
    const snap = moveYoutubeVideo(String(videoId), String(fromKey), String(toKey));
    res.json(
      annotateWatched(
        applyYoutubeDedup(
          applyRegionFilter(applyDismissed(applyBlocklist(snap)), ytLoadCategories())
        )
      )
    );
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 유튜브 카테고리 목록 */
api.get("/youtube/categories", (_req, res) => {
  res.json(ytLoadCategories());
});

/** 카테고리 추가 — 설명이 없거나 짧으면 LLM이 수집 지침을 대신 작성(실패 시 입력값 유지) */
api.post("/youtube/categories", async (req, res) => {
  try {
    const { label, emoji, color, description, region, excludeKeywords, recommendedChannels } =
      req.body ?? {};
    let cat = ytAddCategory({
      label,
      emoji,
      color,
      description,
      region,
      excludeKeywords,
      recommendedChannels,
    });
    if (shouldAutoDescribe(description)) {
      const generated = await generateCategoryDescription({
        kind: "youtube",
        label: cat.label,
        hint: typeof description === "string" ? description : undefined,
        region: cat.region,
        excludeKeywords: cat.excludeKeywords,
        recommendedChannels: cat.recommendedChannels,
      });
      if (generated) cat = ytUpdateCategory(cat.key, { description: generated });
    }
    res.json(cat);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 카테고리 순서 변경 (전체 key 순서 전달) */
api.put("/youtube/categories/order", (req, res) => {
  try {
    const keys = (req.body?.keys ?? []) as string[];
    const cats = ytReorderCategories(keys);
    res.json(cats);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 카테고리 수정 */
api.patch("/youtube/categories/:key", (req, res) => {
  try {
    const { label, emoji, color, description, region, excludeKeywords, recommendedChannels } =
      req.body ?? {};
    const cat = ytUpdateCategory(req.params.key, {
      label,
      emoji,
      color,
      description,
      region,
      excludeKeywords,
      recommendedChannels,
    });
    res.json(cat);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 카테고리 삭제 */
api.delete("/youtube/categories/:key", (req, res) => {
  try {
    const ok = ytDeleteCategory(req.params.key);
    if (!ok) return res.status(404).json({ error: "카테고리를 찾을 수 없습니다." });
    removeBlocksForCategory(req.params.key); // 그 카테고리 전용 제외 채널도 함께 정리(고아 방지)
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ── 카테고리 추천 채널(카드 ⭐ 버튼) ──
// 다음 수집부터 큐레이션 프롬프트의 '[추천 채널(먼저 확인)]'에 주입되어 우선 조사된다.

/** 추천 채널 추가 — 이미 있으면 그대로(멱등, 저장 생략). 갱신된 카테고리 반환. */
api.post("/youtube/categories/:key/recommended-channels", (req, res) => {
  try {
    const { channel, handle } = req.body ?? {};
    const cat = ytLoadCategories().find((c) => c.key === req.params.key);
    if (!cat) return res.status(404).json({ error: "카테고리를 찾을 수 없습니다." });
    const next = addRecommendedChannel(
      cat.recommendedChannels,
      typeof channel === "string" ? channel : null,
      typeof handle === "string" ? handle : null
    );
    if (!next) return res.status(400).json({ error: "채널 정보가 없어 추천 채널로 추가할 수 없습니다." });
    if (next.length === (cat.recommendedChannels ?? []).length) return res.json(cat); // 이미 있음 → 저장 생략
    res.json(ytUpdateCategory(cat.key, { recommendedChannels: next }));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 추천 채널 해제 — 쿼리 channel/handle 과 매칭되는 항목 제거(멱등, 변화 없으면 저장 생략). */
api.delete("/youtube/categories/:key/recommended-channels", (req, res) => {
  try {
    const channel = typeof req.query.channel === "string" ? req.query.channel : null;
    const handle = typeof req.query.handle === "string" ? req.query.handle : null;
    if (!channel?.trim() && !handle?.trim())
      return res.status(400).json({ error: "해제할 채널 정보(channel 또는 handle)를 지정하세요." });
    const cat = ytLoadCategories().find((c) => c.key === req.params.key);
    if (!cat) return res.status(404).json({ error: "카테고리를 찾을 수 없습니다." });
    const next = removeRecommendedChannel(cat.recommendedChannels, channel, handle);
    if (next.length === (cat.recommendedChannels ?? []).length) return res.json(cat); // 변화 없음 → 저장 생략
    res.json(ytUpdateCategory(cat.key, { recommendedChannels: next }));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ── 유튜브 채널 차단 목록(조사 제외) ──

/** 차단 채널 목록 (최근 차단 먼저) */
api.get("/youtube/blocklist", (_req, res) => {
  const list = [...loadBlocklist()].sort((a, b) => b.blockedAt.localeCompare(a.blockedAt));
  res.json(list);
});

/** 채널 차단(카드의 '이 채널 제외' 버튼). categoryKey 지정 시 그 카테고리에서만 제외. 멱등. */
api.post("/youtube/blocklist", (req, res) => {
  try {
    const { channel, handle, categoryKey } = req.body ?? {};
    const entry = addBlock({
      channel: String(channel ?? ""),
      handle: handle ? String(handle) : null,
      categoryKey: categoryKey ? String(categoryKey) : null,
    });
    res.json(entry);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 차단 해제(되돌리기). id는 channelKey. */
api.delete("/youtube/blocklist/:id", (req, res) => {
  const ok = removeBlock(req.params.id);
  if (!ok) return res.status(404).json({ error: "차단 목록에 없습니다." });
  res.json({ ok: true });
});

// ── 유튜브 '본영상' 목록(수집 제외, 일정 기간 후 만료) ──

/** 현재 제외 활성인 본영상 목록(만료 제외, 최근 체크 먼저). */
api.get("/youtube/watched", (_req, res) => {
  const list = [...activeWatched()].sort((a, b) => b.watchedAt.localeCompare(a.watchedAt));
  res.json(list);
});

/** 본영상 체크(카드의 '본영상' 토글 ON). videoId 기준 멱등 — 재체크 시 제외 기간 연장. */
api.post("/youtube/watched", (req, res) => {
  try {
    const { videoId, title, channel } = req.body ?? {};
    const entry = markWatched({
      videoId: String(videoId ?? ""),
      title: title != null ? String(title) : null,
      channel: channel != null ? String(channel) : null,
    });
    res.json(entry);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 본영상 해제(토글 OFF). 다시 검색에 노출될 수 있다. */
api.delete("/youtube/watched/:videoId", (req, res) => {
  const ok = unmarkWatched(req.params.videoId);
  if (!ok) return res.status(404).json({ error: "본영상 목록에 없습니다." });
  res.json({ ok: true });
});

// ── 유튜브 영상 제외 목록(영구) ──
// 본영상(위)은 "이미 봤으니 당분간 빼줘"라 기간이 지나면 만료되지만, 이쪽은 "이런 영상은 원치 않는다"는
// 취향 신호라 만료가 없다. 해제는 관리 다이얼로그의 DELETE 로만 한다.

/** 제외 영상 목록 (최근 제외 먼저) */
api.get("/youtube/dismissed", (_req, res) => {
  const list = [...loadDismissed()].sort((a, b) => b.dismissedAt.localeCompare(a.dismissedAt));
  res.json(list);
});

/** 영상 제외(카드의 '제외' 버튼). 사유는 선택 — 원클릭 제외면 비워 둔다. videoId 기준 멱등. */
api.post("/youtube/dismissed", (req, res) => {
  try {
    const { videoId, title, channel, url, categoryKey, reason } = req.body ?? {};
    const entry = addDismiss({
      videoId: String(videoId ?? ""),
      title: title != null ? String(title) : null,
      channel: channel != null ? String(channel) : null,
      url: url != null ? String(url) : null,
      categoryKey: categoryKey != null ? String(categoryKey) : null,
      reason: reason != null ? String(reason) : null,
    });
    res.json(entry);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * 사유 붙이기/지우기(관리 다이얼로그). 빈 문자열이나 null 을 주면 사유가 지워진다.
 * addDismiss 는 기존 값을 보강만 하므로 삭제는 반드시 이 경로로 와야 한다.
 */
api.patch("/youtube/dismissed/:videoId", (req, res) => {
  const { reason } = req.body ?? {};
  const entry = setDismissReason(req.params.videoId, reason != null ? String(reason) : null);
  if (!entry) return res.status(404).json({ error: "제외 목록에 없습니다." });
  res.json(entry);
});

/** 제외 해제(되돌리기). 다음 조회부터 다시 카드로 보인다. */
api.delete("/youtube/dismissed/:videoId", (req, res) => {
  const ok = removeDismiss(req.params.videoId);
  if (!ok) return res.status(404).json({ error: "제외 목록에 없습니다." });
  res.json({ ok: true });
});

// ── 증시 ──
// 시장(kr/us)이 경로에 박히는 라우트가 많다. :market 은 신뢰 못 할 입력이므로
// 핸들러마다 parseMarket 으로 좁힌 뒤 StockMarket 으로 쓴다.
//
// ⚠️ 등록 순서 주의: GET /stock/search 는 GET /stock/:market 보다 **먼저** 와야 한다.
//    뒤에 두면 market="search" 로 먹혀 검색이 400 만 뱉는다.
//    반면 /stock/tickers/... 계열은 세그먼트 수/리터럴이 달라 :market 과 충돌하지 않는다.

const HISTORY_DAYS = 20;

/** :market 검증. kr|us 가 아니면 null → 호출부가 400. */
function parseMarket(v: unknown): StockMarket | null {
  return v === "kr" || v === "us" ? v : null;
}

/** 종목 검색(네이버 자동완성 프록시). market 쿼리로 시장을 좁힐 수 있다. */
api.get("/stock/search", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) return res.status(400).json({ error: "검색어(q)가 필요합니다." });
  try {
    const candidates = await searchTicker(q);
    // market 쿼리는 선택 — 값이 kr|us 가 아니면 필터하지 않고 전 시장을 돌려준다.
    const market = parseMarket(req.query.market);
    res.json(market ? candidates.filter((c) => c.market === market) : candidates);
  } catch (e) {
    res.status(502).json({ error: `종목 검색에 실패했습니다: ${(e as Error).message}` });
  }
});

// ── 보유 종목 (별도 탭) ────────────────────────────────
//
// ⚠️ 라우트 등록 순서: `/stock/holdings...` 는 `/stock/:market` 보다 **먼저** 와야 한다.
//    Express 는 먼저 등록된 것을 쓰므로 뒤에 두면 "holdings" 가 :market 으로 잡혀
//    "시장은 kr 또는 us" 400 이 난다. (파일 상단 /stock/search 와 같은 함정이다.)
//    → 이 블록은 반드시 `api.get("/stock/:market")` 위쪽에 등록되어야 하는데, 현재 이 파일은
//    선언 순서가 곧 등록 순서라 아래 registerHoldingRoutes() 를 상단에서 호출한다.

/** 보유 종목 + 현재가·손익. 시세 조회를 하므로 다른 목록 API 보다 느리다(수백 ms~수 초). */
api.get("/stock/holdings", async (req, res) => {
  const market = req.query.market ? parseMarket(String(req.query.market)) : undefined;
  if (req.query.market && !market)
    return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  try {
    res.json(await summarizeHoldings(market ?? undefined));
  } catch (e) {
    res.status(500).json({ error: `보유 종목 조회 실패: ${(e as Error).message}` });
  }
});

/** 시세 없이 원장만(입력 폼 초기값·순서 변경용). 빠르다. */
api.get("/stock/holdings/raw", (req, res) => {
  const market = req.query.market ? parseMarket(String(req.query.market)) : undefined;
  if (req.query.market && !market)
    return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  res.json(listHoldings(market ?? undefined));
});

/**
 * 보유 종목 추가. body: { market, query, quantity, avgPrice, targetPrice?, stopPrice?, horizon?, memo? }
 *
 * 등록 종목(stocks)에도 자동으로 들어간다(holdings.ts mirrorToTickers) — 인터뷰에서 확정한
 * 정책이다. 그래서 이 API 하나로 "보유 등록 + 일일 브리핑 대상 편입"이 함께 끝난다.
 */
api.post("/stock/holdings", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const market = parseMarket(String(b.market ?? ""));
  if (!market) return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  try {
    const holding = await createHolding({
      market,
      query: String(b.query ?? ""),
      quantity: Number(b.quantity),
      avgPrice: Number(b.avgPrice),
      targetPrice: b.targetPrice as number | null | undefined,
      stopPrice: b.stopPrice as number | null | undefined,
      horizon: b.horizon as never,
      memo: typeof b.memo === "string" ? b.memo : undefined,
    });
    res.status(201).json(holding);
  } catch (e) {
    const msg = (e as Error).message;
    // 중복 등록은 409, 나머지 입력 오류는 400. 사용자 입력 문제라 500 이 아니다.
    res.status(/이미 보유/.test(msg) ? 409 : 400).json({ error: msg });
  }
});

/** 보유 종목 수정. market/symbol 은 못 바꾼다(= 다른 종목이라는 뜻). */
api.patch("/stock/holdings/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!getHolding(id)) return res.status(404).json({ error: "보유 종목 없음" });
  const b = (req.body ?? {}) as Record<string, unknown>;
  const patch: Parameters<typeof updateHolding>[1] = {};
  // `undefined`(미지정)와 `null`(해제)의 구분을 여기서 잃으면 목표가를 지울 수 없게 된다.
  if (b.quantity !== undefined) patch.quantity = Number(b.quantity);
  if (b.avgPrice !== undefined) patch.avgPrice = Number(b.avgPrice);
  if (b.targetPrice !== undefined) patch.targetPrice = b.targetPrice as number | null;
  if (b.stopPrice !== undefined) patch.stopPrice = b.stopPrice as number | null;
  if (b.horizon !== undefined) patch.horizon = b.horizon as never;
  if (b.memo !== undefined) patch.memo = String(b.memo);
  try {
    res.json(updateHolding(id, patch));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * 보유 종목 삭제(soft). confirm 에 정확한 심볼이 필요하다 — 종목 삭제와 같은 규칙이다.
 * 등록 종목(stocks)은 **그대로 둔다**: 다 팔았어도 계속 지켜보고 싶을 수 있고,
 * 여기서 함께 지우면 그 종목의 시계열이 끊긴다.
 */
api.delete("/stock/holdings/:id", (req, res) => {
  const id = Number(req.params.id);
  const h = getHolding(id);
  if (!h) return res.status(404).json({ error: "보유 종목 없음" });
  if (req.query.confirm !== h.symbol) {
    return res
      .status(400)
      .json({ error: "삭제는 confirm 파라미터에 정확한 종목 심볼이 필요합니다." });
  }
  deleteHolding(id);
  res.json({ ok: true, keptTicker: true });
});

/** 표시 순서 변경. body: { market, ids } */
api.put("/stock/holdings/order", (req, res) => {
  const b = (req.body ?? {}) as { market?: unknown; ids?: unknown };
  const market = parseMarket(String(b.market ?? ""));
  if (!market) return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  try {
    res.json(reorderHoldings(market, (b.ids as number[]) ?? []));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ── 펄스(시간당 실시간 취합) ──────────────────────────

/**
 * 펄스 상태 — 마지막 실행 결과 + 최근 24시간 판정 목록.
 *
 * 화면에 피드를 만들지 않기로 했지만(인터뷰 결정) **상태 확인 창구는 필요하다.**
 * 이게 없으면 "펄스가 도는지, 왜 문자가 안 오는지"를 로그 파일로만 알 수 있다.
 */
api.get("/stock/pulse/status", (_req, res) => {
  res.json({
    running: isPulseRunning(),
    lastRun: getLastPulseRun(),
    notifyEnabled: isPulseNotifyEnabled(),
    schedule: getSchedule().stockPulse,
    recent: allRecentPulseAlerts(24).map((r) => ({
      id: r.id,
      at: r.createdAt,
      slot: r.slot,
      status: r.status,
      severity: r.impact.severity,
      direction: r.impact.direction,
      symbol: r.impact.symbol,
      name: r.impact.name,
      headline: r.impact.headline,
    })),
  });
});

/**
 * 펄스 지금 실행. 백오프를 무시한다(사용자가 직접 누른 것이므로).
 * 실행이 수 분 걸리므로 202 로 먼저 응답하고 백그라운드에서 돌린다(증시 수동 갱신과 같은 패턴).
 *
 * ★ 다른 수동 갱신과 달리 **전역 LLM 슬롯을 타지 않는다.** 스케줄러가 펄스를 슬롯 대상에서
 *   뺀 것과 같은 이유다(scheduler.ts 세마포어 주석): 매시간 도는 10분짜리라, 앞선 20분 작업에
 *   막히면 그 슬롯이 통째로 죽는다. 직렬화가 오히려 해롭다.
 */
api.post("/stock/pulse/run", (req, res) => {
  if (isPulseRunning()) {
    return res.status(409).json({ error: "펄스가 이미 실행 중입니다.", running: true });
  }
  const notify = req.body?.notify !== false;
  const slot = new Date().toTimeString().slice(0, 5);
  void runPulse({ slot, trigger: "manual", notify, force: true }).catch((e) =>
    log.warn(`펄스 수동 실행 예외: ${(e as Error).message}`)
  );
  res.status(202).json({ started: true });
});

/**
 * 최신 증시 브리핑 스냅샷 (아직 수집 전이면 null).
 *
 * 미국장은 슬롯마다 성격이 다른 스냅샷이 최대 3개 공존한다(마감결산/개장프리뷰/혼합).
 * 응답 shape 을 깨지 않기 위해 **본문은 여전히 '가장 최신' 스냅샷 하나**이고,
 * 역할별 스냅샷은 `variants` 필드로 **덧붙인다**(기존 프론트는 이 필드를 무시하면 그만이다).
 * `?role=close|preview|both` 로 단건 조회도 가능하다.
 */
api.get("/stock/:market", (req, res) => {
  const market = parseMarket(req.params.market);
  if (!market) return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  const q = req.query.role;
  if (q === "close" || q === "preview" || q === "both") return res.json(getStockSnapshot(market, q));
  const latest = getStockSnapshot(market);
  if (!latest) return res.json(null);
  res.json({
    ...latest,
    variants: {
      close: getStockSnapshot(market, "close"),
      preview: getStockSnapshot(market, "preview"),
      both: getStockSnapshot(market, "both"),
    },
  });
});

/** 증시 수집 진행 상태(프론트 폴링용). */
api.get("/stock/:market/status", (req, res) => {
  const market = parseMarket(req.params.market);
  if (!market) return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  const snap = getStockSnapshot(market);
  res.json({ collecting: isStockCollecting(market), updatedAt: snap?.updatedAt ?? null });
});

/**
 * 지금 갱신 (수동). LLM 브리핑이라 수 분 걸리므로 **백그라운드로 시작**하고 즉시 202를 반환한다.
 * 프론트는 /stock/:market/status 를 폴링해 '수집 중'을 표시하고, 완료되면 /stock/:market 을 다시 불러온다.
 * 이미 수집 중이면 새로 시작하지 않고 409로 안내(중복 수집 방지).
 */
api.post("/stock/:market/refresh", async (req, res) => {
  const market = parseMarket(req.params.market);
  if (!market) return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  if (isStockCollecting(market)) {
    return res.status(409).json({ error: "이미 증시 수집이 진행 중입니다.", collecting: true });
  }
  // slot 미지정 → refreshStock 이 런 시작 시각 기준 '가장 최근 지난 슬롯'에 귀속시킨다.
  // 그 슬롯이 이미 발송됐으면 조용히 스킵, 미발송이면 여기서 보충 발송된다.
  // 오늘 지난 슬롯이 아직 없으면(첫 슬롯 이전) 알림 없이 화면만 갱신한다 — 보내면 곧 오는
  // 첫 정시 슬롯이 같은 브리핑을 한 번 더 보낸다. '지난 슬롯만 후보'라 미래 슬롯 선점도 없다.
  //
  // ⚠️ 슬롯을 얻은 뒤에야 refreshStock 이 시작되므로 '런 시작 시각'은 큐를 통과한 시점이다.
  //    거기서 슬롯(브리핑 회차)을 정하는 것이 맞다 — 버튼을 누른 시각이 아니라 실제로 데이터를
  //    모은 시각이 그 브리핑의 기준이기 때문이다.
  const started = await startManualLlmJob(market === "kr" ? "국내 증시" : "미국 증시", () =>
    refreshStock({ market, trigger: "manual", notify: true })
  );
  if (!started) return res.status(409).json(llmBusyBody());
  res.status(202).json({ started: true, collecting: true });
});

/** 시장별 관심 종목 목록(표시 순서). */
api.get("/stock/:market/tickers", (req, res) => {
  const market = parseMarket(req.params.market);
  if (!market) return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  res.json(listStocks(market));
});

/**
 * 관심 종목 추가. body: { query, pinned? } — 종목코드·티커·종목명 아무거나 받는다.
 *
 * ⚠️ 사용자 입력을 quoteCode 로 그대로 쓰면 안 된다. 반드시 자동완성이 돌려준 quoteCode(reutersCode)를 쓴다.
 *    틀린 quoteCode 는 원장에 멀쩡히 등록된 것처럼 보이면서 시세 조회만 통째로 실패해 발견이 늦다.
 *
 * 등록 직후 카드가 비지 않도록 시세를 1차로 채우되(prime), **refreshStock 은 부르지 않는다** —
 * LLM 브리핑이라 수 분 걸려 요청이 타임아웃난다. fetchHistory + upsertStockPoints 만 한다.
 * prime 실패는 201 을 막지 않는다(다음 정시 수집이 채운다).
 */
api.post("/stock/:market/tickers", async (req, res) => {
  const market = parseMarket(req.params.market);
  if (!market) return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  // 수집 중 종목 변경은 진행 중인 브리핑이 쓰는 목록과 어긋나 결과가 뒤섞인다 → 거부.
  if (isStockCollecting(market)) {
    return res
      .status(409)
      .json({ error: "수집이 진행 중입니다. 완료된 뒤 종목을 추가해 주세요.", collecting: true });
  }
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) return res.status(400).json({ error: "종목명 또는 종목코드(query)가 필요합니다." });

  let candidates;
  try {
    candidates = await searchTicker(query);
  } catch (e) {
    return res.status(502).json({ error: `종목 검색에 실패했습니다: ${(e as Error).message}` });
  }
  const hit = candidates.find((c) => c.market === market);
  if (!hit) return res.status(404).json({ error: `종목을 찾지 못했습니다: ${query}` });

  let ticker;
  try {
    ticker = createStock({ ...hit, pinned: req.body?.pinned === true });
  } catch {
    return res.status(409).json({ error: "이미 등록된 종목입니다." });
  }

  try {
    const points = await fetchHistory(hit.quoteCode, market, HISTORY_DAYS);
    if (points.length) upsertStockPoints(ticker.id, points, "naver");
  } catch (e) {
    log.warn(`신규 종목 시세 1차 조회 실패 [${ticker.name}]: ${(e as Error).message}`);
  }
  res.status(201).json(ticker);
});

/**
 * 종목 수정 (표시명/고정 여부). symbol·quoteCode 는 못 바꾼다 — 그건 다른 종목이라는 뜻이고,
 * 바꾸면 기존 시계열에 엉뚱한 종가가 이어 붙는다(repo.updateStock 주석 참고).
 */
api.patch("/stock/tickers/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!getStock(id)) return res.status(404).json({ error: "종목 없음" });
  const body = (req.body ?? {}) as { name?: unknown; pinned?: unknown };
  const patch: { name?: string; pinned?: boolean } = {};
  if (body.name != null) {
    const name = String(body.name).trim();
    if (!name) return res.status(400).json({ error: "종목명은 비울 수 없습니다." });
    patch.name = name;
  }
  if (body.pinned != null) patch.pinned = body.pinned === true;
  const updated = updateStock(id, patch);
  if (!updated) return res.status(404).json({ error: "종목 없음" });
  res.json(updated);
});

/**
 * 시장 내 표시 순서 변경. 해당 시장의 활성 종목 id 전부를 원하는 순서로 { ids: number[] } 로 전달.
 * PUT /products/order · PUT /news|youtube/categories/order 와 동일한 계약.
 * 라우트 등록 순서: POST /stock/:market/tickers 와 메서드·세그먼트가 달라 충돌하지 않는다.
 */
api.put("/stock/:market/tickers/order", (req, res) => {
  const market = parseMarket(req.params.market);
  if (!market) return res.status(400).json({ error: "시장은 kr 또는 us 여야 합니다." });
  try {
    res.json(reorderStocks(market, (req.body?.ids ?? []) as number[]));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * 종목 삭제(soft delete — 시계열은 남는다). 오삭제 방지를 위해 confirm 파라미터에
 * 정확한 심볼이 일치해야 한다. DELETE /products/:id 와 동일한 계약.
 */
api.delete("/stock/tickers/:id", (req, res) => {
  const id = Number(req.params.id);
  const stock = getStock(id);
  if (!stock) return res.status(404).json({ error: "종목 없음" });
  // 추가와 같은 이유로 수집 중에는 목록을 건드리지 않는다.
  if (isStockCollecting(stock.market)) {
    return res
      .status(409)
      .json({ error: "수집이 진행 중입니다. 완료된 뒤 종목을 삭제해 주세요.", collecting: true });
  }
  if (req.query.confirm !== stock.symbol) {
    return res.status(400).json({ error: "삭제는 confirm 파라미터에 정확한 종목 심볼이 필요합니다." });
  }
  deleteStock(id);
  res.json({ ok: true });
});

/** 종목 시계열(차트용). days 는 달력일이 아니라 **거래일 행 수**다. 오름차순. */
api.get("/stock/tickers/:id/history", (req, res) => {
  const id = Number(req.params.id);
  if (!getStock(id)) return res.status(404).json({ error: "종목 없음" });
  const days = Number(req.query.days) || HISTORY_DAYS;
  res.json(getStockPoints(id, days));
});

// ── 로또 ──
//
// 라우트가 조회 하나뿐인 이유: 2026-07-30 부터 로또 탭은 **매주 일요일 10:00 cron** 으로만
// 움직인다(수집 → 지난주 추천 번호 채점 → 전략 갱신 → 다음 회차 번호 확정). 화면에서 누를
// 것이 없어 시작·정지·동기화·초기화·반복 라우트를 전부 없앴다.

/** 전체 스냅샷 — 다음 회차 추천 번호 + 지난 10회차 비교 결과. */
api.get("/lotto", (_req, res) => {
  try {
    res.json(getLottoSnapshot());
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * 주간 사이클 수동 실행 — **운영/검증용**이며 화면에 버튼이 없다.
 *
 * cron 을 기다리지 않고 배포 직후 상태를 확인하거나, 사이클이 실패한 뒤 원인을 고치고 즉시
 * 되돌리기 위한 문이다. 사이클 자체가 멱등에 가깝게 설계돼 있어(이미 채점한 회차는 다시
 * 채점하지 않고, 이미 못박은 번호는 덮어쓰지 않는다) 여러 번 눌러도 기록이 망가지지 않는다.
 *
 * ⚠️ 응답을 기다리지 않는다 — 에이전트 호출이 최대 10분이라 await 하면 요청이 끊긴다.
 *    다만 **전역 LLM 슬롯은 탄다**(파일 상단 '수동 지금 갱신' 주석). 이 경로는 화면 버튼이
 *    없어 사람이 직접 부르는 일이 드물지만, 그렇다고 정시 수집과 겹쳐도 되는 건 아니다.
 */
api.post("/lotto/cycle", async (_req, res) => {
  if (isLottoCycleRunning()) {
    return res.status(409).json({ error: "주간 사이클이 이미 진행 중입니다." });
  }
  const started = await startManualLlmJob("로또 사이클", () => runLottoWeeklyCycle("manual"));
  if (!started) return res.status(409).json(llmBusyBody());
  res.json({ ok: true });
});
