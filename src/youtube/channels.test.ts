import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractHandle,
  cleanChannelName,
  extractChannelId,
  parseRssEntries,
  inWindow,
} from "./channels.ts";

// 실제 유튜브 RSS(feeds/videos.xml) 마크업 조각 — 합성이 아니라 라이브 응답에서 캡처.
const REAL_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <yt:channelId>dUcjkyZtf-1WJyPPiETF1g</yt:channelId>
 <title>ITSub잇섭</title>
 <author><name>ITSub잇섭</name><uri>https://www.youtube.com/channel/UCdUcjkyZtf-1WJyPPiETF1g</uri></author>
 <published>2016-08-07T10:23:41+00:00</published>
 <entry>
  <id>yt:video:PwGzuBgIS9M</id>
  <yt:videoId>PwGzuBgIS9M</yt:videoId>
  <yt:channelId>UCdUcjkyZtf-1WJyPPiETF1g</yt:channelId>
  <title>요즘 유행하는 욕실 환풍기 &amp; 제습 전부 테스트</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=PwGzuBgIS9M"/>
  <author><name>ITSub잇섭</name><uri>https://www.youtube.com/channel/UCdUcjkyZtf-1WJyPPiETF1g</uri></author>
  <published>2026-07-16T11:15:14+00:00</published>
  <updated>2026-07-17T21:03:53+00:00</updated>
  <media:group>
   <media:description>이사오고서 진짜 제일 맘에 드는 가전.</media:description>
  </media:group>
 </entry>
 <entry>
  <id>yt:video:abc123XYZ_9</id>
  <yt:videoId>abc123XYZ_9</yt:videoId>
  <yt:channelId>UCdUcjkyZtf-1WJyPPiETF1g</yt:channelId>
  <title>아이폰 카메라 무음 진짜 된다?</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=abc123XYZ_9"/>
  <author><name>ITSub잇섭</name></author>
  <published>2026-07-14T09:00:00+00:00</published>
 </entry>
</feed>`;

test("parseRssEntries: 실제 마크업에서 entry만 파싱(피드 상단 채널 title은 제외)", () => {
  const vids = parseRssEntries(REAL_RSS);
  assert.equal(vids.length, 2);
  const [a, b] = vids;
  assert.equal(a.videoId, "PwGzuBgIS9M");
  assert.equal(a.channel, "ITSub잇섭");
  assert.equal(a.channelId, "UCdUcjkyZtf-1WJyPPiETF1g");
  assert.equal(a.title, "요즘 유행하는 욕실 환풍기 & 제습 전부 테스트"); // &amp; 디코드
  assert.equal(a.date, "2026-07-16"); // published → 로컬 날짜(오프셋 무관하게 날짜 부분)
  assert.equal(a.description, "이사오고서 진짜 제일 맘에 드는 가전.");
  assert.equal(b.videoId, "abc123XYZ_9");
  assert.equal(b.description, null); // media:description 없음
});

test("parseRssEntries: videoId 또는 유효 날짜 없으면 버림", () => {
  const bad = `<feed><entry><title>날짜없음</title><yt:videoId>zzz</yt:videoId></entry>
    <entry><yt:videoId>ok1</yt:videoId><published>2026-07-15T00:00:00+00:00</published></entry></feed>`;
  const vids = parseRssEntries(bad);
  assert.equal(vids.length, 1);
  assert.equal(vids[0].videoId, "ok1");
});

test("extractHandle: 괄호 핸들/일반 문자열", () => {
  assert.equal(extractHandle("찐AI (@jjin-ai-hj)"), "@jjin-ai-hj");
  assert.equal(extractHandle("테크몽 Techmong (@techmong)"), "@techmong");
  assert.equal(extractHandle("안될공학"), null);
  assert.equal(extractHandle("ITSub잇섭"), null);
});

test("cleanChannelName: 괄호/@핸들 토큰 + 가짜 @한글핸들 정규화", () => {
  assert.equal(cleanChannelName("찐AI (@jjin-ai-hj)"), "찐AI");
  assert.equal(cleanChannelName("테크몽 Techmong (@techmong)"), "테크몽 Techmong");
  assert.equal(cleanChannelName("안될공학"), "안될공학");
  // 발굴 LLM이 만든 가짜 @한글핸들 → 이름으로 되돌려 검색 가능하게
  assert.equal(cleanChannelName("@고몽여행"), "고몽여행");
  assert.equal(cleanChannelName("@원지의하루"), "원지의하루");
});

test("extractChannelId: channelId/externalId/channel 경로에서 UC… 추출", () => {
  assert.equal(extractChannelId('..."channelId":"UCdUcjkyZtf-1WJyPPiETF1g"...'), "UCdUcjkyZtf-1WJyPPiETF1g");
  assert.equal(extractChannelId('..."externalId":"UCeN2YeJcBCRJoXgzF_OU3qw"...'), "UCeN2YeJcBCRJoXgzF_OU3qw");
  assert.equal(extractChannelId("<a href=/channel/UCQNE2JmbasNYbjGAcuBiRRg>"), "UCQNE2JmbasNYbjGAcuBiRRg");
  assert.equal(extractChannelId("아무 채널ID 없음"), null);
});

test("inWindow: cutoff~today 포함 경계", () => {
  assert.ok(inWindow("2026-07-11", "2026-07-11", "2026-07-18")); // cutoff 포함
  assert.ok(inWindow("2026-07-18", "2026-07-11", "2026-07-18")); // today 포함
  assert.ok(!inWindow("2026-07-10", "2026-07-11", "2026-07-18"));
  assert.ok(!inWindow("2026-07-19", "2026-07-11", "2026-07-18"));
});
