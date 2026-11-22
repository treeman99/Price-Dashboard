import { useCallback, useEffect, useState } from "react";
import { Loader2, Mail, MessageSquare, Play, RefreshCw } from "lucide-react";
import { safeHref } from "@shared/url";
import {
  DAILY_REPORT_OUTCOME_LABEL,
  type DailyReportEntry,
  type DailyReportListResponse,
  type DailyReportModelOutcome,
  type DailyReportRunSummary,
  type DailyReportSection,
} from "@shared/report";
import { api, type DailyReportRunDetail } from "@/lib/api";
import { formatWhen } from "@/lib/tabConfig";
import { ScheduleControl } from "@/components/ScheduleControl";
import { Button } from "@/components/ui/button";
import {
  EmptyLine,
  EmptyState,
  LoadingState,
  Meta,
  MetaDot,
  Notice,
  PageToolbar,
  SectionHeader,
  StatusTag,
  SubHeader,
  TextLink,
  type TagTone,
} from "@/components/ui/page";
import { cn } from "@/lib/utils";

/**
 * '보고서' 탭 — 세 모델(Opus 5.5 · GPT-6.1 Sol · Gemini 4 Neon) 통합 뉴스·유튜브 보고서.
 *
 * 실행은 서버 스케줄러가 '통합 보고서' 일정(기본 09:00·17:00)마다 봇 홈의 수집기를 돌려 하고, 같은 실행이
 * 뉴스·유튜브 탭도 갱신한다. 이 화면은 실행 목록·모델별 상태·본문을 보여 주고, 실행 1건을 메일·문자로
 * 다시 보낼 수 있다. 보고서 본문은 직전 보고 이후 **새 항목만** 싣는다(탭은 통합 결과 전체).
 */

const POLL_MS = 10_000;

const OUTCOME_TONE: Record<DailyReportModelOutcome, TagTone> = {
  success: "success",
  "skipped-limit": "warn",
  "skipped-error": "error",
};

const TRIGGER_LABEL: Record<string, string> = {
  "price:schedule": "정시",
  "price:catchup": "보충",
  "price:manual": "수동",
  cli: "봇·수동 명령",
};

function when(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatWhen(d, new Date());
}

function runTone(r: { ok: boolean; successCount: number; modelCount: number }): { tone: TagTone; label: string } {
  if (!r.ok) return { tone: "error", label: "통합 실패" };
  if (r.successCount < r.modelCount) return { tone: "warn", label: `부분 ${r.successCount}/${r.modelCount}` };
  return { tone: "success", label: "세 모델 성공" };
}

/** 실행 목록 1행. */
function RunRow({ run, selected, onSelect }: { run: DailyReportRunSummary; selected: boolean; onSelect: () => void }) {
  const t = runTone(run);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "w-full px-2 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected && "bg-muted"
        )}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="num text-[14px] font-semibold">{when(run.startedAt)}</span>
          <StatusTag tone={t.tone}>{t.label}</StatusTag>
          <span className="text-[12px] text-muted-foreground">{TRIGGER_LABEL[run.trigger] ?? run.trigger}</span>
          {run.delivered.email && <Mail aria-label="메일 보냄" className="h-3.5 w-3.5 text-muted-foreground" />}
          {run.delivered.imessage && <MessageSquare aria-label="문자 보냄" className="h-3.5 w-3.5 text-muted-foreground" />}
        </div>
        <p className="num mt-1 text-[12.5px] text-muted-foreground">
          새 {run.counts.reported}건
          {run.counts.seedsOnly ? ` + 추천 업로드 ${run.counts.seedsOnly}` : ""} · 통합 {run.counts.before}→{run.counts.afterMerge}
        </p>
        <p className="mt-1 flex flex-wrap gap-1">
          {run.models.map((m) => (
            <span
              key={m.key}
              title={`${m.label}: ${DAILY_REPORT_OUTCOME_LABEL[m.outcome]}`}
              className={cn(
                "rounded-sm border px-1 text-[11px] leading-4",
                m.outcome === "success"
                  ? "border-tone-success/40 text-tone-success"
                  : m.outcome === "skipped-limit"
                    ? "border-tone-warn/45 text-tone-warn"
                    : "border-tone-error/40 text-tone-error"
              )}
            >
              {m.label.replace(/^Claude |^Gemini 4 /, "")}
            </span>
          ))}
        </p>
      </button>
    </li>
  );
}

function EntryRow({ e }: { e: DailyReportEntry }) {
  const href = safeHref(e.url);
  return (
    <li className="py-3">
      <p className="text-[15px] font-semibold leading-snug">
        {e.update && (
          <StatusTag tone="info" className="mr-1.5">
            새 출처
          </StatusTag>
        )}
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="hover:underline">
            {e.title}
          </a>
        ) : (
          e.title
        )}
      </p>
      <p className="num mt-1 text-[12.5px] text-muted-foreground">
        {e.source} · {e.kind === "youtube" ? `업로드 ${e.date}` : e.date} · 찾은 모델 {e.foundBy.join(", ")}
      </p>
      <p className="mt-1.5 text-[14px] leading-relaxed text-foreground/85">{e.summary}</p>
      {e.secondary.length > 0 && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
          보조 출처:
          {e.secondary.slice(0, 6).map((s) => {
            const h = safeHref(s.link);
            return h ? (
              <TextLink key={s.link} href={h} target="_blank" rel="noreferrer">
                {s.label}
              </TextLink>
            ) : (
              <span key={s.link}>{s.label}</span>
            );
          })}
        </p>
      )}
      {e.conflict && <p className="mt-1.5 text-[12.5px] text-tone-warn">⚠️ 근거 차이: {e.conflict}</p>}
    </li>
  );
}

function Sections({ title, sections }: { title: string; sections: DailyReportSection[] }) {
  const total = sections.reduce((a, s) => a + s.items.length, 0);
  return (
    <section className="mt-8">
      <SectionHeader title={title} count={total} />
      {total === 0 ? (
        <EmptyLine>새 항목 없음</EmptyLine>
      ) : (
        sections.map((s) => (
          <div key={s.key} className="mt-3">
            <SubHeader count={s.items.length}>{s.label}</SubHeader>
            <ul className="divide-y">
              {s.items.map((e, i) => (
                <EntryRow key={`${s.key}-${i}`} e={e} />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

function ReportDetail({
  detail,
  channels,
  onSent,
}: {
  detail: DailyReportRunDetail;
  channels: DailyReportListResponse["channels"] | null;
  onSent: () => void;
}) {
  const [sending, setSending] = useState<"email" | "imessage" | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "error" | "warn"; text: string } | null>(null);
  const r = detail.report;

  async function send(ch: "email" | "imessage") {
    const label = ch === "email" ? "메일" : "문자";
    if (!confirm(`이 보고서를 지금 ${label}로 보낼까요?`)) return;
    setSending(ch);
    setMsg(null);
    try {
      const res = await api.sendReportRun(detail.runId, [ch]);
      if (res.sent[ch]) setMsg({ tone: "success", text: `${label}로 보냈습니다.` });
      else setMsg({ tone: "warn", text: res.skipped[ch] ?? res.errors[0] ?? `${label}를 보내지 못했습니다.` });
      onSent();
    } catch (e) {
      setMsg({ tone: "error", text: (e as Error).message });
    } finally {
      setSending(null);
    }
  }

  if (!r) {
    return (
      <div>
        <Notice tone="muted">이 실행은 구조화 보고서가 생기기 전 버전이라 원문(마크다운)만 보여 줍니다.</Notice>
        <pre className="mt-3 max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-[12.5px] leading-relaxed">
          {detail.markdown ?? "보고서 파일이 없습니다."}
        </pre>
      </div>
    );
  }

  const t = runTone(r);
  const action = r.models.filter((m) => m.outcome === "skipped-error");
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="font-serif text-[22px] font-semibold leading-tight">IT 뉴스·유튜브 통합 보고서</h2>
        <StatusTag tone={t.tone}>{t.label}</StatusTag>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!!sending || !channels?.email.ready}
            title={channels?.email.ready ? "이 보고서를 지금 메일로 보냅니다" : (channels?.email.problem ?? "")}
            onClick={() => void send("email")}
          >
            {sending === "email" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />} 메일로 보내기
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!!sending || !channels?.imessage.ready}
            title={channels?.imessage.ready ? "이 보고서 요약을 지금 문자로 보냅니다" : (channels?.imessage.problem ?? "")}
            onClick={() => void send("imessage")}
          >
            {sending === "imessage" ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />} 문자로 보내기
          </Button>
        </div>
      </div>
      <p className="num mt-1.5 text-[13px] text-muted-foreground">
        보고 {when(r.startedAt)} · {TRIGGER_LABEL[r.trigger] ?? r.trigger} · 실행 ID {r.runId}
        {r.editor.label ? ` · 편집 ${r.editor.label}` : ""}
        {detail.delivered.email ? ` · 메일 보냄 ${when(detail.delivered.email)}` : ""}
        {detail.delivered.imessage ? ` · 문자 보냄 ${when(detail.delivered.imessage)}` : ""}
      </p>
      {msg && (
        <Notice tone={msg.tone} className="mt-3">
          {msg.text}
        </Notice>
      )}
      {!r.ok && (
        <Notice tone="error" className="mt-3">
          세 모델이 모두 건너뛰어 이번 보고서를 만들지 못했습니다. 다음 실행이 같은 구간을 다시 수집합니다.
        </Notice>
      )}
      {action.length > 0 && (
        <Notice tone="error" className="mt-3" title="조치 필요">
          {action.map((m) => `${m.label}: ${m.reason.slice(0, 220)}`).join(" / ")}
        </Notice>
      )}

      {r.ok && (
        <section className="mt-6">
          <SectionHeader title="핵심 요약" />
          {r.highlights.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[14.5px] leading-relaxed">
              {r.highlights.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          ) : (
            <EmptyLine>직전 보고 이후 새 항목이 없습니다.</EmptyLine>
          )}
        </section>
      )}

      <section className="mt-8">
        <SectionHeader title="모델별 상태" />
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-[13.5px]">
            <thead>
              <tr className="border-b border-foreground/70 text-left text-[12px] text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">모델</th>
                <th className="py-1.5 pr-3 font-medium">상태</th>
                <th className="py-1.5 pr-3 text-right font-medium">뉴스/영상</th>
                <th className="py-1.5 text-right font-medium">검색·열람</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {r.models.map((m) => (
                <tr key={m.key} className="align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{m.label}</div>
                    <div className="num text-[12px] text-muted-foreground">
                      {m.model}
                      {m.actualModels.length > 0 && m.actualModels.join(",") !== m.model ? ` → ${m.actualModels.join(", ")}` : ""}
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <StatusTag tone={OUTCOME_TONE[m.outcome]}>{DAILY_REPORT_OUTCOME_LABEL[m.outcome]}</StatusTag>
                    {m.reason && <div className="mt-1 max-w-[28rem] break-words text-[12px] text-muted-foreground">{m.reason.slice(0, 300)}</div>}
                  </td>
                  <td className="num py-2 pr-3 text-right">{m.outcome === "success" ? `${m.newsCount} / ${m.youtubeCount}` : "-"}</td>
                  <td className="num py-2 text-right">{m.toolCalls}회</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="num mt-2 text-[12.5px] text-muted-foreground">
          통합 전 {r.counts.before}건 → 통합 후 {r.counts.afterMerge}건 → 이미 보고한 {r.counts.alreadyReported}건 제외 후 새{" "}
          {r.counts.reported}건{r.counts.seedsOnly ? ` (+ 모델 미선정 추천 채널 업로드 ${r.counts.seedsOnly}건)` : ""}
          {r.editor.note ? ` · ${r.editor.note}` : ""}
        </p>
      </section>

      {r.ok && (
        <>
          <Sections title="주요 뉴스" sections={r.news} />
          <Sections title="유튜브 동향" sections={r.youtube} />
          {r.seedsOnly.length > 0 && (
            <section className="mt-8">
              <SectionHeader title="추천 채널 신규 업로드" count={r.seedsOnly.length} note="모델 미선정 · RSS 기준" />
              <ul className="divide-y">
                {r.seedsOnly.slice(0, 30).map((v) => {
                  const h = safeHref(v.url);
                  return (
                    <li key={v.url} className="py-2 text-[14px]">
                      {h ? (
                        <a href={h} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                          {v.title}
                        </a>
                      ) : (
                        v.title
                      )}
                      <span className="num ml-2 text-[12.5px] text-muted-foreground">
                        {v.channel} · {v.date} · {v.categoryLabel}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}

      {(r.sourceFailures.length > 0 || r.coverage.gap) && (
        <section className="mt-8">
          <SectionHeader title="수집 실패·확인 불가" />
          <ul className="mt-2 space-y-1 text-[13px] text-muted-foreground">
            {r.coverage.gap && (
              <li>
                범위 공백: {when(r.coverage.gap.from)} ~ {when(r.coverage.gap.to)} 구간은 뉴스 수집 범위(최근 24시간) 밖이라 확인하지 못했습니다.
              </li>
            )}
            {r.sourceFailures.slice(0, 20).map((f, i) => (
              <li key={i}>
                {f.label}: {f.error}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="mt-8 text-[12px] text-muted-foreground">
        유튜브 요약은 제목·설명·검색 결과 기준이며 영상을 시청한 것은 아닙니다. 뉴스·유튜브 탭에는 이번 실행의 통합 결과
        전체가 반영되고, 이 보고서는 직전 보고 이후 새 항목만 싣습니다.
      </p>
    </div>
  );
}

export function ReportBoard() {
  const [overview, setOverview] = useState<DailyReportListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DailyReportRunDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const o = await api.report();
      setOverview(o);
      setErr(null);
      setSelected((cur) => (cur && o.runs.some((r) => r.runId === cur) ? cur : (o.runs[0]?.runId ?? null)));
      return o;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const running = !!overview?.running;
  // 실행 중이면 10초마다 확인 → 끝나면 목록이 새 실행을 맨 위에 보여 준다.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(async () => {
      const o = await load();
      if (o && !o.running && o.runs[0]) setSelected(o.runs[0].runId);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [running, load]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetailErr(null);
    api
      .reportRun(selected)
      .then((d) => alive && setDetail(d))
      .catch((e: Error) => alive && setDetailErr(e.message));
    return () => {
      alive = false;
    };
  }, [selected]);

  async function run() {
    setErr(null);
    setBusyMsg(null);
    try {
      const r = await api.runReport();
      if (r.busy && !r.collecting) {
        setBusyMsg(r.reason);
        return;
      }
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (loading) return <LoadingState />;

  const last = overview?.lastAttempt ?? null;
  const ch = overview?.channels ?? null;
  const chLabel = (c: { enabled: boolean; ready: boolean } | undefined, name: string) =>
    !c ? null : !c.enabled ? `${name} 꺼짐` : c.ready ? `${name} 켜짐` : `${name} 켜짐(준비 안 됨)`;

  return (
    <div>
      <PageToolbar
        actions={
          <>
            <Button variant="outline" onClick={() => void load()} disabled={running}>
              <RefreshCw className="h-4 w-4" /> 새로고침
            </Button>
            <Button variant="outline" onClick={() => void run()} disabled={running || overview?.collector.available === false}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {running ? "실행 중…" : "지금 실행"}
            </Button>
          </>
        }
      >
        <ScheduleControl tab="report" label="통합 보고서" />
        <MetaDot />
        <Meta>Opus 5.5 · GPT-6.1 Sol · Gemini 4 Neon</Meta>
        {ch && (
          <>
            <MetaDot />
            <Meta>
              {chLabel(ch.email, "메일")} · {chLabel(ch.imessage, "문자")}
            </Meta>
          </>
        )}
      </PageToolbar>

      {err && <Notice tone="error">{err}</Notice>}
      {busyMsg && <Notice tone="warn">{busyMsg}</Notice>}
      {overview && !overview.collector.available && (
        <Notice tone="error">
          봇 홈에 수집기가 없습니다. 저장소에서 <code>npm run daily:report:bundle</code> 로 배포하세요.
        </Notice>
      )}
      {running && overview?.running && (
        <Notice tone="info" progress>
          세 모델이 뉴스·유튜브를 조사하는 중입니다({when(overview.running.startedAt)} 시작) — 30분 안팎 걸리고, 끝나면 뉴스·유튜브
          탭과 이 목록이 함께 갱신됩니다.
        </Notice>
      )}
      {!running && last && !last.ok && (
        <Notice tone="warn">
          마지막 실행({when(last.at)}, {TRIGGER_LABEL[`price:${last.trigger}`] ?? last.trigger})이 실패했습니다 — {last.error}
        </Notice>
      )}
      {ch && (["email", "imessage"] as const).some((k) => ch[k].enabled && !ch[k].ready) && (
        <Notice tone="warn">
          알림을 켰지만 보낼 수 없습니다 —{" "}
          {(["email", "imessage"] as const)
            .filter((k) => ch[k].enabled && !ch[k].ready)
            .map((k) => `${k === "email" ? "메일" : "문자"}: ${ch[k].problem}`)
            .join(" / ")}
        </Notice>
      )}

      {!overview?.runs.length ? (
        <EmptyState>아직 보고서가 없습니다. 일정 시각에 자동으로 만들어지고, &lsquo;지금 실행&rsquo;으로 바로 만들 수도 있습니다.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-x-10 gap-y-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <aside>
            <SubHeader count={overview.runs.length}>실행 기록</SubHeader>
            <ul className="divide-y lg:max-h-[80vh] lg:overflow-y-auto">
              {overview.runs.map((r) => (
                <RunRow key={r.runId} run={r} selected={r.runId === selected} onSelect={() => setSelected(r.runId)} />
              ))}
            </ul>
          </aside>
          <div className="min-w-0">
            {detailErr && <Notice tone="error">{detailErr}</Notice>}
            {detail && detail.runId === selected ? (
              <ReportDetail detail={detail} channels={ch} onSent={() => void load()} />
            ) : (
              !detailErr && <LoadingState />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
