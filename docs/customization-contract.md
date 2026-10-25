# 탭별 커스텀(스케줄 v2 + 운영 설정) 계약

2026-10-25 사용자 요청: "모든 탭의 기능을 언제나 커스텀 — 취합 시간, 요일, 주기 등".
인터뷰 결정: **스케줄 + 운영 설정 전부** / 주기는 **격주·매월까지** / UI 는 **탭별 버튼 + 전체 보기**.

타입 정본은 `shared/types.ts` 의 `JobSchedule`·`ScheduleResponse`·`TabSettings`·`TabSettingsResponse`.
이 문서는 타입만으로 안 보이는 **의미 규칙**을 고정한다.

## 1. 스케줄 v2

### 1.1 실행일 판정 (`isDueDate`)
- `daily`: 매일.
- `weekly`: `getDay() ∈ days` 이고, `intervalWeeks > 1` 이면 `anchorDate` 가 속한 주(월요일 시작)부터
  센 주 차이가 `intervalWeeks` 의 배수인 주만.
- `monthly`: `getDate() ∈ dates`, 또는 `-1 ∈ dates` 이고 그날이 말일. 없는 날짜는 그 달 건너뜀.
- 모든 계산은 로컬 시간(맥 시간대).

### 1.2 정시 실행
- 시각마다 매일 cron(`m h * * *`) 을 등록하고, 콜백에서 `enabled && isDueDate(repeat, now)` 일 때만 실행.
  (node-cron 으로는 격주·말일을 표현할 수 없어 게이트 방식으로 통일한다.)
- 저장(PUT) 즉시 `rescheduleAll()` — 재시작 불필요.

### 1.3 누락 보충(catch-up)
대상 occurrence = `lastOccurrence(job, now)` (now 이전 마지막 실행 예정). 없거나 `enabled=false` 면 보충 없음.
- occurrence 가 **오늘**이면: 기존과 같다(그 시각 이후의 정상 결과가 없으면 보충).
- occurrence 가 **이전 날**이면: 보충은 **오늘이 실행일이 아닐 때만** 한다(오늘 실행일이면 오늘 슬롯을 기다린다
  — `daily` 의 기존 동작 '아침 7시엔 어제 17시를 보충하지 않는다'를 그대로 보존).
  단, **증시 브리핑(stockKr/stockUs)은 날을 넘겨 보충하지 않는다**(지난 브리핑은 가치가 없고 원장이 일 단위).
- 펄스(stockPulse)는 지금처럼 보충이 없다.
- '커버됨' 판정은 날짜 비교가 아니라 `정상 결과의 updatedAt ≥ occurrence` 로 일반화한다(source/시도 기록 조건은 유지).
- 스킬 랭킹·로또의 주간 경계(`SKILLS_CYCLE_*`/`LOTTO_CYCLE_*` 상수)는 `lastOccurrence(schedule.x, now)` 로 대체한다.
- `daily` 기본 스케줄에서는 **기존 테스트가 전부 그대로 통과해야 한다**(행동 불변).

### 1.4 잡별 제약 (`SCHEDULE_RULES`, 서버 검증 + 화면이 응답값 그대로 사용)
| 잡 | 반복 | 시각 | 비고 |
|---|---|---|---|
| events·news·youtube·stockKr·stockUs·stockPulse | daily/weekly(1~4주)/monthly | 여러 개 | 증시 슬롯 역할(결산/프리뷰)은 기존대로 시각으로 판정 |
| skills | weekly(1~4주, 요일 1개)/monthly(날짜 1개) | 1개 | '기간 증가분' 랭킹이라 하루 간격은 의미 없음. 증가 기간 표기는 실제 window.days |
| lotto | weekly(매주 고정, 요일 1개) | 1개 | 회차당 1사이클. 토요일 추첨 전후 구간은 blackout(추첨 후 '다음 회차' 오판 방지 — 정확한 구간은 cycle.ts 근거로 결정). `추천 번호는 추첨 전 확정·불변` 계약 유지 |

### 1.5 저장
- `data/schedule.json` — 바꾼 잡만 sparse 저장, 나머지는 .env 기본값.
- **v1 형식(잡 → 시각 배열)을 읽으면 `{enabled:true, repeat:{kind:"daily"}, times}` 로 해석**한다(실제 파일이 v1 이다).
- PUT 본문은 `Partial<ScheduleConfig>`(잡 단위 전체 교체). v1 배열이 와도 같은 방식으로 받아 준다.
- 검증 실패 → 400 `{error: "<한국어 사유>"}`.

### 1.6 공용 순수 모듈 `shared/schedule.ts` (pipeline 소유, 화면도 import)
```ts
export const SCHEDULE_RULES: Record<ScheduleJobId, JobScheduleRules>;
export const SCHEDULE_JOB_LABEL: Record<ScheduleJobId, string>;      // "팝업·전시", "증시(한국)" …
export function normalizeJobSchedule(input: unknown, id: ScheduleJobId, now?: Date): JobSchedule; // 엄격, 실패 시 throw Error(한국어)
export function isDueDate(repeat: ScheduleRepeat, date: Date): boolean;
export function nextOccurrence(job: JobSchedule, from: Date): Date | null; // from 초과 첫 실행
export function lastOccurrence(job: JobSchedule, at: Date): Date | null;   // at 이하 마지막 실행
export function describeSchedule(job: JobSchedule): string;               // "매일 08:00, 17:00" / "평일 08:00" / "격주 월요일 09:00" / "격주(그 주 매일) 09:00" / "매월 1·15일 09:00" / "매월 말일 09:00" / "꺼짐"
export function expandInterval(start: string, end: string, everyMinutes: number): string[]; // "N시간마다(시작~끝)" → 시각 목록(끝 포함, 자정 넘김 허용)
export function mondayOf(d: Date, weekOffset?: number): Date;             // 그 주(월요일 시작) 월요일 00:00 + N주 — 격주 판정과 화면의 시작 주 고르기가 같이 쓴다
```

## 2. 운영 설정 (`/api/settings`)
- 저장: `data/tab-settings.json`(sparse) + .env 기본값. 저장 즉시 반영 — 소비처는 `config.X` 직접 참조 대신
  `getTabSettings()` 를 **호출 시점마다** 읽는다(모듈 로드 시 상수로 캡처 금지).
- 범위는 `numberRules` 가 정본. 범위 밖·타입 오류 → 400.
  `.env` 기본값도 이 범위로 자르고 정수로 반올림해 내보낸다(기본값은 언제나 저장·복원 가능해야 한다). 잘린 항목은 기동 시 경고 1줄.
- 알림: 탭 스위치 AND 전역 스위치. `channels` 에 없는 채널은 저장해도 무시.
  증시 브리핑은 꺼진 채널(탭 off·전역 off·메일 자격증명 미설정·iMessage 수신자 없음)을 그 슬롯 원장에서 '처리 완료'로 닫는다 —
  실제 발송 실패만 열어 두고 catch-up 이 재시도한다. 판정은 `stockChannelOffReason`(src/notify/stock-email.ts) 하나.
- `stockPulse.quietStartHour`/`quietEndHour` 변경 시 재등록(`rescheduleAll()`, 멱등). 보류분 묶음 발송 cron 시각은 `quietEndHour` 다.
- 타임아웃은 다음 실행부터 적용.

## 3. 화면
- 각 탭 헤더의 '자동 수집' 버튼 → 그 탭의 스케줄(들) + 운영 설정 다이얼로그. 스킬 랭킹·로또에도 추가.
- 상단 헤더 '설정' → 전 탭 스케줄·운영 설정 한눈에 보기 + 편집 + 가동 중단 알림.
- 반복 편집: 매일 / 매주(요일 칩, 평일·주말 프리셋, N주마다) / 매월(날짜, 말일). 시각: 목록 + 'N시간 간격' 생성기.
- 표시 문구·다음 실행·검증은 `shared/schedule.ts` 를 쓴다(백엔드 로직 중복 구현 금지).
- 응답의 rules/numberRules 로 입력 범위를 제한한다.
