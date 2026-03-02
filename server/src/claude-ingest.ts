import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { db, nowIso } from "./db.js";
import { buildSessionMetadataWithOptions } from "./summary-provider.js";
import { getSummarySettings } from "./settings.js";
import type { ChatRole, MessageRecord, SyncProgress, SyncStats } from "./types.js";

type ParsedClaudeFile = {
  sessionIdHint: string | null;
  project: string | null;
  messages: MessageRecord[];
};

function claudeProjectsDir(): string {
  return process.env.CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), ".claude", "projects");
}

function walkClaudeFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "subagents") continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        result.push(full);
      }
    }
  }
  return result;
}

export function countClaudeSessionFiles(): number {
  return walkClaudeFiles(claudeProjectsDir()).length;
}

function parseTimestamp(input: unknown, fallback: Date): string {
  if (typeof input === "number") {
    const millis = input > 1e12 ? input : input * 1000;
    return new Date(millis).toISOString();
  }
  if (typeof input === "string") {
    const date = new Date(input);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return fallback.toISOString();
}

function normalizeClaudeRole(type: unknown, messageRole: unknown): ChatRole {
  const mr = String(messageRole ?? "").toLowerCase();
  if (mr === "assistant") return "assistant";
  if (mr === "user") return "user";
  const t = String(type ?? "").toLowerCase();
  if (t === "assistant") return "assistant";
  if (t === "user") return "user";
  return "system";
}

function asClaudeText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const blockType = String(obj.type ?? "").toLowerCase();
    if (blockType === "thinking" || blockType === "tool_use" || blockType === "tool_result") {
      continue;
    }
    if (typeof obj.text === "string" && obj.text.trim().length > 0) {
      parts.push(obj.text);
      continue;
    }
    if (typeof obj.input_text === "string" && obj.input_text.trim().length > 0) {
      parts.push(obj.input_text);
      continue;
    }
    if (typeof obj.output_text === "string" && obj.output_text.trim().length > 0) {
      parts.push(obj.output_text);
    }
  }
  return parts.join("\n");
}

function parseClaudeFile(filePath: string, stat: fs.Stats): ParsedClaudeFile {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const extracted: Array<{ role: ChatRole; ts: string; content: string }> = [];
  let project: string | null = null;
  let sessionIdHint: string | null = null;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const type = String(parsed.type ?? "").toLowerCase();
      if (type !== "user" && type !== "assistant") continue;

      const message = (parsed.message ?? null) as Record<string, unknown> | null;
      const role = normalizeClaudeRole(type, message?.role);
      if (role !== "user" && role !== "assistant") continue;

      const content = asClaudeText(message?.content);
      if (!content.trim()) continue;

      const ts = parseTimestamp(parsed.timestamp, stat.mtime);
      extracted.push({ role, ts, content: content.trimEnd() });

      if (!project && typeof parsed.cwd === "string" && parsed.cwd.trim().length > 0) {
        project = parsed.cwd.trim();
      }
      if (!sessionIdHint && typeof parsed.sessionId === "string" && parsed.sessionId.trim().length > 0) {
        sessionIdHint = parsed.sessionId.trim();
      }
    } catch {
      // Keep ingest robust; malformed lines are skipped.
    }
  }

  const deduped: Array<{ role: ChatRole; ts: string; content: string }> = [];
  for (const msg of extracted) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.role === msg.role && prev.content === msg.content) continue;
    deduped.push(msg);
  }

  let turn = 0;
  let prevRole: ChatRole | null = null;
  let prevUserContent = "";
  const messages = deduped.map((msg, idx) => {
    if (msg.role === "user") {
      const isConsecutiveDuplicateUser = prevRole === "user" && prevUserContent === msg.content;
      if (!isConsecutiveDuplicateUser) turn += 1;
      prevUserContent = msg.content;
      prevRole = "user";
    } else if (msg.role === "assistant") {
      prevRole = "assistant";
    }
    return {
      id: crypto
        .createHash("sha1")
        .update(`claude:${filePath}:${idx}:${msg.ts}:${msg.role}:${msg.content.slice(0, 64)}`)
        .digest("hex"),
      session_id: "",
      role: msg.role,
      ts: msg.ts,
      content: msg.content,
      turn_index: turn === 0 ? 1 : turn,
      seq_in_session: idx,
    } satisfies MessageRecord;
  });

  return { sessionIdHint, project, messages };
}

function fileToSessionId(root: string, filePath: string, hint: string | null): string {
  if (hint) return `claude:${hint}`;
  const relative = path.relative(root, filePath);
  return `claude:${relative.replaceAll(path.sep, "/")}`;
}

export function syncClaudeSessions(onProgress?: (progress: SyncProgress) => void): SyncStats {
  const root = claudeProjectsDir();
  const files = walkClaudeFiles(root);
  const settings = getSummarySettings();
  let codexBudget = settings.provider === "hybrid" ? settings.codexLimitPerRun : Number.MAX_SAFE_INTEGER;

  const stats: SyncStats = {
    scannedFiles: files.length,
    updatedSessions: 0,
    skippedFiles: 0,
    warnings: 0,
    warningDetails: [],
  };
  let processedFiles = 0;
  let currentFile = "";
  const emitProgress = () => {
    if (!onProgress) return;
    onProgress({
      totalFiles: files.length,
      processedFiles,
      updatedSessions: stats.updatedSessions,
      skippedFiles: stats.skippedFiles,
      warnings: stats.warnings,
      currentFile,
      warningDetails: stats.warningDetails.slice(-8),
    });
  };
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

  const tx = db.transaction((filePath: string, stat: fs.Stats) => {
    const parsed = parseClaudeFile(filePath, stat);
    const sessionId = fileToSessionId(root, filePath, parsed.sessionIdHint);
    const messages = parsed.messages;

    if (messages.length === 0) {
      stats.warnings += 1;
      stats.warningDetails.push(`[claude] empty messages: ${filePath}`);
      return;
    }

    for (const msg of messages) {
      msg.session_id = sessionId;
    }

    const start = messages[0]?.ts ?? stat.mtime.toISOString();
    const end = messages[messages.length - 1]?.ts ?? stat.mtime.toISOString();
    const durationSec = Math.max(0, Math.floor((new Date(end).valueOf() - new Date(start).valueOf()) / 1000));
    const allowCodex = settings.provider !== "hybrid" || codexBudget > 0;
    const { title, summary, providerUsed, status } = buildSessionMetadataWithOptions(messages, { allowCodex });
    if (providerUsed === "codex" && settings.provider === "hybrid" && codexBudget > 0) {
      codexBudget -= 1;
    }
    const now = nowIso();

    deleteFts.run(sessionId);
    deleteMessages.run(sessionId);
    deleteSession.run(sessionId);

    insertSession.run(
      sessionId,
      "claude",
      filePath,
      parsed.project,
      start,
      end,
      durationSec,
      title,
      summary,
      providerUsed,
      status,
      messages.length,
      now,
      now
    );

    for (const msg of messages) {
      insertMessage.run(msg.id, msg.session_id, msg.role, msg.ts, msg.content, msg.turn_index, msg.seq_in_session);
      insertFts.run(msg.id, msg.session_id, msg.role, msg.content);
    }

    upsertState.run(filePath, Math.floor(stat.mtimeMs), stat.size, now);
    stats.updatedSessions += 1;
  });

  const fileEntries = files.map((filePath) => ({ filePath, stat: fs.statSync(filePath) }));
  fileEntries.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  for (const { filePath, stat } of fileEntries) {
    currentFile = filePath;
    const state = getState.get(filePath) as { last_mtime_ms: number; last_size: number } | undefined;
    if (state && state.last_mtime_ms === Math.floor(stat.mtimeMs) && state.last_size === stat.size) {
      stats.skippedFiles += 1;
      processedFiles += 1;
      emitProgress();
      continue;
    }

    try {
      tx(filePath, stat);
    } catch (error) {
      stats.warnings += 1;
      const detail = error instanceof Error ? error.message : String(error);
      stats.warningDetails.push(`[claude] ingest failed: ${filePath} (${detail})`);
    }
    processedFiles += 1;
    emitProgress();
  }

  return stats;
}
