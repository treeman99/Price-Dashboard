// 네 개 발송 모듈(news/youtube/events/stock)이 SMTP 가 아니라 Gmail API 경로로 나가는지 고정한다.
//
// 스텁 위치를 **fetch 로 잡은 이유**: sendMail 을 모듈 목킹으로 갈아끼우면 "sendMail 을 불렀다"만
// 확인되고, 정작 이번에 갈아엎은 부분(제목·본문·CID 첨부가 실제 MIME 까지 살아서 가는가)은
// 검증되지 않는다. 특히 증시 차트의 인라인 CID 는 조립 단계에서 깨지기 쉬운 곳이라
// 요청 본문의 raw 를 되돌려 MIME 을 직접 본다. 네트워크는 타지 않는다.
//
// ⚠️ DB 를 여는 테스트라 임시 DB 를 DB_PATH 로 가리키고 "동적 import" 한다
// (정적 import 는 hoisting 때문에 env 설정보다 먼저 평가됨) — notify-ledger.test.ts 와 같은 패턴.
// config.dbPath 가 임시 경로가 되면 google-oauth.json / mail-alert.json 기본 위치도 함께 옮겨져
// 실제 data/ 를 건드리지 않는다.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NewsSnapshot } from "../../shared/types.ts";
import type { YoutubeSnapshot } from "../../shared/types.ts";
import type { EventsSnapshot } from "../../shared/types.ts";
import type { StockAnalysis, StockSnapshot } from "../../shared/types.ts";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "price-email-send-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

const { config } = await import("../config.ts");
const { __setStorePathForTest } = await import("./google-auth.ts");
const { __setAlertStorePathForTest, __setIMessageSenderForTest } = await import("./mailer.ts");
const { sendNewsEmail } = await import("./news-email.ts");
const { sendYoutubeEmail } = await import("./youtube-email.ts");
const { sendEventsEmail } = await import("./events-email.ts");
const { sendStockEmail } = await import("./stock-email.ts");
const { createStock } = await import("../db/repo.ts");

const ADDRESS = "tester@gmail.com";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

/**
 * 재인증 경고 발송기를 스텁으로 못 박는다. 이 파일은 발송 성공 경로만 다루지만,
 * 개발 머신 .env 에는 실제 iMessage 수신 번호가 들어 있어 실패 케이스가 하나라도 추가되면
 * 테스트가 진짜 문자를 보낸다. 여기서 막아두면 그런 실수가 애초에 불가능하다.
 */
const alerts: string[] = [];
__setIMessageSenderForTest(async (text: string) => void alerts.push(text));

after(async () => {
  assert.deepEqual(alerts, [], "정상 발송 경로에서 재인증 경고가 나가면 안 된다");
  __setIMessageSenderForTest(null);
  __setAlertStorePathForTest(null);
  __setStorePathForTest(null);
  const { closeDb } = await import("../db/index.ts");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** '메일 설정 완료 + Google 연결됨 + 토큰 유효' 상태를 만든다. */
function connected(): void {
  const file = path.join(tmpDir, "google-oauth.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      refreshToken: "rt-1",
      accessToken: "at-1",
      expiresAt: Date.now() + 3600_000,
      email: ADDRESS,
      needsReauth: false,
      lastError: null,
      lastSuccessAt: new Date().toISOString(),
    }),
    "utf8"
  );
  __setStorePathForTest(file);
  __setAlertStorePathForTest(path.join(tmpDir, "mail-alert.json"));
  config.notify.email = true;
  config.notify.gmailAddress = ADDRESS;
  config.notify.googleClientId = "test-client-id";
  config.notify.googleClientSecret = "test-client-secret";
}

/** Gmail send 를 전부 성공으로 받아치고 요청 본문을 모은다. */
function stubFetch() {
  const calls: Array<{ url: string; raw: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as { raw?: string };
    calls.push({ url: String(url), raw: payload.raw ?? "" });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "18f0" }),
      text: async () => "{}",
    };
  }) as unknown as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

// ── MIME 되돌리기 ──────────────────────────────────────────────

function mimeOf(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

/**
 * RFC2047 encoded-word(=?UTF-8?Q?…?= / ?B?)를 원문으로 되돌린다.
 * 인접한 encoded-word 사이의 공백은 **본문이 아니라 구분자**라 지우고 이어 붙여야 한다
 * (긴 한글 제목은 한 글자가 두 word 로 쪼개지므로, 안 지우면 "정 보"처럼 공백이 낀다).
 */
function decodeWords(v: string): string {
  return v.replace(/=\?UTF-8\?[QB]\?[^?]*\?=(?:\s*=\?UTF-8\?[QB]\?[^?]*\?=)*/gi, (run) => {
    const parts = [...run.matchAll(/=\?UTF-8\?([QB])\?([^?]*)\?=/gi)];
    return Buffer.concat(
      parts.map(([, enc, text]) =>
        enc.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(
              text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) =>
                String.fromCharCode(parseInt(h, 16))
              ),
              "binary"
            )
      )
    ).toString("utf8");
  });
}

/** 헤더 값 추출. 긴 제목은 여러 줄로 접히므로(folding) 이어 붙인 뒤 디코드한다. */
function headerOf(mime: string, name: string): string {
  const head = mime.split(/\r?\n\r?\n/)[0].split(/\r?\n/);
  const i = head.findIndex((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  if (i < 0) return "";
  let v = head[i].slice(head[i].indexOf(":") + 1).trim();
  for (let j = i + 1; j < head.length && /^[ \t]/.test(head[j]); j++) {
    const cont = head[j].trim();
    // 접힌 encoded-word 끼리는 공백 없이 이어야 한다(RFC 2047).
    v += /\?=$/.test(v) && /^=\?/.test(cont) ? cont : ` ${cont}`;
  }
  return decodeWords(v);
}

/** text/html 파트를 quoted-printable 에서 되돌린다. */
function htmlOf(mime: string): string {
  const boundary = /boundary="([^"]+)"/.exec(mime)?.[1];
  const parts = boundary ? mime.split(`--${boundary}`) : [mime];
  const part = parts.find((p) => /content-type:\s*text\/html/i.test(p));
  if (!part) return "";
  const sep = /\r?\n\r?\n/.exec(part);
  if (!sep) return "";
  const body = part.slice(sep.index + sep[0].length);
  const unfolded = body
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  return Buffer.from(unfolded, "binary").toString("utf8");
}

// ── 스냅샷 픽스처(발송 경로 확인에 필요한 최소치) ──────────────

function newsSnapshot(): NewsSnapshot {
  return {
    date: "2026-07-17",
    updatedAt: "2026-07-17T08:00:00+09:00",
    source: "llm",
    categories: [
      {
        key: "ai",
        label: "AI / LLM",
        emoji: "🤖",
        color: "#4361ee",
        items: [
          {
            title: "AI 모델 공개",
            source: "TechCrunch",
            date: "2026-07-17",
            summary: "새 모델이 공개됐다.",
            link: "https://example.com/a",
            related: [],
          },
        ],
      },
    ] as NewsSnapshot["categories"],
    notes: null,
  };
}

function youtubeSnapshot(): YoutubeSnapshot {
  return {
    date: "2026-07-17",
    updatedAt: "2026-07-17T08:00:00+09:00",
    source: "llm",
    freshDays: 7,
    categories: [
      {
        key: "ai",
        label: "AI · LLM",
        emoji: "🤖",
        color: "#ff0000",
        items: [
          {
            title: "새 AI 도구 리뷰",
            channel: "MKBHD",
            channelHandle: "@mkbhd",
            date: "2026-07-16",
            summary: "도구의 실사용 후기를 다룬다.",
            url: "https://www.youtube.com/watch?v=abc123",
            videoId: "abc123",
            thumbnail: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
            views: "1.2M views",
            duration: "12:34",
          },
        ],
      },
    ] as YoutubeSnapshot["categories"],
    notes: null,
  };
}

function eventsSnapshot(): EventsSnapshot {
  return {
    date: "2026-07-17",
    updatedAt: "2026-07-17T08:00:00+09:00",
    source: "llm",
    popups: [
      {
        name: "성수 팝업",
        region: "성수",
        period: "7/1~7/31",
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        summary: "브랜드 체험 공간",
        link: "https://example.com/popup",
        category: null,
        tag: "신규",
      },
    ],
    exhibitions: {
      venues: [
        {
          name: "코엑스",
          items: [
            {
              title: "코엑스 전시",
              venue: "코엑스",
              period: "7/10~7/12",
              startDate: "2026-07-10",
              endDate: "2026-07-12",
              summary: "산업 박람회",
              link: "https://example.com/exh",
              tag: null,
            },
          ],
        },
      ],
    },
    festivals: [],
    notes: null,
  };
}

/** 차트가 실제로 그려지도록 종가 시계열을 채운 분석 1건. */
function analysis(): StockAnalysis {
  const history = Array.from({ length: 20 }, (_, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, "0")}`,
    close: 340000 + i * 250,
    prevClose: 340000 + (i - 1) * 250,
    changePct: 0.07,
    volume: 12_000_000,
    currency: "KRW",
  }));
  return {
    symbol: "005930",
    name: "삼성전자",
    quoteCode: "005930",
    close: 346500,
    changePct: 1.2,
    weekChangePct: 3.4,
    currency: "KRW",
    history,
    ma5: 340000,
    ma20: 330000,
    summary: "외국인 순매수 지속",
    outlook: "박스권 상단 시험",
    rationale: "HBM 수요 코멘트",
    risks: "환율 변동성",
    verdict: "📈",
    verified: true,
  };
}

function stockSnapshot(): StockSnapshot {
  return {
    market: "kr",
    date: "2026-07-17",
    sessionDate: "2026-07-17",
    updatedAt: "2026-07-17T18:00:00+09:00",
    source: "llm",
    closed: false,
    closedReason: null,
    indices: [],
    news: [],
    analyses: [analysis()],
    watchlist: [],
    disclaimer: "본 정보는 투자 권유가 아니며 투자 판단의 책임은 본인에게 있습니다.",
    notes: null,
  };
}

// ── 발송 경로 ──────────────────────────────────────────────────

test("sendNewsEmail: Gmail API 로 제목·본문이 나간다", async () => {
  connected();
  const f = stubFetch();
  try {
    assert.equal(await sendNewsEmail(newsSnapshot()), true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, SEND_URL);

    const mime = mimeOf(f.calls[0].raw);
    assert.equal(headerOf(mime, "Subject"), "📰 Daily News Digest - 2026-07-17");
    assert.equal(headerOf(mime, "From"), ADDRESS);
    assert.equal(headerOf(mime, "To"), ADDRESS);

    const html = htmlOf(mime);
    assert.ok(html.includes("📰 Daily News Digest"));
    assert.ok(html.includes("AI 모델 공개"), "본문에 뉴스 제목이 살아 있어야 한다");
    assert.ok(!/Content-ID:/i.test(mime), "뉴스 메일에는 첨부가 없다");
  } finally {
    f.restore();
  }
});

test("sendYoutubeEmail: Gmail API 로 제목·본문이 나간다", async () => {
  connected();
  const f = stubFetch();
  try {
    assert.equal(await sendYoutubeEmail(youtubeSnapshot()), true);
    assert.equal(f.calls.length, 1);

    const mime = mimeOf(f.calls[0].raw);
    assert.equal(headerOf(mime, "Subject"), "▶ YouTube 소식 - 2026-07-17");

    const html = htmlOf(mime);
    assert.ok(html.includes("새 AI 도구 리뷰"));
    assert.ok(html.includes("https://www.youtube.com/watch?v=abc123"));
  } finally {
    f.restore();
  }
});

test("sendEventsEmail: Gmail API 로 제목·본문이 나간다", async () => {
  connected();
  const f = stubFetch();
  try {
    assert.equal(await sendEventsEmail(eventsSnapshot()), true);
    assert.equal(f.calls.length, 1);

    const mime = mimeOf(f.calls[0].raw);
    assert.equal(
      headerOf(mime, "Subject"),
      "🎈 [팝업·전시·축제] 2026-07-17 오늘의 팝업스토어 & 전시 & 축제 정보"
    );

    const html = htmlOf(mime);
    assert.ok(html.includes("성수 팝업"));
    assert.ok(html.includes("코엑스 전시"));
  } finally {
    f.restore();
  }
});

test("sendStockEmail: 차트 PNG 가 CID 인라인 첨부로 그대로 실린다", async () => {
  connected();
  // 차트는 pinned 종목만 붙는다 — 원장에 심어야 첨부가 생긴다.
  createStock({
    market: "kr",
    symbol: "005930",
    name: "삼성전자",
    quoteCode: "005930",
    exchange: "KOSPI",
    pinned: true,
  });

  const s = stockSnapshot();
  const f = stubFetch();
  try {
    assert.equal(await sendStockEmail(s), true);
    assert.equal(f.calls.length, 1);

    const mime = mimeOf(f.calls[0].raw);
    assert.ok(headerOf(mime, "Subject").includes("2026-07-17"));

    // 본문 img 와 첨부 Content-ID 가 **같은 값**이어야 그림이 렌더된다.
    const cid = "chart_kr_005930@dailystock";
    assert.ok(htmlOf(mime).includes(`cid:${cid}`), "본문에 img[cid] 가 있어야 한다");
    assert.ok(mime.includes(`Content-ID: <${cid}>`), "첨부 Content-ID 가 짝을 이뤄야 한다");
    assert.ok(mime.includes("multipart/related"), "인라인 이미지는 related 컨테이너");
    assert.ok(mime.includes("chart_kr_005930.png"));
    assert.ok(mime.includes("image/png"));
    assert.ok(/Content-Disposition: inline/i.test(mime));
  } finally {
    f.restore();
  }
});

// ── 게이트 ─────────────────────────────────────────────────────

test("NOTIFY_EMAIL 이 꺼져 있으면 네 모듈 모두 조용히 false", async () => {
  connected();
  config.notify.email = false;
  const f = stubFetch();
  try {
    assert.equal(await sendNewsEmail(newsSnapshot()), false);
    assert.equal(await sendYoutubeEmail(youtubeSnapshot()), false);
    assert.equal(await sendEventsEmail(eventsSnapshot()), false);
    assert.equal(await sendStockEmail(stockSnapshot()), false);
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
    config.notify.email = true;
  }
});

test("OAuth 클라이언트 미설정이면 발송을 시도하지 않는다", async () => {
  connected();
  config.notify.googleClientId = "";
  const f = stubFetch();
  try {
    assert.equal(await sendNewsEmail(newsSnapshot()), false);
    assert.equal(await sendYoutubeEmail(youtubeSnapshot()), false);
    assert.equal(await sendEventsEmail(eventsSnapshot()), false);
    assert.equal(await sendStockEmail(stockSnapshot()), false);
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
    config.notify.googleClientId = "test-client-id";
  }
});
