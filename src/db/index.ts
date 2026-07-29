import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db: DatabaseSync | null = null;

/** 싱글턴 DB 핸들. 최초 호출 시 디렉터리 생성 + 스키마 마이그레이션. */
export function db(): DatabaseSync {
  if (_db) return _db;
  const dir = path.dirname(config.dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const conn = new DatabaseSync(config.dbPath);
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec("PRAGMA foreign_keys = ON;");
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  conn.exec(schema);
  migrate(conn);
  _db = conn;
  return conn;
}

/**
 * 멱등 ALTER 마이그레이션.
 * schema.sql 은 전부 CREATE TABLE IF NOT EXISTS 라 기존 테이블에 컬럼을 추가하지 못한다.
 * node:sqlite 는 ADD COLUMN IF NOT EXISTS 미지원 → PRAGMA table_info 로 컬럼 존재를 확인 후
 * 없을 때만 1회 ALTER 한다(여러 번 호출해도 안전).
 */
function migrate(conn: DatabaseSync): void {
  const priceCols = (): Set<string> =>
    new Set(
      (conn.prepare("PRAGMA table_info(price_points)").all() as Array<{ name: string }>).map(
        (r) => r.name
      )
    );
  const cols = priceCols();
  const adds: Array<[string, string]> = [
    ["lowest_mall", "TEXT"], // 전체 최저가 판매처
    ["source", "TEXT"], // 채택된 소스 (danawa|enuri)
    ["lowest_url", "TEXT"], // 종합 최저가가 적힌 페이지 링크 (표시가/착지가 불일치 방지)
  ];
  for (const [name, type] of adds) {
    if (!cols.has(name)) {
      conn.exec(`ALTER TABLE price_points ADD COLUMN ${name} ${type}`);
    }
  }

  // 쿠팡 수집 제거(2026-07-28): 컬럼과 과거 값을 통째로 드롭한다.
  // DROP COLUMN 은 SQLite 3.35+ (node:sqlite 번들은 3.5x) 지원. PK/인덱스에 포함된 컬럼이
  // 아니므로 안전하다. ADD 루프와 달리 '있을 때만' 실행해야 두 번째 기동에서 에러가 안 난다.
  for (const dead of ["coupang_lowest", "coupang_is_rocket"]) {
    if (priceCols().has(dead)) {
      conn.exec(`ALTER TABLE price_points DROP COLUMN ${dead}`);
    }
  }

  // 로또 실험: '실험 반복'(초기화 없이 전체 회차를 다시 도는 기능) 도입으로 예측 표의 PK 가
  // round → (run, round) 로 바뀌었다. SQLite 는 PK 를 ALTER 로 못 바꾸므로 표를 다시 만든다.
  // 기존 행은 전부 run=1 로 옮긴다(첫 바퀴였으므로 사실과 일치한다).
  const predCols = new Set(
    (conn.prepare("PRAGMA table_info(lotto_predictions)").all() as Array<{ name: string }>).map(
      (r) => r.name
    )
  );
  if (predCols.size > 0 && !predCols.has("run")) {
    conn.exec(`
      ALTER TABLE lotto_predictions RENAME TO lotto_predictions_old;
      CREATE TABLE lotto_predictions (
        run          INTEGER NOT NULL DEFAULT 1,
        round        INTEGER NOT NULL REFERENCES lotto_draws(round) ON DELETE CASCADE,
        version      INTEGER NOT NULL,
        sets_json    TEXT NOT NULL,
        matches_json TEXT NOT NULL,
        score        INTEGER NOT NULL,
        cum_score    INTEGER NOT NULL,
        scored_at    TEXT NOT NULL,
        PRIMARY KEY (run, round)
      );
      INSERT INTO lotto_predictions (run, round, version, sets_json, matches_json, score, cum_score, scored_at)
        SELECT 1, round, version, sets_json, matches_json, score, cum_score, scored_at FROM lotto_predictions_old;
      DROP TABLE lotto_predictions_old;
      CREATE INDEX IF NOT EXISTS idx_lotto_pred_version ON lotto_predictions(version);
    `);
  }

  // (run, round) 인덱스는 **여기서** 만든다. schema.sql 에 두면 run 컬럼이 없는 옛 표가 남은
  // DB 에서 부팅이 통째로 죽는다(위 블록이 돌기 전에 실행되기 때문). 이 지점은 표가 새로
  // 만들어졌든 위에서 재작성됐든 컬럼 존재가 보장된다.
  if (conn.prepare("PRAGMA table_info(lotto_predictions)").all().length > 0) {
    conn.exec("CREATE INDEX IF NOT EXISTS idx_lotto_pred_run ON lotto_predictions(run, round)");
  }

  // lotto_strategies.run: PK 를 건드리지 않으므로 단순 ADD 로 충분하다.
  const stratCols = new Set(
    (conn.prepare("PRAGMA table_info(lotto_strategies)").all() as Array<{ name: string }>).map(
      (r) => r.name
    )
  );
  if (stratCols.size > 0 && !stratCols.has("run")) {
    conn.exec("ALTER TABLE lotto_strategies ADD COLUMN run INTEGER NOT NULL DEFAULT 1");
  }

  // products.sort_order: 기존 DB엔 컬럼이 없으므로 1회 ADD 후 id 순서로 백필.
  // (백필로 기존 카드 표시 순서가 종전(id 오름차순)과 동일하게 유지된다.)
  const productCols = new Set(
    (conn.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>).map(
      (r) => r.name
    )
  );
  if (!productCols.has("sort_order")) {
    conn.exec("ALTER TABLE products ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
    conn.exec("UPDATE products SET sort_order = id");
  }
}

/** 테스트/재시작용 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
