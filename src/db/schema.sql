-- 관심 물건
CREATE TABLE IF NOT EXISTS products (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  must_include TEXT NOT NULL DEFAULT '[]', -- JSON array
  must_exclude TEXT NOT NULL DEFAULT '[]', -- JSON array
  min_price    INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1, -- 0/1 (soft delete)
  sort_order   INTEGER NOT NULL DEFAULT 0, -- 대시보드 카드 표시 순서(오름차순)
  created_at   TEXT NOT NULL
);

-- 하루치 가격 스냅샷 (하루 1회분만 유지: (product_id, date) UNIQUE → upsert)
CREATE TABLE IF NOT EXISTS price_points (
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  date           TEXT NOT NULL,            -- YYYY-MM-DD
  naver_lowest   INTEGER,
  danawa_lowest  INTEGER,
  avg_price      INTEGER,
  overall_lowest INTEGER,
  lowest_source  TEXT NOT NULL DEFAULT '',
  lowest_url     TEXT,                     -- 종합 최저가가 실제로 적힌 페이지 링크
  collected_at   TEXT,                     -- ISO datetime
  PRIMARY KEY (product_id, date)
);

-- 당일 Top3 후보 (날짜별 덮어쓰기)
CREATE TABLE IF NOT EXISTS listings (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  rank       INTEGER NOT NULL,
  mall       TEXT NOT NULL,
  price      INTEGER NOT NULL,
  link       TEXT,
  PRIMARY KEY (product_id, date, rank)
);

-- 당일 리뷰 (날짜별 덮어쓰기)
CREATE TABLE IF NOT EXISTS reviews (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  source     TEXT NOT NULL,
  review_date TEXT,
  summary    TEXT NOT NULL,
  rating     REAL,
  link       TEXT,
  PRIMARY KEY (product_id, date, idx)
);

-- 상품 × 소스 고정 ref (watchlist 핵심, pcode 드리프트 방지)
CREATE TABLE IF NOT EXISTS product_sources (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,              -- 'danawa' | 'enuri' | 'llm-websearch'
  ref_id     TEXT,                       -- pcode 등 (LLM은 null)
  url        TEXT NOT NULL,
  confirmed  INTEGER NOT NULL DEFAULT 0, -- 사람이 확정했는지 (1이어야 매일 재조회)
  created_at TEXT NOT NULL,
  PRIMARY KEY (product_id, source)
);

-- 소스별 당일 fetch 캐시 (§11 하드요구사항: 상품×소스당 하루 1회 네트워크 절대 금지)
-- PK (product_id, source, date): 같은 날 재실행 시 캐시 hit → 소스 재호출 없음.
-- 모든 터미널 상태(ok/blocked/not-listed/parse-error/empty)를 캐시 — 실패도 당일 재요청 금지.
CREATE TABLE IF NOT EXISTS source_fetch_cache (
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,    -- 'danawa' | 'enuri' | 'llm-websearch'
  date        TEXT NOT NULL,    -- YYYY-MM-DD
  status      TEXT NOT NULL,
  result_json TEXT NOT NULL,    -- JSON(SourcePriceResult)
  fetched_at  TEXT NOT NULL,    -- ISO datetime
  PRIMARY KEY (product_id, source, date)
);

-- 수집 실행 로그 (catch-up 판단/감사용)
CREATE TABLE IF NOT EXISTS collect_runs (
  date        TEXT PRIMARY KEY,  -- YYYY-MM-DD, 하루 1행 (멱등)
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok          INTEGER NOT NULL DEFAULT 0,
  detail      TEXT               -- JSON: CollectResult
);

CREATE INDEX IF NOT EXISTS idx_price_points_date ON price_points(date);

-- ── 증시 브리핑 ──

-- 관심 종목 (products 의 active/sort_order 관례 그대로)
-- 자연키가 name 이 아니라 (market, symbol) 인 점에 주의: 같은 이름의 한/미 종목이 공존 가능.
CREATE TABLE IF NOT EXISTS stocks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  market     TEXT NOT NULL,              -- 'kr' | 'us'
  symbol     TEXT NOT NULL,              -- '005930' | 'AAPL' (정규화 후 저장)
  name       TEXT NOT NULL,              -- 표시명(한국어 우선): '삼성전자' | '애플'
  quote_code TEXT NOT NULL,              -- 네이버 조회용: '005930' | 'AAPL.O'
  exchange   TEXT NOT NULL DEFAULT '',   -- '코스피' | '나스닥 증권거래소'
  pinned     INTEGER NOT NULL DEFAULT 0, -- 1이면 20일 차트 + 상세 분석 첨부
  active     INTEGER NOT NULL DEFAULT 1, -- 0/1 (soft delete)
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (market, symbol)
);

-- 일별 종가 시계열.
-- ⚠️ date = **거래소 로컬 거래일**이지 수집일이 아니다. 미국장을 KST 수집일로 키잉하면
--    뉴욕 전일 종가가 KST 오늘로 들어가 20일 차트 x축이 하루씩 밀린다.
-- 하루 2회 수집해도 거래일이 키라 충돌하지 않는다. 같은 거래일 재수집 = 정정 종가 반영(upsert).
CREATE TABLE IF NOT EXISTS stock_points (
  stock_id     INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,            -- YYYY-MM-DD (거래소 로컬 거래일)
  close        REAL,
  prev_close   REAL,
  change_pct   REAL,
  volume       INTEGER,
  currency     TEXT NOT NULL DEFAULT 'KRW',
  source       TEXT NOT NULL DEFAULT '', -- 'naver'
  collected_at TEXT,                     -- ISO datetime
  PRIMARY KEY (stock_id, date)
);

-- 시장 × 수집일 1행. 알림 멱등(중복 발송 차단) — collect_runs 와 동형.
-- ⚠️ 여기의 date 는 **서버 로컬 수집일**(KST). stock_points.date 와 의미가 다르다.
CREATE TABLE IF NOT EXISTS stock_runs (
  date        TEXT NOT NULL,             -- YYYY-MM-DD (로컬 수집일)
  market      TEXT NOT NULL,             -- 'kr' | 'us'
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok          INTEGER NOT NULL DEFAULT 0,
  -- JSON: { notifiedBySlot: { "08:00": { email, imessage }, ... }, ... }
  -- ⚠️ 알림 멱등 키는 (date, market, **슬롯 시각**) 이다. 하루 복수 슬롯을 지원해야 하는데
  -- SQLite 는 PK 를 ALTER 로 못 바꾸고 migrate() 에 테이블 재작성 전례가 없어,
  -- 슬롯 차원을 이 자유형 JSON 안에 맵으로 둔다(상세: src/stock/notify-ledger.ts).
  detail      TEXT,
  PRIMARY KEY (date, market)
);

CREATE INDEX IF NOT EXISTS idx_stock_points_date ON stock_points(date);

-- ── 보유 종목 (한국장·미국장과 별도 탭) ──
--
-- stocks 와 분리한 이유: stocks 는 '지켜보는 종목'이고 여기는 '실제 포지션'이라 수명이 다르다.
-- 다 팔아도 계속 지켜보고 싶은 종목이 있고, 그때 stocks 행까지 지워지면 시계열이 끊긴다.
-- 대신 보유 등록 시 stocks 에 자동으로 행을 만든다(src/stock/holdings.ts) — 중복 입력 제거.
--
-- ⚠️ 시세는 이 표에 저장하지 않는다. 현재가·손익률은 조회 시점마다 계산한다
--    (캐시하면 화면과 실제가 언제 갈라졌는지 알 수 없다).
CREATE TABLE IF NOT EXISTS stock_holdings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  market       TEXT NOT NULL,              -- 'kr' | 'us'
  symbol       TEXT NOT NULL,              -- 정규화 후 저장 (stocks 와 같은 규칙)
  name         TEXT NOT NULL,
  quote_code   TEXT NOT NULL,
  exchange     TEXT NOT NULL DEFAULT '',
  quantity     REAL NOT NULL,              -- 소수점 매수가 있으므로 REAL
  avg_price    REAL NOT NULL,
  target_price REAL,                       -- null = 미입력 (0 과 반드시 구분할 것)
  stop_price   REAL,
  horizon      TEXT NOT NULL DEFAULT 'mid',-- 'short' | 'mid' | 'long'
  memo         TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1, -- 0/1 (soft delete)
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (market, symbol)
);

-- ── 펄스 알림 원장 ──
--
-- 표 하나가 네 가지 일을 한다. 쪼개지 않은 이유는 넷이 전부 '같은 판정 목록'의 다른 질의라서다:
--   1) 중복 억제 — fingerprint 로 최근 24시간 조회
--   2) 상한      — date + status='sent' 로 종목별/전체 집계
--   3) 야간 큐   — status='queued' 조회 후 07:00 에 묶음 발송
--   4) 일일 요약 — 최근 24시간 전체(문턱 미달 'below' 포함). 화면·이메일이 없으므로
--                 문턱 미달 건이 사용자에게 도달하는 **유일한 경로**다.
CREATE TABLE IF NOT EXISTS stock_pulse_alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL,
  date        TEXT NOT NULL,              -- YYYY-MM-DD (로컬 발생일 = 상한 집계 단위)
  slot        TEXT NOT NULL,              -- 'HH:mm' 이 판정을 만든 펄스 실행 시각
  symbol      TEXT,                       -- null = 거시·섹터 (별도 상한을 탄다)
  market      TEXT,
  severity    TEXT NOT NULL,              -- 'urgent' | 'important' | 'info'
  trigger     TEXT NOT NULL,              -- 'person' | 'company' | 'macro'
  headline    TEXT NOT NULL,              -- 유사도 판정용으로 컬럼에 꺼내 둔다
  impact_json TEXT NOT NULL,              -- JSON(PulseImpact) 전문
  status      TEXT NOT NULL,              -- 'sent'|'queued'|'dup'|'capped'|'below'|'failed'|'muted'
  created_at  TEXT NOT NULL,              -- ISO datetime
  sent_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_pulse_fp ON stock_pulse_alerts(fingerprint, created_at);
CREATE INDEX IF NOT EXISTS idx_pulse_date ON stock_pulse_alerts(date, status);
CREATE INDEX IF NOT EXISTS idx_pulse_created ON stock_pulse_alerts(created_at);

-- ── 로또 예측 ──
--
-- 다른 탭과 성격이 다르다. 나머지는 '오늘의 상태'를 수집하지만 여기는 **되돌아볼 수 있는 예측
-- 기록**이라 과거 행을 절대 덮어쓰지 않는다. 회차 r 의 예측이 r-1 회차까지의 정보만으로,
-- 그것도 **추첨 전에** 만들어졌다는 것이 이 기록의 유일한 성립 조건이고, 그 증거가 아래 네 표의
-- append-only 성질이다(lotto_upcoming 만 예외 — 채점되면 predictions 로 옮겨지고 비워진다).

-- 동행복권 회차 원본. 채점의 정답지이자, 예측 시점에 '읽을 수 있었던 과거'의 원천이다.
-- 회차는 불변이므로 재수집해도 값이 바뀔 일이 없다(정정 사례 없음) → PK 충돌 시 무시한다.
CREATE TABLE IF NOT EXISTS lotto_draws (
  round      INTEGER PRIMARY KEY,      -- 회차 (1 = 2002-12-07)
  draw_date  TEXT NOT NULL,            -- YYYY-MM-DD
  n1         INTEGER NOT NULL,
  n2         INTEGER NOT NULL,
  n3         INTEGER NOT NULL,
  n4         INTEGER NOT NULL,
  n5         INTEGER NOT NULL,
  n6         INTEGER NOT NULL,
  bonus      INTEGER NOT NULL,
  fetched_at TEXT NOT NULL
);

-- 전략 세대. 주간 사이클이 새 추첨 결과를 채점한 뒤 에이전트가 한 행을 추가한다
-- (= 한 주에 한 세대. version 1 은 무작위 시드 세대).
-- spec_json 은 엔진이 해석하는 선언형 사양이다 — 코드 문자열이 아니다(eval 금지).
CREATE TABLE IF NOT EXISTS lotto_strategies (
  version    INTEGER PRIMARY KEY,      -- 1부터 증가. **반복(run)을 넘어서도 계속 증가한다**
  run        INTEGER NOT NULL DEFAULT 1, -- 이 세대가 만들어진 반복 회차
  from_round INTEGER NOT NULL,         -- 이 세대가 적용되기 시작한 회차
  spec_json  TEXT NOT NULL,            -- JSON(LottoStrategySpec)
  rationale  TEXT NOT NULL DEFAULT '', -- 에이전트가 남긴 근거
  hypothesis TEXT NOT NULL DEFAULT '', -- 검증 가능한 형태의 가설
  author     TEXT NOT NULL,            -- 'seed' | 'agent'
  model      TEXT NOT NULL DEFAULT '', -- 제안한 모델 ID
  created_at TEXT NOT NULL
);

-- 회차별 채점 결과. cum_score 를 저장해 두는 이유는 1200행을 매 조회마다 누적 계산하지
-- 않기 위해서가 아니라(그건 싸다), **중간에 회차를 건너뛰지 않았다는 증거**로 쓰기 위해서다.
-- ⚠️ PK 가 (run, round) 인 이유: (구)'실험 반복'이 1회차부터 몇 바퀴씩 다시 예측했고, round 만
-- PK 면 이전 바퀴의 기록을 덮어써 비교가 불가능했다. 반복 기능은 2026-07-30 에 제거됐지만
-- 그 시절의 8바퀴 기록이 그대로 남아 있어 PK 는 유지한다. 라이브 예측은 **마지막 바퀴(run)를
-- 이어서** 쌓으므로 run 은 더 이상 증가하지 않는다.
CREATE TABLE IF NOT EXISTS lotto_predictions (
  run          INTEGER NOT NULL DEFAULT 1,
  round        INTEGER NOT NULL REFERENCES lotto_draws(round) ON DELETE CASCADE,
  version      INTEGER NOT NULL,       -- 이 회차에 적용된 전략 세대
  sets_json    TEXT NOT NULL,          -- JSON: number[10][6]
  matches_json TEXT NOT NULL,          -- JSON: number[10]
  score        INTEGER NOT NULL,       -- 회차 점수 (-60 ~ +60)
  cum_score    INTEGER NOT NULL,       -- 이 반복의 1회차부터의 누적
  scored_at    TEXT NOT NULL,
  PRIMARY KEY (run, round)
);

CREATE INDEX IF NOT EXISTS idx_lotto_pred_version ON lotto_predictions(version);

-- **다음 회차 추천 번호(추첨 전).** 항상 0행 또는 1행이다.
--
-- ⚠️ lotto_predictions 에 미리 넣을 수 없다. 그 표는 round 가 lotto_draws 를 참조하는데
-- 아직 추첨되지 않은 회차는 lotto_draws 에 없다(FK 위반). 게다가 cursor 를 그 표에서
-- 유도하므로 미채점 행이 섞이면 커서가 회차를 건너뛴다. 그래서 별도 표를 둔다.
--
-- 이 표가 없으면 "추천했던 번호와 실제 추첨 결과를 비교"가 성립하지 않는다 — 화면을 열 때마다
-- 번호를 다시 뽑으면 다음 주에 채점할 대상이 매번 달라지기 때문이다(2026-07-30 전환 전의 버그).
CREATE TABLE IF NOT EXISTS lotto_upcoming (
  round      INTEGER PRIMARY KEY,      -- 아직 추첨되지 않은 회차
  run        INTEGER NOT NULL,         -- 채점될 때 들어갈 예측 스코프
  version    INTEGER NOT NULL,         -- 이 번호를 뽑은 전략 세대
  sets_json  TEXT NOT NULL,            -- JSON: number[10][6]
  created_at TEXT NOT NULL
);
-- ⚠️ (run, round) 인덱스는 여기 두면 안 된다. schema.sql 은 migrate() **이전**에 실행되는데,
-- run 컬럼이 없는 옛 표가 남아 있는 DB 에서는 이 CREATE INDEX 가 "no such column: run" 으로
-- 터지고 그 순간 서버 부팅 자체가 죽는다(실측 2026-07-29). 표를 다시 만든 직후,
-- 즉 컬럼 존재가 보장된 시점에 migrate() 안에서 만든다.

-- ── 스킬 랭킹 (GitHub agent-skills 저장소 주간 추적) ──
--
-- 이 세 표가 존재하는 이유는 하나다: **GitHub 이 과거 star 수를 주지 않는다.**
-- 2026-09-01 실측 — REST `/repos/{o}/{r}/stargazers` + `Accept: …star+json` 은 인증해도 404,
-- GraphQL `stargazers(last:100){starredAt}` 은 stargazerCount 만 주고 totalCount:0 · edges 빈 배열.
-- 그래서 "이번 주에 얼마나 늘었나"는 우리가 매주 남긴 스냅샷을 **직접 차분**해야만 나온다
-- (근거 전문은 shared/skills.ts 머리말).
--
-- ⚠️ 조인 키는 full_name 이 아니라 GitHub 저장소 고유 **id**(정수)다. 이름이 바뀌어도
--    증가분이 끊기면 안 된다 — 이름으로 조인하면 리네임된 저장소가 매주 '신규'로 둔갑한다.

-- 저장소 신원(주간마다 최신값으로 덮어쓴다). 값이 변하는 지표는 여기 두지 않는다.
CREATE TABLE IF NOT EXISTS skill_repos (
  id          INTEGER PRIMARY KEY,   -- GitHub repository id (불변)
  full_name   TEXT NOT NULL,         -- "anthropics/skills" (리네임되면 갱신된다)
  owner       TEXT NOT NULL,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  description TEXT,                  -- 설명을 안 적은 저장소가 실제로 있다 → NULL 허용
  language    TEXT,
  license     TEXT,                  -- SPDX id ("MIT"). 미표기 저장소가 있다 → NULL 허용
  topics      TEXT,                  -- JSON 배열 문자열
  created_at  TEXT,                  -- 저장소 생성 시각(ISO)
  first_seen  TEXT NOT NULL          -- 우리가 처음 관측한 시각(ISO). upsert 시 유지된다
);

-- 주간 스냅샷 1행 = (저장소, 그 주 관측값). **이 표가 증가 랭킹의 유일한 근거다.**
-- PK 가 (repo_id, date) 라 같은 날 두 번 돌려도 값만 덮이고 행이 늘지 않는다(멱등).
CREATE TABLE IF NOT EXISTS skill_repo_points (
  repo_id     INTEGER NOT NULL,
  date        TEXT NOT NULL,         -- YYYY-MM-DD (로컬). 주간 스냅샷 날짜
  stars       INTEGER NOT NULL,
  forks       INTEGER,
  watchers    INTEGER,
  open_issues INTEGER,
  pushed_at   TEXT,
  archived    INTEGER,               -- 0/1
  PRIMARY KEY (repo_id, date)
);

-- 차분은 "직전 date 를 찾아 조인"이라 date 단독 조회가 뜨거운 경로다.
CREATE INDEX IF NOT EXISTS idx_skill_points_date ON skill_repo_points(date);

-- LLM 한국어 요약 캐시.
--
-- ★ source_hash 가 이 표의 존재 이유다. 매주 상위 100건을 무조건 재요약하면 원문이 한 글자도
--   안 바뀐 저장소까지 LLM 을 다시 태운다 — 순수 낭비다. 요약의 입력(저장소 이름 + 원문
--   description)을 해싱해 두고, 해시가 같으면 건너뛴다.
CREATE TABLE IF NOT EXISTS skill_summaries (
  repo_id     INTEGER PRIMARY KEY,
  summary     TEXT NOT NULL,
  source_hash TEXT,                  -- 요약의 입력이 된 원문 해시(sha256 hex)
  updated_at  TEXT NOT NULL
);

-- 네트워크 접근 스캔 캐시 (SkillRepo.access / .units 의 원본).
--
-- ★ pushed_at 이 이 표의 존재 이유다. 파일 목록을 얻는 `git/trees` 호출은 스캔 전체에서
--   **유일하게 core 쿼터를 소비하는 지점**이고, 그 쿼터는 무인증 60회/시간뿐이다(이 집은
--   GITHUB_TOKEN 없이 돈다). 노출 후보가 매주 100건 안팎이라 캐시 없이는 첫 주부터 창을
--   넘긴다. 저장소의 마지막 푸시가 지난주와 같으면 파일도 같으므로 다시 조회하지 않는다.
--   (첫 회차만 50회 남짓 쓰고, 그 뒤로는 그 주에 실제로 푸시된 저장소만 조회한다.)
--
-- ★★ 캐시 무효화 키는 **두 개**다: `pushed_at` 과 `sig_version`.
--    pushed_at 만 보던 시절, 스캐너의 신호 정의를 고쳐도 그 저장소가 다시 푸시될 때까지
--    옛 판정이 그대로 나왔다 — 즉 **신호를 고치는 일 자체가 라이브에 반영되지 않았다.**
--    (실제로 원격 MCP 스킬 864개짜리 저장소가 🔒 로컬 로 굳어 있었다.)
--    지금은 src/skills/scan.ts 의 SCAN_SIGNATURE_VERSION 을 함께 저장하고, 값이 다르면
--    캐시를 무시하고 다시 스캔한다. 그 값은 신호표의 sha256 을 포함하므로 사람이 버전을
--    올리는 걸 잊어도 저절로 갈린다.
--
-- ⚠️ kind="unknown" 은 **저장하지 않는다.** '모른다'를 캐시하면 그 주의 일시적 실패가
--    다음 주까지 굳어 버린다 — 실패는 다음 회차에 다시 시도해야 한다(호출부 saveRepoScan).
CREATE TABLE IF NOT EXISTS skill_scans (
  repo_id     INTEGER PRIMARY KEY,
  pushed_at   TEXT,                 -- 스캔 당시의 저장소 마지막 푸시(ISO). 캐시 무효화 키 ①
  sig_version TEXT,                 -- 그때의 신호 정의 버전. 캐시 무효화 키 ②
  scanned_at  TEXT,                 -- 우리가 스캔한 시각(ISO)
  kind        TEXT,                 -- SkillAccessKind
  total       INT,                  -- 트리 기준 SKILL.md 총 개수
  checked     INT,                  -- 실제로 읽어 검사한 개수 (< total 이면 표본이다)
  network     INT,                  -- 그중 네트워크 신호가 나온 개수
  signals     TEXT,                 -- JSON 배열: 발견된 신호 종류
  units       TEXT                  -- JSON 배열: SkillUnit[] (펼쳐보기 목록)
);
