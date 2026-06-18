/** 비밀값 노출 방지를 위해 단순 콘솔 로거만 사용한다 (키/토큰을 절대 로깅하지 않음). */
function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info: (...args: unknown[]) => console.log(`[${ts()}]`, ...args),
  warn: (...args: unknown[]) => console.warn(`[${ts()}] ⚠️`, ...args),
  error: (...args: unknown[]) => console.error(`[${ts()}] ✖`, ...args),
};

/** 지수 백오프 재시도 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { tries?: number; baseMs?: number; label?: string } = {}
): Promise<T> {
  const tries = opts.tries ?? 3;
  const baseMs = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const wait = baseMs * Math.pow(2, i);
      if (i < tries - 1) {
        log.warn(
          `${opts.label ?? "작업"} 실패 (시도 ${i + 1}/${tries}), ${wait}ms 후 재시도: ${(e as Error).message}`
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}
