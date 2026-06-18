import { config } from "../config.ts";
import { log } from "../util/log.ts";

/**
 * 카카오톡 "나에게 보내기" 메모 API.
 * KAKAO_ACCESS_TOKEN(talk_message 스코프) 필요. 미설정/실패 시 false 반환(수집은 계속).
 * 발송은 수집 1회당 최대 1회(호출 측에서 멱등 보장).
 */
export async function sendKakaoNotice(today: string, productCount: number): Promise<boolean> {
  if (!config.notify.kakao) return false;
  if (!config.notify.kakaoAccessToken) {
    log.warn("KAKAO_ACCESS_TOKEN 미설정 → 카카오 알림 건너뜀");
    return false;
  }

  const text = `📷 가격 추적 리포트 완료 (${today})\n${productCount}종 관심물건 최저가 갱신\n📊 http://localhost:${config.port}`;
  const templateObject = {
    object_type: "text",
    text,
    link: { web_url: `http://localhost:${config.port}`, mobile_web_url: `http://localhost:${config.port}` },
  };

  try {
    const res = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.notify.kakaoAccessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ template_object: JSON.stringify(templateObject) }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      log.warn(`카카오 발송 실패 ${res.status}: ${t.slice(0, 200)}`);
      return false;
    }
    log.info("카카오 알림 발송 완료");
    return true;
  } catch (e) {
    log.warn(`카카오 발송 예외: ${(e as Error).message}`);
    return false;
  }
}
