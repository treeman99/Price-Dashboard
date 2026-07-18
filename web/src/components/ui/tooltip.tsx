import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 아이콘 전용 버튼에 즉시 뜨는 라벨 툴팁.
 *
 * 브라우저 네이티브 `title` 은 약 1.5초 지연 + 작은 시스템 스타일이라 "무슨 버튼인지"
 * 바로 알기 어렵다. 이 컴포넌트는 버튼 안에 라벨 span 을 넣어 hover/focus 즉시 보여준다.
 *
 * 사용법 — 버튼을 named group 으로 만들고 Tip 을 '자식'으로 둔다(래퍼가 아니라 자식이라
 * `DialogTrigger asChild` 처럼 단일 자식을 요구하는 곳과도 호환된다):
 *   <button className="group/tt relative ..." aria-label="영구 삭제">
 *     <Trash2 />
 *     <Tip>영구 삭제</Tip>
 *   </button>
 *
 * 접근성: 시각 라벨은 이 툴팁이, 스크린리더 라벨은 버튼의 aria-label 이 담당한다.
 * (native `title` 은 중복 툴팁을 유발하므로 이 툴팁을 쓰는 버튼에서는 제거한다.)
 */
export function Tip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      role="tooltip"
      className={cn(
        "pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2",
        "translate-y-0.5 whitespace-nowrap rounded-md bg-neutral-900 px-2 py-1 text-xs",
        "font-normal leading-none text-white opacity-0 shadow-md transition-all duration-150",
        "group-hover/tt:translate-y-0 group-hover/tt:opacity-100",
        "group-focus-within/tt:translate-y-0 group-focus-within/tt:opacity-100",
        "dark:bg-neutral-100 dark:text-neutral-900",
        className
      )}
    >
      {children}
    </span>
  );
}
