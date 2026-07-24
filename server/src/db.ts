import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { realProjectName } from "./session-target.js";

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
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN session_outcome TEXT NOT NULL DEFAULT ''`);
} catch {
  // Column may already exist.
}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN keywords_json TEXT NOT NULL DEFAULT '[]'`);
} catch {
  // Column may already exist.
}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN entities_json TEXT NOT NULL DEFAULT '[]'`);
} catch {
  // Column may already exist.
}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 1`);
} catch {
  // Column may already exist.
}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN summary_content_hash TEXT NOT NULL DEFAULT ''`);
} catch {
  // Column may already exist.
}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN summary_model TEXT NOT NULL DEFAULT ''`);
} catch {
  // Column may already exist.
}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN summary_prompt_version INTEGER NOT NULL DEFAULT 1`);
} catch {
  // Column may already exist.
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_usage_records_session_id ON usage_records(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_usage_time ON usage_records(usage_time);
CREATE INDEX IF NOT EXISTS idx_usage_records_tool ON usage_records(tool);
CREATE INDEX IF NOT EXISTS idx_session_usage_summary_tool ON session_usage_summary(tool);
CREATE INDEX IF NOT EXISTS idx_session_usage_summary_total_tokens ON session_usage_summary(total_tokens);
CREATE INDEX IF NOT EXISTS idx_sessions_summary_cache ON sessions(summary_content_hash, summary_model, summary_prompt_version);
CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions(start_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_end_time ON sessions(end_time DESC, start_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_tool_start_time ON sessions(tool, start_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_tool_end_time ON sessions(tool, end_time DESC, start_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session_role ON messages(session_id, role);
CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq_in_session);
`);

const cachedStatusPrefixes = /^(?:(?:cache_non_rule|cache_hit|cache_remote_expired|cache_inactive):)+/i;
const pollutedStatuses = db
  .prepare(
    `SELECT id, summary_status, summary_provider
     FROM sessions
     WHERE summary_status LIKE 'cache_non_rule:%'
        OR summary_status LIKE 'cache_hit:%'
        OR summary_status LIKE 'cache_remote_expired:%'
        OR summary_status LIKE 'cache_inactive:%'`
  )
  .all() as Array<{ id: string; summary_status: string; summary_provider: string }>;
if (pollutedStatuses.length > 0) {
  const updateStatus = db.prepare("UPDATE sessions SET summary_status = ? WHERE id = ?");
  const cleanStatuses = db.transaction(
    (rows: Array<{ id: string; summary_status: string; summary_provider: string }>) => {
      for (const row of rows) {
        const cleaned = row.summary_status.replace(cachedStatusPrefixes, "");
        const fallback = row.summary_provider === "rule" ? "rule_only" : `${row.summary_provider}_ok`;
        updateStatus.run(cleaned || fallback, row.id);
      }
    }
  );
  cleanStatuses(pollutedStatuses);
}

// Backfill: when a session maps to a real project repo, the target ("对象")
// should be the project name rather than whatever the summarizer guessed. This
// is idempotent — after the first run every row already holds the project name,
// so subsequent boots skip the UPDATE. New/changed sessions are corrected at
// ingest time, this only fixes pre-existing rows in place.
const targetBackfillRows = db
  .prepare("SELECT id, project, session_target FROM sessions WHERE project IS NOT NULL AND project <> ''")
  .all() as Array<{ id: string; project: string; session_target: string }>;
const targetBackfillCandidates = targetBackfillRows
  .map((row) => ({ id: row.id, target: realProjectName(row.project), current: (row.session_target ?? "").trim() }))
  .filter((row) => row.target && row.target !== row.current);
if (targetBackfillCandidates.length > 0) {
  const updateTarget = db.prepare("UPDATE sessions SET session_target = ?, updated_at = ? WHERE id = ?");
  const backfillTargets = db.transaction(
    (rows: Array<{ id: string; target: string; current: string }>) => {
      const now = nowIso();
      for (const row of rows) {
        updateTarget.run(row.target, now, row.id);
      }
    }
  );
  backfillTargets(targetBackfillCandidates);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function getDbPath(): string {
  return dbPath;
}
