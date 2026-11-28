import fs from "node:fs";
import path from "node:path";
import type { DailyReportJson } from "../../shared/report.ts";
import { isRedirectUrl } from "../../shared/redirect-url.ts";
import { canonicalUrl, linkKeys } from "./merge.ts";
import { resolveRedirects, type ResolveOptions } from "../util/redirect-resolve.ts";

/**
 * 지난 실행의 경유 주소 풀이 기록 — `runs/<runId>/link-resolutions.json`.
 *
 * 2026-11-28 이전 실행의 report.json 에는 Gemini 검색 경유 주소(vertexaisearch…)가 그대로 들어 있다. 원본 기록은
 * 고치지 않고(봇 홈 산출물은 불변 — report-moves.json 과 같은 덧씌우기 방식) 풀어 낸 원래 주소를 이 파일에 따로 두고,
 * price 가 화면·메일에서 report.json 위에 덧씌운다. 항목 키(key)는 바꾸지 않는다(카테고리 이동 기록이 키에 묶여 있다).
 * 풀지 못한(만료 등) 주소는 그대로 두고 기록만 남긴다. 새 실행은 수집 단계에서 이미 풀린 주소를 저장한다.
 */
export const LINK_RESOLUTIONS_FILE = "link-resolutions.json";

export interface LinkResolutionsFile {
  version: 1;
  runId: string;
  updatedAt: string;
  /** 경유 주소 → 원래 기사 주소. */
  resolved: Record<string, string>;
  /** 풀지 못한 경유 주소 → 사유(다시 시도할 수 있다). domain: 검색 결과에 있던 원래 사이트 도메인(있으면). */
  unresolved: Record<string, { error: string; domain?: string | null; at: string }>;
}

function isOriginal(u: unknown): u is string {
  return typeof u === "string" && /^https?:\/\//i.test(u) && !isRedirectUrl(u);
}

export function readLinkResolutions(runDir: string): LinkResolutionsFile | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(runDir, LINK_RESOLUTIONS_FILE), "utf8")) as LinkResolutionsFile;
    if (!v || typeof v !== "object" || typeof v.resolved !== "object") return null;
    return { version: 1, runId: v.runId, updatedAt: v.updatedAt, resolved: v.resolved ?? {}, unresolved: v.unresolved ?? {} };
  } catch {
    return null;
  }
}

/** report.json 안의 경유 주소(항목 대표 링크·보조 출처). */
export function collectReportRedirects(report: DailyReportJson): string[] {
  const out = new Set<string>();
  for (const s of [...(report.news ?? []), ...(report.youtube ?? [])]) {
    for (const e of s.items ?? []) {
      if (isRedirectUrl(e.url)) out.add(e.url!);
      for (const x of e.secondary ?? []) if (isRedirectUrl(x.link)) out.add(x.link);
    }
  }
  return [...out];
}

/**
 * report.json 위에 풀이 기록을 덧씌운 사본. 풀린 주소만 바꾸고(원래 주소 검증), 키·나머지는 그대로.
 * 풀지 못했지만 원래 도메인 힌트가 있는 링크는 sourceDomain·domain 을 채운다(이미 값이 있으면 둔다).
 */
export function applyLinkResolutions(report: DailyReportJson, file: LinkResolutionsFile | null): DailyReportJson {
  if (!file) return report;
  const map = (u: string | null | undefined): string | null => {
    const v = u ? file.resolved[u] : undefined;
    return isOriginal(v) ? v : null;
  };
  const hint = (u: string | null | undefined): string | null => (u ? (file.unresolved[u]?.domain ?? null) : null);
  const sections = (list: DailyReportJson["news"]) =>
    (list ?? []).map((s) => ({
      ...s,
      items: (s.items ?? []).map((e) => {
        const url = map(e.url);
        const secondary = (e.secondary ?? []).map((x) => {
          const l = map(x.link);
          if (l) return { label: x.label, link: l };
          const d = !x.domain ? hint(x.link) : null;
          return d ? { ...x, domain: d } : x;
        });
        const next = { ...e, secondary };
        if (url) {
          next.url = url;
          delete next.sourceDomain;
        } else if (!e.sourceDomain && hint(e.url)) next.sourceDomain = hint(e.url);
        return next;
      }),
    }));
  return { ...report, news: sections(report.news), youtube: sections(report.youtube) };
}

function writeAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * 실행 1건의 경유 주소를 풀어 풀이 기록을 쓴다(report.json 은 읽기만). 이미 풀린 주소는 다시 요청하지 않고,
 * 전에 못 푼 주소는 다시 시도한다. 경유 주소가 없으면 파일을 만들지 않는다.
 */
export async function resolveRunLinks(
  runDir: string,
  opts: ResolveOptions & { now?: Date } = {}
): Promise<{ total: number; resolved: number; unresolved: number; requested: number; wrote: boolean }> {
  const reportPath = path.join(runDir, "report.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as DailyReportJson;
  const all = collectReportRedirects(report);
  if (!all.length) return { total: 0, resolved: 0, unresolved: 0, requested: 0, wrote: false };
  const prev = readLinkResolutions(runDir);
  const nowIso = (opts.now ?? new Date()).toISOString();
  const file: LinkResolutionsFile = {
    version: 1,
    runId: report.runId ?? path.basename(runDir),
    updatedAt: nowIso,
    resolved: { ...(prev?.resolved ?? {}) },
    unresolved: {},
  };
  const todo = all.filter((u) => !isOriginal(file.resolved[u]));
  const res = await resolveRedirects(todo, opts);
  for (const u of todo) {
    const r = res.get(u);
    if (r?.url) file.resolved[u] = r.url;
    else file.unresolved[u] = { error: r?.error ?? "풀지 못함", ...(r?.domain ? { domain: r.domain } : {}), at: nowIso };
  }
  // report.json 에 없는 예전 기록은 정리한다.
  for (const k of Object.keys(file.resolved)) if (!all.includes(k)) delete file.resolved[k];
  writeAtomic(path.join(runDir, LINK_RESOLUTIONS_FILE), file);
  const resolved = all.filter((u) => isOriginal(file.resolved[u])).length;
  return { total: all.length, resolved, unresolved: all.length - resolved, requested: todo.length, wrote: true };
}

const RUN_ID_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{4}$/;

/**
 * 최근 실행들(기본 15일 — 체크포인트 seen 보존 14일보다 조금 길게)의 경유 주소 → 원래 주소.
 * 실행 폴더는 보관 기간(report.retentionDays, 기본 7일 — retention.ts)이 지나면 지워지므로 실제로는 그 기간만 본다
 * (조사 구간이 24시간이라 충분하다).
 */
export function readLinkResolutionMaps(outputDir: string, now: Date, days = 15): Map<string, string> {
  const out = new Map<string, string>();
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(path.join(outputDir, "runs"));
  } catch {
    return out;
  }
  const limit = now.getTime() - days * 86_400_000;
  for (const id of ids) {
    const m = RUN_ID_RE.exec(id);
    if (!m || Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) < limit) continue;
    const f = readLinkResolutions(path.join(outputDir, "runs", id));
    for (const [k, v] of Object.entries(f?.resolved ?? {})) if (isOriginal(v)) out.set(k, v);
  }
  return out;
}

/**
 * 이미 보고한 키(seen)에 경유 주소 키가 있으면, 그 주소를 풀어 낸 원래 주소의 키도 같은 시각에 본 것으로 더한 사본.
 * 경유 주소로 보고됐던 기사가 원래 주소로 다시 수집됐을 때 새 항목으로 또 실리지 않게 한다.
 */
export function expandSeenWithResolutions(seen: Record<string, string>, map: Map<string, string>): Record<string, string> {
  if (!map.size) return seen;
  const out = { ...seen };
  for (const [wrapper, original] of map) {
    const c = canonicalUrl(wrapper);
    const at = c ? seen[`url:${c}`] : undefined;
    if (!at) continue;
    for (const k of linkKeys(original)) if (!(k in out)) out[k] = at;
  }
  return out;
}
