import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 여러 줄 입력. Input과 동일한 테두리/포커스 스타일을 쓰되 세로로 넉넉히 열어둔다.
 * - min-h: 기본 약 3줄(리스트/키워드용). 산문형(수집 가이드)은 className으로 min-h를 키운다.
 * - max-h + overflow-y-auto: 내용이 많으면 내부 스크롤
 * - resize-y: 필요하면 사용자가 세로로 더 늘릴 수 있음
 */
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex min-h-[4.5rem] max-h-[16rem] w-full resize-y overflow-y-auto rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
