import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/tooltip";

/**
 * 탭 화면의 공통 어휘. 모든 게시판이 같은 문법으로 보이도록 여기 것만 조합해 쓴다.
 * 규칙과 예시는 docs/ui-design-guide.md 참고.
 *
 *   PageToolbar   탭 맨 위 한 줄: 왼쪽 메타(수집 시각·갱신 시각), 오른쪽 동작 버튼
 *   Notice        안내 띠(오류·경고·진행·성공·회색). 상자 대신 왼쪽 굵은 선
 *   SectionHeader 2px 잉크 괘선 + 명조 제목. 섹션 사이 구분은 이것 하나로 한다
 *   SubHeader     섹션 안의 소그룹 라벨(서울 · 8건, 코엑스 …)
 *   Segmented     탭 안의 보기 전환(한국장/미국장 …)
 *   StatusTag     신규·종료임박 같은 짧은 상태 표시
 *   TextLink      목록 행 안의 보조 링크(원문·캘린더)
 *   IconAction    아이콘만 있는 행 동작 버튼(즉시 뜨는 라벨 툴팁 포함)
 *   EmptyState / LoadingState
 */

// ── 툴바 ──────────────────────────────────────────────────────────────────────

export function PageToolbar({
  children,
  actions,
  className,
}: {
  children?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b pb-3",
        className
      )}
    >
      {/* 메타 칸은 flex-basis 0 이라 최소 폭이 없으면 좁은 화면(375px)에서 오른쪽 버튼들 옆에 50~80px 로
          짓눌린다(자동 수집 요약이 통째로 잘리거나 버튼 밑으로 겹친다). 최소 폭을 주면 그때는 버튼 줄이
          아래로 내려가고(ml-auto 로 오른쪽 정렬), 넓은 화면은 지금과 같다. */}
      <div className="flex min-w-[min(100%,16rem)] flex-1 flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-muted-foreground">
        {children}
      </div>
      {/* max-w-full: 버튼이 한 줄에 다 안 들어가는 폭(375px 등)에서는 이 칸이 줄 전체를 차지하고 안에서 줄바꿈된다.
          없으면 버튼 줄이 화면 밖으로 밀려 페이지 전체가 가로로 스크롤된다. */}
      {actions && <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
    </div>
  );
}

/** 메타 문구 사이 가운뎃점. PageToolbar 안에서 `<Meta>` 사이에 둔다. */
export function MetaDot() {
  return (
    <span aria-hidden className="text-muted-foreground/50">
      ·
    </span>
  );
}

/** 툴바의 메타 한 조각. 값(시각·건수)은 `strong` 으로 감싸면 잉크색 숫자로 보인다. */
export function Meta({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("num [&_strong]:font-medium [&_strong]:text-foreground", className)}>{children}</span>;
}

// ── 안내 띠 ───────────────────────────────────────────────────────────────────

export type NoticeTone = "error" | "warn" | "info" | "success" | "muted";

const TONE: Record<NoticeTone, { bar: string; bg: string; icon: string; Icon: React.ElementType }> = {
  error: { bar: "border-tone-error", bg: "bg-tone-error/[0.06]", icon: "text-tone-error", Icon: XCircle },
  warn: { bar: "border-tone-warn", bg: "bg-tone-warn/[0.07]", icon: "text-tone-warn", Icon: AlertTriangle },
  info: { bar: "border-tone-info", bg: "bg-tone-info/[0.06]", icon: "text-tone-info", Icon: Info },
  success: { bar: "border-tone-success", bg: "bg-tone-success/[0.06]", icon: "text-tone-success", Icon: CheckCircle2 },
  muted: { bar: "border-foreground/20", bg: "bg-muted/60", icon: "text-muted-foreground", Icon: Info },
};

/**
 * 안내 띠. 글씨는 잉크색 그대로 두고 톤은 왼쪽 선·아이콘·옅은 바탕으로만 표시한다
 * (색 글씨 문단은 읽히지 않는다).
 *
 * - `progress` 를 주면 아이콘 대신 회전 스피너(수집 중 안내).
 * - `icon={null}` 이면 아이콘 없이.
 * - `action` 은 오른쪽 끝 버튼 자리.
 */
export function Notice({
  tone = "info",
  progress,
  icon,
  title,
  children,
  action,
  className,
  ...rest
}: {
  tone?: NoticeTone;
  progress?: boolean;
  icon?: React.ReactNode | null;
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "title">) {
  const t = TONE[tone];
  const glyph =
    icon === null ? null : icon !== undefined ? (
      icon
    ) : progress ? (
      <Loader2 className={cn("h-4 w-4 animate-spin", t.icon)} />
    ) : (
      <t.Icon className={cn("h-4 w-4", t.icon)} />
    );
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("mb-4 flex items-start gap-2.5 border-l-[3px] px-3.5 py-2.5 text-sm", t.bar, t.bg, className)}
      {...rest}
    >
      {glyph && <span className="mt-[3px] shrink-0 [&_svg]:h-4 [&_svg]:w-4">{glyph}</span>}
      <div className="min-w-0 flex-1 leading-relaxed">
        {title && <p className="font-semibold">{title}</p>}
        {children}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

// ── 섹션 머리 ─────────────────────────────────────────────────────────────────

/**
 * 섹션 머리. 위쪽 2px 잉크 괘선 + 명조 제목 + 건수 + (선택) 오른쪽 동작.
 * 섹션을 상자로 감싸지 말고 이 괘선 하나로 구분한다.
 *
 * - accent: 제목 앞 작은 색 사각형(카테고리 고유색 등). 제목 글씨 자체는 잉크색 유지.
 * - note: 제목 옆 회색 보조 설명(한 줄).
 */
export function SectionHeader({
  title,
  count,
  accent,
  note,
  actions,
  className,
  as: Tag = "h2",
}: {
  title: React.ReactNode;
  count?: number | string | null;
  accent?: string;
  note?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  as?: "h2" | "h3";
}) {
  return (
    <div className={cn("group/section mb-3 mt-10 border-t-2 border-foreground pt-2.5 first:mt-0", className)}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Tag className="flex items-baseline gap-2 font-serif text-[1.3rem] font-semibold leading-tight tracking-[-0.01em]">
          {accent && (
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 translate-y-[-0.1em] rounded-[2px]"
              style={{ backgroundColor: accent }}
            />
          )}
          {title}
        </Tag>
        {count != null && <span className="num font-mono text-[13px] text-muted-foreground">{count}</span>}
        {note && <span className="text-[13px] text-muted-foreground">{note}</span>}
        {actions && <div className="ml-auto flex items-center gap-0.5 self-center">{actions}</div>}
      </div>
    </div>
  );
}

/** 섹션 안 소그룹 라벨. 작은 굵은 글씨 + 건수, 아래 헤어라인. */
export function SubHeader({
  children,
  count,
  accent,
  note,
  actions,
  className,
}: {
  children: React.ReactNode;
  count?: number | string | null;
  accent?: string;
  note?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-1 mt-6 flex items-center gap-2 border-b pb-1.5 first:mt-2", className)}>
      {accent && (
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
      )}
      <h3 className="text-[13px] font-semibold tracking-[0.02em]">{children}</h3>
      {count != null && <span className="num font-mono text-[12px] text-muted-foreground">{count}</span>}
      {note && <span className="text-[12px] text-muted-foreground">{note}</span>}
      {actions && <div className="ml-auto flex items-center gap-0.5">{actions}</div>}
    </div>
  );
}

// ── 작은 부품 ─────────────────────────────────────────────────────────────────

export type TagTone = "new" | "urgent" | "soon" | "neutral" | "info" | "warn" | "success" | "error";

const TAG: Record<TagTone, string> = {
  new: "text-tone-success border-tone-success/40",
  success: "text-tone-success border-tone-success/40",
  urgent: "text-tone-error border-tone-error/40",
  error: "text-tone-error border-tone-error/40",
  soon: "text-tone-info border-tone-info/40",
  info: "text-tone-info border-tone-info/40",
  warn: "text-tone-warn border-tone-warn/45",
  neutral: "text-muted-foreground border-foreground/20",
};

/** 짧은 상태 표시(신규·종료임박·오픈예정 …). 색 채운 알약 대신 글씨+얇은 테두리. */
export function StatusTag({
  tone = "neutral",
  children,
  className,
  ...rest
}: { tone?: TagTone; children: React.ReactNode; className?: string } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center whitespace-nowrap rounded-[3px] border px-1.5 text-[11px] font-semibold leading-none",
        TAG[tone],
        className
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

/** 목록 행 안의 보조 링크(원문 보기·캘린더 추가 …). 평소엔 회색, hover 시 잉크+밑줄. */
export const TextLink = React.forwardRef<
  HTMLAnchorElement,
  React.AnchorHTMLAttributes<HTMLAnchorElement> & { icon?: React.ReactNode }
>(({ className, icon, children, ...props }, ref) => (
  <a
    ref={ref}
    target="_blank"
    rel="noreferrer"
    className={cn(
      "inline-flex items-center gap-1 whitespace-nowrap text-[12.5px] text-muted-foreground underline-offset-[3px] transition-colors hover:text-foreground hover:underline [&_svg]:h-3.5 [&_svg]:w-3.5",
      className
    )}
    {...props}
  >
    {icon}
    {children}
  </a>
));
TextLink.displayName = "TextLink";

/**
 * 툴팁을 버튼 **위쪽 · 오른쪽 끝 정렬**로 띄운다. 가로 스크롤 상자(overflow-x-auto) 안 표의 맨 오른쪽 열 전용.
 *
 * 툴팁은 숨어 있을 때도(opacity 0) 자리를 차지한다. 기본 배치(아래·가운데)로 두면 마지막 열에서 오른쪽으로,
 * 마지막 행에서 아래로 상자 밖에 삐져나오고, overflow-x-auto 는 세로축까지 스크롤 상자로 만들어서
 * 표가 다 보이는 넓은 화면에서도 안쪽 스크롤바가 생겼다(보유 주식 표 실측: 오른쪽 29px · 아래 3px).
 * 위로 열면 위에 늘 열 머리가 있고, 오른쪽 끝에 맞추면 버튼 폭 안에서 끝나 상자를 벗어나지 않는다.
 */
const TIP_ABOVE_END = "bottom-full left-auto right-0 top-auto mb-1.5 mt-0 translate-x-0 -translate-y-0.5";

/**
 * 아이콘만 있는 행 동작(위로·아래로·수정·삭제 …). 즉시 뜨는 라벨 툴팁이 붙는다.
 * `danger` 는 hover 시 빨강. `active` 는 켜진 상태(고정 핀 등)를 잉크색으로.
 * `tip="above-end"` 는 스크롤 상자 안 표의 맨 오른쪽 열에서 쓴다(TIP_ABOVE_END 주석).
 */
export const IconAction = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    danger?: boolean;
    active?: boolean;
    tip?: "below" | "above-end";
  }
>(({ label, danger, active, tip = "below", className, children, type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    aria-label={label}
    className={cn(
      "group/tt relative inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors",
      "hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      "disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent",
      "[&_svg]:h-4 [&_svg]:w-4",
      danger && "hover:text-tone-error",
      active && "text-foreground",
      className
    )}
    {...props}
  >
    {children}
    <Tip className={tip === "above-end" ? TIP_ABOVE_END : undefined}>{label}</Tip>
  </button>
));
IconAction.displayName = "IconAction";

/**
 * 2~4개 중 하나를 고르는 보기 전환(한국장/미국장, star 총합/이번 주 급상승 …).
 * 선택된 칸만 잉크로 채운다. 탭 안의 보기 전환은 전부 이것으로 통일한다.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  "aria-label": ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode; disabled?: boolean }[];
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("inline-flex items-center gap-0.5 rounded-md border border-foreground/20 p-0.5", className)}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[3px] px-3 text-[13px] font-medium transition-colors disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5",
              selected ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function EmptyState({
  icon,
  children,
  action,
  className,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 border-y border-dashed py-14 text-center text-sm text-muted-foreground [&>svg]:h-7 [&>svg]:w-7 [&>svg]:text-muted-foreground/60",
        className
      )}
    >
      {icon}
      <div className="max-w-md leading-relaxed">{children}</div>
      {action}
    </div>
  );
}

/** 섹션 안 '해당 없음' 한 줄. EmptyState 보다 가볍다. */
export function EmptyLine({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("py-3 text-sm text-muted-foreground", className)}>{children}</p>;
}

export function LoadingState({ label = "불러오는 중…" }: { label?: string }) {
  return (
    <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  );
}
