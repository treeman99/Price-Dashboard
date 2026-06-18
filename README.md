# Daily Price Dashboard

맥북 로컬에서 관심 물건의 최저가를 매일 자동 수집해 **localhost 대시보드**로 보여주는 서비스.
Cowork "daily price"의 수집 동작(네이버 쇼핑 API + 웹리서치 + 모델 매칭/필터링)을 그대로 이식하되,
결과를 이메일이 아니라 항상 떠 있는 로컬 대시보드로 제공한다.

## 구성
- **collector/** 네이버 쇼핑 API(결정적) + Agent SDK 웹리서치(비교가/쿠팡/리뷰) + 필터링 + 멱등 저장
- **importer/** 기존 `price_history.json` → SQLite 1회 멱등 임포트
- **scheduler/** in-process 정시 수집 + 잠자기/재시작 누락 catch-up
- **api/** 상품 CRUD · 히스토리/기간필터 · "지금 수집" · 프론트 정적 서빙
- **web/** React+TS+Vite+shadcn+Tailwind+recharts 대시보드
- **service/** launchd 등록/제거 스크립트

기술 스택: 단일 TypeScript 프로젝트, 저장소는 Node 내장 `node:sqlite`(네이티브 빌드 불필요).

## 사전 요구사항
- **macOS** (launchd 서비스 등록 기준) / **Node.js 18 이상** (`node -v`로 확인, 권장 20+)
- 네이버 개발자센터 검색 API 키 (필수) — https://developers.naver.com/
- (선택) Anthropic Console API 키 — 웹리서치(비교가/쿠팡/리뷰)용
- 별도 DB 설치 불필요 (Node 내장 SQLite 사용)

## 빠른 시작 (TL;DR)
```bash
npm install && npm install --prefix web   # 1) 의존성 설치
cp .env.example .env                       # 2) .env 에 네이버 키 입력
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
| `ANTHROPIC_API_KEY` | 선택 | Agent SDK 웹리서치(비교가/쿠팡/리뷰). 없으면 네이버 결과만으로 수집 |
| `PORT` | 기본 7777 | 대시보드/API 포트 |
| `COLLECT_TIME` | 기본 09:00 | 매일 자동 수집 시각(로컬) |
| `NOTIFY_EMAIL` / `GMAIL_ADDRESS` / `GMAIL_APP_PASSWORD` | 선택 | 이메일 리포트 알림 |

> 알림 자격증명이 없으면 이메일 알림만 경고 후 건너뛰고, 수집/대시보드는 정상 동작한다.
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
```

## 주요 API
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/products` | 활성 상품 요약(카드). `?all=1` 비활성 포함 |
| GET | `/api/products/:id/history?days=7\|30\|90` | 기간별 추이 |
| POST | `/api/products` | 상품 추가 + 즉시 1차 수집 |
| DELETE | `/api/products/:id` | 추적 중지(soft). `?hard=1&confirm=<상품명>` 영구 삭제 |
| POST | `/api/products/:id/reactivate` | 추적 재개 |
| POST | `/api/collect` | 지금 수집 |
| GET | `/api/runs/today` | 오늘 수집 상태 |

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
| 카드에 비교가/쿠팡/리뷰가 안 보임 | `ANTHROPIC_API_KEY` 미설정 → 네이버 결과만 표시(정상). 키 넣으면 활성화 |
| 특정 상품 후보 0개(최저가 "-") | 모델 매칭이 엄격하거나 시장 매물 없음 → 상품의 포함/제외/최소가 조정 |
| `ExperimentalWarning: SQLite ...` | Node 내장 SQLite 경고(무해). 서비스는 `NODE_NO_WARNINGS=1`로 숨김 |
| 포트 충돌 | `.env`의 `PORT` 변경 후 재시작 |
| launchd 서비스 상태 확인 | `launchctl print gui/$(id -u)/com.daegun.dailyprice \| head` / 로그: `logs/stderr.log` |
