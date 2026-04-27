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

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  project TEXT,
  provider TEXT,
  model TEXT,
  record_type TEXT NOT NULL,
  source_type TEXT NOT NULL,
  usage_semantics TEXT NOT NULL DEFAULT 'delta',
  usage_time TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  tool_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL,
  raw_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_usage_summary (
  session_id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  project TEXT,
  provider TEXT,
  model TEXT,
  usage_status TEXT NOT NULL DEFAULT 'unavailable',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  tool_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL,
  record_count INTEGER NOT NULL DEFAULT 0,
  last_usage_time TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  message_id UNINDEXED,
  session_id UNINDEXED,
  role,
  content
);
`);

try {
  db.exec(`ALTER TABLE usage_records ADD COLUMN usage_semantics TEXT NOT NULL DEFAULT 'delta'`);
} catch {
  // Column may already exist.
}

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

db.exec(`
CREATE INDEX IF NOT EXISTS idx_usage_records_session_id ON usage_records(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_usage_time ON usage_records(usage_time);
CREATE INDEX IF NOT EXISTS idx_usage_records_tool ON usage_records(tool);
CREATE INDEX IF NOT EXISTS idx_session_usage_summary_tool ON session_usage_summary(tool);
CREATE INDEX IF NOT EXISTS idx_session_usage_summary_total_tokens ON session_usage_summary(total_tokens);
`);

export function nowIso(): string {
  return new Date().toISOString();
}

export function getDbPath(): string {
  return dbPath;
}
