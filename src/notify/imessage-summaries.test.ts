import { test } from "node:test";
import assert from "node:assert/strict";
import { eventsIMessageText, sendEventsIMessage } from "./events-email.ts";
import { youtubeIMessageText, sendYoutubeIMessage } from "./youtube-email.ts";
import { newsIMessageText, sendNewsIMessage } from "./news-email.ts";
import type {
  EventsSnapshot,
  YoutubeSnapshot,
  NewsSnapshot,
} from "../../shared/types.ts";

test("eventsIMessageText: 카운트 + 신규 강조 + 팝업 이름", () => {
  const s = {
    date: "2026-07-17",
    // link 는 표시 대상 판별에 쓰이므로(화면·메일과 동일 기준) 채워 둔다.
    popups: [
      { name: "니케 팝업", isNew: true, link: "https://e.com/1" },
      { name: "쿠키런 팝업", isNew: false, link: "https://e.com/2" },
    ],
    exhibitions: {
      venues: [{ name: "코엑스", items: [{ title: "케이펫", isNew: false, link: "https://e.com/3" }] }],
    },
    festivals: [{ name: "보령머드축제", isNew: true, link: "https://e.com/4" }],
  } as unknown as EventsSnapshot;
  const t = eventsIMessageText(s);
  assert.match(t, /팝업 2 · 🏛 전시 1 · 🎉 축제 1/);
  assert.match(t, /🆕 신규: 니케 팝업, 보령머드축제/);
  assert.match(t, /팝업: 니케 팝업, 쿠키런 팝업/);
});

test("eventsIMessageText: 신규 없으면 신규 줄 생략", () => {
  const s = {
    date: "2026-07-17",
    popups: [{ name: "A", isNew: false, link: "https://e.com/1" }],
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
