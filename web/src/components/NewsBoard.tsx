import { useEffect, useState } from "react";
import { RefreshCw, Loader2, Newspaper, Link as LinkIcon, CalendarDays } from "lucide-react";
import type { NewsSnapshot, NewsItem, NewsCategory } from "@shared/types";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

function NewsItemCard({ item, color }: { item: NewsItem; color: string }) {
  return (
    <Card className="border-l-4 p-4" style={{ borderLeftColor: color }}>
      <h4 className="font-semibold leading-snug">{item.title}</h4>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span>{item.source}</span>
        <span className="inline-flex items-center gap-1">
          <CalendarDays className="h-3 w-3" /> {item.date}
        </span>
      </p>
      {item.summary && <p className="mt-2 text-sm leading-relaxed text-foreground/80">{item.summary}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3 border-t pt-2 text-xs">
        {item.link && (
          <a
            href={item.link}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[#4361ee] hover:underline"
          >
            <LinkIcon className="h-3 w-3" /> 원문 보기
          </a>
        )}
        {item.related.map((r, i) => (
          <a
            key={i}
            href={r.link}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:underline"
          >
            {r.label}
          </a>
        ))}
      </div>
    </Card>
  );
}

function Section({ cat }: { cat: NewsCategory }) {
  return (
    <section className="mt-8">
      <h2
        className="mb-3 flex items-center gap-2 border-b pb-2 text-lg font-bold"
        style={{ color: cat.color, borderColor: cat.color }}
      >
        <span>{cat.emoji}</span>
        {cat.label}
        <span className="text-sm font-normal text-muted-foreground">({cat.items.length})</span>
      </h2>
      {cat.items.length ? (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          {cat.items.map((it, i) => (
            <NewsItemCard key={i} item={it} color={cat.color} />
          ))}
        </div>
      ) : (
        <p className="rounded-md bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          오늘은 해당 카테고리의 최신 뉴스가 없습니다.
        </p>
      )}
    </section>
  );
}

export function NewsBoard() {
  const [snap, setSnap] = useState<NewsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      setSnap(await api.news());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      setSnap(await api.refreshNews());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 불러오는 중…
      </div>
    );
  }

  const updated = snap?.updatedAt ? new Date(snap.updatedAt).toLocaleString("ko-KR") : null;
  const total = snap?.categories.reduce((a, c) => a + c.items.length, 0) ?? 0;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          매일 08:00 자동 수집 · 최근 24시간 뉴스 · 이메일 발송
          {updated && ` · 최종 갱신 ${updated}`}
          {snap && ` · 총 ${total}건`}
        </p>
        <Button variant="outline" onClick={refresh} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          지금 갱신
        </Button>
      </div>

      {err && (
        <div className="mb-4 rounded-md border border-up/40 bg-up/10 px-4 py-3 text-sm text-up">{err}</div>
      )}

      {refreshing && !snap && (
        <p className="text-sm text-muted-foreground">뉴스를 수집하는 중입니다… (1~3분 소요)</p>
      )}

      {!snap ? (
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <Newspaper className="h-10 w-10" />
          <p>아직 수집된 뉴스가 없습니다.</p>
          <Button onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            지금 갱신
          </Button>
        </div>
      ) : (
        <>
          {snap.categories.map((cat) => (
            <Section key={cat.key} cat={cat} />
          ))}
        </>
      )}
    </div>
  );
}
