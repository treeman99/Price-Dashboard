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
  coupang_lowest INTEGER,
  danawa_lowest  INTEGER,
  avg_price      INTEGER,
  overall_lowest INTEGER,
  lowest_source  TEXT NOT NULL DEFAULT '',
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
  detail      TEXT,                      -- JSON: { notified: { email, imessage }, ... }
  PRIMARY KEY (date, market)
);

CREATE INDEX IF NOT EXISTS idx_stock_points_date ON stock_points(date);
