import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatWon(n: number | null | undefined): string {
  if (n == null) return "-";
  return `${n.toLocaleString("ko-KR")}원`;
}

export function formatMan(n: number): string {
  return `${(n / 10000).toLocaleString("ko-KR", { maximumFractionDigits: 0 })}만`;
}
