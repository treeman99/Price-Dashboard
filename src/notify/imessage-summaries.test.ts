import { test } from "node:test";
import assert from "node:assert/strict";
import { priceIMessageText } from "./email.ts";
import { eventsIMessageText, sendEventsIMessage } from "./events-email.ts";
import { youtubeIMessageText, sendYoutubeIMessage } from "./youtube-email.ts";
import { newsIMessageText, sendNewsIMessage } from "./news-email.ts";
import type {
  ProductSummary,
  EventsSnapshot,
  YoutubeSnapshot,
  NewsSnapshot,
} from "../../shared/types.ts";

test("priceIMessageText: 상품별 최저가 + 변동(▼/▲) 표기", () => {
  const summaries = [
    {
      product: { id: 1, name: "맥북 프로 14" },
      latest: { overallLowest: 1_144_000 },
      change: { direction: "down", amount: 2000, percent: 0.2 },
    },
    {
      product: { id: 2, name: "드론" },
      latest: { overallLowest: 895_000 },
      change: { direction: "flat", amount: null, percent: null },
    },
  ] as unknown as ProductSummary[];
  const t = priceIMessageText(summaries, "2026-07-17");
  assert.match(t, /관심 물건 최저가 — 2026-07-17/);
  assert.match(t, /맥북 프로 14: 1,144,000원 ▼2,000원 0\.2%/);
  assert.match(t, /드론: 895,000원$/m); // 변동없음 → 화살표 없음
});

test("eventsIMessageText: 카운트 + 신규 강조 + 팝업 이름", () => {
  const s = {
    date: "2026-07-17",
    popups: [
      { name: "니케 팝업", isNew: true },
      { name: "쿠키런 팝업", isNew: false },
    ],
    exhibitions: { venues: [{ name: "코엑스", items: [{ title: "케이펫", isNew: false }] }] },
    festivals: [{ name: "보령머드축제", isNew: true }],
  } as unknown as EventsSnapshot;
  const t = eventsIMessageText(s);
  assert.match(t, /팝업 2 · 🏛 전시 1 · 🎉 축제 1/);
  assert.match(t, /🆕 신규: 니케 팝업, 보령머드축제/);
  assert.match(t, /팝업: 니케 팝업, 쿠키런 팝업/);
});

test("eventsIMessageText: 신규 없으면 신규 줄 생략", () => {
  const s = {
    date: "2026-07-17",
    popups: [{ name: "A", isNew: false }],
    exhibitions: { venues: [] },
    festivals: [],
  } as unknown as EventsSnapshot;
  const t = eventsIMessageText(s);
  assert.doesNotMatch(t, /🆕/);
});

test("youtubeIMessageText: 총건수 + 비어있지 않은 카테고리만 상위 2개 제목", () => {
  const s = {
    date: "2026-07-17",
    categories: [
      { key: "ai", label: "AI · LLM", emoji: "🤖", color: "#000", items: [] },
      {
        key: "tools",
        label: "AI 활용 · 도구",
        emoji: "🛠️",
        color: "#000",
        items: [{ title: "영상A" }, { title: "영상B" }, { title: "영상C" }],
      },
    ],
  } as unknown as YoutubeSnapshot;
  const t = youtubeIMessageText(s);
  assert.match(t, /유튜브 소식 — 2026-07-17 \(총 3건\)/);
  assert.doesNotMatch(t, /AI · LLM/); // 0건 카테고리는 생략
  assert.match(t, /AI 활용 · 도구\(3\): 영상A \/ 영상B/); // 상위 2개만
});

test("send*IMessage: iMessage 미설정이면 발송 시도 없이 false (0건 가드 포함)", async () => {
  // 이 테스트 환경엔 NOTIFY_IMESSAGE/IMESSAGE_TO 가 없어 isIMessageConfigured()=false →
  // 모든 sendXIMessage 는 osascript 를 부르지 않고 즉시 false 를 반환해야 한다(부작용 없음).
  const emptyEvents = { date: "d", popups: [], exhibitions: { venues: [] }, festivals: [] } as any;
  const emptyYoutube = { date: "d", categories: [{ items: [] }] } as any;
  const emptyNews = { date: "d", categories: [{ items: [] }] } as any;
  assert.equal(await sendEventsIMessage(emptyEvents), false);
  assert.equal(await sendYoutubeIMessage(emptyYoutube), false);
  assert.equal(await sendNewsIMessage(emptyNews), false);
});

test("newsIMessageText: 총건수 + 카테고리별 상위 2개 제목", () => {
  const s = {
    date: "2026-07-17",
    categories: [
      { key: "ai", label: "AI / LLM", emoji: "🤖", color: "#000", items: [{ title: "기사1" }, { title: "기사2" }] },
    ],
  } as unknown as NewsSnapshot;
  const t = newsIMessageText(s);
  assert.match(t, /뉴스 다이제스트 — 2026-07-17 \(총 2건\)/);
  assert.match(t, /AI \/ LLM\(2\): 기사1 \/ 기사2/);
});
