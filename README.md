# Daily Dashboard

맥북 로컬에서 매일 정보를 자동 수집해 **localhost 대시보드(탭형 게시판)**로 보여주는 서비스.

탭 구성:
1. **가격 대시보드** — 관심 물건 최저가 추적(네이버 쇼핑 API + 웹리서치 + 모델 매칭/필터링). 매일 09:00 수집, 시계열 저장.
2. **팝업·전시** — 팝업스토어 + 서울/경기 전시·박람회(코엑스·세텍·킨텍스·수원컨벤션센터). 매일 10:00 갱신, **이력 저장 없이 최신 스냅샷만** 캐시.
3. **뉴스** — 카테고리별 데일리 다이제스트. 하루 2회(08:00·17:00).
4. **유튜브 소식** — 채널·주제별 신규 영상 큐레이션.
5. **증시** — 한국장(08:00 개장 전 프리뷰)·미국장(18:00) 브리핑. 지수·뉴스·등록 종목 분석 + **내 포지션 점검**.
6. **보유 주식** — 실제 보유 포지션(수량·평단가·목표가·손절가·투자기간·메모). 등록하면 관심 종목에 자동 포함되고, **시간당 실시간 취합(펄스)**의 영향도 판정 대상이 된다.
7. **로또** — 매주 일요일 10:00 자동으로 새 추첨 결과를 받아 **지난주에 미리 확정해 둔 추천 번호**를 채점하고, 그 결과로 전략을 갱신한 뒤 다음 회차 번호를 뽑는다. 화면은 다음 회차 예상 번호 + 지난 10회차 비교 결과뿐이다.

새 게시판은 `web/src/App.tsx`의 `TABS` 배열에 항목을 추가해 확장한다.

## 로또 주간 운영

**매주 일요일 10:00 cron 하나가 전부 한다**(`src/lotto/cycle.ts`). 화면에는 조작 버튼이 없다.

```
① 새 추첨 결과 수집  →  ② 지난주에 못박아 둔 추천 번호 채점
                     →  ③ 결과를 에이전트에 전달해 전략 갱신
                     →  ④ 다음 회차 번호를 뽑아 추첨 전에 저장(다음 주 ②의 대상)
```

| 항목 | 내용 |
|---|---|
| 실행 | `일요일 10:00` cron + catch-up(기동 직후·30분마다). 맥이 자고 있었으면 깨어난 뒤 보충한다 |
| 데이터 | 동행복권 `lt645/selectPstLt645InfoNew.do`. **구 `getLottoNumber` API 는 WAF 로 차단되어 못 쓴다.** `srchDir=center` 는 요청 회차를 **중심으로** 위아래 10건을 준다(실측) |
| 대조 | 당첨번호 = 본번호 6 + **보너스 1 = 7개** |
| **번호 확정** | 추첨 **전에** `lotto_upcoming` 에 저장하고 **절대 덮어쓰지 않는다.** 이것이 없으면 화면을 열 때마다 번호가 달라져 '추천했던 번호와 비교'가 성립하지 않는다(전환 전의 실제 버그) |
| 목표 | **가중 회차 점수** = 1×[3+ 있음] + 2×[4+ 있음] + 4×[5+ 있음] + 8×[6개 있음] (회차당 0~15) |
| 대조군 | 회차 점수(적중 m개=+m, 0개=-6, 10세트 합)와 '3+ 세트 수'. 전략이 못 움직인다는 것이 1234회차로 확인됐다 |
| 전략 | **선언형 사양**. 모델이 코드를 쓰지 않으므로 `eval` 이 없다 |
| 갱신 | 새로 채점한 회차가 있을 때만 에이전트를 부른다(주 1회). 프롬프트가 **"표본 1로 사양을 흔들지 마라 · 유지가 정상"** 을 명시한다 — 사용자가 반복 학습을 중단한 이유가 과잉 정합성이었다 |
| 모델 | **Opus 5 고정** — 대시보드 공용 모델 설정을 따르지 않는다(통제 변인) |
| 토큰 한도 | 전략 갱신만 미루고 **번호 추출은 직전 세대로 계속한다.** 4시간 뒤 재시도(`data/lotto-state.json`) |
| 누락 회차 | 미리 못박아 두지 않은 회차는 채점하지 않는다 — 결과를 보고 번호를 고르면 예측이 아니다(로그만 남긴다) |

### 없어진 것 (2026-07-30)

반복 학습(전 회차를 여러 바퀴 다시 도는 것)을 **과잉 정합성 때문에 중단**했다. 함께 사라진 것:
[실험 시작]/[일시정지]/[회차 동기화]/[초기화]/[실험 반복] 버튼, 상태 머신(idle/running/paused/done),
세대 이력·바퀴별 성적표, 회차 점수·누적 점수·가중 회차 점수 추이 차트.
백테스트로 쌓인 8바퀴 × 1234회차 기록은 지우지 않았고(`run` 스코프로 남아 있다), 라이브 예측은
**마지막 바퀴를 이어서** 쌓는다.

### 왜 목표를 바꿨나 (2026-07-29)

처음 목표는 '예측 정확도'(점수)였다. 실데이터 1234회차로 검정한 결과 **그 축에는 올릴 것이 없다**는 것이 확인됐다:

| 검정 | 결과 |
|---|---|
| 번호별 출현 빈도 균등성 | χ²=33.41 (df=44), **p=0.88** — 기계·볼 편향 없음 |
| 전반 617회차 vs 후반 동질성 | **p=0.23** |
| 직전 회차 번호의 재출현 | 16.09% vs 15.46% (기대 15.56%), **z=1.50** — 회차 간 의존성 없음 |
| 엔진 특징 6종의 예측 AUC | hot 0.4983 / cold 0.5017 / overall 0.4961 / gap 0.5002 / decay 0.4988 / pair 0.5011 — **전부 0.50** |
| 합·홀짝·연속번호 분포 | 전부 이론값과 일치 |

점수의 기대값은 **어떤 전략을 써도 -11.003 으로 고정**이다. 고정된 6개 집합이 맞힐 개수의 분포는 그 집합이 무엇이든 같은 초기하분포이고, 기대값은 선형이기 때문이다.

### 목표 지표: 3+ 적중률

3+ 를 달성한 **세트의 총 개수**도 같은 이유로 고정이다(회차당 0.394개). 하지만 그 적중이 **몇 개의 서로 다른 회차에 흩어지는가**는 디자인이 정한다 — 그래서 이 비율만이 최적화 가능하다.

| 구조 | 3+ 적중률 |
|---|---|
| 무작위 10세트 (**기준선**) | 33.36% |
| 45개 전부 커버 | 35.8% |
| 45개 전부 커버 + 세트간 중복 ≤1 | 36.1% |
| 국소탐색 최적해 (**천장**) | **36.43%** |
| 풀을 좁힘(휠링 12~21개) | 12~27% — 오히려 나쁨 |
| 극단 집중 | 5.6% |

최적 구조는 45개를 전부 덮으면서 어떤 두 세트도 번호를 1개까지만 공유하는 것이다(그때 10세트가 덮는 서로 다른 3조합이 이론 최대인 200개가 된다). 이 값들은 40만 회 홀드아웃 표본으로 측정했다 — **탐색에 쓴 표본으로 평가하면 39.3% 같은 과적합된 숫자가 나온다**(실측). 엔진이 표본을 두 벌 쓰는 이유가 이것이다.

⚠️ 천장과 최적 구조는 **에이전트 프롬프트에 넣지 않는다.** 답을 알려주면 실험이 아니라 받아쓰기가 된다(테스트로 못박음). 2026-07-30 전환으로 이 값들을 그리던 차트가 없어졌으므로, 지금 이 표가 그 지식이 남아 있는 유일한 곳이다.

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
> **실행마다 Codex 확인 → 임시 대체**: Codex를 고른 상태에서 **수집을 실행할 때마다 Codex를 먼저
> 확인**한다. 로그인이 초기화됐거나(`codex login status`가 ChatGPT 로그인이 아님), CLI가 없거나,
> 정액제 한도가 소진됐으면(`You've hit your usage limit`, `Quota exceeded`, `429` 등)
> **그 실행만** 남은 시간 안에서 `Opus 5`로 즉시 재시도해 결과를 살린다.
> 대시보드에 저장된 **선택은 그대로 유지**되고, 대체 중이라는 사실만 모델 버튼에 배지로 남는다.
> 복귀에 정해진 시각은 없다 — 다음 실행에서 Codex가 다시 응답하는 순간 배지가 풀리고 그대로
> Codex로 돌아간다. 프롬프트 오류·네트워크 오류 같은 '진짜 실패'는 대체하지 않고 그대로 실패한다
> (대체로 넘기면 Codex 경로의 버그가 Opus 실행에 묻힌다).
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
| GET | `/api/lotto` | 다음 회차 예상 번호 + 지난 10회차 비교 결과 |
| POST | `/api/lotto/cycle` | 주간 사이클 수동 실행 (**운영·검증용**, 화면에 버튼 없음. 응답 즉시) |

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
| 모델 버튼에 "→ Opus 5 임시 대체" 배지 | Codex를 지금 못 쓰는 상태(로그인 초기화 / 정액제 한도 소진). 배지 안에 사유·시작 시각이 있다. 선택은 Codex 그대로이고, 다음 수집에서 Codex가 응답하면 저절로 풀린다. 로그인이 원인이면 `codex login` 후 다음 수집을 기다리거나 "지금 갱신"을 누르면 된다 |
| Codex 수집이 로그인 오류로 실패 | `codex login` 실행 후 `codex login status`가 `Logged in using ChatGPT`인지 확인. API 키 로그인은 의도적으로 거부. 로그인이 풀린 동안에도 수집은 Opus 5로 대체 실행되므로 결과가 비지는 않는다 |
| 특정 상품 후보 0개(최저가 "-") | 모델 매칭이 엄격하거나 시장 매물 없음 → 상품의 포함/제외/최소가 조정 |
| `ExperimentalWarning: SQLite ...` | Node 내장 SQLite 경고(무해). 서비스는 `NODE_NO_WARNINGS=1`로 숨김 |
| 포트 충돌 | `.env`의 `PORT` 변경 후 재시작 |
| launchd 서비스 상태 확인 | `launchctl print gui/$(id -u)/com.daegun.dailyprice \| head` / 로그: `logs/stderr.log` |
