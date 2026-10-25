import { log } from "../util/log.ts";
import { tabTimeoutMs } from "../settings/tab-settings.ts";
import { runAgentQueryText } from "../util/agent-query.ts";
import { getAgentModel } from "../util/model-store.ts";
import { loadSummaries, saveSummary, summarySourceHash } from "./store.ts";
import type { SkillRankEntry, SkillRepo } from "../../shared/skills.ts";

/**
 * 스킬 저장소 한국어 요약(2~3줄).
 *
 * ── 무엇을 LLM 에게 시키지 않는가 ────────────────────────────────────────────
 * ★ **숫자는 절대 생성시키지 않는다.** star 수·순위·증가분은 전부 GitHub API 실측값과 우리
 *   DB 차분에서 나오고, LLM 은 "이 저장소가 어떤 스킬이고 무엇에 쓰는가"라는 **문장만** 쓴다.
 *   종합최저가 사건에서 배운 원칙 그대로다 — 검증 가능한 값과 생성된 문장은 경로를 분리한다.
 *   숫자 하나가 섞이는 순간 목록 전체의 신뢰도가 사라지고, 그게 맞는지 확인할 방법은 없다.
 *
 * ── 실패해도 목록이 비면 안 된다 ────────────────────────────────────────────
 * 요약에 실패한 항목은 summary=null 로 남고 화면이 원문 description 으로 폴백한다. 그래서 이
 * 모듈은 **예외를 밖으로 던지지 않는다** — 요약은 부가 가치이고, 랭킹은 요약 없이도 완결이다.
 */

/** 한 번의 LLM 호출에 넣는 저장소 수. 12건 × description 은 프롬프트가 넉넉히 소화한다. */
export const SKILLS_SUMMARY_BATCH = 12;

/** 요약 1건의 길이 상한(자). 카드 2~3줄에 들어가는 분량이다. */
const SUMMARY_MAX_CHARS = 220;

/**
 * 요약이 필요한 저장소를 고른다 — **byStars TOP 50 ∪ byGrowth TOP 50 중 원문이 바뀐 것만.**
 *
 * 캐시가 이 기능의 비용을 결정한다. 100건을 매주 무조건 재요약하면 원문이 한 글자도 안 바뀐
 * 저장소까지 LLM 을 다시 태우는데, 스킬 저장소의 description 은 몇 달에 한 번 바뀔까 말까 하다
 * (실제로 2회차부터는 대부분 0~5건이 될 것이다). 판정 근거는 source_hash 다(store.ts).
 */
export function pickSummaryTargets(
  byStars: SkillRankEntry[],
  byGrowth: SkillRankEntry[],
  cached: Map<number, { sourceHash: string | null }>
): SkillRepo[] {
  const seen = new Set<number>();
  const targets: SkillRepo[] = [];
  for (const entry of [...byStars, ...byGrowth]) {
    const repo = entry.repo;
    if (seen.has(repo.id)) continue;
    seen.add(repo.id);
    const hit = cached.get(repo.id);
    if (hit && hit.sourceHash === summarySourceHash(repo)) continue; // 원문 그대로 → 재요약 불필요
    targets.push(repo);
  }
  return targets;
}

/** 배치로 자른다. 마지막 배치는 짧을 수 있다. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function buildPrompt(repos: SkillRepo[]): string {
  const list = repos
    .map((r) => {
      const parts = [
        `- id: ${r.id}`,
        `  저장소: ${r.fullName}`,
        `  원문 설명: ${r.description ?? "(없음)"}`,
        `  주요 언어: ${r.language ?? "(불명)"}`,
        `  토픽: ${r.topics.slice(0, 8).join(", ") || "(없음)"}`,
      ];
      return parts.join("\n");
    })
    .join("\n");

  return `아래는 GitHub 의 "AI 에이전트 스킬" 관련 저장소 ${repos.length}개다.
각 저장소가 **어떤 스킬이고 무엇에 쓰는지** 한국어 2~3문장으로 설명해라.

${list}

작성 규칙:
- 반드시 한국어. 영문 설명도 번역해서 쓴다. 2~3문장, 한 항목당 ${SUMMARY_MAX_CHARS}자 이내.
- "무엇을 하는 스킬인가 / 누가 어떤 상황에 쓰는가" 두 가지가 드러나게 쓴다.
- ⚠️ **숫자를 지어내지 마라.** star 수, 순위, 증가분, 다운로드 수, 사용자 수를 절대 쓰지 마라.
  그 수치는 시스템이 API 실측값으로 따로 채운다. 요약문에 숫자가 들어가면 그 항목은 폐기된다.
- 원문 설명이 "(없음)"이면 저장소 이름·토픽·언어만으로 추정해 쓰되, 확실하지 않으면
  "…로 보인다" 처럼 단정하지 말고, 그래도 모르겠으면 그 항목의 summary 를 빈 문자열로 둔다.
- 홍보 문구·감탄사·마크다운 서식 없이 평서문으로만 쓴다.

출력 형식 — 아래 JSON 한 개만 출력한다(다른 텍스트 없이):
{"summaries":[{"id":<위 목록의 id 숫자>,"summary":"한국어 2~3문장"}]}`;
}

function extractJson(text: string): unknown {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e <= s) throw new Error("JSON 미발견");
  return JSON.parse(text.slice(s, e + 1));
}

/**
 * 응답 파싱. 요청한 id 집합 밖의 값·빈 문자열은 버린다.
 *
 * 순수 함수로 떼어 둔 이유는 하나다 — "LLM 이 숫자를 섞어 보내면 그 항목을 버린다"는 규칙을
 * 테스트로 못박기 위해서다. 이 규칙이 조용히 깨지면 화면의 숫자가 어디서 왔는지 알 수 없게 된다.
 */
export function parseSummaryResponse(text: string, allowedIds: Set<number>): Map<number, string> {
  const out = new Map<number, string>();
  const parsed = extractJson(text) as Record<string, unknown>;
  const rows = Array.isArray(parsed?.summaries) ? parsed.summaries : [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = Number(r.id);
    if (!Number.isFinite(id) || !allowedIds.has(id)) continue;
    const summary = typeof r.summary === "string" ? r.summary.trim() : "";
    if (!summary) continue;
    if (containsMetric(summary)) {
      // 지시를 어기고 수치를 섞은 문장은 채택하지 않는다. 원문 폴백이 거짓 숫자보다 낫다.
      log.warn(`스킬 요약에 수치가 섞여 폐기 (id=${id}): ${summary.slice(0, 80)}`);
      continue;
    }
    out.set(id, summary.slice(0, SUMMARY_MAX_CHARS));
  }
  return out;
}

/**
 * 요약문이 '지표 수치'를 담고 있는지.
 *
 * 모든 숫자를 막지는 않는다 — "3개 파일", "2단계" 같은 표현은 정상이고, 버전 번호도 유용하다.
 * 막아야 하는 것은 **우리가 실측값으로 채우는 지표**(star·순위·증가·포크·다운로드)를 LLM 이
 * 지어내는 경우다. 그래서 숫자 자체가 아니라 '숫자 + 지표 단어'의 결합만 잡는다.
 */
export function containsMetric(text: string): boolean {
  return METRIC_RE.test(text);
}

/** 우리가 실측값으로 채우는 지표 단어들. "별"은 넣지 않는다 — '특별·개별'에 걸려 오탐이 난다. */
const METRIC_WORD = "(?:stars?|스타|forks?|포크|다운로드|순위|랭킹|증가)";
/** "1,204", "3.2k", "17만" 같은 수량 표기. */
const METRIC_NUM = "\\d[\\d,.]*\\s*(?:k|만|천)?";
const METRIC_RE = new RegExp(
  // ① 숫자 → 지표 단어 ("1,204 stars", "500개 포크")
  `(?:${METRIC_NUM}\\s*(?:개의?\\s*)?${METRIC_WORD})` +
    // ② 지표 단어 → 숫자 ("star 1,204", "증가: 120", "포크 500개")
    `|(?:${METRIC_WORD}\\s*[:：]?\\s*${METRIC_NUM})` +
    // ③ 순위 표기 ("2위"). 뒤에 한글이 붙으면 '위치·위임' 같은 다른 낱말이라 제외한다.
    `|(?:\\d+\\s*위(?![가-힣]))`,
  "i"
);

/**
 * 대상 저장소들을 배치로 나눠 요약하고 DB 캐시에 저장한다.
 *
 * - 배치 1회 상한: 운영 설정 timeouts.skillsSummaryMin(기본 .env SKILLS_SUMMARY_TIMEOUT_MS = 5분)
 * - 전체 예산: 운영 설정 timeouts.skillsBudgetMin(기본 .env SKILLS_SUMMARY_BUDGET_MS = 20분) — 넘기면 남은 배치를 건너뛴다.
 *   요약이 덜 끝나도 목록은 원문으로 채워지므로, 예산 초과로 랭킹 전체를 늦추지 않는다.
 *
 * @returns 이번에 새로 만든 요약(repo_id → summary)
 */
export async function summarizeSkillRepos(targets: SkillRepo[]): Promise<Map<number, string>> {
  const made = new Map<number, string>();
  if (targets.length === 0) {
    log.info("스킬 요약 — 원문이 바뀐 저장소가 없어 LLM 호출 없음(캐시 적중)");
    return made;
  }

  const batches = chunk(targets, SKILLS_SUMMARY_BATCH);
  const startedAt = Date.now();
  // 시작 시점에 한 번 읽는다 — 한 회차 안에서 예산이 바뀌면 '남은 예산' 계산이 흔들린다.
  const batchMs = tabTimeoutMs("skillsSummaryMin");
  const budgetMs = tabTimeoutMs("skillsBudgetMin");
  log.info(`스킬 요약 시작 — ${targets.length}건 / ${batches.length}배치 (모델 ${getAgentModel()})`);

  for (const [i, batch] of batches.entries()) {
    const spent = Date.now() - startedAt;
    if (spent >= budgetMs) {
      log.warn(
        `스킬 요약 전체 예산 소진(${Math.round(spent / 1000)}초) — 남은 ${batches.length - i}배치 건너뜀. ` +
          "해당 항목은 원문 설명으로 표시된다."
      );
      break;
    }
    const ids = new Set(batch.map((r) => r.id));
    try {
      const text = await runAgentQueryText(
        buildPrompt(batch),
        {
          // tools:[] = 내장 도구 전체 비활성. 손에 든 description 을 옮기는 단일 완성 호출이라
          // 웹을 돌 이유가 없고, 도구를 열면 외부 페이지 프롬프트 인젝션 경로가 생긴다.
          tools: [],
          permissionMode: "bypassPermissions",
          settingSources: [],
          maxTurns: 1,
          model: getAgentModel(), // 대시보드에서 고른 수집·큐레이션 공통 모델
          systemPrompt:
            "너는 개발자 도구를 한국어로 설명하는 기술 문서 작성자다. 지정된 JSON 한 개만 출력하고, " +
            "star 수·순위·증가분 같은 수치는 절대 지어내지 않는다.",
        },
        // 남은 예산과 배치 상한 중 작은 쪽. 예산이 3분 남았는데 5분을 주면 그 배치가 예산을 넘긴다.
        Math.max(30_000, Math.min(batchMs, budgetMs - spent)),
        `스킬 요약 ${i + 1}/${batches.length}`
      );
      const parsed = parseSummaryResponse(text, ids);
      for (const [id, summary] of parsed) {
        const repo = batch.find((r) => r.id === id);
        if (!repo) continue;
        made.set(id, summary);
        try {
          saveSummary(id, summary, summarySourceHash(repo));
        } catch (e) {
          log.warn(`스킬 요약 저장 실패 (id=${id}): ${(e as Error).message}`);
        }
      }
      log.info(`스킬 요약 배치 ${i + 1}/${batches.length} — ${parsed.size}/${batch.length}건 채택`);
    } catch (e) {
      // 배치 하나가 죽어도 나머지는 계속한다. 실패한 항목은 summary=null 로 남아 원문 폴백된다.
      log.warn(`스킬 요약 배치 ${i + 1}/${batches.length} 실패: ${(e as Error).message}`);
    }
  }

  log.info(
    `스킬 요약 완료 — ${made.size}/${targets.length}건 (${Math.round((Date.now() - startedAt) / 1000)}초)`
  );
  return made;
}

/**
 * 랭킹 항목에 요약을 붙인다(캐시 + 이번에 만든 것). 없는 항목은 null 로 남는다.
 *
 * ⚠️ SkillRepo 객체를 **제자리에서 고치지 않고** 새 객체를 만든다. 같은 repo 객체가 byStars 와
 *    byGrowth 양쪽 항목에 공유돼 있어 제자리 수정은 괜찮아 보이지만, 이 스냅샷은 JSON 으로
 *    디스크에 저장되고 다음 회차의 입력이 되기도 한다 — 입력을 변형하지 않는 편이 안전하다.
 */
export function attachSummaries(
  entries: SkillRankEntry[],
  summaries: Map<number, string>
): SkillRankEntry[] {
  return entries.map((e) => ({
    ...e,
    repo: { ...e.repo, summary: summaries.get(e.repo.id) ?? null },
  }));
}

/**
 * 캐시 + 신규 요약을 합친 맵을 만든다. 캐시는 해시가 일치하는 것만 쓴다 —
 * 원문이 바뀌었는데 요약 생성이 실패했다면, 낡은 요약을 붙이는 것보다 원문을 보여주는 게 낫다.
 */
export function mergeSummaries(
  repos: SkillRepo[],
  cached: Map<number, { summary: string; sourceHash: string | null }>,
  fresh: Map<number, string>
): Map<number, string> {
  const out = new Map<number, string>();
  for (const repo of repos) {
    const made = fresh.get(repo.id);
    if (made) {
      out.set(repo.id, made);
      continue;
    }
    const hit = cached.get(repo.id);
    if (hit && hit.sourceHash === summarySourceHash(repo)) out.set(repo.id, hit.summary);
  }
  return out;
}

/** 요약 캐시 조회 래퍼(호출부가 store 를 직접 import 하지 않게). */
export function loadSummaryCache(ids: number[]): Map<number, { summary: string; sourceHash: string | null }> {
  return loadSummaries(ids);
}
