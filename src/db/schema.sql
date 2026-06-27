-- 관심 물건
CREATE TABLE IF NOT EXISTS products (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  must_include TEXT NOT NULL DEFAULT '[]', -- JSON array
  must_exclude TEXT NOT NULL DEFAULT '[]', -- JSON array
  min_price    INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1, -- 0/1 (soft delete)
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

-- 수집 실행 로그 (catch-up 판단/감사용)
CREATE TABLE IF NOT EXISTS collect_runs (
  date        TEXT PRIMARY KEY,  -- YYYY-MM-DD, 하루 1행 (멱등)
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok          INTEGER NOT NULL DEFAULT 0,
  detail      TEXT               -- JSON: CollectResult
);

CREATE INDEX IF NOT EXISTS idx_price_points_date ON price_points(date);
