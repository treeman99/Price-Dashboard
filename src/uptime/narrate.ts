/**
 * 가동 중단 사후 보고 — **사용자에게 보이는 한국어 문장 전부**를 만드는 곳.
 *
 * ## 왜 이 파일이 따로 있는가
 * 2026-08-02 새벽 0시 29분부터 오전 11시 15분까지 10시간 45분 동안 맥북이 클램셸 슬립에
 * 빠져 전 탭 수집이 실패했다. 그런데 `logs/stdout.log` 에 남은 것은 "Codex 응답 시간 초과"
 * 한 줄뿐이라 **LLM 장애로 오진**했고, 진짜 원인(절전)을 밝히는 데 조사 에이전트가 셋
 * 필요했다. 이 모듈이 지탱하는 것은 단 하나다 — *나중에 사용자가 열어봤을 때 "그때 맥이
 * 잠들어 있어서 안 돌았습니다" 라고 **한국어로** 읽히게 하는 것.*
 *
 * 그래서 여기의 규칙은 코드 규칙이라기보다 **글쓰기 규칙**이다:
 *
 * 1. **기술 용어 금지.** `sleep` / `pmset` / `boottime` / `SIGTERM` 같은 단어가 사용자
 *    문장에 나오면 안 된다. 그것들은 `판정근거:` 한 줄에만 모아 둔다(반증 가능성을 위해
 *    남기되, 본문의 가독성을 갉아먹지 않게).
 * 2. **자리표시자 금지.** "…" 나 "TODO" 가 사용자에게 도달하면 이 기능은 실패다.
 *    모든 cause 8종에 대해 실제 완성 문장이 있다.
 * 3. **단정과 추정을 문체로 구분한다.** `confidence` 가 "확실"이 아니면 어미를
 *    "…로 보입니다" 계열로 내린다(§3.4). 증거 없이 단정하는 것이 이 기능이 신뢰를 잃는
 *    가장 빠른 길이고, 한 번 틀리면 사용자는 다시 읽지 않는다.
 * 4. **원인을 정확한 이름으로 부른다.** "전원이 나갔어요" 한 덩어리로 뭉개면 이번 사고
 *    (절전을 LLM 장애로 오인)가 이름만 바꿔 재발한다(§12.3-1).
 * 5. **경로는 언제나 절대경로.** 알림은 폰에서 읽는다. 상대경로를 적으면 알림이 도달해도
 *    정보에는 도달하지 못한다(§6.3).
 *
 * ## 순수 함수다 — I/O 0
 * `fs` 도 `child_process` 도 `config` 도 import 하지 않는다. 파일 경로·대시보드 URL 처럼
 * 환경에 의존하는 값은 **인자로 받는다.** 이유는 두 가지다.
 * - 테스트가 `.env` 나 실제 `data/` 에 의존하지 않는다(명세: 실제 data/ 오염 금지).
 * - 이 모듈이 죽어서 서비스 기동을 막는 경로가 원천적으로 존재하지 않는다.
 *
 * ## 시각 표기 규약 (§5.3)
 * - 본문·headline 은 **KST 한국어**(`새벽 0시 29분` / `오전 11시 15분` / `밤 10시 20분`).
 *   `log.ts` 의 UTC ISO 를 그대로 쓰지 않는다 — 사용자는 UTC 를 읽지 못한다.
 * - `판정근거:` 줄과 stdout·문자의 구간 표기만 숫자(`08-02 00:29`, `07-28 22:24:10`).
 *   여기는 사람이 다른 로그와 대조하는 자리라 숫자가 더 유용하다.
 * - 타임존은 **시스템 TZ 를 믿지 않고 고정 +09:00 으로 계산**한다. 한국은 1988년 이후
 *   서머타임이 없어 오프셋이 고정이고, 이렇게 해야 테스트가 러너의 TZ 와 무관해진다.
 *
 * 명세: `downtime-spec.md` §6(문구 전부) §8.5(복구 상태 문장) §12.3(정직한 전달).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOWNTIME_CAUSE_LABEL,
  DOWNTIME_JOURNAL_FILE,
  DOWNTIME_MENTAL_MODEL_NOTE,
  SHORT_GAP_HINT_MS,
  buildSleepWindows,
  countEvaluatedMissed,
  sleepWindowCoversGap,
} from "../../shared/uptime.ts";
import type {
  DowntimeCause,
  DowntimeConfidence,
  DowntimeEvidence,
  DowntimeNotifyState,
  DowntimeRecoveryState,
  DowntimeSeverity,
  MissedSlot,
  SleepWindow,
} from "../../shared/uptime.ts";

// ────────────────────────────────────────────────────────────────────────────
// 0. 입력 계약
// ────────────────────────────────────────────────────────────────────────────

/**
 * 문구 생성에 필요한 최소 입력.
 *
 * ★ `DowntimeEvent`(§5.2)가 **구조적으로 이 인터페이스를 만족**하도록 필드명을 맞춰 뒀다.
 *   즉 `store.ts` 는 사건을 만들 때 이 조각들만 채워 `narrate()` 를 부르고, 재평가할 때는
 *   완성된 사건 객체를 **그대로** 다시 넘기면 된다(`narrate(event)`). 별도 어댑터가 필요 없다.
 */
export interface NarrationInput {
  cause: DowntimeCause;
  confidence: DowntimeConfidence;
  severity: DowntimeSeverity;
  /** 공백 시작 ISO(+09:00). `new Date()` 로 파싱 가능해야 한다. */
  gapStart: string;
  /** 공백 끝(=감지 시각) ISO(+09:00). */
  gapEnd: string;
  gapMinutes: number;
  /** false 면 길이를 문장에 쓰지 않고 "정확한 길이는 알 수 없습니다" 로 대체한다(§4.5). */
  gapExact: boolean;
  missed: readonly MissedSlot[];
  recoveryState: DowntimeRecoveryState;
  evidence: DowntimeEvidence;
  /**
   * 선택. 넘기면 절전 사유·배터리 문구에 그대로 쓰고, 없으면 `evidence.pmsetLines` 에서
   * 되조립한다(아래 `pickCoveringWindow` 주석 참고). 원장에는 `pmsetLines` 만 동결되므로
   * (§5.2) 재평가 시점에는 대개 이 필드가 비어 있다 — 그래서 폴백이 필수다.
   */
  sleepWindows?: readonly SleepWindow[];
}

/** 사건에 저장되는 한국어 3종 세트(§5.2 headline/body/reasonLine). */
export interface Narration {
  /** 한 줄 요약. 일지의 `[시각] <라벨> — <여기>` 자리와 (P1)배너 제목이 같은 값을 쓴다. */
  headline: string;
  /** "무슨 일" 본문. **논리 줄 단위로 `\n` 구분**이고 하드랩(강제 줄바꿈)은 하지 않는다. */
  body: string;
  /** `"판정근거: …"` 한 줄. ★ 접두사를 **값 안에 포함**한다(아래 주석). */
  reasonLine: string;
}

/**
 * `reasonLine` 값의 접두사.
 *
 * 명세가 두 군데서 엇갈린다: §5.2 JSON 예시는 `"reasonLine": "판정근거: …"` 로 접두사를
 * **값에 포함**하고, §6.1 일지 템플릿은 `  판정근거: <reasonLine>` 이라 접두사를 **템플릿이
 * 붙인다**. 그대로 두면 "판정근거: 판정근거: …" 가 된다.
 *
 * 해소: **값에 포함하는 쪽(§5.2)을 정본으로** 삼고, 일지 렌더러는 이 접두사를 벗겨 낸 뒤
 * 라벨 칸에 다시 넣는다(들여쓰기 정렬 때문). 이렇게 하면 §5.2 JSON 도 §6.1 화면 출력도
 * 둘 다 명세 그대로가 되고, P1 프론트가 `reasonLine` 만 단독으로 찍어도 문장이 성립한다.
 */
export const REASON_PREFIX = "판정근거: ";

// ────────────────────────────────────────────────────────────────────────────
// 1. 시각·기간 포맷 (KST 고정 +09:00)
// ────────────────────────────────────────────────────────────────────────────

/**
 * 한국 표준시 오프셋(ms). **시스템 TZ 를 읽지 않는다.**
 *
 * `Intl.DateTimeFormat({ timeZone: "Asia/Seoul" })` 대신 상수를 쓰는 이유:
 * (a) 한국은 1988-10-08 이후 서머타임이 없어 오프셋이 영구 고정이고,
 * (b) 이 함수들이 러너의 `TZ` 환경변수와 무관하게 같은 문자열을 내야 테스트가 성립하며,
 * (c) `Intl` 의 한국어 로케일 출력("오전 11:15")은 우리가 원하는 "오전 11시 15분" 과
 *     다르고 Node 빌드의 ICU 유무에 따라 흔들린다.
 */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

interface KstParts {
  y: number;
  mo: number;
  day: number;
  h: number;
  mi: number;
  s: number;
}

/**
 * **분 단위 표기는 반올림한다.**
 *
 * 명세 §6.1/§6.2/§6.3/§6.5 가 전부 `gapEnd = 2026-08-02T11:14:46+09:00` 을 "오전 11시 15분" /
 * "11:15" 로 적는다. 네 군데가 일치하므로 오타가 아니라 의도다 — 사람은 초를 잘라 말하지
 * 않고 반올림해 말한다("11시 14분 46초" 라고 하는 사람은 없다).
 *
 * 초 단위 정밀도가 필요한 자리(`판정근거:` 줄)는 `formatKstMonthDayHms` 가 **반올림 없이**
 * 원값을 그대로 찍으므로 대조 가능성은 손상되지 않는다.
 */
function roundToMinute(ms: number): number {
  return Math.round(ms / 60_000) * 60_000;
}

/** epoch ms → KST 달력 조각. 내부에서 UTC getter 를 쓰는 것은 오프셋을 이미 더했기 때문. */
function kstParts(ms: number): KstParts {
  const d = new Date(ms + KST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 표시용(분 반올림) 달력 조각. "같은 날인가 / 같은 시간대인가" 판정은 **화면에 보이는 값**
 * 기준이어야 한다 — 11:59:40 을 "오후 12시" 로 적어 놓고 내부적으로 "오전" 으로 비교하면
 * "오전 11시 59분에 껐고 12시에 켜졌습니다" 같은 어긋난 문장이 나온다.
 */
function dispParts(ms: number): KstParts {
  return kstParts(roundToMinute(ms));
}

/** 두 시각이 표시 기준으로 같은 날인가. */
function isSameDay(a: number, b: number): boolean {
  const x = dispParts(a);
  const y = dispParts(b);
  return x.y === y.y && x.mo === y.mo && x.day === y.day;
}

/**
 * 뒤 시각에서 `새벽/오전/오후/밤` 을 생략해도 되는가.
 *
 * "밤 10시 20분에 껐고 10시 24분에 켜졌습니다" 처럼 **몇 분 뒤**를 말할 때만 자연스럽다.
 * 같은 '오후'라도 3시 12분 → 8시 40분처럼 멀리 떨어져 있으면 반드시 다시 붙여야 한다 —
 * "8시 40분에 다시 켜졌습니다" 는 아침 8시로 읽힌다(명세 §6.1 power-cut 예시도 "오후 8시
 * 40분" 이라고 다시 적는다). 그래서 같은 시간대 **AND 1시간 이내**를 조건으로 둔다.
 */
const PERIOD_OMIT_WINDOW_MS = 60 * 60 * 1000;

function canOmitPeriod(a: number, b: number): boolean {
  if (!isSameDay(a, b)) return false;
  if (periodName(dispParts(a).h) !== periodName(dispParts(b).h)) return false;
  return Math.abs(b - a) < PERIOD_OMIT_WINDOW_MS;
}

/**
 * 하루를 부르는 한국어 이름.
 *
 * 경계는 명세 §6.1 예시에서 **역산**했다(임의로 고른 값이 아니다):
 * - `00:29` → "새벽 0시 29분", `04:51` → "새벽 4시 51분"  ⇒ 0–5시 = 새벽
 * - `09:20` → "오전 9시 20분", `11:15` → "오전 11시 15분" ⇒ 6–11시 = 오전
 * - `15:12` → "오후 3시 12분", `20:40` → "오후 8시 40분"  ⇒ 12–20시 = 오후
 * - `22:20` → "밤 10시 20분"                              ⇒ 21–23시 = 밤
 */
function periodName(h: number): string {
  if (h < 6) return "새벽";
  if (h < 12) return "오전";
  if (h < 21) return "오후";
  return "밤";
}

/** 12시간제 숫자. 0시는 "0시"(새벽 0시), 12시는 "12시"(오후 12시). */
function hour12(h: number): number {
  const r = h % 12;
  if (r !== 0) return r;
  return h === 0 ? 0 : 12;
}

export interface KoreanClockOptions {
  /** `M월 D일` 을 앞에 붙인다. 본문에서 **처음 언급하는 시각**에만 쓴다. */
  withDate?: boolean;
  /** `새벽/오전/오후/밤` 을 생략한다. 바로 앞 시각과 같은 시간대일 때 자연스럽다. */
  omitPeriod?: boolean;
}

/**
 * KST 한국어 시각. 예: `새벽 0시 29분` / `7월 28일 밤 10시 20분` / `오전 9시`.
 * 정각이면 "분"을 생략한다(예: `오전 8시`).
 */
export function formatKoreanClock(ms: number, opts: KoreanClockOptions = {}): string {
  const p = kstParts(roundToMinute(ms));
  const head = opts.withDate ? `${p.mo}월 ${p.day}일 ` : "";
  const period = opts.omitPeriod ? "" : `${periodName(p.h)} `;
  const min = p.mi === 0 ? "" : ` ${p.mi}분`;
  return `${head}${period}${hour12(p.h)}시${min}`;
}

/** 일지 머리의 `[2026-08-02 11:15 KST]` 표기. */
export function formatKstStamp(ms: number): string {
  const p = kstParts(roundToMinute(ms));
  return `${p.y}-${pad2(p.mo)}-${pad2(p.day)} ${pad2(p.h)}:${pad2(p.mi)} KST`;
}

/** `08-02 00:29` — stdout 구간 표기용. */
export function formatKstMonthDayHm(ms: number): string {
  const p = kstParts(roundToMinute(ms));
  return `${pad2(p.mo)}-${pad2(p.day)} ${pad2(p.h)}:${pad2(p.mi)}`;
}

/** `07-28 22:24:10` — 판정근거 줄에서 다른 로그와 대조하기 위한 초 단위 표기. */
export function formatKstMonthDayHms(ms: number): string {
  const p = kstParts(ms);
  return `${pad2(p.mo)}-${pad2(p.day)} ${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}`;
}

/** `11:15` — 알림 줄·구간 끝 표기용. */
export function formatKstHm(ms: number): string {
  const p = kstParts(roundToMinute(ms));
  return `${pad2(p.h)}:${pad2(p.mi)}`;
}

/** `8/2` — 문자 메시지의 짧은 구간 표기(§6.3). */
export function formatKstSlashDate(ms: number): string {
  const p = kstParts(roundToMinute(ms));
  return `${p.mo}/${p.day}`;
}

/**
 * 기간을 한국어로. `645 → "10시간 45분"`, `4 → "4분"`, `120 → "2시간"`.
 * 하루를 넘으면 `1일 3시간 20분` 처럼 일 단위를 앞세운다(맥을 며칠 꺼 두는 경우 §12.1-1).
 */
export function formatDurationKorean(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total === 0) return "1분 미만";
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}일`);
  if (h > 0) parts.push(`${h}시간`);
  if (m > 0) parts.push(`${m}분`);
  return parts.join(" ");
}

/** 초 → `27.8초` / `3분 5초`. 실가동 시간(§6.1 판정근거 재료) 표기 전용. */
function formatSecondsKorean(sec: number): string {
  if (sec < 60) {
    const one = Math.round(sec * 10) / 10;
    return Number.isInteger(one) ? `${one}초` : `${one.toFixed(1)}초`;
  }
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s === 0 ? `${m}분` : `${m}분 ${s}초`;
}

/** 가동률 백분율. 0.07 → `0.07`, 3.2 → `3.2`, 41 → `41`. 유효숫자를 눈에 맞춰 자른다. */
function formatPercent(v: number): string {
  const a = Math.abs(v);
  if (a >= 10) return String(Math.round(v));
  if (a >= 1) return (Math.round(v * 10) / 10).toString();
  return (Math.round(v * 100) / 100).toString();
}

// ────────────────────────────────────────────────────────────────────────────
// 2. 한국어 조사(을/를, 이/가) — 문장이 어색해지면 사람이 안 읽는다
// ────────────────────────────────────────────────────────────────────────────

/**
 * 마지막 글자에 받침이 있는가.
 *
 * 한글 음절은 `0xAC00 + (초성*21 + 중성)*28 + 종성` 이므로 `(code-0xAC00) % 28 !== 0` 이면
 * 받침이 있다. 숫자로 끝나면 읽는 소리 기준(0·1·3·6·7·8 = 받침 있음)을 쓴다 — `62%` 처럼
 * 기호로 끝나면 바로 앞 숫자를 본다.
 */
function hasFinalConsonant(word: string): boolean {
  const cleaned = word.replace(/[)\]"'%\s.]+$/u, "");
  const last = cleaned.at(-1);
  if (!last) return false;
  const code = last.codePointAt(0)!;
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (last >= "0" && last <= "9") return ["0", "1", "3", "6", "7", "8"].includes(last);
  return false;
}

/** 목적격 조사. `분 → 을`, `시 → 를`. */
function eulReul(word: string): string {
  return hasFinalConsonant(word) ? "을" : "를";
}

/** 주격 조사. `건 → 이`, `분 → 이`, `시 → 가`. */
function iGa(word: string): string {
  return hasFinalConsonant(word) ? "이" : "가";
}

// ────────────────────────────────────────────────────────────────────────────
// 3. 텍스트 레이아웃 (일지가 `tail` 로 읽힐 수 있어야 한다)
// ────────────────────────────────────────────────────────────────────────────

/**
 * 터미널 표시 폭(한글·CJK·이모지는 2칸).
 *
 * 왜 필요한가: 일지는 `tail -n 80 data/downtime.log` 로 읽는 물건이라(§9.2 package.json)
 * 줄바꿈을 문자 수로 세면 한글 줄이 실제로는 두 배 길어져 터미널에서 깨져 보인다.
 * 정밀한 East Asian Width 표가 아니라 **줄바꿈 위치를 정하는 근사값**이면 충분하다.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // 한글 자모
  [0x2600, 0x27bf], // 기타 기호(⚠ ✓ …) — 대부분의 터미널에서 2칸으로 그려진다
  [0x2e80, 0x303e], // CJK 부수·괄호
  [0x3041, 0x33ff], // 가나·한글 호환 자모·CJK 기호
  [0x3400, 0x4dbf], // CJK 확장 A
  [0x4e00, 0x9fff], // CJK 통합 한자
  [0xac00, 0xd7a3], // 한글 음절
  [0xf900, 0xfaff], // CJK 호환 한자
  [0xfe30, 0xfe6f], // CJK 호환 형식
  [0xff00, 0xff60], // 전각 영숫자
  [0xffe0, 0xffe6], // 전각 기호
  [0x1f300, 0x1faff], // 이모지
];

function charWidth(cp: number): number {
  for (const [lo, hi] of WIDE_RANGES) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

/** 문자열의 터미널 표시 폭. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f || cp === 0x200d) continue; // 이모지 변형 선택자·ZWJ 는 폭 0
    if (cp != null) w += charWidth(cp);
  }
  return w;
}

/** 일지 한 줄의 목표 폭(표시 칸). 명세 §6.1 예시의 줄바꿈 위치에서 역산한 값. */
const JOURNAL_WIDTH = 100;

/**
 * 공백 경계에서 접어 넣기. 첫 줄은 `first` 접두사, 이후 줄은 `cont`(행잉 인덴트)를 붙인다.
 * 공백 없이 긴 토큰(예: 절대경로)은 자르지 않고 그대로 한 줄을 차지하게 둔다 —
 * 경로가 중간에서 끊기면 복사해서 열 수 없다.
 */
function wrapWithIndent(text: string, first: string, cont: string, limit: number): string[] {
  const words = text.split(/\s+/u).filter((w) => w.length > 0);
  if (words.length === 0) return [first.replace(/\s+$/u, "")];
  const out: string[] = [];
  let prefix = first;
  let line = "";
  for (const w of words) {
    const candidate = line === "" ? w : `${line} ${w}`;
    if (line !== "" && displayWidth(prefix) + displayWidth(candidate) > limit) {
      out.push(prefix + line);
      prefix = cont;
      line = w;
    } else {
      line = candidate;
    }
  }
  out.push(prefix + line);
  return out;
}

/**
 * 일지의 `  라벨: 값` 한 항목. 값이 여러 논리 줄이면 각각 접어 넣고, 이어지는 줄은
 * 라벨 폭만큼 들여쓴다(명세 §6.1 예시의 정렬을 그대로 재현한다).
 */
function renderField(label: string, value: string): string[] {
  const first = `  ${label} `;
  const cont = " ".repeat(displayWidth(first));
  const out: string[] = [];
  for (const [i, logical] of value.split("\n").entries()) {
    out.push(...wrapWithIndent(logical, i === 0 ? first : cont, cont, JOURNAL_WIDTH));
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// 4. 증거에서 문장 재료 뽑기 (판정은 여기서 하지 않는다)
// ────────────────────────────────────────────────────────────────────────────

/** 공백을 덮는 절전 윈도 하나(없으면 null). 문구 재료 전용. */
function pickCoveringWindow(n: NarrationInput): SleepWindow | null {
  const startSec = Math.floor(toMs(n.gapStart) / 1000);
  const endSec = Math.floor(toMs(n.gapEnd) / 1000);
  const windows = n.sleepWindows ?? buildSleepWindows(n.evidence.pmsetLines);
  return windows.find((w) => sleepWindowCoversGap(w, startSec, endSec)) ?? null;
}

/**
 * `pmset` 의 영어 사유를 한국어로. 매핑이 없으면 null 을 돌려 **사유를 아예 말하지 않는다**
 * — 본문에 영어 원문을 노출하는 것보다 침묵이 낫다(원문은 판정근거 줄에 남는다).
 */
function sleepReasonKorean(reason: string | null): string | null {
  if (!reason) return null;
  const r = reason.toLowerCase();
  if (r.includes("clamshell") || r.includes("lid")) return "덮개 닫힘";
  if (r.includes("idle")) return "일정 시간 쓰지 않음";
  if (r.includes("maintenance")) return "시스템 유지보수";
  if (r.includes("software")) return "소프트웨어 요청";
  if (r.includes("low power") || r.includes("lowpower")) return "배터리 부족";
  return null;
}

/** `80% → 48%` 배터리 변화 문구(양끝을 다 알 때만). */
function chargeArrow(w: SleepWindow | null): string | null {
  if (!w || w.chargeStart == null || w.chargeEnd == null) return null;
  return `${w.chargeStart}% → ${w.chargeEnd}%`;
}

/** ISO(+09:00) → epoch ms. 파싱 실패는 0 이 아니라 NaN 으로 두고 호출부에서 걸러 낸다. */
function toMs(iso: string): number {
  return new Date(iso).getTime();
}

/** epoch 초 → ms. null 통과. */
function secToMs(sec: number | null): number | null {
  return sec == null ? null : sec * 1000;
}

// ────────────────────────────────────────────────────────────────────────────
// 5. headline (§6.1 cause 별 실제 문구)
// ────────────────────────────────────────────────────────────────────────────

/**
 * `confidence` 가 "확실"이 아니면 어미를 내린다(§3.4).
 *
 * ⚠️ 하향은 **원인을 주장하는 문장에만** 적용한다. "10시간 45분 동안 수집이 멈췄습니다" 는
 *    측정된 사실이라 확신도와 무관하게 단정형이 맞다. 여기서 뭉개면 정말로 확실한 사실까지
 *    흐려져 문장 전체가 못 미덥게 읽힌다.
 */
function isSoft(c: DowntimeConfidence): boolean {
  return c !== "확실";
}

/**
 * "사고 아님" 꼬리표.
 *
 * `reboot-clean` 예시(§6.1)의 `(사고 아님)` 을 그대로 쓰되, **전원 계열에는 붙이지 않는다.**
 * 손실이 0이어도 `power-cut`·`battery-dead`·`panic` 을 "사고 아님" 이라고 부르면 사용자
 * 요구("전원이 나갔으면 그 사실을 알고 싶다", §12.3-3)를 문구 차원에서 배신한다.
 * 그쪽은 사실만 말한다 — "(놓친 수집은 없습니다)".
 */
const BENIGN_CAUSES: ReadonlySet<DowntimeCause> = new Set<DowntimeCause>([
  "sleep",
  "reboot-clean",
  "restart-intended",
]);

function calmSuffix(n: NarrationInput): string {
  if (n.severity === "사고") return "";
  return BENIGN_CAUSES.has(n.cause) ? " (사고 아님)" : " (놓친 수집은 없습니다)";
}

/** 길이를 문장에 써도 되는지(§4.5 clockSuspect). 못 쓰면 별도 안내 문장으로 대신한다. */
function durationPhrase(n: NarrationInput): string | null {
  return n.gapExact ? formatDurationKorean(n.gapMinutes) : null;
}

const INEXACT_NOTE = "시스템 시각이 바뀐 흔적이 있어 정확한 길이는 알 수 없습니다.";

/** §6.1 headline — cause 8종 전부. */
export function narrateHeadline(n: NarrationInput): string {
  const startMs = toMs(n.gapStart);
  const endMs = toMs(n.gapEnd);
  const dur = durationPhrase(n);
  const soft = isSoft(n.confidence);
  const tail = calmSuffix(n);

  switch (n.cause) {
    case "sleep": {
      const span = `${formatKoreanClock(startMs)}부터 ${formatKoreanClock(endMs)}까지`;
      const verb = soft ? "맥북이 잠들어 있었던 것으로 보입니다." : "맥북이 잠들어 있었습니다.";
      return dur
        ? `${span}, ${dur} 동안 ${verb}${tail}`
        : `${span} ${verb} ${INEXACT_NOTE}${tail}`;
    }
    case "reboot-clean": {
      // 원인은 라벨("맥 정상 종료·재시작")이 이미 말한다. 여기서는 길이만 사실대로.
      return dur
        ? `${dur} 동안 수집이 멈췄습니다.${tail}`
        : `수집이 멈췄습니다. ${INEXACT_NOTE}${tail}`;
    }
    case "restart-intended": {
      return dur
        ? `업데이트로 ${dur} 동안 수집이 멈췄습니다.${tail}`
        : `업데이트로 수집이 잠깐 멈췄습니다. ${INEXACT_NOTE}${tail}`;
    }
    case "app-gap": {
      return dur
        ? `${dur} 동안 수집이 멈췄습니다.${tail}`
        : `수집이 멈췄습니다. ${INEXACT_NOTE}${tail}`;
    }
    case "power-cut":
    case "battery-dead": {
      const verb = soft ? "맥이 꺼져 있었던 것으로 보입니다." : "맥이 꺼져 있었습니다.";
      return dur ? `${dur} 동안 ${verb}${tail}` : `${verb} ${INEXACT_NOTE}${tail}`;
    }
    case "panic": {
      // ★ 명세 §6.1 문구 그대로. 길이는 본문에서 말한다(헤드라인에 다 넣으면 길어진다).
      return soft
        ? `맥이 스스로 재시작된 것으로 보입니다.${tail}`
        : `맥이 스스로 재시작됐습니다.${tail}`;
    }
    case "unknown": {
      // 공백 자체는 **측정된 사실**이므로 확신도와 무관하게 단정형이 맞다.
      return dur
        ? `${dur} 동안 수집이 멈췄습니다.${tail}`
        : `수집이 멈췄습니다. ${INEXACT_NOTE}${tail}`;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 6. body (§6.1 "무슨 일")
// ────────────────────────────────────────────────────────────────────────────

/**
 * ★ 이 기능에서 가장 값어치 있는 한 문장(§6.2 와 짝).
 * 다음 사고 때 사용자와 조사 에이전트가 `stdout.log` 다음으로 여는 곳이 일지이고,
 * 이 줄이 없으면 "Codex 응답 시간 초과" 를 다시 LLM 장애로 읽는다.
 */
const LLM_ALIBI_JOURNAL =
  '※ 이 구간에 남은 "응답 시간 초과" 오류는 LLM 장애가 아니라 위 절전 때문입니다.';

/** §6.2 stdout 판(문장이 미세하게 다르다 — 명세의 두 문구를 각자 그대로 쓴다). */
const LLM_ALIBI_STDOUT =
  '※ 이 구간의 "응답 시간 초과" 오류는 LLM 장애가 아니라 위 절전 때문입니다.';

/** 놓친 슬롯 라벨을 "뉴스·유튜브 소식" 처럼 잇는다(중복 라벨 제거). */
function missedLabels(missed: readonly MissedSlot[]): string {
  const seen: string[] = [];
  for (const m of missed) if (m.evaluated && !seen.includes(m.label)) seen.push(m.label);
  return seen.join("·");
}

/** 비컨 쓰기 실패·확신도에 대한 정직한 각주(§3.4). "기록이 없다"와 "기록에 실패했다"를 가른다. */
function honestyNote(n: NarrationInput): string | null {
  const fails = n.evidence.beaconWriteFailures;
  if (fails > 0) {
    return `※ 가동 기록을 남기는 데 ${fails}번 실패한 구간이라, 위 판정은 확정이 아니라 추정입니다.`;
  }
  if (n.confidence === "불명" && n.cause !== "unknown") {
    return "※ 증거가 부족해 원인을 확정하지 못했습니다. 위 설명은 가장 그럴듯한 쪽을 적은 것입니다.";
  }
  return null;
}

function sleepBody(n: NarrationInput): string[] {
  const soft = isSoft(n.confidence);
  const win = pickCoveringWindow(n);
  const reasonKo = sleepReasonKorean(win?.reason ?? null);
  const lines: string[] = [];

  // 1) 멘탈모델 교정 — "전원이 나간 게 아니라 잠든 것" 이라는 사실이 이 사건의 핵심이다.
  const closing = soft ? "잠든 것으로 보입니다." : "잠든 것입니다.";
  if (reasonKo === "덮개 닫힘") {
    lines.push(
      `덮개를 닫으면 충전기를 꽂아 두어도 맥북은 잠듭니다. 전원이 나간 것이 아니라 ${closing}`
    );
  } else if (reasonKo) {
    lines.push(`맥북이 '${reasonKo}'으로 잠들었습니다. 전원이 나간 것이 아니라 ${closing}`);
  } else {
    lines.push(`맥북이 잠들어 있었습니다. 전원이 나간 것이 아니라 ${closing}`);
  }

  // 2) 프로그램이 죽지 않았다는 사실 + 실가동률. 이번 사고의 형태(T1)를 그대로 설명한다.
  const seg: string[] = [];
  if (n.evidence.sameProcess) {
    const cpu = n.evidence.cpuSecondsInGap;
    const duty = n.evidence.dutyPercent;
    const dur = durationPhrase(n);
    if (cpu != null && duty != null && dur) {
      seg.push(
        `수집 프로그램은 죽지 않았지만 맥과 함께 멈춰 있었습니다 — ${dur} 중 실제로 일한 시간은 ${formatSecondsKorean(cpu)}(${formatPercent(duty)}%)뿐입니다.`
      );
    } else {
      seg.push("수집 프로그램은 죽지 않았지만 맥과 함께 멈춰 있었습니다.");
    }
  } else {
    seg.push("수집 프로그램도 그 사이에 멈췄다가 다시 시작됐습니다.");
  }
  if (countEvaluatedMissed(n.missed) > 0) {
    seg.push("그동안 예정돼 있던 수집이 제 시각에 돌지 못했습니다.");
  }
  lines.push(seg.join(" "));

  // 3) 배터리 변화 — "충전기를 뽑아도 배터리로 돈다"는 멘탈모델을 숫자로 뒷받침한다(§6.4).
  const arrow = chargeArrow(win);
  if (arrow) lines.push(`그동안 배터리는 ${arrow}로 줄었을 뿐, 꺼지지는 않았습니다.`);

  // 4) ★ LLM 알리바이.
  lines.push(LLM_ALIBI_JOURNAL);
  return lines;
}

function rebootCleanBody(n: NarrationInput): string[] {
  const soft = isSoft(n.confidence);
  const downMs = secToMs(n.evidence.lastCleanShutdownEpoch) ?? toMs(n.gapStart);
  const upMs = secToMs(n.evidence.bootEpochNow) ?? toMs(n.gapEnd);
  // 같은 날·같은 시간대면 두 번째 시각에서 "M월 D일"·"밤" 을 떨어뜨린다 — 사람이 쓰는 방식.
  const sameDay = isSameDay(downMs, upMs);
  const omitPeriod = canOmitPeriod(downMs, upMs);
  const upText = formatKoreanClock(upMs, {
    withDate: !sameDay,
    omitPeriod,
  });
  const verb = soft ? "다시 켜진 것으로 보입니다." : "다시 켜졌습니다.";
  return [
    `${formatKoreanClock(downMs, { withDate: true })}에 맥을 정상적으로 종료하셨고, ${upText}에 ${verb}`,
    "강제 종료나 전원 차단이 아닙니다.",
  ];
}

function powerCutBody(n: NarrationInput): string[] {
  const startMs = toMs(n.gapStart);
  const upMs = secToMs(n.evidence.bootEpochNow) ?? toMs(n.gapEnd);
  const sameDay = isSameDay(startMs, upMs);
  const omitPeriod = canOmitPeriod(startMs, upMs);
  const startText = formatKoreanClock(startMs, { withDate: true });
  const upText = formatKoreanClock(upMs, {
    withDate: !sameDay,
    omitPeriod,
  });

  const lines = [
    `${startText}${eulReul(startText)} 마지막으로 기록이 끊겼고, ${upText}에 다시 켜졌습니다.`,
  ];

  // 두 번째 문단: 무엇이 없어서 '비정상'이라고 부르는지 + 아닌 것들을 하나씩 지운다.
  const seg = [
    "그 사이에 '정상 종료' 기록이 남지 않았습니다.",
    "전원이 갑자기 끊겼거나 전원 버튼을 길게 눌러 강제 종료된 것으로 보입니다.",
  ];
  const noPanic = n.evidence.panicDirReadable && n.evidence.panicAtEpoch == null;
  const pct = n.evidence.batteryAtGapStart.percent;
  if (noPanic && pct != null) {
    seg.push(`커널 패닉 기록은 없고, 마지막으로 확인된 배터리는 ${pct}%라 방전도 아닙니다.`);
  } else if (noPanic) {
    seg.push("커널 패닉 기록은 없습니다.");
  } else if (pct != null) {
    seg.push(`마지막으로 확인된 배터리는 ${pct}%였습니다.`);
  }
  if (!n.evidence.panicDirReadable) {
    seg.push("(시스템 오류 기록 폴더를 읽지 못해 커널 패닉 여부는 확인하지 못했습니다.)");
  }
  lines.push(seg.join(" "));
  return lines;
}

function batteryDeadBody(n: NarrationInput): string[] {
  const soft = isSoft(n.confidence);
  const downMs = toMs(n.gapStart);
  const upMs = secToMs(n.evidence.bootEpochNow) ?? toMs(n.gapEnd);
  const sameDay = isSameDay(downMs, upMs);
  const omitPeriod = canOmitPeriod(downMs, upMs);
  const pct = n.evidence.batteryAtGapStart.percent;
  const verb = soft ? "맥이 꺼진 것으로 보입니다." : "맥이 꺼졌습니다.";

  const seg = [`배터리가 다 떨어져 ${formatKoreanClock(downMs, { withDate: true })}에 ${verb}`];
  if (pct != null) {
    seg.push(`마지막으로 확인된 잔량은 ${pct}%였고 충전기가 꽂혀 있지 않았습니다.`);
  } else {
    seg.push("충전기가 꽂혀 있지 않은 상태였습니다.");
  }
  seg.push(
    `${formatKoreanClock(upMs, { withDate: !sameDay, omitPeriod })}에 다시 켜졌습니다.`
  );
  return [seg.join(" ")];
}

function panicBody(n: NarrationInput): string[] {
  const soft = isSoft(n.confidence);
  const atMs = secToMs(n.evidence.panicAtEpoch) ?? toMs(n.gapStart);
  const verb = soft
    ? "시스템 오류(커널 패닉)로 맥이 재시작된 것으로 보입니다."
    : "시스템 오류(커널 패닉)로 맥이 재시작됐습니다.";
  const lines = [
    `${formatKoreanClock(atMs, { withDate: true })}에 ${verb}`,
    "전원이 끊긴 것이 아니라 macOS 가 스스로 멈춘 것입니다.",
  ];
  const dur = durationPhrase(n);
  if (dur) lines.push(`그 사이 ${dur} 동안 수집이 멈춰 있었습니다.`);
  return lines;
}

function appGapBody(n: NarrationInput): string[] {
  const soft = isSoft(n.confidence);
  const gapMs = toMs(n.gapEnd) - toMs(n.gapStart);
  // 하향은 **추론하는 절**(왜 죽었는지)에만 건다. "정상 종료 신호를 받은 흔적이 없습니다" 는
  // 관측된 사실이라 여기에 "…로 보입니다" 를 붙이면 오히려 어색하고 정보량도 준다.
  const opening = soft
    ? "수집 프로그램이 예기치 않게 종료되어 자동으로 다시 시작된 것으로 보입니다."
    : "수집 프로그램이 예기치 않게 종료되어 자동으로 다시 시작됐습니다.";
  const lines = [
    `${opening} 맥은 켜져 있었고 (부팅 시각 그대로), 정상 종료 신호를 받은 흔적이 없습니다.`,
  ];
  // §3.2 Q1d / §12.2-7: kill -9 로 직접 재시작한 경우를 이 한 줄로 흡수한다.
  if (Number.isFinite(gapMs) && gapMs < SHORT_GAP_HINT_MS) {
    lines.push("직접 재시작하셨다면 무시하셔도 됩니다.");
  }
  return lines;
}

function unknownBody(n: NarrationInput): string[] {
  // ★ 정직성 조항(§6.1 unknown). "전원이 나갔다" 로 단정하면 모든 재부팅을 정전으로
  //   오보하게 되고(§3.2 Q2b fail-open), 그 순간 이 기능은 신뢰를 잃는다.
  const lines = [
    "맥이 재시작됐는데, 종료 기록을 읽지 못해 정상 종료였는지 전원이 나간 것인지 판정하지 못했습니다.",
    "전원이 나갔다고 단정하지 않겠습니다.",
  ];
  if (!n.evidence.shutdownLogParsed) {
    lines.push(
      "(맥OS 업데이트로 종료 기록 형식이 바뀌면 이렇게 됩니다. 다음 재시작 때 다시 확인합니다.)"
    );
  }
  return lines;
}

function restartIntendedBody(n: NarrationInput): string[] {
  const soft = isSoft(n.confidence);
  const lines = [
    soft
      ? "업데이트하느라 프로그램을 잠깐 껐다 켠 것으로 보입니다. 맥은 계속 켜져 있었습니다."
      : "업데이트하느라 프로그램을 잠깐 껐다 켰습니다. 맥은 계속 켜져 있었습니다.",
  ];
  const labels = missedLabels(n.missed);
  if (labels) lines.push(`그 사이에 ${labels} 수집 시각이 지나갔습니다.`);
  return lines;
}

/** §6.1 "무슨 일" 본문. 논리 줄을 `\n` 으로 잇는다(하드랩 없음 — 일지 렌더러가 접는다). */
export function narrateBody(n: NarrationInput): string {
  let lines: string[];
  switch (n.cause) {
    case "sleep":
      lines = sleepBody(n);
      break;
    case "reboot-clean":
      lines = rebootCleanBody(n);
      break;
    case "power-cut":
      lines = powerCutBody(n);
      break;
    case "battery-dead":
      lines = batteryDeadBody(n);
      break;
    case "panic":
      lines = panicBody(n);
      break;
    case "app-gap":
      lines = appGapBody(n);
      break;
    case "restart-intended":
      lines = restartIntendedBody(n);
      break;
    case "unknown":
      lines = unknownBody(n);
      break;
  }
  const note = honestyNote(n);
  if (note) lines = [...lines, note];
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// 7. reasonLine (§6.1 판정근거 — 상시 병기)
// ────────────────────────────────────────────────────────────────────────────

/**
 * 판정근거 한 줄.
 *
 * 여기만 기술 용어가 허용되는 자리다. 목적은 **반증 가능성**이다 — 판정이 틀렸을 때
 * 사용자(혹은 다음 조사 에이전트)가 이 줄만 보고 "아 이건 다른 이유네" 라고 뒤집을 수
 * 있어야 한다. 그래서 다른 로그와 대조하기 쉬운 숫자 시각(`07-28 22:24:10`)을 쓴다.
 */
export function narrateReasonLine(n: NarrationInput): string {
  const ev = n.evidence;
  const seg: string[] = [];
  const bootMs = secToMs(ev.bootEpochNow);

  // 1) 부팅 시각 — 절전 ↔ 재부팅을 가르는 유일한 신호(§3.3-1)라 언제나 맨 앞.
  if (bootMs != null) {
    const stamp = formatKstMonthDayHms(bootMs);
    seg.push(ev.bootChanged ? `부팅 ${stamp}` : `부팅 시각 변화 없음(${stamp})`);
  } else {
    seg.push("부팅 시각을 읽지 못함");
  }
  if (ev.bootFromFallback) seg.push("부팅 시각은 추정값(sysctl 실패)");

  // 2) 마지막 생존(=공백 시작).
  const startMs = toMs(n.gapStart);
  if (Number.isFinite(startMs)) seg.push(`마지막 생존 ${formatKstMonthDayHms(startMs)}`);

  // 3) cause 별 결정적 증거.
  const cleanMs = secToMs(ev.lastCleanShutdownEpoch);
  if (n.cause === "reboot-clean" && cleanMs != null && bootMs != null) {
    const diff = Math.round((bootMs - cleanMs) / 1000);
    seg.push(
      `직전 정상 종료 기록 ${formatKstMonthDayHms(cleanMs)} (차이 ${diff}초, shutdown 기록 파일)`
    );
  } else if ((n.cause === "power-cut" || n.cause === "battery-dead") && cleanMs != null) {
    seg.push(
      `마지막 정상 종료 기록 ${formatKstMonthDayHms(cleanMs)} (직전 부팅보다 과거 → 비정상)`
    );
  } else if (n.cause === "unknown" && !ev.shutdownLogParsed) {
    seg.push("종료 기록 파일을 찾지 못함(형식 변경 가능성)");
  } else if (ev.bootChanged && cleanMs != null) {
    // 맥이 꺼진 적 없는 사건(절전·앱 재시작)에서 "직전 정상 종료 기록"은 며칠 전 값이라
    // 판정과 무관하다. 붙이면 근거 줄만 길어지고 읽는 사람을 헷갈리게 한다.
    seg.push(`직전 정상 종료 기록 ${formatKstMonthDayHms(cleanMs)}`);
  }

  // 4) 커널 패닉.
  const panicMs = secToMs(ev.panicAtEpoch);
  if (panicMs != null) seg.push(`커널 패닉 기록 ${formatKstMonthDayHms(panicMs)}`);
  else if (!ev.panicDirReadable) seg.push("커널 패닉 폴더를 읽지 못함");
  else if (n.cause === "power-cut" || n.cause === "battery-dead") seg.push("커널 패닉 파일 0건");

  // 5) 전원관리 기록(절전 사유·배터리·짧은 깨어남).
  if (!ev.pmsetParsed) {
    seg.push("전원관리 기록을 읽지 못함");
  } else {
    const win = pickCoveringWindow(n);
    if (win) {
      const bits: string[] = [];
      if (win.reason) bits.push(`사유 '${win.reason}'`);
      const arrow = chargeArrow(win);
      if (arrow) bits.push(`배터리 ${arrow}`);
      if (ev.darkWakeCount > 0) bits.push(`짧은 깨어남 ${ev.darkWakeCount}회`);
      seg.push(
        bits.length > 0
          ? `전원관리 기록에 같은 구간의 절전(${bits.join(", ")})`
          : "전원관리 기록에 같은 구간의 절전"
      );
    } else if (n.cause === "power-cut" || n.cause === "battery-dead") {
      const pct = ev.batteryAtGapStart.percent;
      if (pct != null) seg.push(`전원관리 기록의 마지막 배터리 ${pct}%`);
    } else {
      seg.push("전원관리 기록에 이 구간을 덮는 절전 없음");
    }
  }

  // 6) 프로세스 동일성(T1 의 정체) + 종료 마커.
  if (ev.sameProcess) seg.push(`프로세스 동일(pid ${ev.currentPid})`);
  else if (ev.prevPid != null) seg.push(`프로세스 교체(pid ${ev.prevPid} → ${ev.currentPid})`);
  if (ev.prevBeaconMode === "stopping") seg.push("종료 신호(SIGTERM/SIGINT) 마커 있음");

  // 7) 확신도를 깎은 사유는 반드시 드러낸다 — 왜 "…로 보입니다" 인지 설명 못 하면 불친절하다.
  if (ev.beaconWriteFailures > 0) seg.push(`가동 기록 쓰기 실패 ${ev.beaconWriteFailures}회`);
  if (ev.clockSuspect) seg.push("시스템 시각 점프 의심(길이 표기 생략)");

  // 8) 실가동률 — 트리거로는 절대 쓰지 않고 문장 재료로만(§0 버린 것 2번).
  //    절전(T1)에서는 이미 본문이 "27.8초(0.07%)뿐입니다" 라고 말했으므로 여기서 되풀이하지
  //    않는다. 같은 숫자를 두 번 적으면 근거 줄이 본문의 요약이 아니라 잡음이 된다.
  const dutyStatedInBody = n.cause === "sleep" && ev.sameProcess;
  if (!dutyStatedInBody && ev.cpuSecondsInGap != null && ev.dutyPercent != null) {
    seg.push(
      `실가동 ${formatSecondsKorean(ev.cpuSecondsInGap)}(${formatPercent(ev.dutyPercent)}%)`
    );
  }

  return REASON_PREFIX + seg.join(" / ");
}

// ────────────────────────────────────────────────────────────────────────────
// 8. 놓친 것 · 지금 상태 · 알림 (§6.1 나머지 세 줄)
// ────────────────────────────────────────────────────────────────────────────

function slotText(m: MissedSlot): string {
  const base = `${m.label} ${m.slot}`;
  if (!m.recovered) return base;
  const at = m.recoveredAt ? toMs(m.recoveredAt) : NaN;
  return Number.isFinite(at) ? `${base}(${formatKoreanClock(at)}에 받아옴)` : `${base}(받아옴)`;
}

/**
 * "놓친 것" 줄(§6.1).
 *
 * `evaluated: false` 인 항목(자정을 넘는 공백의 어제 슬롯, §8.4)은 **개수에서 빼고 따로**
 * 적는다. 그 시각이 공백 안에 있었던 것은 참이지만 커버 여부를 검증하지 못했으므로,
 * 같은 줄에 섞어 세면 "3건 놓쳤다"는 문장이 거짓이 될 수 있다.
 */
export function narrateMissedSummary(missed: readonly MissedSlot[]): string {
  const done = missed.filter((m) => m.evaluated);
  const past = missed.filter((m) => !m.evaluated);
  if (done.length === 0 && past.length === 0) {
    return "없음 — 이 구간에 예정된 자동 수집이 없었습니다.";
  }
  const lines: string[] = [];
  if (done.length > 0) {
    lines.push(`${done.map(slotText).join(" · ")} — ${done.length}건`);
  } else {
    lines.push("없음 — 제 시각을 놓친 자동 수집은 없었습니다.");
  }
  if (past.length > 0) {
    const note = past.find((m) => m.note)?.note ?? "지난 날짜라 보충 대상이 아닙니다";
    lines.push(
      `그 밖에 ${past.map((m) => `${m.label} ${m.slot}`).join(" · ")} ${past.length}건이 공백에 걸쳐 있었지만, ${note}.`
    );
  }
  return lines.join("\n");
}

/** "지금 상태" 줄(§8.5 recoveryState 문장). */
export function narrateRecoveryLine(n: NarrationInput): string {
  const total = countEvaluatedMissed(n.missed);
  if (total === 0) return "정상입니다. 확인하실 것 없습니다.";

  const done = n.missed.filter((m) => m.evaluated && m.recovered);
  const left = n.missed.filter((m) => m.evaluated && !m.recovered);
  switch (n.recoveryState) {
    case "복구중":
      // 절전은 "깨어난 직후" 라는 말이 사용자 체감과 정확히 맞는다(§6.1 sleep 예시).
      return n.cause === "sleep"
        ? "깨어난 직후 누락 점검이 자동으로 시작됐습니다. 화면이 비어 있어도 잠시 뒤 채워집니다."
        : "다시 정상 가동 중입니다. 누락 점검이 자동으로 보충합니다.";
    case "복구완료":
      return `놓친 ${total}건을 모두 다시 받아왔습니다.`;
    case "일부복구": {
      const names = missedLabels(left) || "나머지";
      return `${total}건 중 ${done.length}건을 다시 받아왔고, ${names} ${left.length}건은 아직 받아오지 못했습니다.`;
    }
    case "복구없음":
      return "아직 보충되지 않았습니다. 잠시 뒤 다시 확인해 주세요.";
  }
}

/**
 * "알림" 줄(§6.1).
 *
 * @param imessageConfigured `isIMessageConfigured()`(`src/notify/imessage.ts:32`) 결과.
 *        이 모듈은 순수 함수라 config 를 못 읽는다 — 호출부(store/index)가 넘겨 준다.
 *        "아직 안 보냄" 과 "보낼 설정이 아예 없음" 은 사용자에게 완전히 다른 사실이다.
 */
export function narrateNotifyLine(
  notified: DowntimeNotifyState,
  severity: DowntimeSeverity,
  imessageConfigured = true
): string {
  if (notified.imessage) {
    const at = notified.at ? toMs(notified.at) : NaN;
    return Number.isFinite(at)
      ? `iMessage 발송 완료 ${formatKstHm(at)}`
      : "iMessage 발송 완료";
  }
  if (severity !== "사고") return "보내지 않음(사고 아님)";
  if (!imessageConfigured) return "미설정";
  if (notified.queuedUntil) {
    const at = toMs(notified.queuedUntil);
    return Number.isFinite(at)
      ? `대기(조용시간, ${formatKstHm(at)} 이후 발송)`
      : "대기(조용시간)";
  }
  return "발송 준비 중";
}

// ────────────────────────────────────────────────────────────────────────────
// 9. 사건 3종 세트 조립
// ────────────────────────────────────────────────────────────────────────────

/** headline / body / reasonLine 을 한 번에. `store.ts` 의 정문. */
export function narrate(n: NarrationInput): Narration {
  return {
    headline: narrateHeadline(n),
    body: narrateBody(n),
    reasonLine: narrateReasonLine(n),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 10. 일지 파일 (§5.3 / §6.1)
// ────────────────────────────────────────────────────────────────────────────

/**
 * 일지 절대경로. `config.dbPath` 를 받아 `data/downtime.log` 를 만든다.
 *
 * `path.resolve` 를 쓰는 이유: `DB_PATH` 환경변수로 상대경로가 들어와도 **절대경로**가
 * 나와야 한다. 이 값이 그대로 stdout 과 문자에 실려 나가고(§6.2/§6.3), 폰에서 상대경로는
 * 열 수 없다. 파일시스템을 건드리지 않으므로 여전히 순수하다.
 */
export function resolveJournalPath(dbPath: string): string {
  return path.resolve(path.dirname(dbPath), DOWNTIME_JOURNAL_FILE);
}

/**
 * `config` 를 못 읽는 자리에서 쓰는 일지 경로 기본값 = `<저장소>/data/downtime.log`.
 *
 * 이 모듈의 파일 위치에서 역산한다(`src/uptime/narrate.ts` → `../../data`). `config.ts` 가
 * `repoRoot/data/price.db` 를 기본으로 잡는 것과 **같은 계산**이라 기본 설정에서는 정확히
 * 일치한다. 어긋나는 경우는 `DB_PATH` 환경변수로 DB 위치를 옮겼을 때뿐이고, 그때는 호출부가
 * `resolveJournalPath(config.dbPath)` 를 명시적으로 넘기면 된다.
 *
 * 파일시스템을 건드리지 않으므로 이 모듈은 여전히 I/O 0 이다 — `import.meta.url` 은 그냥 문자열.
 */
export const DEFAULT_JOURNAL_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "data",
  DOWNTIME_JOURNAL_FILE
);

/**
 * 일지 영구 헤더 — 파일이 없을 때 **1회만** 기록한다(§6.1).
 *
 * ★ 명세와 다르게 한 점(근거는 §6.4): §6.1 의 헤더 예시는 3줄이고 §6.4 의 멘탈모델 교정
 *   문장은 4줄인데, §6.4 는 자기 위치를 "P0 = 일지 헤더" 라고 명시한다. 두 텍스트는 같은
 *   말이지만 §6.1 판에는 **"최근 2주 동안 배터리가 47% 아래로 내려간 적이 없다"** 는
 *   실측 숫자가 빠져 있다. 그 숫자가 이 안내문의 설득력 전부이므로(숫자가 없으면 그냥
 *   훈계로 읽힌다) 여기서는 §6.1 의 첫 줄 + `shared/uptime.ts` 의
 *   `DOWNTIME_MENTAL_MODEL_NOTE`(=§6.4 원문)를 쓴다. 결과적으로 P0 일지 헤더와 P1 이력
 *   화면 하단이 **한 글자도 다르지 않은 같은 문자열**을 쓰게 된다 — shared 에 그 상수를
 *   둔 이유가 바로 그것이다.
 */
export const DOWNTIME_JOURNAL_HEADER =
  "# 가동 중단 기록 — 자동 수집이 멈췄던 구간만 적힙니다. 아무 일 없으면 이 파일은 늘어나지 않습니다.\n" +
  DOWNTIME_MENTAL_MODEL_NOTE.split("\n")
    .map((line, i) => (i === 0 ? `# ${line}` : `#        ${line.trim()}`))
    .join("\n") +
  "\n";

/** 일지 항목 렌더링에 필요한 입력 = 문구 3종이 이미 채워진 사건. `DowntimeEvent` 가 만족한다. */
export interface JournalEntryInput extends NarrationInput {
  headline: string;
  body: string;
  reasonLine: string;
  notified: DowntimeNotifyState;
}

/**
 * 일지 항목 한 덩어리(§6.1 고정 포맷).
 *
 * ★ `store.ts` 와의 계약 — 이 포맷은 **되읽을 수 있어야** 한다(200건 절삭 §5.3):
 *   1. 항목은 반드시 `[` 로 시작하는 줄에서 시작한다(열 0).
 *   2. 이어지는 줄은 전부 공백 2칸 이상으로 들여쓴다.
 *   3. 항목은 개행 하나로 끝나고, 항목 사이에는 빈 줄이 정확히 하나 있다.
 *   되읽기는 `splitJournalEntries()` 를 쓰라 — 정규식을 각자 짜면 조용히 갈라진다.
 */
export function renderJournalEntry(ev: JournalEntryInput, imessageConfigured = true): string {
  const endMs = toMs(ev.gapEnd);
  const label = DOWNTIME_CAUSE_LABEL[ev.cause];
  const reasonBody = ev.reasonLine.startsWith(REASON_PREFIX)
    ? ev.reasonLine.slice(REASON_PREFIX.length)
    : ev.reasonLine;

  const lines: string[] = [`[${formatKstStamp(endMs)}] ${label} — ${ev.headline}`];
  lines.push(...renderField("무슨 일:", ev.body));
  lines.push(...renderField("놓친 것:", narrateMissedSummary(ev.missed)));
  lines.push(...renderField("지금 상태:", narrateRecoveryLine(ev)));
  lines.push(...renderField("판정근거:", reasonBody));
  lines.push(
    ...renderField("알림:", narrateNotifyLine(ev.notified, ev.severity, imessageConfigured))
  );
  return lines.join("\n") + "\n\n";
}

/**
 * 일지 본문을 항목 배열로 되읽는다(헤더는 제외).
 * `store.ts` 가 200건으로 절삭할 때 쓴다 — 포맷의 주인이 역함수도 갖고 있어야 갈라지지 않는다.
 * 각 원소는 `renderJournalEntry` 의 출력과 동일하게 `"\n\n"` 로 끝난다.
 */
export function splitJournalEntries(text: string): string[] {
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("[")) {
      if (cur) out.push(cur.join("\n").replace(/\n*$/u, "") + "\n\n");
      cur = [line];
    } else if (cur) {
      cur.push(line);
    }
    // 헤더(`#`)와 선두 빈 줄은 버린다 — 헤더는 store 가 따로 붙인다.
  }
  if (cur) out.push(cur.join("\n").replace(/\n*$/u, "") + "\n\n");
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// 11. stdout 병기 (§6.2) — ★ 이 기능에서 가장 값싸고 가장 중요한 산출물
// ────────────────────────────────────────────────────────────────────────────

/**
 * `logs/stdout.log` 에 남길 줄.
 *
 * ★ 왜 이게 제일 중요한가: 다음 사고 때 사용자와 조사 에이전트가 **반사적으로 여는 곳이
 *   여기**이고, 2026-08-02 에는 여기 "Codex 응답 시간 초과(3600s)" 만 있어서 LLM 장애로
 *   오진했다. 이 줄은 그 오류 **바로 옆**에 붙는다. 추가 인프라 0, `log.warn()` 한 번.
 *
 * 반환값의 `text` 는 `log.warn()`/`log.info()` 에 **그대로** 넘기면 된다.
 * `log.ts` 가 `[ISO] ⚠️` 접두사를 붙이므로 여기서는 붙이지 않는다.
 *
 * @param journalPath ★ 반드시 절대경로(`resolveJournalPath(config.dbPath)`).
 */
export function narrateStdout(
  n: NarrationInput,
  journalPath: string
): { level: "warn" | "info"; text: string } {
  const startMs = toMs(n.gapStart);
  const endMs = toMs(n.gapEnd);
  const label = DOWNTIME_CAUSE_LABEL[n.cause];
  const dur = durationPhrase(n);
  const span = `${formatKstMonthDayHm(startMs)} ~ ${formatKstHm(endMs)} KST`;

  // `무시` 등급은 사용자에게 보여주지 않는 사건이다(§3.5). 그래도 한 줄은 남긴다 —
  // 나중에 "이 기능이 오탐하고 있나"를 반증하려면 안 보여준 것도 흔적이 있어야 한다.
  if (n.severity === "무시") {
    return {
      level: "info",
      text: `가동 공백 ${dur ?? "(길이 불명)"}(${label}) — 놓친 수집이 없어 사건으로 올리지 않습니다. ${span}`,
    };
  }

  // 1줄: 무슨 일이 얼마나. 절전이면 사유·배터리를 괄호로 덧붙인다.
  const detail: string[] = [];
  if (n.cause === "sleep") {
    const win = pickCoveringWindow(n);
    const reasonKo = sleepReasonKorean(win?.reason ?? null);
    if (reasonKo) detail.push(reasonKo);
    const arrow = chargeArrow(win);
    if (arrow) detail.push(`배터리 ${arrow.replace(/ /gu, "")}`);
  }
  const head = `가동 공백 ${dur ?? "(길이 불명)"} — ${label}${detail.length > 0 ? `(${detail.join(", ")})` : ""}. ${span}.`;

  const lines = [head];

  // 2줄: 무엇이 못 돌았는지. 이게 사용자가 실제로 겪는 증상("왜 뉴스가 비었지")과 이어진다.
  const done = n.missed.filter((m) => m.evaluated);
  if (done.length > 0) {
    const list = done.map((m) => `${m.label} ${m.slot}`).join(" · ");
    lines.push(`   ${list} ${iGa(list)} 예정 시각에 돌지 못했습니다.`);
  } else {
    lines.push("   이 구간에 제 시각을 놓친 자동 수집은 없습니다.");
  }

  // 3줄: ★ LLM 알리바이. 프로세스가 살아 있던 구간(절전)에서만 의미가 있다.
  if (n.cause === "sleep" || n.evidence.sameProcess) lines.push(`   ${LLM_ALIBI_STDOUT}`);

  // 4줄: 자세히 볼 곳. **절대경로.**
  lines.push(`   자세히: ${journalPath}`);
  return { level: "warn", text: lines.join("\n") };
}

// ────────────────────────────────────────────────────────────────────────────
// 12. iMessage 본문 (§6.3)
// ────────────────────────────────────────────────────────────────────────────

/** cause → 문자 첫 줄의 "원인:" 값. 여기서도 "전원이 나갔다"를 함부로 쓰지 않는다. */
function causePhraseForSms(n: NarrationInput): string {
  switch (n.cause) {
    case "sleep": {
      const reasonKo = sleepReasonKorean(pickCoveringWindow(n)?.reason ?? null);
      const paren = reasonKo ? ` (${reasonKo})` : "";
      return `맥북 절전${paren} — 전원이 나간 것은 아닙니다`;
    }
    case "reboot-clean":
      return "맥 정상 종료·재시작 — 사고가 아닙니다";
    case "restart-intended":
      return "서비스 재시작 (업데이트) — 맥은 계속 켜져 있었습니다";
    case "app-gap":
      return "수집 프로그램이 예기치 않게 종료됐다가 자동으로 복구됐습니다";
    case "power-cut":
      return "비정상 종료 (전원 차단이나 강제 종료)";
    case "battery-dead":
      return "배터리 방전으로 맥이 꺼졌습니다";
    case "panic":
      return "예기치 않은 재시작 (커널 패닉) — 전원이 끊긴 것은 아닙니다";
    case "unknown":
      return "원인 확인 불가 — 전원이 나갔다고 단정하지 않겠습니다";
  }
}

export interface IMessageOptions {
  /** ★ 일지 절대경로. 상대경로는 폰에서 열 수 없다(§6.3). */
  journalPath: string;
  /** 대시보드 주소. `http://localhost:${config.port}` 를 넘기라. */
  dashboardUrl?: string;
}

/**
 * §6.3 iMessage 본문. `sendIMessage(text)` 에 그대로 넘긴다.
 *
 * 문자는 **몇 초 안에 훑고 끝**이라 일지보다 훨씬 짧게 간다. 대신 마지막 두 줄(일지
 * 절대경로 · 대시보드 주소)이 "더 알고 싶으면 여기" 로 이어지는 유일한 다리다.
 */
export function narrateIMessage(n: NarrationInput, opts: IMessageOptions): string {
  const startMs = toMs(n.gapStart);
  const endMs = toMs(n.gapEnd);
  const dur = durationPhrase(n);
  const dashboard = opts.dashboardUrl ?? "http://localhost:7777";

  const lines: string[] = [];
  lines.push(dur ? `[대시보드] 수집이 ${dur} 멈췄습니다` : "[대시보드] 수집이 한동안 멈췄습니다");
  lines.push("");
  lines.push(`원인: ${causePhraseForSms(n)}`);
  lines.push(
    `구간: ${formatKstSlashDate(startMs)} ${formatKstHm(startMs)} → ${formatKstHm(endMs)}`
  );

  const done = n.missed.filter((m) => m.evaluated);
  if (done.length > 0) {
    lines.push(`못 돈 것: ${done.map((m) => `${m.label} ${m.slot}`).join(", ")}`);
  }
  lines.push(`지금: ${narrateRecoveryLine(n)}`);
  lines.push("");
  lines.push(`자세한 기록: ${opts.journalPath}`);
  lines.push(`화면: ${dashboard}`);
  return lines.join("\n");
}

/**
 * `narrateIMessage` 의 1인자 어댑터 — `src/uptime/notify.ts` 가 이 이름으로 부른다.
 *
 * ## 왜 옵션을 선택 인자로 뒀나 (모듈 간 계약)
 * `notify.ts` 는 `downtimeIMessageText(ev)` 로 부른다. 이 모듈은 **순수 함수**라
 * `config` 를 import 하지 않으므로(그러면 `dotenv` 가 문구 테스트의 임포트 그래프에
 * 끌려 들어온다) 경로·포트를 스스로 알 수 없다. 그래서 기본값은 저장소 구조에서 역산한
 * `DEFAULT_JOURNAL_PATH` 와 `http://localhost:7777`(config 기본 포트)이다.
 *
 * ★ 호출부 권장: `PORT` 나 `DB_PATH` 를 바꾼 환경이라면 두 번째 인자로
 *   `{ journalPath: resolveJournalPath(config.dbPath), dashboardUrl: \`http://localhost:${"$"}{config.port}\` }`
 *   를 넘겨라. 기본 설정에서는 넘기지 않아도 값이 동일하다.
 */
export function downtimeIMessageText(n: NarrationInput, opts?: Partial<IMessageOptions>): string {
  return narrateIMessage(n, {
    journalPath: opts?.journalPath ?? DEFAULT_JOURNAL_PATH,
    dashboardUrl: opts?.dashboardUrl,
  });
}

/**
 * `store.ts` 의 `DowntimeNarrator.journalHeader?()` 에 그대로 꽂는 함수형 래퍼.
 * (상수 `DOWNTIME_JOURNAL_HEADER` 와 같은 값 — 배선 코드가 화살표 함수를 만들지 않아도 되게.)
 */
export function journalHeader(): string {
  return DOWNTIME_JOURNAL_HEADER;
}
