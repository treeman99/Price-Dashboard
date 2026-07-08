import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import type { YoutubeReclass, YoutubeCategoryDef } from "../../shared/types.ts";

/**
 * 사용자 재분류 피드백 저장소.
 * 사용자가 카드를 다른 카테고리로 옮기면 그 사례를 기록하고,
 * 다음 수집 프롬프트(buildPrompt)에 few-shot 규칙으로 주입해 큐레이터 분류를 교정한다.
 * 영상은 매주 바뀌므로 videoId가 아니라 "제목+채널" 패턴을 학습 신호로 남긴다.
 */
const RECLASS_PATH = path.join(path.dirname(config.dbPath), "youtube-reclass.json");

/** 파일에 유지할 최대 기록 수(오래된 것부터 버림). */
const MAX_RECORDS = 60;
/** 프롬프트에 주입할 최근 규칙 수(과다 주입으로 인한 지시 희석 방지). */
const PROMPT_LIMIT = 25;

let memo: YoutubeReclass[] | null = null;

/** 제목/채널 정규화(소문자+공백정리) → 재이동 시 같은 항목으로 덮어쓰기 위한 키. */
function reclassKey(title: string, channel: string): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return `${norm(title)}::${norm(channel)}`;
}

function save(list: YoutubeReclass[]): void {
  try {
    fs.mkdirSync(path.dirname(RECLASS_PATH), { recursive: true });
    fs.writeFileSync(RECLASS_PATH, JSON.stringify(list, null, 2));
  } catch (e) {
    log.warn(`유튜브 재분류 기록 저장 실패: ${(e as Error).message}`);
  }
}

/** 재분류 기록 목록(없으면 빈 배열). */
export function loadReclass(): YoutubeReclass[] {
  if (memo) return memo;
  try {
    if (fs.existsSync(RECLASS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(RECLASS_PATH, "utf8"));
      if (Array.isArray(parsed)) {
        memo = parsed as YoutubeReclass[];
        return memo;
      }
    }
  } catch (e) {
    log.warn(`유튜브 재분류 기록 로드 실패 → 빈 목록 사용: ${(e as Error).message}`);
  }
  memo = [];
  return memo;
}

export interface AddReclassInput {
  title: string;
  channel: string;
  fromKey: string;
  fromLabel: string;
  toKey: string;
  toLabel: string;
  /** 이동 시각(ISO). 호출부에서 주입(테스트 결정성). */
  movedAt: string;
}

/** 재분류 기록 추가. 같은 (제목+채널)은 최신 이동으로 덮어쓰고, 상한 초과분은 오래된 것부터 버린다. */
export function addReclass(input: AddReclassInput): YoutubeReclass {
  const list = loadReclass();
  const id = reclassKey(input.title, input.channel);
  const entry: YoutubeReclass = {
    id,
    title: input.title.trim().slice(0, 200),
    channel: input.channel.trim().slice(0, 80),
    fromKey: input.fromKey,
    fromLabel: input.fromLabel,
    toKey: input.toKey,
    toLabel: input.toLabel,
    movedAt: input.movedAt,
  };
  // 같은 항목 제거 후 맨 뒤에 추가(최신이 뒤). 상한 초과 시 앞(오래된 것)부터 버림.
  const next = list.filter((r) => r.id !== id);
  next.push(entry);
  const trimmed = next.slice(-MAX_RECORDS);
  save(trimmed);
  memo = trimmed;
  log.info(`유튜브 재분류 기록: "${entry.title}" ${entry.fromLabel} → ${entry.toLabel}`);
  return entry;
}

/**
 * 프롬프트용 재분류 규칙 섹션. 현재 존재하는 카테고리(defs)로 라벨을 최신화하고,
 * 출발/도착 중 하나라도 사라진 카테고리면 건너뛴다. 최근 PROMPT_LIMIT개만 사용.
 */
export function buildReclassSection(defs: YoutubeCategoryDef[]): string {
  const list = loadReclass();
  if (!list.length) return "";
  const labelByKey = new Map(defs.map((d) => [d.key, d.label]));
  const lines: string[] = [];
  // 최신 규칙이 뒤에 있으므로 뒤에서부터 취해 최근 것을 우선 노출.
  for (let i = list.length - 1; i >= 0 && lines.length < PROMPT_LIMIT; i--) {
    const r = list[i];
    const from = labelByKey.get(r.fromKey);
    const to = labelByKey.get(r.toKey);
    if (!from || !to || from === to) continue; // 사라진 카테고리는 규칙에서 제외
    lines.push(`  - "${r.title}" (${r.channel}) 같은 영상 → '${from}'가 아니라 '${to}'에 넣어라.`);
  }
  if (!lines.length) return "";
  return (
    `\n\n📌 사용자 재분류 규칙(반드시 준수 — 과거에 사용자가 직접 카드를 옮긴 사례에서 학습):\n` +
    lines.join("\n") +
    `\n  위 사례의 제목·채널·주제와 비슷한 영상은 사용자가 지정한 카테고리 쪽으로 분류하라.`
  );
}
