import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { db, nowIso } from "./db.js";
import { buildSessionMetadataWithOptions } from "./summary-provider.js";
import { getSummarySettings } from "./settings.js";
import type { ChatRole, MessageRecord, SyncProgress, SyncStats } from "./types.js";

function codexSessionsDir(): string {
  return process.env.CODEX_SESSIONS_DIR ?? path.join(os.homedir(), ".codex", "sessions");
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json"))) {
        result.push(full);
      }
    }
  }
  return result;
}

export function countCodexSessionFiles(): number {
  return walkFiles(codexSessionsDir()).length;
}

function asText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item && typeof (item as { text: unknown }).text === "string") {
          return (item as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.output_text === "string") return obj.output_text;
    if (typeof obj.input_text === "string") return obj.input_text;
    if (Array.isArray(obj.parts)) return asText(obj.parts);
  }
  return "";
}

function normalizeRole(raw: unknown): ChatRole {
  const role = String(raw ?? "").toLowerCase();
  if (role.includes("assistant") || role === "model") return "assistant";
  if (role.includes("developer")) return "system";
  if (role.includes("tool") || role.includes("function")) return "tool";
  if (role.includes("system")) return "system";
  return "user";
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

function extractMessage(event: unknown, fallback: Date): { role: ChatRole; ts: string; content: string } | null {
  if (!event || typeof event !== "object") return null;
  const obj = event as Record<string, unknown>;

  const role = normalizeRole(obj.role ?? obj.author ?? obj.sender ?? obj.type);
  const content =
    asText(obj.content) ||
    asText(obj.text) ||
    asText(obj.message) ||
    asText(obj.output_text) ||
    asText(obj.input_text) ||
    "";

  if (!content.trim()) return null;

  const ts = parseTimestamp(obj.timestamp ?? obj.created_at ?? obj.time ?? obj.ts, fallback);
  return { role, ts, content: content.trimEnd() };
}

function extractFromCodexEnvelope(
  record: Record<string, unknown>,
  fallback: Date
): Array<{ role: ChatRole; ts: string; content: string }> {
  const lineTs = parseTimestamp(record.timestamp, fallback);
  const lineType = String(record.type ?? "");
  const payload = (record.payload ?? null) as Record<string, unknown> | null;
  if (!payload) return [];

  if (lineType === "response_item") {
    const payloadType = String(payload.type ?? "");
    if (payloadType === "message") {
      const role = normalizeRole(payload.role);
      const content = asText(payload.content) || asText(payload.text) || "";
      if (!content.trim()) return [];
      return [{ role, ts: lineTs, content: content.trimEnd() }];
    }

    if (payloadType === "function_call_output") {
      const content = asText(payload.output) || "";
      if (!content.trim()) return [];
      return [{ role: "tool", ts: lineTs, content: content.trimEnd() }];
    }
  }

  if (lineType === "event_msg") {
    const payloadType = String(payload.type ?? "");
    if (payloadType === "user_message") {
      const content = asText(payload.message) || "";
      if (!content.trim()) return [];
      return [{ role: "user", ts: lineTs, content: content.trimEnd() }];
    }
  }

  return [];
}

function fileToSessionId(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  return `codex:${relative.replaceAll(path.sep, "/")}`;
}

function extractProjectPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function projectFromRecord(record: Record<string, unknown>): string | null {
  const direct = extractProjectPath(record.cwd ?? record.project);
  if (direct) return direct;

  const payload = record.payload;
  if (payload && typeof payload === "object") {
    const fromPayload = extractProjectPath((payload as Record<string, unknown>).cwd);
    if (fromPayload) return fromPayload;
  }

  const context = record.context;
  if (context && typeof context === "object") {
    const fromContext = extractProjectPath((context as Record<string, unknown>).cwd);
    if (fromContext) return fromContext;
  }

  return null;
}

function parseFile(filePath: string, stat: fs.Stats): { project: string | null; messages: MessageRecord[] } {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = filePath.endsWith(".jsonl") ? raw.split(/\r?\n/).filter((l) => l.trim().length > 0) : [raw];

  const extracted: Array<{ role: ChatRole; ts: string; content: string }> = [];
  let project: string | null = null;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!project && item && typeof item === "object") {
            project = projectFromRecord(item as Record<string, unknown>) ?? project;
          }
          const msg = extractMessage(item, stat.mtime);
          if (msg) extracted.push(msg);
        }
      } else if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        if (!project) {
          project = projectFromRecord(obj) ?? project;
        }
        const envelopeMessages = extractFromCodexEnvelope(obj, stat.mtime);
        if (envelopeMessages.length > 0) {
          extracted.push(...envelopeMessages);
          continue;
        }

        if ("messages" in obj) {
          const list = (obj as { messages?: unknown }).messages;
          if (Array.isArray(list)) {
            for (const item of list) {
              const msg = extractMessage(item, stat.mtime);
              if (msg) extracted.push(msg);
            }
            continue;
          }
        }

        const msg = extractMessage(parsed, stat.mtime);
        if (msg) extracted.push(msg);
      } else {
        continue;
      }
    } catch {
      // Keep ingest robust; malformed lines are skipped.
    }
  }

  const deduped: Array<{ role: ChatRole; ts: string; content: string }> = [];
  for (const msg of extracted) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.role === msg.role && prev.content === msg.content) {
      continue;
    }
    deduped.push(msg);
  }

  let turn = 0;
  let prevRole: ChatRole | null = null;
  let prevUserContent = "";
  const messages = deduped.map((msg, idx) => {
    if (msg.role === "user") {
      const isConsecutiveDuplicateUser = prevRole === "user" && prevUserContent === msg.content;
      if (!isConsecutiveDuplicateUser) {
        turn += 1;
      }
      prevUserContent = msg.content;
      prevRole = "user";
    } else if (msg.role === "assistant") {
      prevRole = "assistant";
    }
    return {
      id: crypto.createHash("sha1").update(`${filePath}:${idx}:${msg.ts}:${msg.role}`).digest("hex"),
      session_id: "",
      role: msg.role,
      ts: msg.ts,
      content: msg.content,
      turn_index: turn === 0 ? 1 : turn,
      seq_in_session: idx,
    };
  });
  return { project, messages };
}

export function syncCodexSessions(
  onProgress?: (progress: SyncProgress) => void,
  options?: { onlyPaths?: Set<string> }
): SyncStats {
  const root = codexSessionsDir();
  const onlyPaths = options?.onlyPaths;
  const files = walkFiles(root).filter((p) => !onlyPaths || onlyPaths.has(p));
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
    const sessionId = fileToSessionId(root, filePath);
    const parsed = parseFile(filePath, stat);
    const project = parsed.project;
    const messages = parsed.messages;

    if (messages.length === 0) {
      stats.warnings += 1;
      stats.warningDetails.push(`[codex] empty messages: ${filePath}`);
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
      "codex",
      filePath,
      project,
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
      stats.warningDetails.push(`[codex] ingest failed: ${filePath} (${detail})`);
    }
    processedFiles += 1;
    emitProgress();
  }

  return stats;
}
