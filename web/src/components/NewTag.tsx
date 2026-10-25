import { cn } from "@/lib/utils";
import { StatusTag } from "@/components/ui/page";

/**
 * '지난번 이 탭을 본 뒤 새로 들어온 항목' 표시. 행 제목 앞에 글줄과 같은 높이로 붙인다.
 * 언제 붙고 언제 사라지는지는 lib/seen.ts 가 정한다.
 */
export function NewTag({ className }: { className?: string }) {
  return (
    <StatusTag
      tone="new"
      title="지난번 이 탭을 본 뒤 새로 들어온 항목"
      className={cn("mr-1.5 translate-y-[-1.5px]", className)}
    >
      신규
    </StatusTag>
  );
}
