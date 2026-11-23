import { getTabSettings } from "../settings/tab-settings.ts";
import { isMailConfigured } from "./mailer.ts";

/**
 * 탭 알림 게이트 — 2026-11-23 증시·팝업/전시·스킬 랭킹 메일 복구(사용자 결정: **메일만, 문자는 보내지 않는다**).
 *
 * PR #2 이전의 isTabNotifyEnabled(src/settings/tab-settings.ts)를 대신한다. 세 탭의 메일 모듈(stock/events/skills-email.ts)은
 * 예전 코드 그대로 이 함수 하나로 '보내도 되는가'를 본다:
 *  - 메일: 탭 스위치(운영 설정 stock·events·skills.notifyEmail, 기본 켜짐 = 예전 기본값) AND 전역 메일 설정(isMailConfigured).
 *  - 문자: 항상 false — 이 세 탭은 문자를 보내지 않는다(통합 보고서 문자는 src/report/deliver.ts 가 따로 맡는다).
 *  - 뉴스·유튜브(탭 없음)·펄스·가동 중단: false.
 */
export type NotifyChannel = "email" | "imessage";
export type MailTab = "stock" | "events" | "skills";

export function isTabNotifyEnabled(tab: string, channel: NotifyChannel): boolean {
  if (channel !== "email") return false;
  if (tab !== "stock" && tab !== "events" && tab !== "skills") return false;
  if (!isMailConfigured()) return false;
  return getTabSettings()[tab].notifyEmail;
}
