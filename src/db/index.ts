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
  const cols = new Set(
    (conn.prepare("PRAGMA table_info(price_points)").all() as Array<{ name: string }>).map(
      (r) => r.name
    )
  );
  const adds: Array<[string, string]> = [
    ["coupang_is_rocket", "INTEGER"], // 0/1/null
    ["lowest_mall", "TEXT"], // 전체 최저가 판매처
    ["source", "TEXT"], // 채택된 소스 (danawa|enuri|llm-websearch)
  ];
  for (const [name, type] of adds) {
    if (!cols.has(name)) {
      conn.exec(`ALTER TABLE price_points ADD COLUMN ${name} ${type}`);
    }
  }
}

/** 테스트/재시작용 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
