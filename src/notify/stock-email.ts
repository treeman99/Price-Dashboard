import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { renderLineChartPng } from "./chart.ts";
import { isMailConfigured, sendMail, type MailAttachment } from "./mailer.ts";
import { isIMessageConfigured, sendIMessage } from "./imessage.ts";
import { isTabNotifyEnabled } from "../settings/tab-settings.ts";
import { escapeHtml, escapeAttr, safeHref } from "./html.ts";
import {
  FONT,
  HAIRLINE,
  INK,
  INK_80,
  MARKET,
  MUTED,
  TAB_COLOR,
  TNUM,
  articleRow,
  breakLongRuns,
  cellNote,
  changeText,
  dataTable,
  emailDocument,
  emptyLine,
  metaLine,
  notice,
  sectionHeader,
  statusTag,
  strong,
  subHeader,
  textLink,
} from "./email-kit.ts";
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
import { formatPnlPct, horizonLabel, pnlTone } from "../../shared/holdings.ts";
import type {
  NotifyChannel,
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
 * ⚠️ 등락 색은 **한국 증시 관례**를 따른다: 상승=빨강, 하락=파랑(email-kit MARKET · changeText).
 * 같은 디렉터리의 email.ts(쇼핑 리포트)는 "하락=초록(GREEN)"이라 규칙이 정반대다.
 * 가격이 내리면 좋은 쇼핑과 달리 증시는 방향 자체가 정보라서, 두 색 규칙을 절대 섞으면 안 된다.
 */

/** iMessage 본문 상한. 초과분은 알림 미리보기에서 어차피 잘리므로 보내기 전에 자른다. */
const IMESSAGE_MAX = 500;

/** 증시 상승·하락 색. 보합·값 없음은 흐린 잉크(색을 입히지 않는다). */
function marketColor(tone: "up" | "down" | "flat"): string {
  return tone === "up" ? MARKET.up : tone === "down" ? MARKET.down : MUTED;
}

/** 등락률 텍스트. changeTone 이 null·0·비유한수를 모두 flat 으로 모아주므로 여기선 화살표만 고른다. */
function pctText(pct: number | null): string {
  const t = changeTone(pct);
  if (t === "flat") return "-";
  return `${t === "up" ? "▲" : "▼"}${Math.abs(pct as number).toFixed(1)}%`;
}

/** 지수는 통화가 아니라 포인트다 — formatPrice(원/$ 붙음) 대신 소수 2자리 고정. */
function indexValue(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return v.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 시세 표기(이스케이프 포함) — 모르는 통화는 코드가 그대로 붙어 나오므로 감싸 둔다. */
function priceHtml(v: number | null, currency: string): string {
  return escapeHtml(formatPrice(v, currency));
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

// ── 지면 부품(증시 전용) ────────────────────────────────────────
// 공용 부품은 email-kit.ts. 여기 것은 종목 행에서만 쓰는 조각이다.

/**
 * 브리핑의 전망(verdict)·주목 강도(attention)는 서버 계약상 이모지 값이다(src/stock/curate.ts VERDICTS·ATTENTIONS).
 * 지면에는 이모지를 아이콘 대신 쓰지 않고 글씨 태그로 단다 — web/src/components/StockCard.tsx 와 같은 매핑.
 * 모르는 값은 그대로 둔다(statusTag 가 이스케이프한다).
 */
const VERDICT_LABEL: Record<string, string> = { "📈": "상승 전망", "📉": "하락 전망", "➡️": "보합 전망" };

/** "🔥강" → "주목 강". 한글 등급이 없으면 받은 값 그대로. */
function attentionLabel(attention: string): string {
  const level = attention.replace(/[^가-힣]/g, "");
  return level ? `주목 ${level}` : attention;
}

/** 큰 숫자(지수·종가·손익률) — 명조 22px tabular. html 그대로. */
function bigNumber(html: string, color: string = INK): string {
  return `<span style="font-family:${FONT.serif};font-size:22px;font-weight:600;line-height:1.25;letter-spacing:-0.01em;color:${color};${TNUM}">${html}</span>`;
}

/** 큰 숫자 + 등락률 한 줄. label 이 있으면 위에 12px 흐린 잉크로(화면 StockCard 의 '종가'). */
function quoteLine(valueHtml: string, pct: number | null, label?: string): string {
  return (
    (label ? `<p style="margin:10px 0 0;font-size:12px;color:${MUTED}">${escapeHtml(label)}</p>` : "") +
    `<p style="margin:${label ? 0 : 2}px 0 0">${bigNumber(valueHtml)}&nbsp;&nbsp;<span style="font-size:15px">${changeText(pct)}</span></p>`
  );
}

/** 행 제목 — 이름(semibold) 뒤에 상태 태그. name 은 텍스트, tags 는 html. */
function nameLine(name: string, tags: string[] = []): string {
  const after = tags.filter(Boolean).map((t) => ` ${t}`).join("");
  return `<p style="margin:0;font-size:15px;font-weight:600;line-height:1.45;color:${INK}">${escapeHtml(name)}${after}</p>`;
}

/** 이름 아래 회색 한 줄 — Mono 종목코드 + 덧붙일 조각(html). */
function codeLine(symbol: string, parts: (string | null | false)[] = []): string {
  const code = `<span style="font-family:${FONT.mono}">${escapeHtml(symbol)}</span>`;
  return `<p style="margin:2px 0 0;font-size:12px;line-height:1.6;color:${MUTED};${TNUM}">${metaLine([code, ...parts])}</p>`;
}

/**
 * 서술 한 덩어리 — 라벨(12px 흐린 잉크) + 본문. 화면 StockCard 의 Field 와 같다.
 * 값이 없으면 아무것도 그리지 않는다. label·value 는 텍스트.
 */
function field(label: string | null, value: string | null | undefined): string {
  if (!value) return "";
  const head = label ? `<div style="font-size:12px;font-weight:600;color:${MUTED}">${escapeHtml(label)}</div>` : "";
  return `<div style="margin-top:10px">${head}<div style="margin-top:2px;font-size:14px;line-height:1.65;color:${INK_80};white-space:pre-line">${breakLongRuns(escapeHtml(value))}</div></div>`;
}

/** 종목·지수 한 행. 상자 없이 아래 헤어라인으로만 나눈다. */
function itemRow(inner: string): string {
  return `<div style="padding:16px 0;border-bottom:1px solid ${HAIRLINE}">${inner}</div>`;
}

const DASH = `<span style="color:${MUTED}">-</span>`;

// ── 섹션 렌더러 ────────────────────────────────────────────────

function newsSection(items: StockNewsItem[]): string {
  if (!items.length) return emptyLine("최근 24시간 내 수집된 뉴스가 없습니다.");

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
      const rows = list
        .map((it) => {
          const href = safeHref(it.link);
          return articleRow({
            title: it.title,
            href,
            meta: metaLine([
              escapeHtml(it.source),
              it.date ? `<span style="font-family:${FONT.mono}">${escapeHtml(it.date)}</span>` : null,
            ]),
            summary: it.summary ? breakLongRuns(escapeHtml(it.summary)) : undefined,
            after: href ? textLink(href, "원문 보기") : undefined,
          });
        })
        .join("");
      return subHeader(bucket, { count: list.length }) + rows;
    })
    .join("");
}

function indexRow(i: StockIndex): string {
  // rationale 이 없으면 outlook 을 감춘다 — 근거 없는 전망은 노출하지 않는다는 규칙(types.ts StockIndex 주석).
  const outlook = i.outlook && i.rationale ? field("전망", i.outlook) + field("근거", i.rationale) : "";
  return itemRow(
    nameLine(i.name) + quoteLine(escapeHtml(indexValue(i.value)), i.changePct) + field(null, i.comment) + outlook
  );
}

/** 등록 종목 한 행. cid 가 있으면 그 종목만 인라인 차트를 붙인다(첨부 생성에 성공한 종목). */
function analysisRow(a: StockAnalysis, cid: string | null): string {
  const verdict = a.verdict ? statusTag(VERDICT_LABEL[a.verdict] ?? a.verdict) : "";
  const unverified = a.verified ? null : statusTag("시세 미검증", "warn");
  // 이동평균은 값이 하나라도 있을 때만(예전 카드와 같은 조건). 화면 StockCard 의 '5일 등락 · 5일선 · 20일선' 줄.
  const ma =
    a.ma5 != null || a.ma20 != null
      ? [`5일선 ${strong(priceHtml(a.ma5, a.currency))}`, `20일선 ${strong(priceHtml(a.ma20, a.currency))}`]
      : [];
  const stats = `<p style="margin:6px 0 0;font-size:13px;color:${MUTED};${TNUM}">${metaLine([
    `5일 등락 ${changeText(a.weekChangePct)}`,
    ...ma,
  ])}</p>`;
  // 신문지 바탕 PNG 라 테두리 없이 지면에 그대로 얹는다. 폭은 첨부 PNG(540px)에 맞추고, 좁은 화면에선 줄어든다.
  const img = cid
    ? `<img src="cid:${escapeAttr(cid)}" alt="${escapeAttr(a.name)} 최근 20거래일" width="540" style="display:block;width:100%;max-width:540px;height:auto;margin:12px 0 0;border:0"/>`
    : "";

  return itemRow(
    nameLine(a.name, [verdict]) +
      codeLine(a.symbol, [unverified]) +
      quoteLine(priceHtml(a.close, a.currency), a.changePct, "종가") +
      stats +
      img +
      field("요약", a.summary) +
      field("전망", a.outlook) +
      field("근거", a.rationale) +
      field("리스크", a.risks)
  );
}

/**
 * 관심 종목 한 행. marketNote 가 있으면 '해외 참고' 항목이라 시장 태그를 붙여 **다른 묶음임을 보인다**
 * (섹션도 따로 끊는다). 통화 표기는 항목의 currency 만 보므로(shared/stock.ts formatPrice) 별도 분기가
 * 필요 없다 — 해외 항목엔 verifyWatchlist 가 실제 시장의 통화를 붙여 두었다.
 */
function watchRow(w: StockWatchItem, marketNote?: string): string {
  return itemRow(
    nameLine(w.name) +
      codeLine(w.symbol, [statusTag(attentionLabel(w.attention)), marketNote ? statusTag(marketNote) : null]) +
      quoteLine(priceHtml(w.close, w.currency), w.changePct, "종가") +
      field("요약", w.summary) +
      // 전망은 근거가 있을 때만 — 종합 테이블과 같은 조건이라 표와 행이 서로 다른 말을 하지 않는다.
      (w.outlook && w.rationale ? field("전망", w.outlook) : "") +
      field("근거", w.rationale) +
      field("리스크", w.risks) +
      field("주목 가격대", w.levels)
  );
}

function summaryTable(s: StockSnapshot): string {
  // 근거 없는 전망은 표에서도 감춘다 — 행(indexRow)만 막고 표를 열어두면
  // 같은 전망이 '핵심 근거 -' 상태로 표에 그대로 실린다.
  //
  // 표에는 시장 컬럼이 없다. 해외 참고 항목을 관심 종목과 같은 묶음으로 찍으면 섹션에서 애써
  // 분리한 게 표에서 다시 섞인다 → 이름 아래 회색 묶음 표기에 시장명을 박는다.
  // 미국장 브리핑의 한국 종목은 '해외'가 아니라 '국내'다 — 라벨은 시장 상대적이다(foreignSectionTitle 과 같다).
  const row = (name: string, group: string, tone: number | null, outlook: string | null, rationale: string | null) => [
    `<span style="font-weight:600">${escapeHtml(name)}</span> ${changeText(tone)}${cellNote(escapeHtml(group))}`,
    outlook && rationale ? escapeHtml(outlook) : DASH,
    rationale ? `<span style="font-size:13px;color:${INK_80}">${escapeHtml(rationale)}</span>` : DASH,
  ];

  const { domestic, foreign } = partitionWatchlist(s);
  const foreignGroup = s.market === "kr" ? "해외" : "국내";
  const rows = [
    ...s.indices.map((i) => row(i.name, "지수", i.changePct, i.outlook, i.rationale)),
    ...s.analyses.map((a) => row(a.name, "등록", a.changePct, a.outlook, a.rationale)),
    ...domestic.map((w) => row(w.name, "관심", w.changePct, w.outlook, w.rationale)),
    ...foreign.map((w) =>
      row(w.name, `${foreignGroup} · ${marketLabel(watchMarket(w, s.market))}`, w.changePct, w.outlook, w.rationale)
    ),
  ];

  if (!rows.length) return emptyLine("표에 담을 항목이 없습니다.");
  return dataTable([{ label: "지수/종목", width: "32%" }, { label: "전망", width: "28%" }, { label: "핵심 근거" }], rows);
}

/**
 * 메타 줄의 거래일 사실.
 *
 * ⚠️ close/preview 는 `sessionDate !== date` 조건부 로직을 쓰면 안 된다. 프리뷰의 sessionDate
 * 는 '오늘 밤 뉴욕 세션'이라 KST 수집일과 **같아지는 날이 대부분**이고, 그러면 대상 세션 표기가
 * 조용히 사라진다. 역할이 있으면 항상 표시하고, 문구로 두 브리핑을 구분한다.
 */
function sessionFactOf(s: StockSnapshot): string | null {
  const role = effectiveRole(s);
  if (role === "close" && s.sessionDate) return `간밤 뉴욕장(${escapeHtml(s.sessionDate)}) 마감 결산`;
  if (role === "preview" && s.sessionDate) return `오늘 밤(${escapeHtml(s.sessionDate)}) 뉴욕장 개장 프리뷰`;
  // both·한국장은 현행 조건부 로직 유지.
  return s.sessionDate && s.sessionDate !== s.date ? `거래일 ${escapeHtml(s.sessionDate)}` : null;
}

/** 지면 뼈대. 제목에서 국기는 뺀다(제목 앞 이모지 금지) — 메일 제목(subject)에는 그대로 남는다. */
function documentHtml(s: StockSnapshot, meta: (string | null | false)[], body: string): string {
  return emailDocument({
    tab: "stock",
    title: titleOf(s),
    date: s.date,
    meta: metaLine([sessionFactOf(s), ...meta]),
    body,
    footnote: s.disclaimer ? escapeHtml(s.disclaimer) : undefined,
  });
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
    const reason = s.closedReason ? `(${escapeHtml(s.closedReason)})` : "";
    return documentHtml(s, ["휴장"], notice(`휴장일${reason}입니다. 오늘은 브리핑이 없습니다.`, "muted"));
  }

  const accent = TAB_COLOR.stock;
  const charts = chartSymbols ?? new Set<string>();
  const { domestic, foreign } = partitionWatchlist(s);
  const positions = positionSection(s);

  const analyses = s.analyses.length
    ? s.analyses.map((a) => analysisRow(a, charts.has(a.symbol) ? chartCid(s.market, a.symbol) : null)).join("")
    : emptyLine("등록된 종목이 없습니다.");
  const indices = s.indices.length ? s.indices.map(indexRow).join("") : emptyLine("지수 데이터를 가져오지 못했습니다.");
  const watchlist = domestic.length
    ? domestic.map((w) => watchRow(w)).join("")
    : emptyLine("오늘 추려진 관심 종목이 없습니다.");
  // 해외 참고는 **평소 0건이 정상**이다. 관심 종목처럼 플레이스홀더 문구를 두면
  // 매일 '해외 참고 없음'이 뜨는 노이즈가 되므로 비면 섹션 자체를 렌더하지 않는다(웹과 동일).
  // 제목은 화면과 같은 foreignSectionTitle 그대로다(공용 문구라 화면·메일이 함께 바뀌어야 한다).
  const foreignSection = foreign.length
    ? sectionHeader({ title: escapeHtml(foreignSectionTitle(s.market)), accent, count: foreign.length }) +
      `<p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:${MUTED}">${escapeHtml(
        marketLabel(s.market)
      )}에 상장되지 않은 종목입니다. 오늘 이 장에서 직접 거래되지 않으며, 시세·통화는 해당 종목의 상장 시장 기준입니다.</p>` +
      foreign.map((w) => watchRow(w, marketLabel(watchMarket(w, s.market)))).join("")
    : "";

  const body = [
    positions,
    sectionHeader({ title: "24시간 뉴스 브리핑", accent, count: s.news.length || null, first: !positions }),
    newsSection(s.news),
    sectionHeader({ title: "지수", accent, count: s.indices.length || null }),
    indices,
    sectionHeader({ title: "등록 종목", accent, count: s.analyses.length || null }),
    analyses,
    sectionHeader({ title: "오늘의 관심 종목", accent, count: domestic.length || null }),
    notice("관심 종목은 시장에서 거론되는 사실을 정리한 것으로 매수 추천이 아닙니다.", "muted"),
    watchlist,
    foreignSection,
    sectionHeader({ title: "종합 테이블", accent }),
    summaryTable(s),
    s.notes
      ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:${MUTED};white-space:pre-line">${escapeHtml(s.notes)}</p>`
      : "",
  ].join("\n");

  return documentHtml(
    s,
    [
      `등록 ${strong(`${s.analyses.length}종목`)}`,
      `관심 ${strong(`${domestic.length}종목`)}`,
      foreign.length > 0 && `${s.market === "kr" ? "해외" : "국내"} 참고 ${strong(`${foreign.length}종목`)}`,
    ],
    body
  );
}

/**
 * 본문 HTML 과 인라인 차트 첨부를 함께 만든다. pinned = 차트를 붙일 종목 심볼. 발송·DB 조회 없음.
 *
 * 차트를 먼저 만들고 **성공한 종목만** HTML 에 img 를 박는다(깨진 CID 방지) — 실패한 종목은 차트 없이 렌더한다.
 * 메일 크기·생성 시간 때문에 차트는 pinned 만. 시계열이 비면 빈 차트라 의미가 없어 건너뛴다.
 */
export function buildStockEmailParts(
  s: StockSnapshot,
  pinned: ReadonlySet<string>
): { html: string; attachments: MailAttachment[] } {
  const attachments: MailAttachment[] = [];
  const chartSymbols = new Set<string>();
  if (!s.closed) {
    for (const a of s.analyses) {
      if (!pinned.has(a.symbol) || !a.history.length) continue;
      try {
        attachments.push({
          filename: `chart_${s.market}_${a.symbol}.png`,
          content: renderStockChart(a),
          // 본문의 <img src="cid:..."> 와 짝을 이룬다 — 이 값이 어긋나면 차트가 깨진다.
          cid: chartCid(s.market, a.symbol),
          contentType: "image/png",
        });
        chartSymbols.add(a.symbol);
      } catch (e) {
        log.warn(`증시 차트 생성 실패 [${a.name}]: ${(e as Error).message}`);
      }
    }
  }
  return { html: buildStockEmailHtml(s, chartSymbols), attachments };
}

/**
 * 내 포지션 점검 행 1건.
 *
 * 목표가·손절가는 **거리(%)로만** 표시한다. 도달 알림은 인터뷰에서 트리거로 선택되지
 * 않았으므로 여기서 "도달!" 같은 행동 신호를 만들면 사용자가 요청하지 않은 알림이 된다.
 */
function positionRow(p: StockPositionReview): string {
  const level = (label: string, price: number | null, pct: number | null): string | null =>
    price == null ? null : `${label} ${strong(priceHtml(price, p.currency))} (${escapeHtml(formatPnlPct(pct))})`;
  const levels = [level("목표", p.targetPrice, p.toTargetPct), level("손절", p.stopPrice, p.toStopPct)];

  // 이름 왼쪽 · 손익률 오른쪽. 좌우 배치는 flex 대신 표로(Gmail·Outlook 이 flex 를 무시한다).
  const head = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="top" style="padding:0">${nameLine(p.name)}${codeLine(p.symbol, [escapeHtml(horizonLabel(p.horizon))])}</td>
<td valign="top" align="right" style="padding:0 0 0 12px;white-space:nowrap;text-align:right">${bigNumber(
    escapeHtml(formatPnlPct(p.pnlPct)),
    marketColor(pnlTone(p.pnlPct))
  )}<div style="font-size:12px;color:${MUTED}">손익률</div></td>
</tr></table>`;

  return itemRow(
    head +
      `<p style="margin:8px 0 0;font-size:13px;color:${MUTED};${TNUM}">${metaLine([
        `현재가 ${strong(priceHtml(p.close, p.currency))} ${changeText(p.changePct)}`,
        `평단 ${priceHtml(p.avgPrice, p.currency)}`,
        `${escapeHtml(String(p.quantity))}주`,
      ])}</p>` +
      (levels.some(Boolean)
        ? `<p style="margin:2px 0 0;font-size:13px;color:${MUTED};${TNUM}">${metaLine(levels)}</p>`
        : "") +
      field(null, p.factors) +
      field("지난 24시간 실시간 취합", p.pulseSummary)
  );
}

/**
 * 포지션 점검 섹션. 보유 종목이 없으면 **섹션 자체를 렌더하지 않는다** —
 * 해외 참고 섹션과 같은 판단이다(비어 있는 섹션이 매일 뜨면 그냥 노이즈다).
 */
function positionSection(s: StockSnapshot): string {
  const positions = s.positions ?? [];
  if (!positions.length) return "";
  return (
    sectionHeader({ title: "내 포지션 점검", accent: TAB_COLOR.holdings, count: positions.length, first: true }) +
    notice("손익·거리 수치는 서버가 계산한 값이며, 서술은 AI 영향도 판정입니다. 매매 권유가 아닙니다.", "muted") +
    positions.map(positionRow).join("")
  );
}

/**
 * 종목 1건의 20거래일 종가 차트 PNG. 실패는 호출부가 잡는다(그 종목만 차트 없이 렌더).
 * 선은 잉크 한 가지, 마지막 점 하나만 오늘 등락의 상승·하락 색(화면 StockChart 와 같은 인상).
 */
function renderStockChart(a: StockAnalysis): Buffer {
  return renderLineChartPng({
    // 축 눈금은 화면처럼 MM-DD.
    labels: a.history.map((p) => p.date.slice(5)),
    series: [
      {
        label: "종가",
        endColor: marketColor(changeTone(a.changePct)),
        values: a.history.map((p) => p.close),
      },
    ],
    title: `${a.name} 최근 20거래일`,
    // 눈금값은 min~max 보간이라 정수가 아니다. 반올림하지 않으면 "1,437,333.333" 같은 라벨이 찍힌다.
    // USD 는 화면 눈금처럼 소수 2자리 — 저가주는 정수로 자르면 눈금이 같은 값으로 뭉갠다.
    formatY: (v) =>
      a.currency === "USD"
        ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : Math.round(v).toLocaleString("ko-KR"),
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
 * 증시 알림 채널이 **꺼져 있으면 그 사유**, 켜져 있으면 null.
 *
 * 꺼짐 = 탭 스위치 off · 전역 스위치 off(NOTIFY_EMAIL / NOTIFY_IMESSAGE) · 메일 자격증명 미설정 ·
 * iMessage 수신자 없음. 판정은 isTabNotifyEnabled(전역 AND 탭) 한 줄이고, 사유는 로그 문구용이다.
 *
 * ⚠️ send 함수의 조기 반환과 stock.ts 의 원장 기록(꺼진 채널은 SLOT_HANDLED 로 닫는다)이 **이 함수
 *    하나**를 본다. 둘이 따로 판정하면 '원장은 켜짐으로 보고 열어 둠 · send 는 꺼짐으로 보고 안 보냄'인
 *    틈이 생기고, 그 슬롯은 영원히 미발송이라 catch-up 이 30분마다 증시 브리핑 전체를 다시 수집한다
 *    (2026-10-25 QA H1 — 대시보드 탭 알림 스위치 한 번이면 열리는 경로였다).
 * ⚠️ '자격증명은 있는데 Google 미연결·재로그인 필요'는 꺼짐이 아니다(isMailConfigured 판정 —
 *    tab-settings.ts isTabNotifyEnabled 주석의 2026-08-05 실패 모드). 발송을 시도해 실패로 남겨야
 *    재연결 뒤 catch-up 이 그 슬롯을 보충한다.
 */
export function stockChannelOffReason(channel: NotifyChannel): string | null {
  if (isTabNotifyEnabled("stock", channel)) return null;
  if (channel === "email") {
    if (!config.notify.email) return "전역 NOTIFY_EMAIL 꺼짐";
    if (!isMailConfigured()) return "메일 설정 미완료(GMAIL_ADDRESS / GOOGLE_CLIENT_*)";
  } else if (!isIMessageConfigured()) {
    return config.notify.imessage ? "iMessage 수신자(IMESSAGE_TO) 미설정" : "전역 NOTIFY_IMESSAGE 꺼짐";
  }
  return "대시보드 운영 설정";
}

/**
 * 증시 브리핑을 본인 iMessage 로 발송. 채널이 꺼져 있으면(stockChannelOffReason) false.
 * 절대 throw 하지 않는다(수집 흐름을 막지 않음) — 실패는 로깅 후 false.
 */
export async function sendStockIMessage(s: StockSnapshot): Promise<boolean> {
  if (stockChannelOffReason("imessage")) return false;
  try {
    await sendIMessage(stockIMessageText(s));
    return true;
  } catch (e) {
    log.warn(`증시 iMessage 발송 예외: ${(e as Error).message}`);
    return false;
  }
}

/**
 * 증시 브리핑 이메일 발송. 채널이 꺼져 있으면(stockChannelOffReason) false.
 * 발송 실패는 throw 하지 않고 false — 브리핑 알림 하나가 수집 런 전체를 깨면 안 된다.
 */
export async function sendStockEmail(s: StockSnapshot): Promise<boolean> {
  const off = stockChannelOffReason("email");
  if (off) {
    log.info(`증시 메일 알림 꺼짐(${off}) → 건너뜀`);
    return false;
  }

  try {
    // pinned 는 스냅샷이 아니라 원장에만 있어 여기서 조회한다 → 순수 빌더(buildStockEmailParts)는 이 조회를 타지 않는다.
    // 휴장이면 차트를 붙이지 않으므로 원장도 읽지 않는다.
    const pinned = s.closed
      ? new Set<string>()
      : new Set(
          listStocks(s.market)
            .filter((t) => t.pinned)
            .map((t) => t.symbol)
        );
    const { html, attachments } = buildStockEmailParts(s, pinned);

    return await sendMail({
      subject: subjectOf(s),
      html,
      attachments,
    });
  } catch (e) {
    log.warn(`증시 이메일 발송 예외 [${s.market}]: ${(e as Error).message}`);
    return false;
  }
}
