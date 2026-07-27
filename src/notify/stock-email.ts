import nodemailer from "nodemailer";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { renderLineChartPng } from "./chart.ts";
import { sendIMessage, isIMessageConfigured } from "./imessage.ts";
import { escapeHtml, escapeAttr, safeHref } from "./html.ts";
import { listStocks } from "../stock/tickers.ts";
import {
  changeTone,
  effectiveRole,
  formatPrice,
  marketLabel,
  roleLabel,
  partitionWatchlist,
  watchMarket,
  foreignSectionTitle,
} from "../../shared/stock.ts";
import { formatPnlPct, horizonLabel } from "../../shared/holdings.ts";
import type {
  StockAnalysis,
  StockIndex,
  StockMarket,
  StockNewsItem,
  StockPositionReview,
  StockSnapshot,
  StockWatchItem,
} from "../../shared/types.ts";

/**
 * 증시 브리핑 이메일 + iMessage.
 *
 * ⚠️ 등락 색은 **한국 증시 관례**를 따른다: 상승=빨강, 하락=파랑.
 * 같은 디렉터리의 email.ts(쇼핑 리포트)는 "하락=초록(GREEN)"이라 규칙이 정반대다.
 * 가격이 내리면 좋은 쇼핑과 달리 증시는 방향 자체가 정보라서, 두 색 규칙을 절대 섞으면 안 된다.
 */
const UP = "#e74c3c"; // 상승
const DOWN = "#2563eb"; // 하락
const FLAT = "#888888"; // 보합·값 없음

/** iMessage 본문 상한. 초과분은 알림 미리보기에서 어차피 잘리므로 보내기 전에 자른다. */
const IMESSAGE_MAX = 500;

function toneColor(pct: number | null): string {
  const t = changeTone(pct);
  return t === "up" ? UP : t === "down" ? DOWN : FLAT;
}

/** 등락률 텍스트. changeTone 이 null·0·비유한수를 모두 flat 으로 모아주므로 여기선 화살표만 고른다. */
function pctText(pct: number | null): string {
  const t = changeTone(pct);
  if (t === "flat") return "-";
  return `${t === "up" ? "▲" : "▼"}${Math.abs(pct as number).toFixed(1)}%`;
}

function pctBadge(pct: number | null): string {
  return `<span style="color:${toneColor(pct)};font-weight:600">${pctText(pct)}</span>`;
}

/** 지수는 통화가 아니라 포인트다 — formatPrice(원/$ 붙음) 대신 소수 2자리 고정. */
function indexValue(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return v.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function flagOf(m: StockMarket): string {
  return m === "kr" ? "🇰🇷" : "🇺🇸";
}
/**
 * 브리핑 제목. 역할이 붙으면 "미국증시 마감결산"/"미국증시 개장프리뷰" 로 갈린다.
 *
 * ⚠️ role='both'·한국장은 **현행 문자열을 1바이트도 바꾸지 않는다.** 사용자의 기존 메일
 * 필터·검색이 깨지지 않아야 하고, 기존 테스트도 이 보증에 물려 있다.
 */
function titleOf(s: StockSnapshot): string {
  const base = s.market === "kr" ? "국내증시" : "미국증시";
  const label = roleLabel(effectiveRole(s));
  return `${base} ${label ?? "브리핑"}`;
}

/**
 * 이메일 제목.
 *
 * ⚠️ 역할별 분기는 **필수다.** 예전에는 두 슬롯의 제목이 `🇺🇸 미국증시 브리핑 - 2026-07-20` 으로
 * **바이트 단위로 동일**했다(s.date 가 KST 수집일이라 같은 날 두 런이 같은 값). From/To 까지
 * 같아서 Gmail 이 두 통을 한 스레드로 병합했고, 두 번째 메일이 접혀 사실상 보이지 않았다.
 *
 * 날짜만 갈라서도 안 된다 — 07-17 과 07-20 중 무엇이 결산인지 사용자가 외워야 한다.
 * 역할 토큰 + 역할별로 의미 있는 날짜를 함께 쓴다.
 */
export function subjectOf(s: StockSnapshot): string {
  const role = effectiveRole(s);
  const head = `${flagOf(s.market)} ${titleOf(s)}`;
  if (role === "close") return `${head} - ${s.sessionDate ?? s.date}(뉴욕)`;
  if (role === "preview") return `${head} - ${s.sessionDate ?? s.date}(뉴욕) 밤`;
  return `${head} - ${s.date}`;
}

/** CID 는 종목 단위로 유일해야 한다 — 한·미에 같은 심볼이 공존할 수 있어 market 을 함께 넣는다. */
function chartCid(market: StockMarket, symbol: string): string {
  return `chart_${market}_${symbol}@dailystock`;
}

// ── 섹션 렌더러 ────────────────────────────────────────────────

function newsSection(items: StockNewsItem[]): string {
  if (!items.length)
    return `<p style="color:#999;padding:12px;background:#f8f9fa;border-radius:8px">최근 24시간 내 수집된 뉴스가 없습니다.</p>`;

  // bucket 그룹. 등장 순서를 유지해야 LLM 이 매긴 중요도 순서가 보존된다(Map 은 삽입 순서 보장).
  const buckets = new Map<string, StockNewsItem[]>();
  for (const it of items) {
    const key = it.bucket || "기타";
    const arr = buckets.get(key);
    if (arr) arr.push(it);
    else buckets.set(key, [it]);
  }

  return [...buckets.entries()]
    .map(([bucket, list]) => {
      const cards = list
        .map((it) => {
          const href = safeHref(it.link);
          const link = href
            ? `<p style="margin:6px 0 0"><a href="${escapeAttr(href)}" style="color:#4361ee;text-decoration:none;font-size:13px">🔗 원문 보기</a></p>`
            : "";
          return `<div style="margin-bottom:10px;padding:12px 14px;background:#f8f9fa;border-radius:8px;border-left:4px solid #4361ee">
      <h4 style="margin:0 0 4px;font-size:14px;color:#1a1a2e">${escapeHtml(it.title)}</h4>
      <p style="margin:0 0 4px;color:#888;font-size:12px">${escapeHtml(it.source)}${it.date ? ` · 📅 ${escapeHtml(it.date)}` : ""}</p>
      ${it.summary ? `<p style="margin:0;color:#444;font-size:13px;line-height:1.6">${escapeHtml(it.summary)}</p>` : ""}
      ${link}
    </div>`;
        })
        .join("");
      return `<h3 style="margin:16px 0 8px;font-size:15px;color:#1a1a2e">📌 ${escapeHtml(bucket)}</h3>${cards}`;
    })
    .join("");
}

function indexCard(i: StockIndex): string {
  // rationale 이 없으면 outlook 을 감춘다 — 근거 없는 전망은 노출하지 않는다는 규칙(types.ts StockIndex 주석).
  const outlook =
    i.outlook && i.rationale
      ? `<p style="margin:6px 0 0;color:#444;font-size:13px"><b>전망</b> ${escapeHtml(i.outlook)}</p>
       <p style="margin:4px 0 0;color:#666;font-size:12px"><b>전망 사유</b> ${escapeHtml(i.rationale)}</p>`
      : "";
  return `<div style="margin-bottom:10px;padding:12px 14px;background:#f8f9fa;border-radius:8px;border-left:4px solid ${toneColor(i.changePct)}">
    <h3 style="margin:0 0 4px;font-size:15px;color:#1a1a2e">${escapeHtml(i.name)}
      <span style="font-weight:600">${indexValue(i.value)}</span> ${pctBadge(i.changePct)}</h3>
    ${i.comment ? `<p style="margin:0;color:#444;font-size:13px;line-height:1.6">${escapeHtml(i.comment)}</p>` : ""}
    ${outlook}
  </div>`;
}

/** 종목 카드. chartCid 가 있으면 그 종목만 인라인 차트를 붙인다(첨부 생성에 성공한 종목). */
function analysisCard(a: StockAnalysis, cid: string | null): string {
  const img = cid
    ? `<div style="margin:10px 0"><img src="cid:${escapeAttr(cid)}" alt="${escapeAttr(a.name)} 최근 20거래일" width="540" style="max-width:100%;border:1px solid #f0f0f0;border-radius:8px"/></div>`
    : "";
  const ma =
    a.ma5 != null || a.ma20 != null
      ? `<tr><td style="padding:2px 12px 2px 0;color:#666">이동평균</td><td>5일 ${formatPrice(a.ma5, a.currency)} · 20일 ${formatPrice(a.ma20, a.currency)}</td></tr>`
      : "";
  const unverified = a.verified
    ? ""
    : ` <span style="background:#fff3cd;color:#8a6d3b;border-radius:4px;padding:1px 6px;font-size:11px">시세 미검증</span>`;

  return `<div style="border:1px solid #eee;border-radius:10px;padding:16px;margin:12px 0">
    <h3 style="margin:0 0 8px;font-size:16px">${escapeHtml(a.verdict)} ${escapeHtml(a.name)}
      <span style="color:#888;font-size:13px">${escapeHtml(a.symbol)}</span>${unverified}</h3>
    <table style="border-collapse:collapse;font-size:14px">
      <tr><td style="padding:2px 12px 2px 0;color:#666">종가</td><td><b>${formatPrice(a.close, a.currency)}</b> ${pctBadge(a.changePct)}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666">5거래일</td><td>${pctBadge(a.weekChangePct)}</td></tr>
      ${ma}
    </table>
    ${img}
    ${a.summary ? `<p style="margin:8px 0 0;color:#444;font-size:13px;line-height:1.6"><b>요약</b> ${escapeHtml(a.summary)}</p>` : ""}
    ${a.outlook ? `<p style="margin:6px 0 0;color:#444;font-size:13px"><b>전망</b> ${escapeHtml(a.outlook)}</p>` : ""}
    ${a.rationale ? `<p style="margin:4px 0 0;color:#666;font-size:12px"><b>전망 사유</b> ${escapeHtml(a.rationale)}</p>` : ""}
    ${a.risks ? `<p style="margin:4px 0 0;color:#666;font-size:12px"><b>리스크</b> ${escapeHtml(a.risks)}</p>` : ""}
  </div>`;
}

/**
 * 관심 종목 카드. marketNote 가 있으면 '해외 참고' 항목이라 배경·보더를 앰버가 아닌
 * 슬레이트-블루로 바꾸고 시장 칩을 붙여 **한눈에 다른 묶음임을 보이게** 한다.
 * 통화 표기는 항목의 currency 만 보므로(shared/stock.ts formatPrice) 별도 분기가 필요 없다 —
 * 해외 항목엔 verifyWatchlist 가 실제 시장의 통화를 붙여 두었다.
 */
function watchCard(w: StockWatchItem, marketNote?: string): string {
  const bg = marketNote ? "#f5f7fb" : "#fffdf5";
  const bar = marketNote ? "#5b7cfa" : "#f0ad4e";
  const chip = marketNote
    ? ` <span style="background:#e8edf7;color:#3f5185;border-radius:4px;padding:1px 6px;font-size:11px">${escapeHtml(marketNote)}</span>`
    : "";
  return `<div style="margin-bottom:10px;padding:12px 14px;background:${bg};border-radius:8px;border-left:4px solid ${bar}">
    <h3 style="margin:0 0 4px;font-size:15px;color:#1a1a2e">${escapeHtml(w.attention)} ${escapeHtml(w.name)}
      <span style="color:#888;font-size:13px">${escapeHtml(w.symbol)}</span>${chip}
      <span style="font-weight:600">${formatPrice(w.close, w.currency)}</span> ${pctBadge(w.changePct)}</h3>
    ${w.summary ? `<p style="margin:0;color:#444;font-size:13px;line-height:1.6">${escapeHtml(w.summary)}</p>` : ""}
    ${w.levels ? `<p style="margin:4px 0 0;color:#666;font-size:12px"><b>주목 가격대</b> ${escapeHtml(w.levels)}</p>` : ""}
    ${w.rationale ? `<p style="margin:4px 0 0;color:#666;font-size:12px"><b>거론 사유</b> ${escapeHtml(w.rationale)}</p>` : ""}
    ${w.risks ? `<p style="margin:4px 0 0;color:#666;font-size:12px"><b>리스크</b> ${escapeHtml(w.risks)}</p>` : ""}
  </div>`;
}

function summaryTable(s: StockSnapshot): string {
  // 근거 없는 전망은 표에서도 감춘다 — 카드(indexCard)만 막고 표를 열어두면
  // 같은 전망이 '핵심 근거 -' 상태로 표에 그대로 실린다.
  const row = (label: string, tone: number | null, outlook: string | null, rationale: string | null) =>
    `<tr>
      <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px">${label} ${pctBadge(tone)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px;color:#444">${outlook && rationale ? escapeHtml(outlook) : "-"}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;color:#666">${rationale ? escapeHtml(rationale) : "-"}</td>
    </tr>`;

  // 표에는 시장 컬럼이 없다. 해외 참고 항목을 관심 종목과 같은 💡 로 찍으면 카드에서 애써
  // 분리한 게 표에서 다시 섞인다 → 프리픽스를 🌐 로 나누고 라벨에 시장명을 박는다.
  const { domestic, foreign } = partitionWatchlist(s);
  const rows = [
    ...s.indices.map((i) => row(`📊 ${escapeHtml(i.name)}`, i.changePct, i.outlook, i.rationale)),
    ...s.analyses.map((a) => row(`📈 ${escapeHtml(a.name)}`, a.changePct, a.outlook, a.rationale)),
    ...domestic.map((w) => row(`💡 ${escapeHtml(w.name)}`, w.changePct, w.outlook, w.rationale)),
    ...foreign.map((w) =>
      row(
        `🌐 ${escapeHtml(w.name)}(${escapeHtml(marketLabel(watchMarket(w, s.market)))})`,
        w.changePct,
        w.outlook,
        w.rationale
      )
    ),
  ].join("");

  if (!rows) return `<p style="color:#999">표에 담을 항목이 없습니다.</p>`;
  return `<table style="border-collapse:collapse;width:100%;margin-top:8px">
    <tr style="background:#f8f9fa">
      <th style="padding:8px;text-align:left;font-size:13px;color:#666">지수/종목</th>
      <th style="padding:8px;text-align:left;font-size:13px;color:#666">전망</th>
      <th style="padding:8px;text-align:left;font-size:13px;color:#666">핵심 근거</th>
    </tr>
    ${rows}
  </table>`;
}

/**
 * 헤더 서브라인의 거래일 병기.
 *
 * ⚠️ close/preview 는 `sessionDate !== date` 조건부 로직을 쓰면 안 된다. 프리뷰의 sessionDate
 * 는 '오늘 밤 뉴욕 세션'이라 KST 수집일과 **같아지는 날이 대부분**이고, 그러면 대상 세션 표기가
 * 조용히 사라진다. 역할이 있으면 항상 표시하고, 문구로 두 브리핑을 구분한다.
 */
function sessionLineOf(s: StockSnapshot): string {
  const role = effectiveRole(s);
  if (role === "close" && s.sessionDate) return ` · 간밤 뉴욕장(${escapeHtml(s.sessionDate)}) 마감 결산`;
  if (role === "preview" && s.sessionDate)
    return ` · 오늘 밤(${escapeHtml(s.sessionDate)}) 뉴욕장 개장 프리뷰`;
  // both·한국장은 현행 조건부 로직 유지.
  return s.sessionDate && s.sessionDate !== s.date ? ` · 거래일 ${escapeHtml(s.sessionDate)}` : "";
}

function shellHtml(s: StockSnapshot, body: string): string {
  const session = sessionLineOf(s);
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;max-width:680px;margin:0 auto;padding:16px">
    <h1 style="color:#1a1a2e;border-bottom:3px solid #1a1a2e;padding-bottom:8px">${flagOf(s.market)} ${titleOf(s)}</h1>
    <p style="color:#666;font-size:13px">${escapeHtml(s.date)}${session} · 대시보드: <a href="http://localhost:${config.port}">localhost:${config.port}</a></p>
    ${body}
    <hr style="margin-top:32px;border:none;border-top:1px solid #eee">
    <p style="color:#999;font-size:11px;line-height:1.6">${escapeHtml(s.disclaimer)}</p>
    <p style="color:#aaa;font-size:11px;text-align:center">Daily Dashboard · 로컬 자동 수집</p>
  </div>`;
}

/**
 * 브리핑 이메일 HTML(순수 함수).
 *
 * @param chartSymbols 인라인 차트를 붙일 종목 심볼 집합. **첨부 생성에 성공한 종목만** 넣는다 —
 *   PNG 없이 img[cid] 를 먼저 박아두면 실패한 종목 자리에 깨진 이미지가 남는다.
 *   기본값(미지정)은 차트 없음이라 DB·캔버스 없이 이 함수만 테스트할 수 있다.
 */
export function buildStockEmailHtml(s: StockSnapshot, chartSymbols?: ReadonlySet<string>): string {
  // 휴장이면 오케스트레이터가 호출을 막지만, 방어적으로 짧은 안내만 렌더한다.
  if (s.closed) {
    const reason = s.closedReason ? ` (${escapeHtml(s.closedReason)})` : "";
    return shellHtml(
      s,
      `<p style="margin:24px 0;padding:16px;background:#f8f9fa;border-radius:8px;color:#444">😴 휴장일${reason}입니다. 오늘은 브리핑이 없습니다.</p>`
    );
  }

  const charts = chartSymbols ?? new Set<string>();
  const analyses = s.analyses.length
    ? s.analyses
        .map((a) => analysisCard(a, charts.has(a.symbol) ? chartCid(s.market, a.symbol) : null))
        .join("")
    : `<p style="color:#999">등록된 종목이 없습니다.</p>`;
  const indices = s.indices.length
    ? s.indices.map(indexCard).join("")
    : `<p style="color:#999">지수 데이터를 가져오지 못했습니다.</p>`;
  const { domestic, foreign } = partitionWatchlist(s);
  const watchlist = domestic.length
    ? domestic.map((w) => watchCard(w)).join("")
    : `<p style="color:#999">오늘 추려진 관심 종목이 없습니다.</p>`;
  // 해외 참고는 **평소 0건이 정상**이다. 관심 종목처럼 플레이스홀더 문구를 두면
  // 매일 '해외 참고 없음'이 뜨는 노이즈가 되므로 비면 섹션 자체를 렌더하지 않는다(웹과 동일).
  const foreignSection = foreign.length
    ? `
    <h2 style="color:#5b7cfa;margin-top:32px;border-bottom:2px solid #eee;padding-bottom:6px">${escapeHtml(
      foreignSectionTitle(s.market)
    )}</h2>
    <p style="color:#666;font-size:12px;margin:0 0 10px">${escapeHtml(
      marketLabel(s.market)
    )}에 상장되지 않은 종목입니다. 오늘 이 장에서 직접 거래되지 않으며, 시세·통화는 해당 종목의 상장 시장 기준입니다.</p>
    ${foreign
      .map((w) => watchCard(w, marketLabel(watchMarket(w, s.market))))
      .join("")}`
    : "";

  const body = `
    ${positionSection(s)}
    <h2 style="color:#4361ee;margin-top:28px;border-bottom:2px solid #eee;padding-bottom:6px">🌍 24시간 뉴스 브리핑</h2>
    ${newsSection(s.news)}

    <h2 style="color:#1a1a2e;margin-top:32px;border-bottom:2px solid #eee;padding-bottom:6px">📊 지수 분석 &amp; 전망</h2>
    ${indices}

    <h2 style="color:#1a1a2e;margin-top:32px;border-bottom:2px solid #eee;padding-bottom:6px">📈 등록 종목 분석 &amp; 전망</h2>
    ${analyses}

    <h2 style="color:#f0ad4e;margin-top:32px;border-bottom:2px solid #eee;padding-bottom:6px">💡 오늘의 관심 종목</h2>
    ${watchlist}
    <p style="color:#8a6d3b;font-size:12px;background:#fff3cd;border-radius:6px;padding:8px 10px;margin-top:8px">관심 종목은 시장에서 거론되는 사실을 정리한 것으로 매수 추천이 아닙니다.</p>
${foreignSection}

    <h2 style="color:#1a1a2e;margin-top:32px;border-bottom:2px solid #eee;padding-bottom:6px">📋 종합 테이블</h2>
    ${summaryTable(s)}
    ${s.notes ? `<p style="color:#888;font-size:12px;margin-top:12px">📝 ${escapeHtml(s.notes)}</p>` : ""}`;

  return shellHtml(s, body);
}

/**
 * 내 포지션 점검 카드 1건.
 *
 * 목표가·손절가는 **거리(%)로만** 표시한다. 도달 알림은 인터뷰에서 트리거로 선택되지
 * 않았으므로 여기서 "도달!" 같은 행동 신호를 만들면 사용자가 요청하지 않은 알림이 된다.
 */
function positionCard(p: StockPositionReview): string {
  const tone = toneColor(p.pnlPct);
  const dist = (label: string, price: number | null, pct: number | null): string =>
    price == null
      ? ""
      : `<span style="color:#666;margin-right:10px">${label} ${escapeHtml(
          formatPrice(price, p.currency)
        )} <span style="color:#888">(${escapeHtml(formatPnlPct(pct))})</span></span>`;

  return `
  <div style="border:1px solid #e5e7eb;border-left:4px solid ${tone};border-radius:8px;padding:12px 14px;margin:10px 0;background:#fff">
    <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
      <strong style="font-size:15px">${escapeHtml(p.name)} <span style="color:#888;font-weight:400;font-size:12px">${escapeHtml(
        p.symbol
      )} · ${escapeHtml(horizonLabel(p.horizon))}</span></strong>
      <span style="color:${tone};font-weight:700;font-size:15px">${escapeHtml(formatPnlPct(p.pnlPct))}</span>
    </div>
    <div style="color:#444;font-size:13px;margin-top:6px">
      현재가 <strong>${escapeHtml(formatPrice(p.close, p.currency))}</strong>
      <span style="color:#888">· 평단 ${escapeHtml(formatPrice(p.avgPrice, p.currency))} · ${escapeHtml(
        String(p.quantity)
      )}주</span>
      ${pctBadge(p.changePct)}
    </div>
    <div style="font-size:12px;margin-top:6px">
      ${dist("🎯 목표", p.targetPrice, p.toTargetPct)}${dist("🛡 손절", p.stopPrice, p.toStopPct)}
    </div>
    ${
      p.factors
        ? `<div style="color:#333;font-size:13px;margin-top:8px;line-height:1.6">${escapeHtml(p.factors)}</div>`
        : ""
    }
    ${
      p.pulseSummary
        ? `<div style="color:#555;font-size:12px;margin-top:8px;background:#f8f9fa;border-radius:6px;padding:8px 10px">
             <strong style="color:#666">⏱ 지난 24시간 실시간 취합</strong><br>${escapeHtml(p.pulseSummary)}
           </div>`
        : ""
    }
  </div>`;
}

/**
 * 포지션 점검 섹션. 보유 종목이 없으면 **섹션 자체를 렌더하지 않는다** —
 * 해외 참고 섹션과 같은 판단이다(비어 있는 섹션이 매일 뜨면 그냥 노이즈다).
 */
function positionSection(s: StockSnapshot): string {
  const positions = s.positions ?? [];
  if (!positions.length) return "";
  return `
    <h2 style="color:#059669;margin-top:28px;border-bottom:2px solid #eee;padding-bottom:6px">💼 내 포지션 점검</h2>
    ${positions.map(positionCard).join("")}
    <p style="color:#8a6d3b;font-size:12px;background:#fff3cd;border-radius:6px;padding:8px 10px;margin-top:8px">손익·거리 수치는 서버가 계산한 값이며, 서술은 AI 영향도 판정입니다. 매매 권유가 아닙니다.</p>`;
}

/** 종목 1건의 20거래일 종가 차트 PNG. 실패는 호출부가 잡는다(그 종목만 차트 없이 렌더). */
function renderStockChart(a: StockAnalysis): Buffer {
  return renderLineChartPng({
    labels: a.history.map((p) => p.date),
    series: [
      {
        label: "종가",
        color: a.changePct != null && a.changePct >= 0 ? UP : DOWN,
        values: a.history.map((p) => p.close),
      },
    ],
    title: `${a.name} 최근 20거래일`,
    // 눈금값은 min~max 보간이라 정수가 아니다. 반올림하지 않으면 "1,437,333.333" 같은 라벨이 찍힌다.
    formatY: (v) => (a.currency === "USD" ? `$${v.toFixed(0)}` : Math.round(v).toLocaleString("ko-KR")),
  });
}

/** 증시 브리핑 iMessage 텍스트(플레인). 이메일과 달리 '요약 + 메일 보라'가 목적이라 몇 줄로 끊는다. */
export function stockIMessageText(s: StockSnapshot): string {
  // 잠금화면 미리보기는 첫 줄만 보인다 → 역할 구분은 이 head 한 줄이 유일한 수단이다.
  const head = `${flagOf(s.market)} ${titleOf(s)} (${s.date})`;
  const lines: string[] = [head];

  if (s.closed) {
    lines.push(`😴 휴장${s.closedReason ? ` — ${s.closedReason}` : ""}`);
  } else {
    // 내 포지션을 지수보다 **앞에** 둔다. 잠금화면에서 보이는 몇 줄 안에 들어가야 할 정보의
    // 우선순위는 '내가 들고 있는 것' > '시장 전체'다. 500자 예산이라 최대 3종목만 싣는다.
    const positions = s.positions ?? [];
    if (positions.length) {
      lines.push(
        positions
          .slice(0, 3)
          .map((p) => `${p.name} ${formatPnlPct(p.pnlPct)}`)
          .join(" · ") + (positions.length > 3 ? ` 외 ${positions.length - 3}` : "")
      );
    }
    const idx = (s.indices ?? [])
      .slice(0, 4)
      .map((i) => `${i.name} ${indexValue(i.value)} ${pctText(i.changePct)}`)
      .join(" · ");
    if (idx) lines.push(idx);
    // 관심 건수는 domestic 기준으로 센다 — 배열이 하나라 그냥 length 를 쓰면 해외 참고가
    // 관심 종목 수에 합산돼 채널마다 다시 섞인다. 해외 참고는 있을 때만 덧붙인다(500자 예산).
    const { domestic, foreign } = partitionWatchlist(s);
    lines.push(
      `등록 ${(s.analyses ?? []).length}종목 · 관심 ${domestic.length}종목` +
        (foreign.length ? ` · 해외참고 ${foreign.length}종목` : "")
    );
    lines.push("📧 메일 확인!");
  }

  // 면책은 채널 불문 필수(types.ts StockSnapshot.disclaimer). 길면 잘라서라도 넣는다.
  if (s.disclaimer) lines.push(`⚠️ ${truncate(s.disclaimer, 90)}`);

  return truncate(lines.join("\n"), IMESSAGE_MAX);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * 증시 브리핑을 본인 iMessage 로 발송. off/미설정이면 false.
 * 절대 throw 하지 않는다(수집 흐름을 막지 않음) — 실패는 로깅 후 false.
 */
export async function sendStockIMessage(s: StockSnapshot): Promise<boolean> {
  if (!isIMessageConfigured()) return false;
  try {
    await sendIMessage(stockIMessageText(s));
    return true;
  } catch (e) {
    log.warn(`증시 iMessage 발송 예외: ${(e as Error).message}`);
    return false;
  }
}

/**
 * 증시 브리핑 이메일 발송. NOTIFY_EMAIL + Gmail 자격증명 필요.
 * 발송 실패는 throw 하지 않고 false — 브리핑 알림 하나가 수집 런 전체를 깨면 안 된다.
 */
export async function sendStockEmail(s: StockSnapshot): Promise<boolean> {
  if (!config.notify.email) return false;
  if (!config.notify.gmailAddress || !config.notify.gmailAppPassword) {
    log.warn("이메일 자격증명 미설정 → 증시 이메일 건너뜀");
    return false;
  }

  try {
    // 차트를 먼저 만들고 성공한 종목만 HTML 에 img 를 박는다(깨진 CID 방지).
    // pinned 는 스냅샷이 아니라 원장에만 있어 여기서 조회한다 → 순수 함수는 이 조회를 타지 않는다.
    const attachments: { filename: string; content: Buffer; cid: string }[] = [];
    const chartSymbols = new Set<string>();
    if (!s.closed) {
      const pinned = new Set(
        listStocks(s.market)
          .filter((t) => t.pinned)
          .map((t) => t.symbol)
      );
      for (const a of s.analyses) {
        // 메일 크기·생성 시간 때문에 차트는 pinned 만. 시계열이 비면 빈 차트라 의미가 없다.
        if (!pinned.has(a.symbol) || !a.history.length) continue;
        try {
          attachments.push({
            filename: `chart_${s.market}_${a.symbol}.png`,
            content: renderStockChart(a),
            cid: chartCid(s.market, a.symbol),
          });
          chartSymbols.add(a.symbol);
        } catch (e) {
          log.warn(`증시 차트 생성 실패 [${a.name}]: ${(e as Error).message}`);
        }
      }
    }

    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: config.notify.gmailAddress, pass: config.notify.gmailAppPassword },
    });
    await transport.sendMail({
      from: config.notify.gmailAddress,
      to: config.notify.gmailAddress,
      subject: subjectOf(s),
      html: buildStockEmailHtml(s, chartSymbols),
      attachments,
    });
    log.info(`증시 이메일 발송 완료 [${s.market}] (차트 ${attachments.length}개 포함)`);
    return true;
  } catch (e) {
    log.warn(`증시 이메일 발송 예외 [${s.market}]: ${(e as Error).message}`);
    return false;
  }
}
