import { Router } from "express";
import { getTabSettingsResponse, saveTabSettings } from "../settings/tab-settings.ts";
import type { DeepPartial, TabSettings } from "../../shared/types.ts";

/**
 * 탭별 운영 설정 API(docs/customization-contract.md §2). 타입 정본은 shared/types.ts 의
 * `TabSettings`·`TabSettingsResponse`.
 *
 * routes.ts 와 파일을 나눈 이유: 그 파일은 다른 작업과 동시에 편집되는 중이고, 이 라우트는
 * 저장소(src/settings) 하나에만 기대는 독립 단위라 마운트 한 줄로 붙이는 편이 충돌이 없다.
 */
export const settingsApi = Router();

/** 현재 유효 설정 + .env 기본값 + 숫자 범위. */
settingsApi.get("/settings", (_req, res) => {
  res.json(getTabSettingsResponse());
});

/**
 * 부분 수정(DeepPartial<TabSettings>). 검증 실패는 400 {error}(한국어 사유).
 *
 * (예전에는 조용 시간이 바뀌면 펄스 보류분 묶음 발송 cron 을 재등록했다. 메일·문자 발송 기능을
 *  제거하면서 그 cron 이 없어졌고, 조용 시간은 펄스 판정 게이트가 호출 시점마다 읽는다.)
 */
settingsApi.put("/settings", (req, res) => {
  try {
    saveTabSettings((req.body ?? {}) as DeepPartial<TabSettings>);
    res.json(getTabSettingsResponse());
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
