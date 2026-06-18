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
  _db = conn;
  return conn;
}

/** 테스트/재시작용 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
