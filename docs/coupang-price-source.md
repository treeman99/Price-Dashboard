# 쿠팡 가격 수집 강화 — 설계 문서 (v0, 검토용)

> 상태: **설계 확정 전.** Phase 0(검증 스파이크) 결과로 "수집 메커니즘"을 최종 결정한다.
> 골격(PriceSource 추상화·스키마·watchlist·폴백/알림)은 메커니즘과 무관하게 먼저 확정한다.

## 1. 배경 / 현재 상태

쿠팡 직접 크롤링은 Akamai Bot Manager 때문에 사실상 불가 → **가격비교 사이트를 경유**해 쿠팡 판매가와 전체 최저가를 가져온다. 1차 다나와, 폴백 에누리.

현재 코드의 실상(중요):
- 쿠팡/다나와 가격은 **스크래핑이 아니라** `src/collector/research.ts`가 Agent SDK `WebSearch` 도구로 매번 `"{상품명}"`을 **LLM에게 재검색**시켜 JSON으로 추출한다.
- 따라서 **"키워드 재검색 → 매일 다른 상품 → 추세선 깨짐"** 문제가 이미 현재 코드에 존재한다. 이 설계의 1차 동기다.
- 네이버 쇼핑 API(`src/collector/naver.ts`)는 결정적 백본으로 정상 동작. 리서치 실패 시 EMPTY로 degrade. **per-product 에러 격리 + 이메일 알림** 구조가 이미 있다(`src/collector/collect.ts`).

→ 본 작업의 본질: **"새 기능 추가"가 아니라 `research.ts`를 비결정적 LLM 검색에서 pcode 고정 소스로 교체하는 리팩터링.**

## 2. 목표 / 비목표

**목표**
- 상품을 **키워드가 아니라 소스별 고정 식별자(다나와 pcode/URL)** 로 추적한다.
- `PriceSource` 인터페이스로 다나와/에누리/(보존)LLM검색을 플러그인화하고 1차 실패 시 폴백한다.
- 상품 1건당: 상품명·모델명, 다나와 pcode·URL, **쿠팡 판매가·로켓여부**, 전체 최저가·최저가 판매처, 수집 시각(KST), 사용 소스를 저장한다.
- 차단(403/빈 응답/캡차/비정상 HTML) 감지 → 해당 소스 스킵 → 로그+알림, 전체 작업은 중단하지 않는다.

**비목표**
- 쿠팡 직접 크롤링. (금지)
- 수집 데이터의 상업적 재배포. (금지)
- 클라우드/데이터센터 실행. (가정용 IP 로컬 전용. 위반 시 코드가 경고)

## 3. 검증된 제약 (2026-06 실측)

| 항목 | 결과 | 출처 |
|---|---|---|
| 다나와 robots.txt | 상품(pcode) 경로 **허용**. 단 `/*?iframe=*` **Disallow** ⚠️ | danawa.com/robots.txt |
| 에누리 robots.txt | `Allow: /` + crawl-delay 1s, `ClaudeBot`/`GPTBot` 명시 허용 (스크래핑 친화적) | enuri.com/robots.txt |
| 다나와에 쿠팡가 존재? | **예.** "쿠팡 로켓배송관"·"쿠팡 와우할인 최저가몰" 별도 섹션 존재 | m.danawa.com/sectionMain.html?code=21 |

## 4. Phase 0 — 검증 스파이크 (착수 전 필수, ~30분)

전체 설계가 깔고 있는 단 하나의 미검증 가정을 못 박는다.

**검증 질문**
1. 다나와 pcode 상품 페이지에서 쿠팡 판매가가 **SSR(서버렌더링)** 로 오는가, 아니면 **iframe/XHR로 지연 로딩**되는가? (후자면 robots `/*?iframe=*` Disallow와 충돌 가능)
2. 개별 상품에서 **쿠팡이 다나와 판매처 목록에 실제로 포함되는 비율**은? (쿠팡이 피드를 안 주는 품목 다수 → `null` 빈도)
3. 로켓배송 배지를 HTML에서 결정적으로 식별 가능한가?
4. 에누리에서 동일 항목이 더 잘 잡히는가? (1차/폴백 순서 재검토 근거)

**방법**: 실제 상품(예: 맥북 1~2종)의 pcode 페이지를 (a) `curl`/`fetch` 원본 HTML, (b) 헤드리스 렌더링(Chrome/Playwright) 두 경로로 받아 쿠팡 판매가·로켓·최저가 판매처가 어디서 나오는지 비교. 네트워크 탭에서 가격목록 XHR 엔드포인트 확인.

**결정 트리 (스파이크 결과 → 메커니즘)**

| 스파이크 결과 | 채택 메커니즘 |
|---|---|
| 쿠팡가가 SSR로 옴 | **raw fetch + HTML 파서** (가장 가벼움) |
| iframe/XHR이지만 robots 비위반 공개 엔드포인트 | raw fetch로 그 엔드포인트 호출 |
| iframe/XHR + robots `/*?iframe=*` 충돌 | **헤드리스 렌더링** 또는 **LLM 경로 유지(pcode URL 고정)** 중 택1 — ToS 존중 우선 |
| 쿠팡 누락률이 높음(>50%) | 1차를 에누리로, 또는 네이버/LLM 폴백 비중 상향 |

**DoD**: 위 4개 질문에 실측 근거로 답 + 권장 메커니즘 1개 + 근거 스니펫.

### Phase 0 결과 (2026-06 실측 완료)

추적 상품 4종(리코 GR4, DJI 오즈모 포켓4, 드리미 X60 Ultra, 로보락 S10 MaxV Ultra)으로 전 흐름 재현.

**다나와 — 기술적으로 완전히 가능**
- `search.danawa.com/dsearch.php` → pcode 해석: 일반 curl HTTP 200 (Akamai 차단 없음). robots: `Crawl-delay: 10`, dsearch 허용.
- `prod.danawa.com/info/?pcode=` 상품 페이지: HTTP 200. **요약 최저가(예: 1,571,700원)는 SSR HTML에 존재** (robots 허용 경로).
- **판매처별 목록(쿠팡 개별가 + 로켓 + 전체 몰)은 `prod.danawa.com/info/ajax/getAllPriceCompareMallList.ajax.php` XHR로 로딩.** 일반 curl(+Referer, X-Requested-With) HTTP 200으로 전체 반환. 쿠팡 행은 몰코드 `cmpnyc=TP40F`(로고 alt="쿠팡")로 결정적 식별. 로켓배송 텍스트 식별 가능.
- **쿠팡 노출률: 4/4 (전부 로켓). 쿠팡가 결정적 추출 성공.**

| 상품 | pcode | 쿠팡가 | 로켓 |
|---|---|---|---|
| 리코 GR IV (정품) | 96984461 | 2,490,000 | O |
| DJI 오즈모 포켓4 (스탠다드 콤보) | 122628409 | 662,000 | O |
| 드리미 X60 Ultra (화이트) | 107991857 | 1,290,000 | O |
| 로보락 S10 MaxV Ultra (화이트) | 106736861 | 1,571,700 | O |

**⛔ robots 충돌 (핵심)**
- `prod.danawa.com/robots.txt`가 **`Disallow: /info/ajax/`** 와 `Disallow: /list/ajax/`, `/api/` 를 명시. 즉 쿠팡 개별가가 들어있는 바로 그 엔드포인트는 **robots 금지**.
- 반면 **상품 페이지(`/info/?pcode=`)와 SSR 요약 최저가는 robots 허용.** 단 SSR 요약은 몰별 분해가 없어 "쿠팡가 vs 전체최저가"를 항상 분리하지는 못함(이번 표본은 우연히 쿠팡=최저가).
- → 다나와에서 **robots를 엄격히 지키면 쿠팡 개별가+로켓을 깔끔히 얻기 어렵다.** 제안서의 "robots.txt 존중" 원칙과 충돌하는 정책 결정 지점.

**에누리 — robots 친화적(미완 검증)**
- `enuri.com/robots.txt`: `Allow: /`, `Crawl-delay: 1`, `ClaudeBot` 명시 허용. `/detail.jsp` 상품 페이지 허용. ajax 디스얼로우 없음.
- 검색·상세 페이지 HTTP 200 확인. 단 상세에서 쿠팡가가 SSR인지 허용된 ajax인지는 **정확한 상품 매칭으로 1회 더 검증 필요**(스파이크 중 제목 추출 실패로 엉뚱한 modelno를 잡아 미완).

**메커니즘 결론**: 순수 기술로는 **raw fetch + HTML 파서로 충분**(헤드리스/Akamai 우회 불필요). 남은 건 기술이 아니라 **robots 정책 결정** — §11로 이관.

## 5. 아키텍처 (메커니즘 무관 골격)

### 5.1 PriceSource 인터페이스 (스케치)

```ts
export type SourceId = "danawa" | "enuri" | "llm-websearch";

export interface SourceRef {        // 상품 × 소스마다 고정된 재조회 대상
  source: SourceId;
  refId: string | null;             // danawa pcode 등
  url: string;                      // 매일 재조회할 고정 URL
}

export interface SourcePriceResult {
  source: SourceId;
  status: "ok" | "blocked" | "not-listed" | "parse-error" | "empty";
  fetchedAt: string;                // ISO(UTC). KST는 표시 변환
  productName: string | null;
  modelName: string | null;
  coupang: { price: number; isRocket: boolean; url: string | null } | null;
  overallLowest: { price: number; mall: string; url: string | null } | null;
  raw?: unknown;                    // 감사/디버그
}

export interface PriceSource {
  id: SourceId;
  /** 최초 1회: 키워드/모델 → 후보 ref 목록 (사람이 확정) */
  resolve(q: { name: string; mustInclude: string[][]; minPrice: number }): Promise<SourceRef[]>;
  /** 매일: 고정 ref 재조회 */
  fetch(ref: SourceRef): Promise<SourcePriceResult>;
}
```

### 5.2 오케스트레이션 (collect.ts 교체 지점)

상품별로 **확정된 SourceRef**들을 우선순위대로(danawa → enuri → llm-websearch) 시도:
- `status === "ok"`이고 coupang/overallLowest 중 하나라도 있으면 채택, 종료.
- `status === "blocked"` → 로그 + 알림 큐에 적재 + 다음 소스로 폴백.
- `status === "not-listed"` (쿠팡 미편입) → 다음 소스. 모두 미편입이면 쿠팡가 `null`로 정상 저장.
- **현재 `research.ts`의 WebSearch 경로는 버리지 않고 `llm-websearch` 소스로 보존** → 스크래핑이 다 막혀도 가격선이 끊기지 않는 최종 폴백.

### 5.3 차단 감지

HTTP 403 / 응답 본문 캡차 키워드 / 빈 응답 / 기대 셀렉터 부재 → `status: "blocked" | "empty" | "parse-error"`. 소스 객체 내부에서 매핑하고, 오케스트레이터는 상태값만 보고 폴백/알림 판단.

## 6. 데이터 모델 변경

⚠️ **마이그레이션 주의**: `src/db/index.ts`는 기동 시 `schema.sql`을 `exec`하지만 전부 `CREATE TABLE IF NOT EXISTS`라 **기존 테이블에 컬럼을 추가하지 못한다.** 추가 컬럼/테이블은 `ALTER TABLE ADD COLUMN`을 **존재 여부 체크 후 1회 적용**하는 마이그레이션 단계가 필요하다(`node:sqlite`는 `ADD COLUMN IF NOT EXISTS` 미지원 → `PRAGMA table_info`로 가드).

신규 테이블 — 상품×소스 고정 ref(watchlist 핵심):
```sql
CREATE TABLE IF NOT EXISTS product_sources (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,            -- 'danawa' | 'enuri'
  ref_id     TEXT,                     -- pcode 등
  url        TEXT NOT NULL,
  confirmed  INTEGER NOT NULL DEFAULT 0, -- 사람이 확정했는지 (드리프트 방지)
  created_at TEXT NOT NULL,
  PRIMARY KEY (product_id, source)
);
```

`price_points` 추가 컬럼(ALTER):
```sql
ALTER TABLE price_points ADD COLUMN coupang_is_rocket INTEGER; -- 0/1/null
ALTER TABLE price_points ADD COLUMN lowest_mall TEXT;          -- 최저가 판매처
ALTER TABLE price_points ADD COLUMN source TEXT;               -- 사용된 소스
```
(쿠팡 URL/모델명 등 부가 메타는 필요 시 별도 컬럼 또는 listings 재활용)

## 7. watchlist / pcode 확정 흐름 (사람 검수 필수)

"최초 1회 키워드→pcode 확정"은 자동 매칭도 같은 드리프트 위험이 있다. 따라서:
1. 상품 추가/관리 UI에서 `resolve()`가 후보 pcode 목록(상품명·가격·썸네일)을 제시.
2. **사람이 정확한 pcode를 골라 `confirmed=1`로 저장** → 이후 매일은 이 ref만 재조회.
3. 확정 전(`confirmed=0`) 상품은 LLM/네이버 폴백으로만 수집(드리프트 가능성 표시).

frontend-engineer: 상품 관리 UI에 "소스 연결/pcode 확정" 단계 추가. backend: `/api/products/:id/sources` CRUD + resolve 프록시.

## 8. 수집 매너 (차단 예방 = 사이트 부하 예방)

- 저빈도: 하루 1~2회(현 09:00 단발 유지). 상품 간 **랜덤 지터** 2~5s.
- 소스별 **응답 캐시**(같은 날 재실행 시 재요청 안 함, 멱등).
- 현실적 User-Agent/Accept-Language 헤더, 에누리 crawl-delay 1s 준수.
- **로컬 전용 가드**: 사설/가정용 IP가 아니면(데이터센터 의심) 기동 시 경고 로그 — 사람 약속이 아니라 코드로.

## 9. 작업 분해 / 역할 배분

| # | 작업 | 담당 | 선행 |
|---|---|---|---|
| 0 | ✅ 검증 스파이크 → 메커니즘/소스/정책 확정 (§4·§11) | tech-lead | 완료 |
| 1 | `PriceSource` 인터페이스 + 오케스트레이터 폴백 + `research.ts`→`llm-websearch` 소스화 | pipeline | 0 |
| 2 | danawa/enuri 소스 구현(스파이크 결과 메커니즘) + 차단 감지 | pipeline | 1 |
| 3 | 스키마 마이그레이션(product_sources, price_points ALTER) + repo 함수 | pipeline | 1 |
| 4 | `/api/products/:id/sources` CRUD + resolve 프록시 + 응답에 쿠팡/로켓/판매처/소스 추가 | backend | 3 |
| 5 | 상품 관리 UI에 pcode 확정 단계 + 카드에 쿠팡 로켓/판매처/소스 배지 | frontend | 4 |
| 6 | E2E: resolve→확정→수집→저장→API→화면 + 차단 폴백 검증 | qa | 2-5 |

## 10. DoD / 실행 방법

- `npm run typecheck` 통과 + 로컬 동작 + 최소 테스트(소스 파서 단위 테스트, 차단 감지 분기).
- 실행: `npm run collect`(즉시 수집) / `curl -X POST localhost:7777/api/collect`.
- 스키마 변경 후 기존 DB에서 마이그레이션 멱등 적용 확인.

## 11. 결정 기록 (2026-06, 사용자 확정)

- **수집 메커니즘: raw fetch + HTML 파서.** 헤드리스/Akamai 우회 불필요(스파이크 검증).
- **1차 소스: 다나와.** 쿠팡 개별가+로켓을 `prod.danawa.com/info/ajax/getAllPriceCompareMallList.ajax.php`에서 추출(`cmpnyc=TP40F` 행). 폴백: 에누리 → LLM-WebSearch.
- **robots 정책: 실용 우선 — `/info/ajax/` 금지 경로 사용을 허용.** 근거: 개인용 단일 사용자, 저빈도(1~2회/일), 수집 데이터 비재배포. **단, robots가 막는 본질(사이트 부하)을 상쇄하기 위해 §8 매너 가드를 하드 요구사항으로 적용**(아래). 이 결정은 본 도구가 개인 로컬 용도에 한함을 전제로 하며, 다중 사용자/상업/클라우드로 확장 시 재검토 대상.
- **KST 저장 정책: `collected_at`는 ISO(UTC) 저장 유지 + 표시단에서 KST 변환.** 별도 KST 컬럼 불필요.

### §8 매너 — 하드 요구사항 (금지 경로 사용 대가)

금지 엔드포인트를 쓰는 만큼 부하 최소화는 선택이 아니라 필수다.
- **빈도 상한**: 상품×소스당 하루 최대 1회 네트워크 호출(같은 날 재실행은 캐시 hit, 절대 재요청 금지).
- **순차 + 지터**: 상품 간 직렬 처리 + 2~5s 랜덤 지연. 동시 요청 금지.
- **search 단계 Crawl-delay 10s 준수**, ajax/info는 최소 2s 간격.
- **현실적 헤더**: UA + `Accept-Language: ko-KR` + `Referer`(해당 pcode 페이지) + `X-Requested-With: XMLHttpRequest`.
- **로컬 전용 가드**: 사설/가정용 IP가 아니면 기동 시 경고 + ajax 소스 자동 비활성화(클라우드 차단·부하 급증 방지).
- **차단 감지 시 즉시 백오프**: 403/빈 응답/캡차 → 해당 소스 당일 스킵 + 알림.

### 후속 검증(선택, 비차단)

- 에누리 상세의 쿠팡가 노출 방식(SSR vs 허용 ajax) 1회 확인 → 폴백 파서 구현 시.
- 비전자/니치 상품의 쿠팡 누락률(현 표본은 전자제품 4/4 노출).

## 부록 A — 다나와 소스 참조 구현 레시피 (스파이크 실측, TS로 이식)

세 단계. 모두 일반 fetch로 HTTP 200 확인됨.

**1) 키워드 → pcode 해석 (최초 1회, 사람 확정용 후보 생성)**
```
GET https://search.danawa.com/dsearch.php?k1={URL인코딩 키워드}
헤더: User-Agent(데스크톱 크롬), Accept-Language: ko-KR,ko;q=0.9
파싱: /info/?pcode=(\d+) 와 인접 제목 추출 → mustInclude/mustExclude 매칭,
      "해외구매" 제외. (Crawl-delay 10s 준수)
```

**2) pcode 페이지 → cate 코드 + SSR 요약 최저가**
```
GET https://prod.danawa.com/info/?pcode={pcode}
정규식: cate1=(\d+) … cate4, productCode = '(\d+)'
요약 최저가(SSR): <span class="price lowest"><em class="prc_c">([\d,]+)</em>
```

**3) 판매처 목록 ajax → 쿠팡 행 추출 (핵심)**
```
POST https://prod.danawa.com/info/ajax/getAllPriceCompareMallList.ajax.php
헤더: + Referer: https://prod.danawa.com/info/?pcode={pcode}
      + X-Requested-With: XMLHttpRequest
      + Content-Type: application/x-www-form-urlencoded; charset=UTF-8
바디: pcode={pcode}&cate1=..&cate2=..&cate3=..&cate4=..&depth=4
쿠팡 행: 몰코드 cmpnyc=TP40F (로고 alt="쿠팡")
  가격: /cmpnyc=TP40F[^>]*?>.*?<em class="prc_c">([\d,]+)</em>/s  (DOTALL)
  로켓: 해당 쿠팡 행 블록 내 "로켓배송" 텍스트 (전체 body 아닌 행 단위로 스코프할 것)
전체 최저가/판매처: <span class="price lowest"> 가 붙은 행의 cmpnyc/로고 alt
```

⚠️ 구현 주의:
- `cmpnyc=TP40F`가 쿠팡 몰코드. **여러 행 중 prc_c가 여러 개**이므로 TP40F 링크에 가장 가까운 `prc_c`를 행 단위 블록으로 잘라 매칭(전역 첫 매치 금지).
- 로켓 판정은 body 전역 검색이 아니라 **쿠팡 행 DOM 블록 내부**로 한정(오탐 방지).
- 차단 감지: HTTP≠200 / body 길이 비정상 / `defaultMallList` 셀렉터 부재 / 캡차 키워드 → `status: blocked`.
