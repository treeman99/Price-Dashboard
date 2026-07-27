import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { isIMessageConfigured, sendIMessage } from "./imessage.ts";
import {
  DIRECTION_EMOJI,
  DIRECTION_LABEL,
  SEVERITY_LABEL,
  TRIGGER_LABEL,
} from "../../shared/pulse.ts";
import { STOCK_DISCLAIMER } from "../stock/curate.ts";
import type { PulseAlertRecord, PulseImpact } from "../../shared/types.ts";

/**
 * 펄스 알림의 문자 포맷.
 *
 * 화면도 이메일도 없이 **문자가 유일한 출력**이라(인터뷰 결정), 이 파일의 포맷이 곧 제품이다.
 * 그래서 원칙이 하나 있다: **본문만 보고 판단이 서야 한다.** 링크를 눌러야만 무슨 일인지
 * 알 수 있는 문자는 새벽 3시에 쓸모가 없다.
 */

/**
 * 단건 문자 상한. stock-email.ts 의 브리핑 요약(500자)보다 넉넉하게 잡는다 —
 * 브리핑은 "자세한 건 메일 보세요"가 성립하지만 펄스는 이게 전부라 근거까지 실어야 한다.
 */
const SINGLE_MAX = 900;

/**
 * 묶음(야간 보류 플러시) 상한. 여러 건이 들어가므로 더 크게 잡되, 무한정 늘리지는 않는다 —
 * 지나치게 긴 iMessage 는 알림 미리보기에서 잘려 오히려 안 읽힌다.
 */
const DIGEST_MAX = 2500;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** 첫 출처의 링크. 문자에는 링크를 하나만 싣는다(여러 개는 미리보기를 망친다). */
function primaryLink(i: PulseImpact): string | null {
  return i.sources.find((s) => !!s.url)?.url ?? null;
}

function originLabel(i: PulseImpact): string {
  const s = i.sources[0];
  if (!s) return "";
  const when = s.publishedAt ? ` · ${s.publishedAt}` : "";
  return `${s.origin || s.title}${when}`;
}

/**
 * 단건 알림 본문.
 *
 * 머리말에 강도·트리거를 붙이는 이유: 새벽에 온 문자가 **왜** 새벽에 왔는지를 첫 줄에서
 * 알 수 있어야 한다. '긴급'이 아닌데 새벽에 왔다면 그건 버그이고, 라벨이 있어야 사용자가
 * 그걸 발견해 신고할 수 있다.
 */
export function pulseIMessageText(i: PulseImpact): string {
  const scope = i.symbol ? `${i.name}(${i.symbol})` : i.name;
  const lines: string[] = [
    `${DIRECTION_EMOJI[i.direction]} [${SEVERITY_LABEL[i.severity]}·${TRIGGER_LABEL[i.trigger]}] ${scope}`,
    "",
    i.headline,
    "",
    `▸ 방향: ${DIRECTION_LABEL[i.direction]}`,
    `▸ 근거: ${i.rationale}`,
    `▸ 리스크: ${i.risks}`,
  ];
  const origin = originLabel(i);
  if (origin) lines.push(`▸ 출처: ${origin}`);
  const link = primaryLink(i);
  if (link) lines.push(link);
  // 면책은 매 건 붙인다. 판정만 읽고 매매하는 것을 막기 위한 것이라 생략 대상이 아니다.
  lines.push("", "※ AI 영향도 판정 · 매매 권유가 아닙니다");
  return truncate(lines.join("\n"), SINGLE_MAX);
}

/**
 * 야간 보류분 묶음 본문.
 *
 * 단건과 달리 근거·리스크를 싣지 않는다 — 여러 건이라 다 실으면 잘린다. 대신 아침에는
 * 사용자가 대시보드·메일로 후속 확인이 가능한 시간대라, 여기서는 **무슨 일이 있었는지의
 * 목록**에 집중한다.
 */
export function pulseDigestText(records: PulseAlertRecord[]): string {
  const head = `🌙 밤사이 보류된 증시 알림 ${records.length}건`;
  const body = records
    .map((r, n) => {
      const i = r.impact;
      const scope = i.symbol ? `${i.name}(${i.symbol})` : i.name;
      const at = r.createdAt.slice(11, 16);
      const link = primaryLink(i);
      return (
        `${n + 1}. ${DIRECTION_EMOJI[i.direction]} [${SEVERITY_LABEL[i.severity]}] ${at} ${scope}\n` +
        `   ${i.headline}` +
        (link ? `\n   ${link}` : "")
      );
    })
    .join("\n");
  return truncate(
    `${head}\n\n${body}\n\n※ AI 영향도 판정 · 매매 권유가 아닙니다`,
    DIGEST_MAX
  );
}

/**
 * 단건 발송. 성공 true / 미설정·실패 false. **절대 throw 하지 않는다** —
 * 알림 하나가 펄스 실행 전체를 깨면 나머지 판정까지 잃는다.
 */
export async function sendPulseIMessage(i: PulseImpact): Promise<boolean> {
  if (!isIMessageConfigured()) return false;
  try {
    await sendIMessage(pulseIMessageText(i));
    return true;
  } catch (e) {
    log.warn(`펄스 iMessage 발송 실패 [${i.symbol ?? "macro"}]: ${(e as Error).message}`);
    return false;
  }
}

/** 묶음 발송. 빈 목록이면 아무것도 하지 않고 false. */
export async function sendPulseDigest(records: PulseAlertRecord[]): Promise<boolean> {
  if (!records.length) return false;
  if (!isIMessageConfigured()) return false;
  try {
    await sendIMessage(pulseDigestText(records));
    log.info(`펄스 야간 보류 ${records.length}건 묶음 발송 완료`);
    return true;
  } catch (e) {
    log.warn(`펄스 묶음 iMessage 발송 실패: ${(e as Error).message}`);
    return false;
  }
}

/**
 * 문자 채널이 아예 꺼져 있는지. 펄스 실행 자체를 건너뛸 근거로 쓴다 —
 * 출력 채널이 문자 하나뿐인데 그게 꺼져 있으면 매시간 LLM 을 돌릴 이유가 없다.
 *
 * ⚠️ 이 판정으로 펄스를 끄면 **원장도 안 쌓여서** 일일 브리핑의 24시간 요약도 빈다.
 *    그래도 끄는 쪽이 맞다 — 사용자가 알림을 안 켰다는 건 이 기능을 안 쓴다는 뜻이고,
 *    쓰지도 않는 기능이 하루 16회 토큰을 태우면 안 된다.
 */
export function isPulseNotifyEnabled(): boolean {
  return isIMessageConfigured();
}

/** 면책 문구는 브리핑과 같은 출처를 쓴다(문구가 채널마다 갈라지지 않게). */
export { STOCK_DISCLAIMER };

/** 설정된 문턱. 검증·폴백은 config 가 한다(env 접근은 config.ts 로 일원화). */
export function pulseThreshold(): "urgent" | "important" | "info" {
  return config.stockPulse.threshold;
}

export const PULSE_CAPS = () => ({
  perSymbolCap: config.stockPulse.perSymbolCap,
  dailyCap: config.stockPulse.dailyCap,
  macroCap: config.stockPulse.macroCap,
});
