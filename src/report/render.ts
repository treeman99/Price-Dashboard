import type { ReportGroup } from "./merge.ts";
import { MODEL_SHORT, OUTCOME_LABEL } from "./models.ts";
import { formatWindowKst, kstShort } from "../util/recency.ts";
import { linkSite, UNRESOLVED_LINK_LABEL } from "../../shared/redirect-url.ts";
import type { CategoryInfo, EditorRecord, ModelRunRecord, RawData, SharedSeedVideo } from "./pipeline.ts";

export interface RenderInput {
  now: Date;
  runId: string;
  runDir: string;
  preview: boolean;
  models: ModelRunRecord[];
  editor: EditorRecord;
  groups: ReportGroup[];
  seedsOnly: SharedSeedVideo[];
  counts: { before: number; outOfWindow?: number; excludedByUser?: number; afterMerge: number; alreadyReported: number; reported: number; seedsOnly: number };
  raw: RawData;
  /** 유튜브 조사 기간(시간). */
  freshHours: number;
  /** 실행 시점 기준 조사 구간(시각 단위). 없으면(예전 호출) 구간 문구를 시간 수로만 적는다. */
  windows?: { news: { start: Date; end: Date; hours: number }; youtube: { start: Date; end: Date; hours: number } };
  lastSuccessAt: string | null;
  categories: CategoryInfo;
}

const KST_FMT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Asia/Seoul 기준 사람이 읽는 시각. */
export function kst(d: Date | string | null): string {
  if (!d) return "-";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return String(d);
  return `${KST_FMT.format(date)} KST`;
}

/** 마크다운 표·목록을 깨뜨리는 문자를 무력화한다(외부 텍스트는 데이터일 뿐이다). */
function md(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "／")
    .replace(/([*_`[\]<>])/g, "\\$1")
    .trim();
}

/** 링크 뒤 사이트 표기: " (도메인)" 또는 검색 경유 주소를 못 풀었으면 " (도메인 · 원래 주소 확인 불가)". */
function siteNote(url: string | null | undefined, hintDomain?: string | null): string {
  const x = linkSite(url, hintDomain);
  if (x.unresolved) return ` (${x.domain ? `${md(x.domain)} · ` : ""}${UNRESOLVED_LINK_LABEL})`;
  return x.domain ? ` (${md(x.domain)})` : "";
}

function link(label: string, url: string | null | undefined): string {
  if (!url || !/^https?:\/\//.test(url)) return md(label);
  return `[${md(label) || "링크"}](${url.replace(/\)/g, "%29").replace(/\s/g, "%20")})`;
}

/** 발행·업로드 시각 표기: "11/23 08:30" — 시각을 모르면 "11/23(시각 미확인)". */
function whenOf(it: { date: string; publishedAt?: string | null; timeApprox?: boolean }): string {
  if (it.publishedAt && !it.timeApprox) return md(kstShort(it.publishedAt));
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(it.date);
  return `${m ? `${Number(m[1])}/${Number(m[2])}` : md(it.date)}(시각 미확인)`;
}

function foundBy(g: ReportGroup): string {
  return g.models.map((m) => MODEL_SHORT[m] ?? m).join(", ");
}

export function renderReport(r: RenderInput): string {
  const succeeded = r.models.filter((m) => m.outcome === "success");
  const skipped = r.models.filter((m) => m.outcome !== "success");
  const L: string[] = [];
  L.push(`# IT 뉴스·유튜브 통합 보고서${r.preview ? " (미리보기 — 운영 기록에 반영 안 됨)" : ""}`);
  L.push("");
  L.push(`- 보고 시각: ${kst(r.now)} (Asia/Seoul)`);
  L.push(`- 실행 ID: \`${r.runId}\` · 보존 위치: \`${r.runDir}\``);
  if (!succeeded.length) {
    L.push(`- **통합 실패**: 세 모델이 모두 건너뛰어져 보고서를 만들지 못했습니다. 증분 기준 시점은 진행하지 않았습니다(다음 실행이 같은 구간을 다시 수집).`);
  } else if (skipped.length) {
    L.push(
      `- **부분 결과**: ${r.models.length}개 모델 중 ${succeeded.length}개 성공. 건너뛴 모델(${skipped
        .map((m) => m.spec.label)
        .join(", ")})의 독립 취합은 이 보고서에 반영되지 않았습니다.`
    );
  } else {
    L.push(`- 통합 상태: ${r.models.length}개 모델 모두 독립 취합 성공`);
  }

  // ── 모델별 상태 ──
  L.push("");
  L.push("## 모델별 상태");
  L.push("");
  L.push("| 모델 | 모델 ID (요청 → 응답 기록) | 상태 | 사유 | 뉴스/영상 | 검색·열람 근거 |");
  L.push("|---|---|---|---|---|---|");
  for (const m of r.models) {
    const actual = m.actualModels.length ? m.actualModels.join(", ") : m.outcome === "success" ? "응답에 표기 없음" : "-";
    L.push(
      `| ${m.spec.label} | \`${m.spec.model}\` → ${actual} | ${OUTCOME_LABEL[m.outcome]} | ${md(m.reason).slice(0, 220) || "-"} | ${
        m.outcome === "success" ? `${m.newsCount} / ${m.youtubeCount}` : "-"
      } | 도구 호출 ${m.toolCalls}회 |`
    );
  }
  L.push("");
  L.push(
    `- 편집 모델: ${r.editor.spec ? `${r.editor.spec.label} (\`${r.editor.spec.model}\`)` : "없음"}${r.editor.note ? ` — ${md(r.editor.note)}` : ""}`
  );
  const failedEditors = r.editor.attempts.filter((a) => !a.ok);
  if (failedEditors.length) L.push(`- 편집 실패 시도: ${failedEditors.map((a) => `\`${a.model}\` ${md(a.error)}`).join(" / ")}`);
  L.push(
    `- 중복 제거: 통합 전 ${r.counts.before}건${r.counts.outOfWindow ? ` → 조사 구간 밖 ${r.counts.outOfWindow}건 제외` : ""}${r.counts.excludedByUser ? ` → 사용자 취합 제외 ${r.counts.excludedByUser}건 제외` : ""} → 통합 후 ${r.counts.afterMerge}건 → 이미 보고된 ${r.counts.alreadyReported}건 제외 후 **${r.counts.reported}건**${
      r.counts.seedsOnly ? ` (+ 모델 미선정 추천 채널 업로드 ${r.counts.seedsOnly}건 별도)` : ""
    }`
  );
  const actionNeeded = r.models.filter((m) => m.outcome === "skipped-error");
  if (actionNeeded.length) {
    L.push(`- **조치 필요**: ${actionNeeded.map((m) => `${m.spec.label} — ${md(m.reason).slice(0, 200)}`).join(" / ")}`);
  }

  // ── 수집 범위 ──
  L.push("");
  L.push("## 수집 범위");
  L.push("");
  const nw = r.windows?.news;
  const yw = r.windows?.youtube;
  L.push(
    `- 뉴스: **${nw ? formatWindowKst(nw) : "최근 24시간"}** (실행 시점 기준 최근 ${nw?.hours ?? 24}시간, **발행 시각 단위**로 판정) — 카테고리 ${r.categories.news.length}개(${r.categories.news
      .map((c) => md(c.label))
      .join(", ")}).`
  );
  L.push(
    "  - 발행 시각을 확인하지 못한 기사는 날짜만으로 보수적으로 판정한다: 그 날 전체가 구간 안인 날짜(대개 오늘)만 싣고 '시각 미확인'으로 표시, 그 밖의 날짜는 뺀다."
  );
  const gn = r.raw.geekNews;
  L.push(
    `- GeekNews 공식 피드: ${gn.ok ? `${kst(gn.since)} 초과 ~ ${kst(gn.until)} 등록 글 ${gn.entries.length}건(커뮤니티 등록 시각, 원문 발행 시각과 다를 수 있음)` : `수집 실패 — ${md(gn.error)}`}`
  );
  L.push(
    `- 유튜브: **${yw ? formatWindowKst(yw) : `최근 ${r.freshHours}시간`}** (실행 시점 기준 최근 ${yw?.hours ?? r.freshHours}시간, **업로드 시각 단위** — 서버가 watch 페이지의 실제 업로드 시각으로 재검증) — 카테고리 ${r.categories.youtube.length}개, 채널 차단·제외 영상·본영상·제외 키워드·지역(한국 전용)·Shorts·라이브 규칙 적용.`
  );
  L.push(
    `- 증분: 위 구간 안에서 이전 보고서에 이미 실린 링크·영상(${r.counts.alreadyReported}건)은 제외했습니다${r.lastSuccessAt ? `(직전 성공 보고 ${kst(r.lastSuccessAt)})` : "(첫 성공 실행)"}.`
  );
  if (r.lastSuccessAt && r.now.getTime() - Date.parse(r.lastSuccessAt) > 24 * 3_600_000) {
    const gapEnd = new Date(r.now.getTime() - 24 * 3_600_000);
    L.push(
      `- ⚠️ 범위 공백: 직전 성공(${kst(r.lastSuccessAt)}) 이후 24시간을 넘는 구간(${kst(r.lastSuccessAt)} ~ ${kst(gapEnd)})은 조사 구간(실행 시점 기준 최근 24시간) 밖이라 확인하지 못했습니다.`
    );
  }

  if (!succeeded.length) {
    L.push("");
    L.push("## 수집 실패·확인 불가");
    L.push("");
    for (const s of r.raw.sources.filter((x) => !x.ok)) L.push(`- 원자료 실패: ${md(s.label)} — ${md(s.error)}`);
    L.push(`- 모델 결과가 없어 뉴스·유튜브 항목을 싣지 않았습니다. 중간 결과와 오류 원문은 \`${r.runDir}/models/\` 에 있습니다.`);
    return `${L.join("\n")}\n`;
  }

  // ── 핵심 요약 ──
  L.push("");
  L.push("## 핵심 요약");
  L.push("");
  if (!r.groups.length) {
    L.push("- 직전 보고 이후 새 항목이 없습니다.");
  } else if (r.editor.highlights.length) {
    for (const h of r.editor.highlights) L.push(`- ${md(h)}`);
  } else {
    for (const g of r.groups.slice(0, 5)) L.push(`- ${md(g.rep.title)}`);
  }

  const section = (kind: "news" | "youtube", title: string, cats: { key: string; label: string }[]) => {
    const list = r.groups.filter((g) => g.rep.kind === kind);
    L.push("");
    L.push(`## ${title}`);
    L.push("");
    if (!list.length) {
      L.push("- 새 항목 없음");
      return;
    }
    const order = new Map(cats.map((c, i) => [c.key, i]));
    const byCat = new Map<string, ReportGroup[]>();
    for (const g of list) {
      const arr = byCat.get(g.rep.categoryKey) ?? [];
      arr.push(g);
      byCat.set(g.rep.categoryKey, arr);
    }
    const keys = [...byCat.keys()].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
    for (const k of keys) {
      const gs = byCat.get(k)!;
      L.push(`### ${md(gs[0].rep.categoryLabel)}`);
      L.push("");
      for (const g of gs) {
        const it = g.rep;
        const upd = g.update ? " _(이전 보고 이후 새 출처)_" : "";
        if (kind === "news") {
          L.push(`- **${md(it.title)}**${upd}`);
          L.push(`  - ${md(it.summary)}`);
          L.push(`  - 출처: ${link(it.source || "원문", it.url)}${siteNote(it.url, it.sourceDomain)} · 발행 ${whenOf(it)} · 찾은 모델: ${foundBy(g)}`);
        } else {
          L.push(`- **${md(it.title)}**${upd} — ${md(it.source)}, 업로드 ${whenOf(it)}`);
          L.push(`  - ${md(it.summary)} _(제목·설명·검색 결과 기준 요약, 영상 본문은 시청하지 않음)_`);
          L.push(`  - ${link("영상 보기", it.url)} · 찾은 모델: ${foundBy(g)}`);
        }
        if (g.secondary.length) {
          const unresolvedOnly = (u: string, d?: string | null) => (linkSite(u, d).unresolved ? siteNote(u, d) : "");
          L.push(`  - 보조 출처: ${g.secondary.map((s) => link(s.label, s.link) + unresolvedOnly(s.link, s.domain)).join(" · ")}`);
        }
        if (g.conflict) L.push(`  - ⚠️ 근거 차이: ${md(g.conflict)}`);
      }
      L.push("");
    }
  };
  section("news", "주요 뉴스", r.categories.news);
  section("youtube", "유튜브 동향", r.categories.youtube);

  if (r.seedsOnly.length) {
    L.push("");
    L.push("## 추천 채널 신규 업로드 (모델 미선정, RSS 기준)");
    L.push("");
    L.push("세 모델 모두 고르지 않았지만 price 유튜브 탭 추천 채널 RSS 에 창 안 업로드로 올라온 영상입니다(내용 미확인, 제목 기준).");
    L.push("");
    const ytLabel = new Map(r.categories.youtube.map((c) => [c.key, c.label]));
    for (const v of r.seedsOnly.slice(0, 30)) {
      L.push(`- ${link(v.title, `https://www.youtube.com/watch?v=${v.videoId}`)} — ${md(v.channel)}, ${md(v.date)} · ${md(ytLabel.get(v.categoryKey) ?? v.categoryKey)}`);
    }
    if (r.seedsOnly.length > 30) L.push(`- 외 ${r.seedsOnly.length - 30}건은 \`raw/youtube-seeds.json\` 참고`);
  }

  // ── 실패·확인 불가 ──
  L.push("");
  L.push("## 수집 실패·확인 불가");
  L.push("");
  const failedSources = r.raw.sources.filter((s) => !s.ok);
  const okSources = r.raw.sources.filter((s) => s.ok);
  L.push(`- 공용 원자료: 성공 ${okSources.length}곳 / 실패 ${failedSources.length}곳 (실패한 출처는 성공으로 기록하지 않아 다음 실행이 그 구간을 다시 조회)`);
  for (const s of failedSources.slice(0, 20)) L.push(`  - ${md(s.label)}: ${md(s.error) || "응답 없음"}`);
  for (const m of skipped) L.push(`- ${m.spec.label}: ${OUTCOME_LABEL[m.outcome]} — ${md(m.reason).slice(0, 300)}`);
  L.push("- 유튜브 요약은 제목·설명·검색 결과에 근거하며 영상 본문을 시청한 것이 아닙니다.");
  L.push(`- 모델별 중간 결과·검색 근거: \`${r.runDir}/models/<모델>/\`, 통합 근거: \`${r.runDir}/merge.json\``);
  return `${L.join("\n")}\n`;
}
