import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const baseDir = process.env.CHAT_ARCHIVE_HOME ?? path.join(os.homedir(), ".chat-archive");
fs.mkdirSync(baseDir, { recursive: true });

const dbPath = path.join(baseDir, "chat-archive.db");
export const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  source_path TEXT NOT NULL,
  project TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  duration_sec INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  summary_provider TEXT NOT NULL DEFAULT 'rule',
  summary_status TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  ts TEXT NOT NULL,
  content TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  seq_in_session INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ingest_state (
  source_path TEXT PRIMARY KEY,
  last_mtime_ms INTEGER NOT NULL,
  last_size INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  message_id UNINDEXED,
  session_id UNINDEXED,
  role,
  content
);
`);

try {
  db.exec(`ALTER TABLE sessions ADD COLUMN summary_provider TEXT NOT NULL DEFAULT 'rule'`);
} catch {
  // Column may already exist.
}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN summary_status TEXT NOT NULL DEFAULT ''`);
} catch {
  // Column may already exist.
}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN session_purpose TEXT NOT NULL DEFAULT ''`);
} catch {
  // Column may already exist.
}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN session_target TEXT NOT NULL DEFAULT ''`);
} catch {
  // Column may already exist.
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function getDbPath(): string {
  return dbPath;
}
