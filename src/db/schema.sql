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
  status      TEXT NOT NULL,              -- 'sent'|'queued'|'dup'|'capped'|'below'|'failed'
  created_at  TEXT NOT NULL,              -- ISO datetime
  sent_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_pulse_fp ON stock_pulse_alerts(fingerprint, created_at);
CREATE INDEX IF NOT EXISTS idx_pulse_date ON stock_pulse_alerts(date, status);
CREATE INDEX IF NOT EXISTS idx_pulse_created ON stock_pulse_alerts(created_at);
