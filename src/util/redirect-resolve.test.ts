// 검색 경유 주소 → 원래 기사 주소. 실제 형태(2026-11-28 운영 보고서에 저장된 vertexaisearch 주소, Google 이 실제로 돌려준
// 302 응답 헤더)를 로컬 HTTP 서버로 재현해 Node fetch(redirect: "manual")가 Location 을 그대로 주는지까지 확인한다.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  __clearRedirectHintsForTest,
  hintDomain,
  redirectHint,
  rememberRedirectHints,
  resolveRedirect,
  resolveRedirects,
  summarizeResolutions,
} from "./redirect-resolve.ts";
import { loadAgyRedirectHints, parseAgyStream } from "./antigravity-query.ts";

const BASE = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/";
// 운영 보고서(runs/20261128T000000Z-8ae7)에 실제로 저장된 토큰과 그 주소가 2026-11-28 17:09 KST 에 돌려준 Location.
const PUDU_TOKEN =
  "AUZIYQGQGIPDPMCXYqC-BSHLiuWIPXk24ZeXjxfiXAkXsUuJXgm5OTdtUamOC4jYAVhHPE1NcH9scV0rank8dzm6Ofhr_MeEG3BltsS4seykDiCWrBfwWrKom-yNX-h6qEF_AjeNv3HShyRzePXlP7ta6oVeX6kkZOfz9xShPMH8P8jwz7kVICMlE1qw8qBW2TXkhHtQ6S1lON6u-ySK0s2_TfKRyA8WvRYc2LoMPpESKT8x6IIRCEsMMgduxHIZo76Hdz2WrEsg3tysoR_hV0950uCY13E23jSezShh2mMxeHao41C__U4=";
const PUDU_TARGET =
  "https://www.prnewswire.com/apac/news-releases/pudu-robotics-accelerates-apac-and-middle-east-expansion-with-300-growth-and-strengthened-strategic-partnerships-302951721.html";

const requests: { method: string; path: string }[] = [];
let server: http.Server;
let origin = "";

before(async () => {
  server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "", path: req.url ?? "" });
    const token = (req.url ?? "").replace("/grounding-api-redirect/", "");
    // Google 실제 302 응답 헤더 모양(curl -I 로 본 것)
    const redirect = (to: string) => {
      res.writeHead(302, {
        location: to,
        "x-robots-tag": "noindex",
        "content-type": "text/html; charset=UTF-8",
        server: "scaffolding on HTTPServer2",
      });
      res.end(req.method === "HEAD" ? undefined : `<HTML><HEAD><TITLE>Redirecting</TITLE></HEAD><BODY><A HREF="${to}">here</A></BODY></HTML>`);
    };
    if (token === PUDU_TOKEN) return redirect(PUDU_TARGET);
    if (token === "HEAD405") {
      if (req.method === "HEAD") {
        res.writeHead(405);
        return res.end();
      }
      return redirect("https://www.cnn.com/2026/11/27/tech/openai-apple-countersuit");
    }
    if (token === "RELATIVE") return redirect("/grounding-api-redirect/" + PUDU_TOKEN); // 경유 → 경유(상대 주소)
    if (token === "LOOP") return redirect("/grounding-api-redirect/LOOP");
    if (token === "SLOW") return; // 응답 없음 → 시간 제한
    res.writeHead(404, { "content-type": "text/html" });
    res.end("Not Found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

/** 경유 주소 호스트만 로컬 서버로 돌리는 진짜 fetch. 기사 사이트로 가는 요청이 있으면 실패시킨다. */
const localFetch: typeof fetch = (input, init) => {
  const url = String(input);
  if (!url.startsWith("https://vertexaisearch.cloud.google.com/")) throw new Error(`기사 사이트 요청 금지: ${url}`);
  return fetch(url.replace("https://vertexaisearch.cloud.google.com", origin), init);
};

test("vertexaisearch 경유 주소: HEAD 의 302 Location 을 읽어 원래 기사 주소로(기사 사이트에는 요청하지 않음)", async () => {
  requests.length = 0;
  const r = await resolveRedirect(BASE + PUDU_TOKEN, { fetchImpl: localFetch, timeoutMs: 2000 });
  assert.deepEqual(r, { original: BASE + PUDU_TOKEN, url: PUDU_TARGET, domain: null, how: "redirect" });
  assert.deepEqual(requests.map((x) => x.method), ["HEAD"]);
});

test("HEAD 를 안 받으면 GET 으로 한 번 더, 경유→경유(상대 Location)는 이어서 푼다", async () => {
  const a = await resolveRedirect(BASE + "HEAD405", { fetchImpl: localFetch, timeoutMs: 2000 });
  assert.equal(a?.url, "https://www.cnn.com/2026/11/27/tech/openai-apple-countersuit");
  const b = await resolveRedirect(BASE + "RELATIVE", { fetchImpl: localFetch, timeoutMs: 2000 });
  assert.equal(b?.url, PUDU_TARGET);
  const loop = await resolveRedirect(BASE + "LOOP", { fetchImpl: localFetch, timeoutMs: 2000, maxHops: 2 });
  assert.equal(loop?.url, null);
  assert.equal(loop?.how, "failed");
});

test("만료(404)·시간 초과: 원래 주소 없음 → 검색 결과 도메인 힌트가 있으면 hint, 없으면 failed", async () => {
  __clearRedirectHintsForTest();
  const gone = await resolveRedirect(BASE + "EXPIRED", { fetchImpl: localFetch, timeoutMs: 2000 });
  assert.equal(gone?.how, "failed");
  assert.equal(gone?.url, null);
  assert.match(gone?.error ?? "", /Location/);
  const t0 = Date.now();
  const slow = await resolveRedirect(BASE + "SLOW", {
    fetchImpl: localFetch,
    timeoutMs: 300,
    hint: (u) => (u.endsWith("SLOW") ? "bnnbloomberg.ca" : null),
  });
  assert.ok(Date.now() - t0 < 3000, "시간 제한 안에 끝난다(HEAD+GET 각 300ms)");
  assert.deepEqual({ url: slow?.url, domain: slow?.domain, how: slow?.how }, { url: null, domain: "bnnbloomberg.ca", how: "hint" });
});

test("여러 건: 경유 주소만, 중복 없이, 동시성 제한 안에서", async () => {
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const fake: typeof fetch = async (input) => {
    calls++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    const n = String(input).split("/").pop();
    return new Response(null, { status: 302, headers: { location: `https://site${n}.example/article` } });
  };
  const urls = [
    ...Array.from({ length: 10 }, (_, i) => `${BASE}T${i}`),
    `${BASE}T0`, // 중복
    "https://www.reuters.com/technology/x/", // 원래 주소 — 요청 안 함
  ];
  const res = await resolveRedirects(urls, { fetchImpl: fake, concurrency: 3 });
  assert.equal(res.size, 10);
  assert.equal(calls, 10);
  assert.ok(peak <= 3, `동시 요청 ${peak}`);
  assert.equal(res.get(`${BASE}T3`)?.url, "https://sitet3.example/article");
  assert.equal(summarizeResolutions(res), "경유 주소 10건 → 원래 주소 10건");
});

test("google.com/url 등 파라미터 경유 주소는 요청 없이 푼다(Opus·GPT 응답에 섞여도 같은 처리)", async () => {
  const never: typeof fetch = async () => {
    throw new Error("요청하면 안 됨");
  };
  const r = await resolveRedirect("https://www.google.com/url?sa=t&url=https%3A%2F%2Fwww.theverge.com%2Fx", { fetchImpl: never });
  assert.deepEqual({ url: r?.url, how: r?.how }, { url: "https://www.theverge.com/x", how: "param" });
  assert.equal(await resolveRedirect("https://www.theverge.com/x", { fetchImpl: never }), null);
});

test("Gemini 검색 결과의 [도메인](경유 주소) 짝을 도메인 힌트로 기억한다(agy 대화 기록 실제 형식)", () => {
  __clearRedirectHintsForTest();
  assert.equal(hintDomain("www.YouTube.com"), "youtube.com");
  assert.equal(hintDomain("Reuters"), null, "이름은 도메인이 아니다");
  // transcript_full.jsonl 한 줄(2026-11-28 search_web 결과 형식 — content 는 JSON 문자열)
  const line = JSON.stringify({
    step_index: 13,
    source: "MODEL",
    type: "GENERIC",
    status: "DONE",
    content:
      `The search for "Pudu Robotics" returned the following summary:\n푸두 로보틱스…[1]\n\nSources:\n[1] [prnewswire.com](${BASE}${PUDU_TOKEN})\n[2] [Reuters](${BASE}NAMEONLY)\n\nNote: Source URLs are HTTP redirects; check where they resolve if you need the direct link.`,
  });
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), "agy-brain-"));
  try {
    const id = "9c441362-e1dd-4f1e-b9c3-c17fbade49bb";
    const dir = path.join(brain, id, ".system_generated", "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "transcript_full.jsonl"), line + "\n");
    assert.equal(loadAgyRedirectHints(id, brain), 1);
    assert.equal(redirectHint(BASE + PUDU_TOKEN), "prnewswire.com");
    assert.equal(redirectHint(BASE + "NAMEONLY"), null);
    assert.equal(loadAgyRedirectHints("../../etc", brain), 0, "대화 ID 형식이 아니면 읽지 않는다");
    assert.equal(loadAgyRedirectHints("00000000-0000-0000-0000-000000000000", brain), 0, "기록 없으면 0");
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
  assert.equal(rememberRedirectHints("[youtube.com](https://example.com/not-vertex)"), 0);
});

test("agy stream-json 에서 대화 ID 를 읽는다(검색 결과 본문은 stream 에 없다)", () => {
  const stream = [
    { event: "init", conversation_id: "9c441362-e1dd-4f1e-b9c3-c17fbade49bb", init: { model: "gemini-4-neon-xhigh" } },
    {
      event: "step_update",
      step_update: { conversation_id: "9c441362-e1dd-4f1e-b9c3-c17fbade49bb", step_index: 2, state: "DONE", step_type: "tool", tool_name: "search_web", tool_info: { name: "search_web", parameters: { query: "Anthropic IPO Nasdaq" } } },
    },
    { event: "result", result: { status: "SUCCESS", response: `{"link":"${BASE}${PUDU_TOKEN}"}` } },
  ]
    .map((x) => JSON.stringify(x))
    .join("\n");
  const p = parseAgyStream(stream);
  assert.equal(p.conversationId, "9c441362-e1dd-4f1e-b9c3-c17fbade49bb");
  assert.equal(p.initModel, "gemini-4-neon-xhigh");
  assert.equal(p.tools.length, 1);
});
