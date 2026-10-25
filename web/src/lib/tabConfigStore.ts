import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import type { ScheduleResponse, TabSettingsResponse } from "@shared/types";

/**
 * 스케줄(/api/schedule)·운영 설정(/api/settings) 응답을 화면 전체가 **한 벌** 공유하는 저장소.
 *
 * 탭 툴바 버튼, 상단 '설정' 전체 보기, 스킬 랭킹 안내 문구, 툴바의 알림 표기가 같은 값을 본다.
 * 각자 따로 불러오면 한 곳에서 저장한 뒤 다른 곳이 옛 값을 계속 보여 준다(예: 전체 보기에서
 * 뉴스 알림을 끄고 닫았는데 뉴스 툴바엔 여전히 '이메일 발송').
 */
export interface TabConfigState {
  schedule: ScheduleResponse | null;
  scheduleErr: string | null;
  settings: TabSettingsResponse | null;
  settingsErr: string | null;
  /** 첫 응답(성공·실패)이 오기 전. */
  loading: boolean;
}

let state: TabConfigState = {
  schedule: null,
  scheduleErr: null,
  settings: null,
  settingsErr: null,
  loading: true,
};
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let loadedOnce = false;

function set(patch: Partial<TabConfigState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/**
 * 옛 서버(스케줄 v1: 잡 → 시각 배열)는 /api/schedule 이 다른 모양을 준다. 그대로 쓰면 화면이
 * undefined 를 읽다 죽으므로 모양을 확인해 '불러오기 실패'로 돌린다.
 */
function isScheduleV2(r: unknown): r is ScheduleResponse {
  const o = r as Partial<ScheduleResponse> | null;
  return !!o && typeof o.schedule === "object" && typeof o.rules === "object" && typeof o.defaults === "object";
}

/** 두 응답을 다시 읽는다. 동시에 여러 번 불려도 요청은 한 번만 나간다. */
export function reloadTabConfig(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    const [sched, settings] = await Promise.allSettled([api.schedule(), api.settings()]);
    const patch: Partial<TabConfigState> = { loading: false };
    if (sched.status === "fulfilled") {
      if (isScheduleV2(sched.value)) {
        patch.schedule = sched.value;
        patch.scheduleErr = null;
      } else {
        patch.scheduleErr = "서버가 새 스케줄 형식을 아직 지원하지 않습니다(서버 재시작 필요).";
      }
    } else {
      patch.scheduleErr = (sched.reason as Error)?.message ?? "스케줄을 불러오지 못했습니다.";
    }
    if (settings.status === "fulfilled") {
      patch.settings = settings.value;
      patch.settingsErr = null;
    } else {
      patch.settingsErr = (settings.reason as Error)?.message ?? "운영 설정을 불러오지 못했습니다.";
    }
    set(patch);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** 저장(PUT) 응답을 그대로 반영한다 — 서버가 정규화한 최종값이 정본이다. */
export function applySchedule(r: ScheduleResponse) {
  set({ schedule: r, scheduleErr: null });
}

export function applySettings(r: TabSettingsResponse) {
  set({ settings: r, settingsErr: null });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function snapshot() {
  return state;
}

/** 저장소 구독. 처음 쓰는 컴포넌트가 마운트될 때 한 번 불러온다. */
export function useTabConfig(): TabConfigState {
  const s = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    if (loadedOnce) return;
    loadedOnce = true;
    void reloadTabConfig();
  }, []);
  return s;
}
