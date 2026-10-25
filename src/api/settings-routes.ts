import { Router } from "express";
import { getTabSettings, getTabSettingsResponse, saveTabSettings } from "../settings/tab-settings.ts";
import { rescheduleAll } from "../scheduler/scheduler.ts";
import type { DeepPartial, TabSettings } from "../../shared/types.ts";

/**
 * 탭별 운영 설정 API(docs/customization-contract.md §2). 타입 정본은 shared/types.ts 의
 * `TabSettings`·`TabSettingsResponse`.
 *
 * routes.ts 와 파일을 나눈 이유: 그 파일은 다른 작업과 동시에 편집되는 중이고, 이 라우트는
 * 저장소(src/settings) 하나에만 기대는 독립 단위라 마운트 한 줄로 붙이는 편이 충돌이 없다.
 */
export const settingsApi = Router();

/** 현재 유효 설정 + .env 기본값 + 숫자 범위 + 탭별 채널 + 전역 채널 상태. */
settingsApi.get("/settings", (_req, res) => {
  res.json(getTabSettingsResponse());
});

/**
 * 부분 수정(DeepPartial<TabSettings>). 검증 실패는 400 {error}(한국어 사유).
 *
 * 조용 시간 끝(quietEndHour)은 펄스 보류분 묶음 발송 cron 의 시각이다 — 바뀌면 재시작 없이
 * 즉시 재등록해야 그날 아침 발송이 새 시각에 나간다. 시작 시각은 cron 이 아니지만 같은 쌍이라
 * 함께 본다(재등록은 멱등이라 한 번 더 불러도 무해하다).
 */
settingsApi.put("/settings", (req, res) => {
  try {
    const before = getTabSettings().stockPulse;
    const updated = saveTabSettings((req.body ?? {}) as DeepPartial<TabSettings>);
    if (
      updated.stockPulse.quietStartHour !== before.quietStartHour ||
      updated.stockPulse.quietEndHour !== before.quietEndHour
    ) {
      rescheduleAll();
    }
    res.json(getTabSettingsResponse());
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
