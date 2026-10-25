import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 켜기/끄기 스위치. 새 의존성 없이 버튼 하나로 만든다(role="switch" + aria-checked).
 * 켜진 색은 탭 고유색(--tab)이다 — 전체 보기에서 다른 탭을 편집할 때는 감싼 요소가 --tab 을 바꿔 준다.
 * 모서리는 가이드대로 4px 이하(알약 모양 대신 각진 토글).
 */
export const Switch = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
  }
>(({ checked, onCheckedChange, className, disabled, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onCheckedChange(!checked)}
    className={cn(
      "relative inline-flex h-5 w-9 shrink-0 items-center rounded-[4px] border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40",
      checked ? "border-transparent bg-tab" : "border-input bg-muted",
      className
    )}
    {...props}
  >
    <span
      aria-hidden
      className={cn(
        "absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-[2px] bg-card shadow-sm transition-[left]",
        checked ? "left-[calc(100%-1rem)]" : "left-0.5"
      )}
    />
  </button>
));
Switch.displayName = "Switch";
