/**
 * 뉴스·유튜브 탭 제거(2026-11-23 사용자 결정) 회귀 방지 — 소스 수준.
 *
 * 통합 '보고서' 탭 하나만 남기고, 뉴스·유튜브 탭 전용 화면·정기 작업·스냅샷 저장을 걷어 냈다.
 * 수집기가 읽는 설정·상태 파일(카테고리·차단·제외·본영상·재분류·제외 사이트)과 그 관리 API 는 남아야 한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (r: string) => fs.readFileSync(path.join(ROOT, r), "utf8");

test("화면: 뉴스·유튜브 탭과 그 보드가 없고 보고서 탭만 있다(예전 주소는 보고서로)", () => {
  const app = read("web/src/App.tsx");
  assert.doesNotMatch(app, /id: "news"|id: "youtube"|NewsBoard|YoutubeBoard/);
  assert.match(app, /id: "report"/);
  assert.match(app, /TAB_ALIASES[^\n]*news: "report", youtube: "report"/);
  assert.equal(fs.existsSync(path.join(ROOT, "web/src/components/NewsBoard.tsx")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "web/src/components/YoutubeBoard.tsx")), false);
});

test("서버: 뉴스·유튜브 탭 스냅샷 저장·조회·갱신 경로가 없다", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "src/news/news.ts")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "src/youtube/youtube.ts")), false);
  const routes = read("src/api/routes.ts");
  for (const p of ['"/news"', '"/news/refresh"', '"/news/status"', '"/youtube"', '"/youtube/refresh"', '"/youtube/status"', '"/youtube/move"']) {
    assert.doesNotMatch(routes, new RegExp(`api\\.(get|post)\\(${p.replace(/[/]/g, "\\/")},`), p);
  }
  assert.doesNotMatch(read("src/report/service.ts"), /news-latest|youtube-latest|applyNewsReportSnapshot/);
  assert.doesNotMatch(read("src/report/pipeline.ts"), /buildTabSnapshots|"tabs"/);
});

test("수집 설정·사용자 동작 API 는 남아 있다(보고서 탭 '수집 설정'·항목 동작이 쓴다)", () => {
  const routes = read("src/api/routes.ts");
  for (const p of [
    'api.get("/news/categories"',
    'api.get("/youtube/categories"',
    'api.post("/youtube/categories/:key/recommended-channels"',
    'api.post("/youtube/blocklist"',
    'api.post("/youtube/watched"',
    'api.post("/youtube/dismissed"',
    'api.post("/news/excluded-domains"',
    'api.post("/report/runs/:runId/move"',
  ]) {
    assert.ok(routes.includes(p), p);
  }
});

test("수집기는 사용자 설정·상태 파일을 모두 사본으로 읽는다(초기화·교체 없음)", () => {
  const cli = read("src/report/cli.ts");
  for (const f of [
    "news-categories.json",
    "youtube-categories.json",
    "youtube-blocklist.json",
    "youtube-dismissed.json",
    "youtube-watched.json",
    "youtube-reclass.json",
    "youtube-channels.json",
    "tab-settings.json",
    "news-excluded-domains.json",
    "news-reclass.json",
  ]) {
    assert.ok(cli.includes(`"${f}"`), f);
  }
});
