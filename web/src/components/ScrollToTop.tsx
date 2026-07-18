import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 아래로 스크롤하면 우하단에 나타나는 '맨 위로' 플로팅 버튼(모든 탭 공통).
 * App 최상위에 1개만 렌더한다(fixed 라 뷰포트 기준). 스크롤은 window(문서) 기준.
 * color: 활성 탭 고유색 — 탭을 바꾸면 버튼 색도 따라 바뀐다.
 */
export function ScrollToTop({ color }: { color: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 300);
    onScroll(); // 마운트 시 현재 위치 반영
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function scrollTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
    // 일부 임베디드 환경은 smooth 를 무시한다 → 잠시 뒤에도 안 움직였으면 즉시 이동으로 폴백.
    window.setTimeout(() => {
      if (window.scrollY > 0) window.scrollTo(0, 0);
    }, 500);
  }

  return (
    <button
      type="button"
      onClick={scrollTop}
      aria-label="맨 위로 스크롤"
      title="맨 위로"
      className={cn(
        "fixed bottom-6 right-6 z-50 inline-flex h-11 w-11 items-center justify-center rounded-full text-white shadow-lg ring-1 ring-black/10 transition-all duration-200 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        visible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"
      )}
      style={{ backgroundColor: color }}
    >
      <ArrowUp className="h-5 w-5" />
    </button>
  );
}
