import { getTabSettings } from "../settings/tab-settings.ts";

/**
 * 펄스 게이트 정책 값(문턱·상한). 예전에는 문자 발송 모듈(notify/pulse-imessage.ts)에 함께 있었다.
 * 메일·문자 발송 기능을 제거하면서 판정 기록에 필요한 정책만 남겼다.
 *
 * 설정된 문턱. 대시보드 값 우선, 없으면 .env. 검증·폴백은 tab-settings 가 한다.
 * 호출 시점마다 읽는다 — 저장 즉시 다음 펄스부터 반영된다.
 */
export function pulseThreshold(): "urgent" | "important" | "info" {
  return getTabSettings().stockPulse.threshold;
}

export const PULSE_CAPS = () => {
  const p = getTabSettings().stockPulse;
  return { perSymbolCap: p.perSymbolCap, dailyCap: p.dailyCap, macroCap: p.macroCap };
};
