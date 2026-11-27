/**
 * 일일 보고서 — 모델별 결과 통합(순수 함수만).
 *
 * 규칙(three-model-update.md):
 * - URL 정규화 · 기사/영상 고유 ID · 동일 사건의 의미로 중복을 하나로 합친다.
 * - 동일 사건은 원출처·최신성·구체성·신뢰성으로 대표 하나를 고르고 나머지는 보조 출처로 둔다.
 * - 한 모델만 찾은 항목은 **반드시 보존**한다(편집기가 빠뜨리면 편집 결과를 버린다).
 * - 근거가 충돌하면 차이를 표시하고 사실을 임의로 섞지 않는다.
 */
import { youtubeId } from "../../shared/youtube-thumb.ts";

export type ReportKind = "news" | "youtube";

export interface ReportItem {
  /** `${model}:${kind}:${n}` — 편집기가 고를 수 있는 유일한 식별자. */
  id: string;
  kind: ReportKind;
  /** 찾은 모델 key(claude/gpt/gemini). */
  model: string;
  categoryKey: string;
  categoryLabel: string;
  title: string;
  summary: string;
  /** 뉴스 출처명 또는 유튜브 채널명. */
  source: string;
  url: string | null;
  /** 발행일(뉴스)·업로드일(유튜브) YYYY-MM-DD. */
  date: string;
  /** 발행·업로드 시각(로컬 오프셋 ISO). 모르면 null. */
  publishedAt?: string | null;
  /** 시각을 확인하지 못하고 날짜만으로 조사 구간 안이라고 판정했는가. */
  timeApprox?: boolean;
  videoId?: string | null;
  /** 유튜브 채널 핸들(있으면) — 채널 차단 판정용. */
  channelHandle?: string | null;
  originalTitle?: string | null;
  related?: { label: string; link: string }[];
}

export interface ReportGroup {
  /** 대표 항목. */
  rep: ReportItem;
  members: ReportItem[];
  /** 그 사건을 찾은 모델 key(정렬). */
  models: string[];
  /** 대표가 아닌 출처(중복 링크 제외). */
  secondary: { label: string; link: string }[];
  conflict: string;
  /** 통합 근거(정확 키 일치 / 편집기 의미 통합 / 단독). */
  reason: string;
  /** 이 그룹의 모든 고유 키. */
  keys: string[];
  /** 이전 보고서에 일부 키가 이미 실렸으면 true(새 출처가 붙은 업데이트). */
  update?: boolean;
}

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|igshid$|spm$|cmpid$|ocid$)/i;

/** YouTube URL → 11자 영상 ID. 규칙은 화면·메일 섬네일과 같이 쓰려고 shared 로 옮겼다. */
export { youtubeId };

/**
 * URL 정규화: 스킴 https 통일, www. 제거, 추적 파라미터·조각 제거, 끝 슬래시 제거, 쿼리 정렬.
 * YouTube 는 watch?v=ID, GeekNews 토픽은 topic?id=N 으로 접는다. 잘못된 URL 이면 null.
 */
export function canonicalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  const vid = youtubeId(u.toString());
  if (vid && /(^|\.)youtube\.com$|^youtu\.be$/.test(host)) return `https://www.youtube.com/watch?v=${vid}`;
  if (host === "news.hada.io") {
    const id = u.searchParams.get("id");
    if (u.pathname.startsWith("/topic") && id) return `https://news.hada.io/topic?id=${id}`;
  }
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const q = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `https://${host}${path === "/" && !q ? "" : path}${q}`;
}

/** 항목의 고유 키: 정규화 URL · 영상 ID · GeekNews 토픽 ID(대표 링크와 보조 링크 모두). */
export function itemKeys(item: ReportItem): string[] {
  const keys = new Set<string>();
  const links = [item.url, ...(item.related ?? []).map((r) => r.link)];
  for (const l of links) {
    const c = canonicalUrl(l);
    if (!c) continue;
    keys.add(`url:${c}`);
    const vid = youtubeId(c);
    if (vid) keys.add(`yt:${vid}`);
    const gn = /news\.hada\.io\/topic\?id=(\d+)/.exec(c)?.[1];
    if (gn) keys.add(`gn:${gn}`);
  }
  if (item.videoId) keys.add(`yt:${item.videoId}`);
  return [...keys];
}

/** 대표 링크의 키만(보조 링크 제외). 강한 동일성 판단(편집기 검증)에 쓴다. */
export function primaryKeys(item: ReportItem): string[] {
  return itemKeys({ ...item, related: [] });
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    const p = this.parent.get(x) ?? x;
    if (p === x) return x;
    const r = this.find(p);
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * 결정론적 1차 그룹화: 같은 종류(뉴스/영상) 안에서 고유 키가 하나라도 겹치면 같은 그룹.
 * 반환은 항목 id 배열의 배열(입력 순서 유지).
 */
export function exactGroups(items: ReportItem[]): string[][] {
  const uf = new UnionFind();
  const owner = new Map<string, string>();
  for (const it of items) {
    for (const k of itemKeys(it)) {
      const scoped = `${it.kind}|${k}`;
      const prev = owner.get(scoped);
      if (prev) uf.union(it.id, prev);
      else owner.set(scoped, it.id);
    }
  }
  const groups = new Map<string, string[]>();
  for (const it of items) {
    const r = uf.find(it.id);
    const arr = groups.get(r) ?? [];
    arr.push(it.id);
    groups.set(r, arr);
  }
  return [...groups.values()];
}

/** 원출처 점수: 커뮤니티 재게시·검색 결과보다 원문 출처를 우선한다. */
function sourceScore(it: ReportItem): number {
  const host = (() => {
    try {
      return new URL(it.url ?? "").hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  if (!it.url) return 0;
  if (/news\.hada\.io|news\.naver\.com|news\.google\.|reddit\.com|x\.com|twitter\.com|news\.ycombinator\.com/.test(host)) return 1;
  return 2;
}

/** 대표 선택(결정론적): 원출처 > 최신 날짜 > 구체성(요약 길이) > 입력 순서. */
export function pickRepresentative(members: ReportItem[]): ReportItem {
  return [...members].sort((a, b) => {
    const s = sourceScore(b) - sourceScore(a);
    if (s) return s;
    const d = b.date.localeCompare(a.date);
    if (d) return d;
    return b.summary.length - a.summary.length;
  })[0];
}

/** 같은 그룹 안의 사실 충돌(결정론적으로 볼 수 있는 것만): 날짜 표기 차이. */
export function detectConflict(members: ReportItem[]): string {
  const dates = [...new Set(members.map((m) => m.date))];
  if (dates.length > 1) {
    const by = dates.map((d) => `${d}(${members.filter((m) => m.date === d).map((m) => m.model).join("·")})`);
    return `모델별 날짜 표기가 다름: ${by.join(" / ")}`;
  }
  return "";
}

export function buildGroup(members: ReportItem[], reason: string, repId?: string, conflict?: string): ReportGroup {
  const rep = (repId && members.find((m) => m.id === repId)) || pickRepresentative(members);
  const repUrl = canonicalUrl(rep.url);
  const seen = new Set<string>(repUrl ? [repUrl] : []);
  const secondary: { label: string; link: string }[] = [];
  const push = (label: string, link: string | null | undefined) => {
    const c = canonicalUrl(link);
    if (!c || seen.has(c)) return;
    seen.add(c);
    secondary.push({ label: label || c, link: String(link) });
  };
  for (const r of rep.related ?? []) push(r.label, r.link);
  for (const m of members) {
    if (m === rep) continue;
    push(m.source || m.title, m.url);
    for (const r of m.related ?? []) push(r.label, r.link);
  }
  const keys = new Set<string>();
  for (const m of members) for (const k of itemKeys(m)) keys.add(k);
  const merged = [conflict?.trim(), detectConflict(members)].filter(Boolean).join(" · ");
  return {
    rep,
    members,
    models: [...new Set(members.map((m) => m.model))].sort(),
    secondary: secondary.slice(0, 6),
    conflict: merged,
    reason,
    keys: [...keys],
  };
}

/** 결정론적 통합(편집기 실패 시의 대비책이자 편집기 입력의 기본 묶음). */
export function deterministicMerge(items: ReportItem[]): ReportGroup[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return exactGroups(items).map((ids) => {
    const members = ids.map((id) => byId.get(id)!);
    return buildGroup(members, members.length > 1 ? "정규화 URL·영상 ID·토픽 ID 일치" : "단독 발견");
  });
}

export interface EditorGroup {
  ids: string[];
  representative: string;
  reason?: string;
  conflict?: string;
  /** 편집기가 사용자 분류 교정 규칙에 비춰 고친 카테고리 key(그 종류의 카테고리일 때만 적용). */
  category?: string;
}

/** 종류별 카테고리 key → 표시 라벨(편집기·사용자 이동의 카테고리 검증용). */
export type CategoryLabels = Record<ReportKind, Map<string, string>>;

/**
 * 재분류 기록 매칭 키: 제목+출처(채널) 정규화. src/youtube/reclass.ts·src/news/reclass.ts 의 reclassKey 와
 * **같은 규칙**이어야 한다(소문자·앞뒤 공백 제거·연속 공백 하나로).
 */
export function titleSourceKey(title: string, source: string): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return `${norm(title)}::${norm(source)}`;
}

/** 사용자가 옮긴 기록(재분류 학습) 1건의 필요한 부분. */
export interface MoveRecord {
  title: string;
  channel: string;
  toKey: string;
}

/**
 * 사용자 카테고리 이동을 결정론적으로 적용한다: 같은 제목+출처(채널)를 사용자가 옮긴 적이 있으면 그 카테고리로.
 * 기록은 오래된 것 → 최신 순이라 뒤의 것이 이긴다. 지금 없는 카테고리로의 기록은 무시한다.
 * 반환: 사용자 기록과 일치한 항목 id → 그 카테고리 key(이미 그 카테고리였던 항목 포함 — 편집기가 다시 옮기지 못하게).
 */
export function applyUserMoves(
  items: ReportItem[],
  moves: Record<ReportKind, MoveRecord[]>,
  labels: CategoryLabels
): Map<string, string> {
  const target: Record<ReportKind, Map<string, string>> = { news: new Map(), youtube: new Map() };
  for (const kind of ["news", "youtube"] as const) {
    for (const r of moves[kind] ?? []) if (labels[kind].has(r.toKey)) target[kind].set(titleSourceKey(r.title, r.channel), r.toKey);
  }
  const matched = new Map<string, string>();
  for (const it of items) {
    const to = target[it.kind].get(titleSourceKey(it.title, it.source));
    if (!to) continue;
    matched.set(it.id, to);
    it.categoryKey = to;
    it.categoryLabel = labels[it.kind].get(to) ?? to;
  }
  return matched;
}

/** 그룹의 어느 항목이라도 사용자 기록과 일치하면 그 카테고리로 둔다(편집기 교정보다 사용자 결정이 우선). */
export function keepUserMoves(groups: ReportGroup[], forced: Map<string, string>, labels: CategoryLabels): ReportGroup[] {
  if (!forced.size) return groups;
  return groups.map((g) => {
    const hit = g.members.find((m) => forced.has(m.id));
    const to = hit && forced.get(hit.id);
    if (!to || to === g.rep.categoryKey) return g;
    return { ...g, rep: { ...g.rep, categoryKey: to, categoryLabel: labels[g.rep.kind].get(to) ?? to } };
  });
}

/**
 * 편집기(LLM) 그룹 검증 후 적용. 다음 중 하나라도 어기면 throw — 호출부는 결정론적 통합으로 물러선다.
 * - 모든 항목 id 가 정확히 한 그룹에만 들어가야 한다(한 모델 단독 항목 누락 금지, 지어낸 id 금지).
 * - 대표는 그 그룹의 id 여야 한다.
 * - 뉴스와 영상을 섞지 않는다.
 * - 대표 링크가 같은(정확 키 일치) 항목을 서로 다른 그룹으로 쪼개지 않는다.
 */
export function applyEditorGroups(items: ReportItem[], groups: EditorGroup[], labels?: CategoryLabels): ReportGroup[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const used = new Set<string>();
  const groupOf = new Map<string, number>();
  if (!Array.isArray(groups) || !groups.length) throw new Error("편집기 그룹이 비어 있음");
  groups.forEach((g, gi) => {
    if (!g || !Array.isArray(g.ids) || !g.ids.length) throw new Error(`그룹 ${gi}: ids 없음`);
    if (!g.ids.includes(g.representative)) throw new Error(`그룹 ${gi}: 대표가 그룹 밖`);
    for (const id of g.ids) {
      if (!byId.has(id)) throw new Error(`그룹 ${gi}: 모르는 id ${id}`);
      if (used.has(id)) throw new Error(`id ${id} 가 두 그룹에 중복`);
      used.add(id);
      groupOf.set(id, gi);
    }
    if (new Set(g.ids.map((id) => byId.get(id)!.kind)).size > 1) throw new Error(`그룹 ${gi}: 뉴스·영상 혼합`);
  });
  const missing = items.filter((i) => !used.has(i.id)).map((i) => i.id);
  if (missing.length) throw new Error(`편집기가 항목 ${missing.length}건을 누락: ${missing.slice(0, 5).join(", ")}`);
  for (const ids of exactGroups(items.map((i) => ({ ...i, related: [] })))) {
    const gs = new Set(ids.map((id) => groupOf.get(id)));
    if (gs.size > 1) throw new Error(`같은 링크의 항목을 서로 다른 그룹으로 분리: ${ids.join(", ")}`);
  }
  return groups.map((g) => {
    const members = g.ids.map((id) => byId.get(id)!);
    const reason = members.length > 1 ? `편집기 통합 — ${String(g.reason ?? "동일 사건").slice(0, 200)}` : "단독 발견";
    const group = buildGroup(members, reason, g.representative, typeof g.conflict === "string" ? g.conflict.slice(0, 300) : "");
    // 편집기의 카테고리 교정: 그 종류의 실제 카테고리 key 일 때만 받는다(지어낸 key·종류 혼동은 무시).
    const cat = typeof g.category === "string" ? g.category.trim() : "";
    const label = cat && labels?.[group.rep.kind].get(cat);
    if (label && cat !== group.rep.categoryKey) group.rep = { ...group.rep, categoryKey: cat, categoryLabel: label };
    return group;
  });
}

/**
 * 증분: 이전 보고서에 실린 키(seen)와 비교한다.
 * - 그룹의 모든 키가 이미 보고됨 → 제외(alreadyReported)
 * - 일부만 보고됨 → 새 출처가 붙은 업데이트로 표시하고 유지
 * - 전부 새 키 → 유지
 */
export function splitIncremental(
  groups: ReportGroup[],
  seen: Record<string, string>
): { fresh: ReportGroup[]; alreadyReported: ReportGroup[] } {
  const fresh: ReportGroup[] = [];
  const alreadyReported: ReportGroup[] = [];
  for (const g of groups) {
    const known = g.keys.filter((k) => k in seen);
    if (g.keys.length && known.length === g.keys.length) alreadyReported.push(g);
    else fresh.push(known.length ? { ...g, update: true } : g);
  }
  return { fresh, alreadyReported };
}

/** 보고한 키를 seen 에 더하고 보존 기간(일)이 지난 키를 걷어 낸다. */
export function updateSeen(
  seen: Record<string, string>,
  reported: ReportGroup[],
  nowIso: string,
  keepDays = 14
): Record<string, string> {
  const next: Record<string, string> = {};
  const limit = Date.parse(nowIso) - keepDays * 86_400_000;
  for (const [k, at] of Object.entries(seen)) if (Date.parse(at) >= limit) next[k] = at;
  for (const g of reported) for (const k of g.keys) if (!(k in next)) next[k] = nowIso;
  return next;
}
