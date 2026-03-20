import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { db, nowIso } from "./db.js";
import { buildSessionMetadataWithOptions } from "./summary-provider.js";
import { getSummarySettings } from "./settings.js";
import type { ChatRole, MessageRecord, SyncProgress, SyncStats } from "./types.js";

type OpencodeSessionRow = {
  id: string;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
};

type OpencodeMessageRow = {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
};

type OpencodePartRow = {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string;
};

type ParsedOpencodeSession = {
  project: string | null;
  messages: MessageRecord[];
  title: string;
};

function opencodeDbPath(): string {
  return process.env.OPENCODE_DB_PATH ?? path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
}

function parseEpochMillis(input: unknown): string {
  if (typeof input === "number" && Number.isFinite(input)) {
    return new Date(input).toISOString();
  }
  if (typeof input === "string" && input.trim()) {
    const value = Number(input);
    if (Number.isFinite(value)) return new Date(value).toISOString();
    const date = new Date(input);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return new Date(0).toISOString();
}

function normalizeRole(raw: unknown): ChatRole {
  const role = String(raw ?? "").toLowerCase();
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  if (role === "tool") return "tool";
  return "system";
}

function parsePartContent(raw: string): { type: string; text: string; tool: string } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      type: String(parsed.type ?? ""),
      text: typeof parsed.text === "string" ? parsed.text : "",
      tool: typeof parsed.tool === "string" ? parsed.tool : "",
    };
  } catch {
    return { type: "", text: "", tool: "" };
  }
}

function parseMessageRole(raw: string): ChatRole {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizeRole(parsed.role);
  } catch {
    return "system";
  }
}

function sessionSourcePath(dbPath: string, sessionId: string): string {
  return `${dbPath}#session:${sessionId}`;
}

function normalizeOpencodeTitle(rawTitle: string, messages: MessageRecord[]): string {
  const title = rawTitle.trim();
  const firstUser = messages.find((msg) => msg.role === "user")?.content.trim() ?? "";
  const firstLine = firstUser.split("\n").map((line) => line.trim()).find(Boolean) ?? "";

  const cleanTaskLine = (value: string): string => {
    const cleaned = value
      .replace(/^\d+\.\s*task:\s*/i, "")
      .replace(/^task:\s*/i, "")
      .replace(/^\d+\.\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length <= 88) return cleaned;
    return `${cleaned.slice(0, 85).trim()}...`;
  };

  if (!title || /^new session\b/i.test(title)) {
    return cleanTaskLine(firstLine) || "Untitled Session";
  }

  if (/^\d+\.\s*task:/i.test(title)) {
    return cleanTaskLine(title) || cleanTaskLine(firstLine) || "Untitled Session";
  }

  if (/^install and configure /i.test(title)) {
    const normalized = title.replace(/\s+/g, " ").trim();
    return normalized.length <= 88 ? normalized : `${normalized.slice(0, 85).trim()}...`;
  }

  return title;
}

function opencodeStateMarker(session: OpencodeSessionRow, parsedTitle: string, partCount: number): number {
  const titleHash = crypto.createHash("sha1").update(parsedTitle).digest().readUInt32BE(0);
  return session.time_updated + partCount + (titleHash % 100000);
}

export function countOpencodeSessionFiles(): number {
  const file = opencodeDbPath();
  if (!fs.existsSync(file)) return 0;
  const source = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = source.prepare("SELECT COUNT(*) AS c FROM session WHERE time_archived IS NULL").get() as { c: number };
    return row.c;
  } finally {
    source.close();
  }
}

function parseSessionMessages(
  session: OpencodeSessionRow,
  messageRows: OpencodeMessageRow[],
  partRows: OpencodePartRow[]
): ParsedOpencodeSession {
  const partsByMessage = new Map<string, OpencodePartRow[]>();
  for (const part of partRows) {
    const items = partsByMessage.get(part.message_id) ?? [];
    items.push(part);
    partsByMessage.set(part.message_id, items);
  }
  for (const items of partsByMessage.values()) {
    items.sort((a, b) => a.time_created - b.time_created);
  }

  const extracted: Array<{ role: ChatRole; ts: string; content: string }> = [];
  let turn = 0;

  for (const msg of messageRows.sort((a, b) => a.time_created - b.time_created)) {
    const role = parseMessageRole(msg.data);
    const parts = partsByMessage.get(msg.id) ?? [];
    const texts: string[] = [];
    const tools: string[] = [];

    for (const part of parts) {
      const parsed = parsePartContent(part.data);
      if (parsed.type === "text" && parsed.text.trim()) {
        texts.push(parsed.text.trimEnd());
        continue;
      }
      if (parsed.type === "tool" && parsed.tool.trim()) {
        tools.push(parsed.tool.trim());
      }
    }

    const ts = parseEpochMillis(msg.time_created);
    if (role === "user" && texts.length > 0) {
      turn += 1;
      extracted.push({ role: "user", ts, content: texts.join("\n\n") });
      continue;
    }

    if (role === "assistant") {
      if (texts.length > 0) {
        extracted.push({ role: "assistant", ts, content: texts.join("\n\n") });
      }
      if (tools.length > 0) {
        const uniqueTools = Array.from(new Set(tools));
        extracted.push({ role: "tool", ts, content: `Tools: ${uniqueTools.join(", ")}` });
      }
    }
  }

  const messages = extracted.map((msg, idx) => ({
    id: crypto.createHash("sha1").update(`opencode:${session.id}:${idx}:${msg.ts}:${msg.role}:${msg.content.slice(0, 64)}`).digest("hex"),
    session_id: "",
    role: msg.role,
    ts: msg.ts,
    content: msg.content,
    turn_index: turn === 0 ? 1 : msg.role === "user" ? Math.max(1, idx + 1) : Math.max(1, turn),
    seq_in_session: idx,
  })) as MessageRecord[];

  let currentTurn = 0;
  for (const message of messages) {
    if (message.role === "user") {
      currentTurn += 1;
      message.turn_index = currentTurn;
    } else {
      message.turn_index = Math.max(1, currentTurn);
    }
  }

  return {
    project: session.directory?.trim() || null,
    messages,
    title: normalizeOpencodeTitle(session.title, messages),
  };
}

export function syncOpencodeSessions(
  onProgress?: (progress: SyncProgress) => void,
  options?: { onlyPaths?: Set<string> }
): SyncStats {
  const file = opencodeDbPath();
  const stats: SyncStats = {
    scannedFiles: 0,
    updatedSessions: 0,
    skippedFiles: 0,
    warnings: 0,
    warningDetails: [],
  };
  if (!fs.existsSync(file)) return stats;

  const settings = getSummarySettings();
  let codexBudget = settings.provider === "hybrid" ? settings.codexLimitPerRun : Number.MAX_SAFE_INTEGER;
  const onlyPaths = options?.onlyPaths;
  const source = new Database(file, { readonly: true, fileMustExist: true });

  let processedFiles = 0;
  let currentFile = "";
  const emitProgress = () => {
    if (!onProgress) return;
    onProgress({
      totalFiles: stats.scannedFiles,
      processedFiles,
      updatedSessions: stats.updatedSessions,
      skippedFiles: stats.skippedFiles,
      warnings: stats.warnings,
      currentFile,
      warningDetails: stats.warningDetails.slice(-8),
    });
  };

  try {
    const sessions = source
      .prepare(
        "SELECT id, directory, title, time_created, time_updated FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC"
      )
      .all() as OpencodeSessionRow[];
    const filteredSessions = sessions.filter((session) => !onlyPaths || onlyPaths.has(sessionSourcePath(file, session.id)));
    stats.scannedFiles = filteredSessions.length;
    emitProgress();

    const getState = db.prepare("SELECT last_mtime_ms, last_size FROM ingest_state WHERE source_path = ?");
    const upsertState = db.prepare(`
      INSERT INTO ingest_state(source_path, last_mtime_ms, last_size, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_path) DO UPDATE SET
        last_mtime_ms = excluded.last_mtime_ms,
        last_size = excluded.last_size,
        updated_at = excluded.updated_at
    `);
    const deleteSession = db.prepare("DELETE FROM sessions WHERE id = ?");
    const deleteMessages = db.prepare("DELETE FROM messages WHERE session_id = ?");
    const deleteFts = db.prepare("DELETE FROM message_fts WHERE session_id = ?");
    const insertSession = db.prepare(`
      INSERT INTO sessions(
        id, tool, source_path, project, start_time, end_time, duration_sec,
        title, summary, summary_provider, summary_status, message_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMessage = db.prepare(`
      INSERT INTO messages(id, session_id, role, ts, content, turn_index, seq_in_session)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(
      "INSERT INTO message_fts(message_id, session_id, role, content) VALUES (?, ?, ?, ?)"
    );

    const tx = db.transaction((session: OpencodeSessionRow) => {
      const sourcePath = sessionSourcePath(file, session.id);
      const messageRows = source
        .prepare("SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC")
        .all(session.id) as OpencodeMessageRow[];
      const partRows = source
        .prepare("SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC")
        .all(session.id) as OpencodePartRow[];

      const parsed = parseSessionMessages(session, messageRows, partRows);
      if (parsed.messages.length === 0) {
        stats.warnings += 1;
        stats.warningDetails.push(`[opencode] empty messages: ${session.id}`);
        return;
      }
      for (const msg of parsed.messages) {
        msg.session_id = `opencode:${session.id}`;
      }

      const start = parsed.messages[0]?.ts ?? parseEpochMillis(session.time_created);
      const end = parsed.messages[parsed.messages.length - 1]?.ts ?? parseEpochMillis(session.time_updated);
      const durationSec = Math.max(0, Math.floor((new Date(end).valueOf() - new Date(start).valueOf()) / 1000));
      const allowCodex = settings.provider !== "hybrid" || codexBudget > 0;
      const { title, summary, providerUsed, status } = buildSessionMetadataWithOptions(parsed.messages, { allowCodex });
      if (providerUsed === "codex" && settings.provider === "hybrid" && codexBudget > 0) {
        codexBudget -= 1;
      }
      const now = nowIso();
      const sessionPk = `opencode:${session.id}`;

      deleteFts.run(sessionPk);
      deleteMessages.run(sessionPk);
      deleteSession.run(sessionPk);

      insertSession.run(
        sessionPk,
        "opencode",
        sourcePath,
        parsed.project,
        start,
        end,
        durationSec,
        parsed.title || title || session.title || "Untitled Session",
        summary,
        providerUsed,
        status,
        parsed.messages.length,
        now,
        now
      );

      for (const msg of parsed.messages) {
        insertMessage.run(msg.id, msg.session_id, msg.role, msg.ts, msg.content, msg.turn_index, msg.seq_in_session);
        insertFts.run(msg.id, msg.session_id, msg.role, msg.content);
      }

      upsertState.run(sourcePath, session.time_updated, opencodeStateMarker(session, parsed.title, partRows.length), now);
      stats.updatedSessions += 1;
    });

    for (const session of filteredSessions) {
      currentFile = sessionSourcePath(file, session.id);
      try {
        const messageRows = source
          .prepare("SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC")
          .all(session.id) as OpencodeMessageRow[];
        const partRows = source
          .prepare("SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC")
          .all(session.id) as OpencodePartRow[];
        const parsed = parseSessionMessages(session, messageRows, partRows);
        const state = getState.get(currentFile) as { last_mtime_ms: number; last_size: number } | undefined;
        const sizeMarker = opencodeStateMarker(session, parsed.title, partRows.length);
        if (state && state.last_mtime_ms === session.time_updated && state.last_size === sizeMarker) {
          stats.skippedFiles += 1;
          processedFiles += 1;
          emitProgress();
          continue;
        }
        tx(session);
      } catch (error) {
        stats.warnings += 1;
        const detail = error instanceof Error ? error.message : String(error);
        stats.warningDetails.push(`[opencode] ingest failed: ${session.id} (${detail})`);
      }
      processedFiles += 1;
      emitProgress();
    }

    return stats;
  } finally {
    source.close();
  }
}
