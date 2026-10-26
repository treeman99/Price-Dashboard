import { Fragment, useEffect, useId, useState } from "react";
import { Archive, ChevronDown, Globe, Loader2, Lock, RefreshCw, Star, TrendingUp } from "lucide-react";
import type {
  SkillAccess,
  SkillRankEntry,
  SkillRankKind,
  SkillUnit,
  SkillWindow,
  SkillsSnapshot,
} from "@shared/skills";
import { SKILLS_RANK_SIZE } from "@shared/skills";
import { describeSchedule } from "@shared/schedule";
import { safeHref } from "@shared/url";
import { api, type CollectAttempt } from "@/lib/api";
import { useTabConfig } from "@/lib/tabConfigStore";
import { formatWhen } from "@/lib/tabConfig";
import { ScheduleControl } from "@/components/ScheduleControl";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import {
  EmptyState,
  LoadingState,
  Meta,
  MetaDot,
  Notice,
  PageToolbar,
  SectionHeader,
  Segmented,
  StatusTag,
  type TagTone,
} from "@/components/ui/page";
import { cn } from "@/lib/utils";

/**
 * 스킬 랭킹 탭 — GitHub 의 Claude/Agent 스킬 저장소를 **총합**과 **주간 증가** 두 갈래로 본다.
 *
 * 정식 회차는 서버 스케줄(기본 매주 월요일 09:00, 툴바 '자동 갱신'에서 격주·매월로 바꿀 수 있다)이
 * 돈다. '지금 갱신'은 이번 회차가 이미 기록돼 있으면 **중간 점검**이다 — 지금 star 로 다시 매기되
 * 다음 회차의 비교 기준(DB 스냅샷)에는 남지 않는다(snap.interim). 회차가 비어 있으면 그 회차를
 * 대신 돈다. 어느 쪽인지는 서버가 정하고, 화면은 interim 을 보고 그 사실을 적기만 한다.
 *
 * ★ 이 화면의 핵심 규율은 **증가분 구간을 속이지 않는 것**이다. 계약(shared/skills.ts)이
 *   SkillWindow.days 를 굳이 실어 보내는 이유가 그것이고, 여기서는 그 값을 그대로 인용한다.
 *   비교할 지난 스냅샷이 없는 첫 회차(window === null)에는 0 으로 채우거나 총합 순위를
 *   대신 보여주지 않고, 비어 있다는 사실을 그대로 말한다.
 */

/** 수집 진행 상태 폴링 주기. 뉴스 탭과 같은 간격으로 맞춘다. */
const POLL_MS = 5000;

/** 천 단위 구분. star·forks 처럼 자릿수가 큰 값에만 쓴다. */
const num = (n: number) => n.toLocaleString("ko-KR");

/**
 * "+1,204" / "-3". 부호를 값에서 뽑는다 — 메일(notify/skills-email.ts 의 signed)과 같은 규약이다.
 * star 는 줄어들기도 하므로("+" 를 고정으로 붙이면 -3 이 "+-3" 으로 나온다) 부호를 지어내지 않는다.
 */
const signed = (n: number) => `${n >= 0 ? "+" : "-"}${num(Math.abs(n))}`;

/** ISO → "어제 21:26"·"10/19(월) 09:00" — 다른 탭 툴바와 같은 표기(formatWhen). 읽을 수 없으면 null. */
function fmtWhen(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : formatWhen(d, new Date());
}

/**
 * 마지막 푸시 시각을 "n일 전"으로. 별만 많고 죽은 저장소를 한눈에 가르는 값이라
 * 절대 시각보다 상대 표기가 읽기 쉽다. 아주 오래된 것은 일수로 적으면 자릿수만 커져
 * 개월·년으로 접는다.
 */
function relTime(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "오늘";
  if (days === 1) return "어제";
  if (days < 60) return `${days}일 전`;
  if (days < 365) return `${Math.floor(days / 30)}개월 전`;
  return `${Math.floor(days / 365)}년 전`;
}

/** 한 줄에 노출할 topic 칩 개수. 넘치면 "+n" 으로 접는다(줄바꿈으로 목록이 무너지지 않게). */
const TOPIC_LIMIT = 4;

/** 언어 점 색(GitHub linguist 색, 상위권에 실제로 나오는 언어만). 목록에 없으면 회색 점. */
const LANG_COLOR: Record<string, string> = {
  Python: "#3572A5",
  JavaScript: "#f1e05a",
  TypeScript: "#3178c6",
  HTML: "#e34c26",
  Go: "#00ADD8",
  Rust: "#dea584",
  "C++": "#f34b7d",
  Shell: "#89e051",
};

/** 표의 열 수. 펼침 행이 colSpan 으로 순위 열을 뺀 나머지를 덮는다. */
const COLS = 8;

/**
 * 로컬 쪽 툴팁에만 붙는 **판정의 한계** 한 줄.
 *
 * ★ 우리가 실제로 뒷받침할 수 있는 주장은 "이 스킬은 네트워크를 안 쓴다"가 아니라
 *   **"SKILL.md 본문에서 네트워크 호출 근거를 찾지 못했다"** 이다. 스캐너는 본문의 텍스트만
 *   보므로, 외부 서비스 CLI 를 호출만 하는 스킬처럼 본문에 흔적이 옅은 경우를 놓칠 수 있다.
 *   태그 라벨은 짧아야 하니 이 단서는 툴팁에만 싣는다.
 *
 * ★ `external`/`partial` 에는 붙이지 않는다. 그쪽은 **찾은 것**이라 확정이고, 확정 옆에
 *   "놓칠 수 있다"를 적으면 오히려 발견 사실이 의심스럽게 읽힌다.
 */
const LOCAL_LIMIT =
  "SKILL.md 본문 기준입니다 — 외부 서비스 CLI 를 호출만 하는 스킬은 놓칠 수 있습니다.";

/**
 * 네트워크 접근 태그의 표기 규칙(라벨·톤·툴팁 본문)을 한자리에 모은다.
 *
 * ★ `local` 과 `local-sampled` 를 **같은 모양으로 그리지 않는다.** 계약(shared/skills.ts)이
 *   두 kind 를 나눈 이유가 "864개 중 40개만 보고 로컬이라 단정하지 않기" 이므로, 화면이
 *   그걸 뭉개면 나눈 의미가 사라진다. 추정 쪽은 문구에 '추정 · 표본'을 남기고 테두리를
 *   점선으로 둬서 색을 보지 않고도 확정과 구분되게 한다.
 * ★ `no-skill`·`unknown` 은 회색(중립)이다. "모른다"는 경고가 아니므로 위험 색을 쓰지 않는다.
 */
function accessTag(a: SkillAccess): {
  label: string;
  tone: TagTone;
  icon: "local" | "net" | null;
  dashed?: boolean;
  detail: string;
} {
  // "20개 중 20개 검사" — 표본이면 이 문장만으로도 전수가 아니었음이 드러난다.
  const scanned = `${num(a.total)}개 중 ${num(a.checked)}개 검사`;
  const found =
    a.signals.length > 0 ? `발견된 신호: ${a.signals.join(", ")}` : "발견된 네트워크 신호 없음";

  switch (a.kind) {
    case "local":
      return {
        label: `로컬 ${num(a.total)}/${num(a.total)}`,
        tone: "success",
        icon: "local",
        detail: `${found} · ${scanned} (전수). ${LOCAL_LIMIT}`,
      };
    case "local-sampled":
      return {
        label: `로컬 추정 · 표본 ${num(a.checked)}/${num(a.total)}`,
        tone: "success",
        icon: "local",
        dashed: true,
        detail: `${found} · ${scanned}. 표본이라 나머지는 확인하지 못했습니다 — '로컬'로 단정하지 않습니다. ${LOCAL_LIMIT}`,
      };
    case "external":
      return {
        label: `외부 접근 ${num(a.network)}/${num(a.checked)}`,
        tone: "warn",
        icon: "net",
        detail: `${found} · ${scanned} · 검사한 전부에서 신호가 나왔습니다.`,
      };
    case "partial":
      return {
        label: `일부 외부 ${num(a.network)}/${num(a.checked)}`,
        tone: "warn",
        icon: "net",
        detail: `${found} · ${scanned} · 그중 ${num(a.network)}개에서 신호가 나왔습니다.`,
      };
    case "no-skill":
      return {
        label: "스킬 없음",
        tone: "neutral",
        icon: null,
        detail: "SKILL.md 가 없는 저장소입니다(목록·도구 저장소일 수 있습니다).",
      };
    default:
      return {
        label: "판정 불가",
        tone: "neutral",
        icon: null,
        detail: "파일을 읽지 못해 판정하지 못했습니다. 외부 접근이 없다는 뜻은 아닙니다.",
      };
  }
}

/**
 * 집계 태그 1개. 툴팁에 신호 종류와 검사 범위를 적는다.
 *
 * 툴팁은 hover/focus 로만 뜨므로 같은 문장을 sr-only 로도 실어 스크린리더가 놓치지 않게 한다
 * (태그를 tabIndex 로 만들면 50줄 × 1개씩 탭 스톱이 늘어난다).
 */
function AccessTag({ access }: { access: SkillAccess }) {
  const c = accessTag(access);
  return (
    <StatusTag tone={c.tone} className={cn("group/tt relative gap-1", c.dashed && "border-dashed")}>
      {c.icon === "local" && <Lock aria-hidden className="h-3 w-3" />}
      {c.icon === "net" && <Globe aria-hidden className="h-3 w-3" />}
      {c.label}
      <span className="sr-only"> — {c.detail}</span>
      {/*
        기본 Tip 은 nowrap + 가운데 정렬이라 신호가 여러 개면 가로로 길어져 좁은 폭에서
        잘린다. 왼쪽 정렬 + 줄바꿈으로 바꿔 375px 에서도 칸 안에 들어오게 한다.
        `w-max` 가 없으면 absolute 박스가 태그 너비(≈90px)에 맞춰 접혀 세로로 길쭉해진다.
      */}
      <Tip className="left-0 w-max max-w-[13rem] translate-x-0 whitespace-normal text-left leading-snug">
        {c.detail}
      </Tip>
    </StatusTag>
  );
}

/**
 * 펼침 목록 — 표본에 든 개별 스킬을 한 줄씩. 표 아래 전체 폭 확장 행에 다단으로 흘린다
 * (최대 40줄이라 한 단으로 두면 행 하나가 화면을 다 먹는다).
 *
 * ★ `units` 는 표본이라 `access.total` 보다 짧을 수 있다. 남은 개수를 그냥 "N개 더" 로만
 *   적으면 나머지가 로컬인 줄 오해하므로, 검사하지 못했다는 사실을 함께 적는다.
 */
function UnitsList({ units, access, id }: { units: SkillUnit[]; access?: SkillAccess; id: string }) {
  const rest = access ? access.total - units.length : 0;
  return (
    <div id={id} className="bg-muted/50 px-3 py-2">
      <ul className="columns-1 gap-8 md:columns-2 xl:columns-3 2xl:columns-4">
        {units.map((u) => {
          const href = safeHref(u.url);
          const net = u.signals.length > 0;
          return (
            <li key={u.path} className="flex break-inside-avoid gap-1.5 py-0.5 text-[12px] leading-relaxed">
              {net ? (
                <Globe aria-hidden className="mt-[4px] h-3 w-3 shrink-0 text-tone-warn" />
              ) : (
                <Lock aria-hidden className="mt-[4px] h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <span className="sr-only">{net ? "외부 접근" : "로컬"}</span>
              <span className="min-w-0">
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all font-medium underline-offset-[3px] hover:underline"
                  >
                    {u.name}
                  </a>
                ) : (
                  <span className="break-all font-medium">{u.name}</span>
                )}
                {net && (
                  <span className="ml-2 break-words text-muted-foreground">{u.signals.join(", ")}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {access && rest > 0 && (
        <p className="mt-1.5 border-t pt-1.5 text-[12px] text-muted-foreground">
          … {num(rest)}개 더 (표본 {num(access.checked)}개만 검사해 나머지는 확인하지 못했습니다)
        </p>
      )}
    </div>
  );
}

/** 순위 변동 표시. prevRank 가 null 이면 신규 진입(NEW). */
function RankDelta({ rank, prevRank }: { rank: number; prevRank: number | null }) {
  if (prevRank === null) {
    return <span className="font-mono text-[11px] font-semibold text-tone-info">NEW</span>;
  }
  const diff = prevRank - rank; // 양수 = 순위가 올랐다
  if (diff === 0) return <span className="font-mono text-[11px] text-muted-foreground/50">–</span>;
  const up = diff > 0;
  return (
    <span
      className={cn(
        "num font-mono text-[11px] font-semibold",
        up ? "text-tone-success" : "text-muted-foreground"
      )}
      title={`지난 회차 ${prevRank}위`}
    >
      {up ? "▲" : "▼"}
      {Math.abs(diff)}
    </span>
  );
}

/** 값이 없는 칸. 빈칸으로 두면 표에서 줄이 밀린 것처럼 보인다. */
const Dash = () => <span className="text-muted-foreground/50">—</span>;

/** 랭킹 한 줄(+ 펼쳤을 때 그 아래 확장 행). */
function RankRow({ entry, kind }: { entry: SkillRankEntry; kind: SkillRankKind }) {
  const r = entry.repo;
  const href = safeHref(r.url);
  // 펼침 상태는 줄마다 독립이다(RankRow 인스턴스가 곧 한 줄이므로 지역 상태로 충분).
  const [openUnits, setOpenUnits] = useState(false);
  const unitsId = useId();
  // 표본에 든 개별 스킬. 수집 전 스냅샷에는 없다 — 없으면 펼치기 자체를 내지 않는다.
  const units = r.units ?? [];
  // 요약(LLM 한국어)이 우선이고, 없으면 GitHub 원문 설명으로 폴백한다.
  // 요약 실패가 줄을 비우면 안 된다 — 그때도 사용자는 이 저장소가 뭔지 알아야 한다.
  const desc = r.summary ?? r.description ?? "설명 없음";
  const pushed = relTime(r.pushedAt);
  const extraTopics = r.topics.length - TOPIC_LIMIT;
  const expanded = openUnits && units.length > 0;

  return (
    <Fragment>
      {/* 펼친 동안은 확장 행과 한 덩어리로 읽히게 사이 헤어라인을 뺀다. */}
      <tr className={cn(expanded && "[&>td]:!border-b-0")}>
        {/* 순위 + 변동 */}
        <td className="text-right">
          <div className="num font-mono text-[15px] font-semibold leading-tight">{entry.rank}</div>
          <RankDelta rank={entry.rank} prevRank={entry.prevRank} />
        </td>

        {/* 저장소 이름 · 설명 · topic */}
        <td>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="break-all text-[15px] underline-offset-[3px] hover:underline"
              >
                <span className="text-muted-foreground">{r.owner}/</span>
                <span className="font-semibold">{r.name}</span>
              </a>
            ) : (
              <span className="break-all text-[15px] font-semibold">{r.fullName}</span>
            )}
            {/* 별은 많은데 관리가 끊긴 저장소를 숨기지 않는다. */}
            {r.archived && (
              <StatusTag tone="warn" className="gap-1">
                <Archive aria-hidden className="h-3 w-3" /> 보관됨
              </StatusTag>
            )}
          </div>

          {/* 칸 폭에 따라 잘리는 부분은 title 로 전문을 볼 수 있게 한다. */}
          <p
            className="mt-0.5 line-clamp-2 whitespace-pre-line text-[13px] leading-relaxed text-muted-foreground"
            title={desc}
          >
            {desc}
          </p>

          {r.topics.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {r.topics.slice(0, TOPIC_LIMIT).map((t) => (
                <span
                  key={t}
                  className="rounded-[3px] bg-muted px-1.5 py-px text-[11px] text-muted-foreground"
                >
                  {t}
                </span>
              ))}
              {extraTopics > 0 && (
                <span className="text-[11px] text-muted-foreground">+{extraTopics}</span>
              )}
            </div>
          )}
        </td>

        <td className="whitespace-nowrap text-[13px] text-muted-foreground">
          {r.language ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40"
                style={LANG_COLOR[r.language] ? { backgroundColor: LANG_COLOR[r.language] } : undefined}
              />
              {r.language}
            </span>
          ) : (
            <Dash />
          )}
        </td>

        <td className="whitespace-nowrap text-[13px] text-muted-foreground">{r.license ?? <Dash />}</td>

        <td className="num whitespace-nowrap text-right text-[13px] text-muted-foreground">{num(r.forks)}</td>

        <td className="whitespace-nowrap text-[13px] text-muted-foreground">
          {pushed ? <span title={`마지막 푸시 ${r.pushedAt}`}>{pushed}</span> : <Dash />}
        </td>

        {/*
          네트워크 접근 — 이 행에서 topic 보다 먼저 읽혀야 할 값이라 칸을 따로 둔다.
          ★ access 가 없으면 태그를 **아예 그리지 않는다.** 이 기능 배포 전 스냅샷을 보는
            사용자에게 "미확인" 자리표시자를 띄우면 없는 판정을 있는 것처럼 읽히게 된다.
        */}
        <td className="whitespace-nowrap">
          <div className="flex flex-col items-start gap-1">
            {r.access && <AccessTag access={r.access} />}
            {units.length > 0 && (
              <button
                type="button"
                onClick={() => setOpenUnits((v) => !v)}
                aria-expanded={openUnits}
                aria-controls={openUnits ? unitsId : undefined}
                className="-ml-1 inline-flex items-center gap-0.5 rounded-[3px] px-1 py-px text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ChevronDown
                  aria-hidden
                  className={cn("h-3.5 w-3.5 transition-transform", openUnits && "rotate-180")}
                />
                {openUnits ? "접기" : "펼치기"}
              </button>
            )}
          </div>
        </td>

        {/* star 총합 · 증가분 */}
        <td className="whitespace-nowrap text-right">
          <div className="num text-[15px] font-semibold leading-tight">{num(r.stars)}</div>
          {entry.starsGained !== null && (
            <div
              className={cn(
                "num mt-0.5 text-[12px]",
                kind === "growth" ? "font-semibold text-tone-success" : "text-muted-foreground"
              )}
            >
              {signed(entry.starsGained)}
            </div>
          )}
        </td>
      </tr>

      {expanded && (
        <tr>
          <td aria-hidden />
          <td colSpan={COLS - 1} className="!pt-0">
            <UnitsList units={units} access={r.access} id={unitsId} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/**
 * 증가 랭킹의 비교 구간 라벨. days 를 그대로 인용한다 — 7 로 하드코딩하지 않는다.
 * 중간 점검이면 toDate 쪽은 저장된 스냅샷이 아니라 지금 값이라 그렇게 적는다.
 */
function windowLabel(w: SkillWindow, interim: boolean): string {
  return interim
    ? `최근 ${w.days}일간 증가 (${w.fromDate} 스냅샷 → ${w.toDate} 중간 점검)`
    : `최근 ${w.days}일간 증가 (${w.fromDate} → ${w.toDate} 스냅샷 비교)`;
}

export function SkillsBoard() {
  const [snap, setSnap] = useState<SkillsSnapshot | null>(null);
  const [kind, setKind] = useState<SkillRankKind>("total");
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [attempt, setAttempt] = useState<CollectAttempt | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 다른 탭이 AI 수집을 붙잡고 있어 '지금 갱신'이 시작조차 못 한 경우의 안내.
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const { schedule } = useTabConfig();

  async function load() {
    try {
      setSnap(await api.skills());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  /** 진행 상태를 갱신하고 '수집 중'인지 돌려준다(실패하면 null). 뉴스 탭과 같은 방식. */
  async function checkStatus(): Promise<boolean | null> {
    try {
      const s = await api.skillsStatus();
      setCollecting(s.collecting);
      setAttempt(s.lastAttempt ?? null);
      return s.collecting;
    } catch {
      return null; // 상태 폴링 실패는 무시(다음 주기에 재시도)
    }
  }

  useEffect(() => {
    void load();
    void checkStatus(); // 진입 시 (자동 갱신 수집이 돌고 있으면) '수집 중'을 즉시 반영
  }, []);

  // 수집 중이면 5초마다 확인 → 끝나면 스냅샷을 자동으로 다시 불러온다.
  useEffect(() => {
    if (!collecting) return;
    const id = setInterval(async () => {
      if ((await checkStatus()) === false) await load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [collecting]);

  async function refresh() {
    setErr(null);
    setBusyMsg(null);
    try {
      const r = await api.refreshSkills(); // 백그라운드 시작(202) 또는 시작 불가(409)
      if (r.busy && !r.collecting) {
        // 다른 탭이 AI 수집을 붙잡고 있다 → 시작된 게 없으므로 '수집 중'으로 넘어가면 안 된다.
        setBusyMsg(r.reason);
        return;
      }
      setCollecting(true); // '수집 중' 배너 + 폴링 시작 → 완료되면 자동 반영
    } catch (e) {
      setErr((e as Error).message); // 5xx 등 진짜 실패만 표시
    }
  }

  if (loading) return <LoadingState />;

  if (!snap) {
    return (
      <EmptyState
        action={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            다시 시도
          </Button>
        }
      >
        <p>스킬 랭킹을 불러올 수 없습니다.</p>
        {err && <p className="mt-2 text-xs text-muted-foreground/70">({err})</p>}
      </EmptyState>
    );
  }

  const entries = kind === "total" ? snap.byStars : snap.byGrowth;
  const updated = fmtWhen(snap.updatedAt);
  // 첫 회차 = 비교할 지난주 스냅샷이 없다. 증가 랭킹은 이때 '0' 이 아니라 '없음'이다.
  const firstCycle = snap.window === null;
  // 갱신 주기는 사용자가 바꿀 수 있어(격주·매월) 고정 문구 대신 지금 스케줄을 그대로 읽는다.
  const skillsJob = schedule?.schedule.skills;
  const firstFillText = !skillsJob
    ? "자동 갱신에서 채워집니다."
    : skillsJob.enabled
      ? `${describeSchedule(skillsJob)} 자동 갱신에서 채워집니다.`
      : "자동 갱신이 꺼져 있습니다 — 위 '자동 갱신'에서 켜세요.";

  return (
    <div>
      <PageToolbar
        actions={
          <>
            <Segmented
              aria-label="랭킹 종류"
              value={kind}
              onChange={setKind}
              options={[
                { value: "total", label: <><Star /> star 총합</> },
                { value: "growth", label: <><TrendingUp /> 이번 주 급상승</> },
              ]}
            />
            <Button variant="outline" onClick={refresh} disabled={collecting}>
              {collecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {collecting ? "수집 중…" : "지금 갱신"}
            </Button>
          </>
        }
      >
        <ScheduleControl tab="skills" label="자동 갱신" />
        <MetaDot />
        <Meta>
          <span title="GitHub 스킬 저장소 star 를 주간 스냅샷으로 쌓아 직접 차분합니다">GitHub star 주간 차분</span>
        </Meta>
        {updated && (
          <>
            <MetaDot />
            <Meta>
              최종 갱신 <strong>{updated}</strong>
              {snap.interim && (
                <span title="지금 star 로 다시 매긴 결과입니다. 다음 회차의 비교 기준에는 남지 않습니다"> (중간 점검)</span>
              )}
            </Meta>
          </>
        )}
      </PageToolbar>

      {err && <Notice tone="error">{err}</Notice>}
      {busyMsg && <Notice tone="warn">{busyMsg}</Notice>}

      {collecting && (
        <Notice tone="info" progress>
          스킬 저장소를 수집하는 중입니다… 몇 분 걸릴 수 있고, 완료되면 자동으로 반영됩니다.
        </Notice>
      )}

      {/*
        수집이 실패하면 서버는 지난 회차 스냅샷을 그대로 유지한다 — 화면이 멀쩡해 보여서
        사용자는 이번 주 것으로 착각한다. notes 는 그 사실을 적어 둔 유일한 자리라 접지 않고
        눈에 띄게 띄운다.
      */}
      {snap.notes && (
        <Notice tone="warn">
          <span className="whitespace-pre-line break-words">{snap.notes}</span>
        </Notice>
      )}

      {/* 마지막 수집 시도가 실패로 끝났다면, 아래 목록이 지난 회차라는 뜻이다. */}
      {attempt && !attempt.ok && (
        <Notice tone="warn">
          마지막 수집 시도가 실패했습니다{fmtWhen(attempt.at) ? ` (${fmtWhen(attempt.at)})` : ""}
          . 아래 목록은 {snap.date} 스냅샷으로, 이번 주 것이 아닐 수 있습니다.
        </Notice>
      )}

      <section>
        <SectionHeader
          title={kind === "total" ? "star 총합 순위" : "이번 주 급상승"}
          // 증가 랭킹은 구간을 숨기지 않는다 — days 를 그대로 인용한다(7일이 아닐 수 있다).
          note={
            kind === "growth" && snap.window
              ? windowLabel(snap.window, !!snap.interim)
              : `기준 ${snap.date} ${snap.interim ? "중간 점검" : "스냅샷"}`
          }
        />

        {kind === "growth" && firstCycle ? (
          <EmptyState icon={<TrendingUp />}>
            <p>증가 순위는 다음 자동 갱신부터 채워집니다.</p>
            <p className="mt-1 text-xs">(비교할 지난주 기록이 아직 없어요)</p>
          </EmptyState>
        ) : entries.length === 0 ? (
          <EmptyState>
            {snap.source === "empty"
              ? `아직 첫 수집 전입니다. ${firstFillText}`
              : "표시할 저장소가 없습니다."}
          </EmptyState>
        ) : (
          // 넓은 화면에서는 스크롤 상자를 만들지 않는다 — 접근 태그 툴팁이 마지막 행 아래로
          // 내려올 때 overflow 상자에 잘리기 때문이다. 좁은 화면에서만 가로 스크롤을 준다.
          <div className="max-lg:overflow-x-auto">
            <table className="dtable max-lg:min-w-[60rem]">
              <thead>
                <tr>
                  <th className="w-14 text-right">순위</th>
                  <th>저장소</th>
                  <th>언어</th>
                  <th>라이선스</th>
                  <th className="text-right">포크</th>
                  <th>최근 푸시</th>
                  <th>네트워크 접근</th>
                  <th className="text-right">★ star</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <RankRow key={e.repo.id} entry={e} kind={kind} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-[12px] text-muted-foreground">
          이번 주 추적 저장소 {num(snap.trackedCount)}개 중 상위 {SKILLS_RANK_SIZE} · GitHub 은
          과거 star 수를 주지 않아 매주 우리 스냅샷을 남겨 직접 차분합니다.
        </p>
      </section>
    </div>
  );
}
