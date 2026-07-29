# Daily Dashboard

맥북 로컬에서 매일 정보를 자동 수집해 **localhost 대시보드(탭형 게시판)**로 보여주는 서비스.

탭 구성:
1. **가격 대시보드** — 관심 물건 최저가 추적(네이버 쇼핑 API + 웹리서치 + 모델 매칭/필터링). 매일 09:00 수집, 시계열 저장.
2. **팝업·전시** — 팝업스토어 + 서울/경기 전시·박람회(코엑스·세텍·킨텍스·수원컨벤션센터). 매일 10:00 갱신, **이력 저장 없이 최신 스냅샷만** 캐시.
3. **뉴스** — 카테고리별 데일리 다이제스트. 하루 2회(08:00·17:00).
4. **유튜브 소식** — 채널·주제별 신규 영상 큐레이션.
5. **증시** — 한국장(08:00 개장 전 프리뷰)·미국장(18:00) 브리핑. 지수·뉴스·등록 종목 분석 + **내 포지션 점검**.
6. **보유 주식** — 실제 보유 포지션(수량·평단가·목표가·손절가·투자기간·메모). 등록하면 관심 종목에 자동 포함되고, **시간당 실시간 취합(펄스)**의 영향도 판정 대상이 된다.
7. **로또** — 예측 알고리즘이 어디까지 정확해질 수 있는지 검증하는 **실험 탭**. 1회차(2002-12-07)부터 최신 회차까지 walk-forward 백테스트를 돌리며 전략을 세대별로 진화시킨다.

새 게시판은 `web/src/App.tsx`의 `TABS` 배열에 항목을 추가해 확장한다.

## 로또 예측 실험

수집 탭이 아니라 **실험 탭**이다. 매 회차 10세트(각 번호 6개)를 제출하고 실제 당첨번호와 대조해 점수를 매기며, 50회차마다 전용 에이전트가 전략을 개정한다.

| 항목 | 내용 |
|---|---|
| 데이터 | 동행복권 `lt645/selectPstLt645InfoNew.do` (1회차~최신, 1요청당 10회차). **구 `getLottoNumber` API 는 WAF 로 차단되어 못 쓴다** |
| 채점 | 당첨번호 = 본번호 6 + **보너스 1 = 7개**. 세트 적중 1개=+1 … 6개=+6, **0개=-6**. 회차 점수 = 10세트 합(-60~+60) |
| 진행 | walk-forward — r회차 예측에 쓰는 정보는 r-1회차까지뿐(`historyBefore`) |
| 전략 | **선언형 사양**(가중치 6종·창 크기·온도·탐색률·배치 방식·필터). 모델이 코드를 쓰지 않으므로 `eval` 이 없다 |
| 진화 | 50회차마다 `src/lotto/agent.ts` 가 성적표를 읽고 다음 세대 사양을 제안 |
| 모델 | **Opus 5 고정** — 대시보드 공용 모델 설정을 따르지 않는다(실험의 통제 변인) |
| 토큰 한도 | 한도 소진 시 그 자리에서 멈추고 **4시간 뒤 자동 재개**(재개 시각은 `data/lotto-state.json`, 스케줄러가 30분마다 확인) |
| 시작 | 자동 아님 — 로또 탭의 **[실험 시작]** 버튼 |
| 회차 동기화 | 매주 토요일 21:30(추첨 직후) 신규 회차만. **완주하면 이것도 멈춘다**(아래) |
| 완주 | 최신 회차에 닿으면 `done` — **실험과 주간 동기화를 포함한 모든 자동 동작이 정지**하고 탭에 배너를 띄운다. 다음 동작(처음부터 반복 / 주 1회 새 회차만)은 사용자가 지정한다. 수동 [회차 동기화] 버튼은 이 정지의 영향을 받지 않는다 |

### 무작위 기준선 (-11.003점/회차)

차트의 점선이 이 값이다. 당첨번호가 균등 무작위이므로 **어떤 전략을 쓰든 회차당 기대점수는 이 값으로 고정**된다 — 고정된 6개 집합이 맞힐 개수의 분포는 그 집합이 무엇이든 같은 초기하분포이기 때문이다. 전략이 실제로 바꿀 수 있는 것은 기대값이 아니라 **분산**이다.

실데이터 1234회차 실측(2026-07-29):

| 전략 | 평균 | 기준선 대비 | z | 표준편차 |
|---|---|---|---|---|
| 순수 무작위 | -11.09 | -0.09 | -0.26 | 11.5 |
| hot 편향 | -11.40 | -0.40 | -0.50 | 28.0 |
| cold/gap 편향 | -11.76 | -0.76 | -0.91 | 29.2 |
| pair 편향 | -10.27 | +0.73 | +0.88 | 29.1 |
| partition(세트 분산) | -11.31 | -0.31 | -1.47 | **7.4** |
| max-coverage(45개 전부 덮기) | -11.25 | -0.25 | -1.12 | **7.7** |
| 극단 탐욕(temp=0.05) | -12.33 | -1.32 | -1.34 | 34.6 |

전부 잡음 범위(|z| < 1.5) 안이고, 눈에 띄게 달라지는 것은 표준편차뿐이다. 이 불변식은 회귀 테스트로 못박혀 있다(`src/lotto/experiment.test.ts`) — 깨진다면 채점이 틀렸거나 예측이 미래를 본 것이다.

## 증시 전용 에이전트 & 시간당 펄스

증시 관련 LLM 호출은 전부 **증시 전용 에이전트**(`src/stock/agent.ts`)를 지난다. 정체성·도구·타임아웃이 한 곳에 모여 있고, 모드는 둘이다:

- `briefing` — 일일 리포트(기존 브리핑)
- `pulse` — 시간당 실시간 취합(신규)

> 모델은 분리하지 않는다. 대시보드에서 고른 공용 모델(Codex / Opus 5)을 계속 쓴다.

**펄스**는 매시간(기본 하루 18회, 장중·장전후 집중) 보유 종목에 영향을 줄 재료를 취합해 **iMessage**로 알린다.

| 항목 | 동작 |
|---|---|
| 소스 | 세이브티커 속보 API(결정론적) + WebSearch(인물 발언·세계 각국 뉴스) |
| 판정 | 재료의 **방향(긍정/부정/중립) × 강도(긴급/중요/참고)** — 매매 행동 지시는 프롬프트·코드 양쪽에서 차단 |
| 문턱 | `중요` 이상만 문자 발송 (`STOCK_PULSE_THRESHOLD`) |
| 상한 | 종목당 3건 / 전체 10건 / 거시·섹터 별도 2건 (하루) |
| 중복 | 이슈 지문 24시간 차단. 단 **강도가 오르면**(중요→긴급) 재발송 |
| 야간 | 23~07시는 `긴급`만 즉시, `중요`는 쌓아 뒀다가 07:00 묶음 1통 |
| catch-up | **없음** — 지나간 시각의 실시간 취합은 보충하지 않는다 |

문자 문턱을 넘지 못한 판정은 원장에만 남고, **일일 브리핑의 '내 포지션 점검 → 지난 24시간 실시간 취합'** 에서 회수된다(화면 피드·펄스 이메일은 없다).

> ⚠️ 펄스는 `NOTIFY_IMESSAGE=true` + `IMESSAGE_TO` 설정 + 보유 종목 1건 이상일 때만 실행된다. 하나라도 빠지면 건너뛰고 로그에만 남는다.
>
> 상세 사양: `docs/stock-agent-v2.md`

## 구성
- **collector/** 네이버 쇼핑 API(결정적) + 가격비교 소스 폴백(다나와 → 에누리 → AI 웹리서치) + 필터링 + 멱등 저장
- **importer/** 기존 `price_history.json` → SQLite 1회 멱등 임포트
- **scheduler/** in-process 정시 수집 + 잠자기/재시작 누락 catch-up
- **api/** 상품 CRUD · 히스토리/기간필터 · "지금 수집" · 프론트 정적 서빙
- **web/** React+TS+Vite+shadcn+Tailwind+recharts 대시보드
- **service/** launchd 등록/제거 스크립트

기술 스택: 단일 TypeScript 프로젝트, 저장소는 Node 내장 `node:sqlite`(네이티브 빌드 불필요).

## 사전 요구사항
- **macOS** (launchd 서비스 등록 기준) / **Node.js 18 이상** (`node -v`로 확인, 권장 20+)
- 네이버 개발자센터 검색 API 키 (필수) — https://developers.naver.com/
- (선택) Anthropic Console API 키 — 웹리서치(비교가/리뷰)용
- Codex CLI + ChatGPT 로그인 — **기본 모델(Codex 5.6 Sol)** 이 정액제 크레딧을 쓴다
- (선택) Python 3 — 팝업/전시 날짜 검증(insane-engine)용. `bash tools/insane-engine/setup.sh` 1회 실행
- 별도 DB 설치 불필요 (Node 내장 SQLite 사용)

## 빠른 시작 (TL;DR)
```bash
npm install && npm install --prefix web   # 1) 의존성 설치
cp .env.example .env                       # 2) .env 에 네이버 키 입력
bash tools/insane-engine/setup.sh          # 2-1) (선택) 날짜 검증 엔진 venv 준비
npm run import                             # 3) 기존 이력 임포트(최초 1회)
npm run web:build                          # 4) 프론트 빌드
npm start                                  # 5) http://localhost:7777 접속
```

## npm 스크립트 한눈에 보기
| 스크립트 | 설명 |
|---|---|
| `npm install` | 백엔드 의존성 설치 |
| `npm install --prefix web` | 프론트(web) 의존성 설치 |
| `npm run import` | `price_history.json` → SQLite 임포트(멱등) |
| `npm run web:build` | **프론트 빌드** → `web/dist` 생성 (서버가 이걸 서빙) |
| `npm run build` | `web:build` 별칭 |
| `npm start` | 백엔드+스케줄러 기동 (프론트 dist 정적 서빙) |
| `npm run dev` | 백엔드 watch 모드 |
| `npm run web:dev` | 프론트 Vite dev 서버(핫리로드) |
| `npm run collect` | 지금 즉시 전체 수집(CLI) |
| `npm run typecheck` | 백엔드 타입체크 |

## 1. 설치
```bash
npm install            # 백엔드 의존성
npm install --prefix web   # 프론트 의존성 (install.sh가 자동 빌드도 함)
cp .env.example .env   # 키 입력 (이미 .env 가 있다면 생략)
```

### .env (비밀값 — 절대 커밋 금지, `.gitignore` 처리됨)
| 키 | 필수 | 설명 |
|---|---|---|
| `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` | ✅ | 네이버 쇼핑 검색 API. 없으면 수집 fail-fast |
| `ANTHROPIC_API_KEY` | 선택 | Opus 5 가격 웹리서치용. Codex 선택 시에는 불필요 |
| `EVENTS_VERIFY_DATES` / `INSANE_*` | 선택 | 팝업/전시 날짜 검증(insane-engine). 차단된 실제 페이지를 우회 fetch 해 종료된 행사를 제외. 끄려면 `EVENTS_VERIFY_DATES=false`. 자세한 항목은 `.env.example`/`tools/insane-engine/README.md` |
| `PORT` | 기본 7777 | 대시보드/API 포트 |
| `COLLECT_TIME` | 기본 09:00 | 매일 가격 수집 시각(로컬) |
| `EVENTS_COLLECT_TIME` | 기본 10:00 | 매일 팝업/전시 갱신 시각(로컬) |
| `NOTIFY_EMAIL` / `GMAIL_ADDRESS` / `GMAIL_APP_PASSWORD` | 선택 | 이메일 리포트 알림 |

> 알림 자격증명이 없으면 이메일 알림만 경고 후 건너뛰고, 수집/대시보드는 정상 동작한다.
>
> **AI 에이전트 선택**: 대시보드 상단에서 `Codex 5.6 Sol`(기본) · `Opus 5` · `Codex 5.6 Terra` 중 고른다.
> Codex는 `codex login status`가 `Logged in using ChatGPT`일 때만 실행하며,
> `OPENAI_API_KEY`/`CODEX_API_KEY`를 전달하거나 API 종량 과금으로 자동 전환하지 않는다.
>
> **한도 소진 자동 전환 · 주간 복귀**: Codex 정액제 한도가 소진되면(`You've hit your usage limit`,
> `Quota exceeded`, `429 Too Many Requests` 등) 수집 모델이 자동으로 `Opus 5`로 바뀌고,
> 그 실행도 남은 시간 안에서 Opus 5로 즉시 재시도해 그날 결과를 살린다. 전환 사실은 대시보드
> 모델 버튼에 배지로 남는다. 매주 **일요일 21:00** 에 자동으로 `Codex 5.6 Sol`로 되돌아가며,
> 그 시각에 맥이 꺼져 있었으면 다음 기동 시 1회 보충(catch-up)한다. 언제든 직접 고르면
> 수동 선택이 우선한다(다음 일요일 21:00 까지).
>
> **카카오 알림 안내**: 카카오 "나에게 보내기"(PlayMCP MemoChat)는 OAuth 인증이 필요한 MCP라,
> 무인으로 도는 launchd 백그라운드 서비스에서는 직접 호출할 수 없다. 카카오 알림이 필요하면
> PlayMCP가 연결된 claude.ai/Claude Code 측 스케줄 에이전트가 대시보드(`/api/runs/today`)를 읽어
> 메모를 보내는 방식으로 구성해야 한다. (대시보드가 1차 출력, 알림은 부가)

## 2. 기존 데이터 임포트 (최초 1회, 멱등)
```bash
npm run import         # price_history.json → SQLite (없으면 폴백 시드 8종)
```

## 3. 빌드 & 실행

### A. 프로덕션 (권장 — 단일 서버가 API + 대시보드 모두 서빙)
```bash
npm run web:build      # 프론트 빌드 → web/dist 생성
npm start              # http://localhost:7777
```
- `npm run web:build`는 내부적으로 `tsc --noEmit`(타입체크) → `vite build`를 수행한다.
- `npm start`는 `web/dist`가 있으면 그대로 서빙하고, 없으면 빌드 안내 페이지를 띄운다.
  (빌드를 깜빡해도 API는 `/api/*`에서 정상 동작한다.)

### B. 개발 (프론트 핫리로드)
```bash
npm run dev            # 터미널1: 백엔드 + 스케줄러 (파일 변경 시 자동 재시작)
npm run web:dev        # 터미널2: 프론트 dev 서버(5173) — /api 는 7777로 프록시
```
→ 브라우저에서 **http://localhost:5173** 접속.

### 포트/수집 시각 바꾸기
`.env`에서 변경 후 재시작:
```bash
PORT=8080
COLLECT_TIME=08:00     # HH:mm (24시간, 로컬 시각)
```

## 4. 상시 서비스 등록 (launchd)
로그인 시 자동 기동 + 상시 유지 + 매일 `COLLECT_TIME` 자동 수집:
```bash
./service/install.sh   # plist 생성·로드 (프론트 미빌드 시 자동 빌드)
./service/uninstall.sh # 제거 (DB/로그는 보존)
```
로그: `logs/stdout.log`, `logs/stderr.log`

## 수동 조작
```bash
npm run collect                 # 지금 즉시 전체 수집 (CLI)
curl -X POST localhost:7777/api/collect   # 지금 수집 (API) — 대시보드 "지금 수집" 버튼과 동일

# 다나와/에누리 ref(pcode·modelno) 조사·확정
npx tsx src/cli.ts link                    # 조사만 (DB 변경 없음) — 어느 상품이 연결되는지 리포트
npx tsx src/cli.ts link --apply            # 검증 통과한 후보를 확정 저장
npx tsx src/cli.ts link --apply --product=15   # 특정 상품만
```

### 종합 최저가는 어떻게 정해지나
`종합 최저가 = min(네이버 최저가, 확정된 가격비교 소스의 전체최저가)` 이고, **그 금액이 적힌
페이지 링크(`lowest_url`)를 값과 한 쌍으로** 저장한다. 네이버가 최저면 네이버 Top1 리스팅,
다나와/에누리가 최저면 그 소스가 조회한 페이지로 연결된다.

가격 소스는 **네이버 + 확정된 다나와/에누리 스크래핑뿐**이다. LLM 웹검색은 리뷰 전용이며
가격을 내지 않는다 — 2026-07-29 라이브 실측에서 LLM 이 보고한 최저가가 자기가 준 비교
페이지의 실제 최저가와 일치한 건 10건 중 2건뿐이었고, 나머지는 카드할인·적립 반영가라
화면 금액과 링크 착지 금액이 어긋났다. `product_sources` 에 확정된 ref 가 없는 상품은
네이버 단독으로 수집한다(`npx tsx src/cli.ts link` 로 연결 가능 여부를 확인).

## 주요 API
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/products` | 활성 상품 요약(카드). `?all=1` 비활성 포함 |
| GET | `/api/products/:id/history?days=7\|30\|90` | 기간별 추이 |
| POST | `/api/products` | 상품 추가 + 즉시 1차 수집 |
| DELETE | `/api/products/:id` | 추적 중지(soft). `?hard=1&confirm=<상품명>` 영구 삭제 |
| POST | `/api/products/:id/reactivate` | 추적 재개 |
| POST | `/api/collect` | 지금 수집(가격) |
| GET | `/api/runs/today` | 오늘 가격 수집 상태 |
| GET | `/api/events` | 최신 팝업/전시 스냅샷 |
| POST | `/api/events/refresh` | 팝업/전시 지금 갱신 |
| GET | `/api/stock/:market` | 최신 증시 브리핑 스냅샷 (kr\|us) |
| GET | `/api/stock/holdings` | 보유 종목 + 현재가·손익 (시세 조회로 느림) |
| GET | `/api/stock/holdings/raw` | 보유 종목 원장만 (빠름) |
| POST | `/api/stock/holdings` | 보유 종목 추가 (등록 종목에 자동 포함) |
| PATCH | `/api/stock/holdings/:id` | 보유 종목 수정 (`null`=해제, 키 생략=유지) |
| DELETE | `/api/stock/holdings/:id?confirm=<심볼>` | 보유 종목 삭제 (등록 종목은 보존) |
| GET | `/api/stock/pulse/status` | 펄스 상태 + 최근 24시간 판정 목록 |
| POST | `/api/stock/pulse/run` | 펄스 지금 실행 (백오프 무시) |
| GET | `/api/lotto` | 로또 실험 전체 스냅샷(차트·전략 이력) — 폴링 금지 |
| GET | `/api/lotto/status` | 진행 상태만 (폴링용) |
| POST | `/api/lotto/start` | 실험 시작/재개 (응답은 즉시, 진행은 백그라운드) |
| POST | `/api/lotto/pause` | 일시정지 (다음 회차 경계에서 멈춤) |
| POST | `/api/lotto/sync` | 동행복권 회차 동기화 (`?force=1` 전량 재수집) |
| POST | `/api/lotto/reset?confirm=reset` | 채점·전략 초기화 (회차 원본은 보존) |
| POST | `/api/lotto/ack` | 완주 배너 확인 처리 |

## 동작 메모
- **멱등성**: `(product_id, date)` UNIQUE → 같은 날 재수집은 덮어쓰기. 알림은 하루 1회.
- **catch-up**: 기동 직후 + 30분마다 점검, 예정 시각이 지났고 오늘 성공 수집이 없으면 1회 보충.
- **날짜**: 모든 "오늘" 판정은 로컬(KST) 기준.
- **DoD**: 백엔드/프론트 타입체크 통과 · 로컬 동작 · 임포트 멱등/수집/스케줄/CRUD E2E 검증 완료.

## 트러블슈팅
| 증상 | 원인 / 해결 |
|---|---|
| 기동 시 `NAVER_CLIENT_ID ... 없습니다` 오류 | `.env`에 네이버 키 미입력 → 키 입력 후 재시작 |
| 대시보드에 "프론트가 아직 빌드되지 않았습니다" | `npm run web:build` 실행 후 새로고침 |
| Opus 선택 시 카드에 비교가/리뷰가 안 보임 | `ANTHROPIC_API_KEY` 미설정 → 네이버 결과만 표시. 키를 넣거나 Codex를 선택 |
| Codex 수집이 로그인 오류로 실패 | `codex login` 실행 후 `codex login status`가 `Logged in using ChatGPT`인지 확인. API 키 로그인은 의도적으로 거부 |
| 고르지 않았는데 모델이 `Opus 5`로 바뀌어 있음 | Codex 정액제 한도 소진으로 자동 전환된 상태. 모델 버튼의 "자동 전환" 배지에 사유·시각이 있다. 일요일 21:00 자동 복귀를 기다리거나 직접 다시 고르면 된다 |
| 특정 상품 후보 0개(최저가 "-") | 모델 매칭이 엄격하거나 시장 매물 없음 → 상품의 포함/제외/최소가 조정 |
| `ExperimentalWarning: SQLite ...` | Node 내장 SQLite 경고(무해). 서비스는 `NODE_NO_WARNINGS=1`로 숨김 |
| 포트 충돌 | `.env`의 `PORT` 변경 후 재시작 |
| launchd 서비스 상태 확인 | `launchctl print gui/$(id -u)/com.daegun.dailyprice \| head` / 로그: `logs/stderr.log` |
