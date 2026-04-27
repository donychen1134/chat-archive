import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { db, nowIso } from "./db.js";
import { buildSessionMetadataWithOptions } from "./summary-provider.js";
import { getSummarySettings } from "./settings.js";
import type { ChatRole, MessageRecord, SyncProgress, SyncStats, UsageInput } from "./types.js";
import { replaceSessionUsage } from "./usage.js";

type ParsedGeminiFile = {
  sessionIdHint: string | null;
  projectHash: string | null;
  project: string | null;
  messages: MessageRecord[];
  usage: UsageInput[];
};

function geminiSessionsDir(): string {
  return process.env.GEMINI_SESSIONS_DIR ?? path.join(os.homedir(), ".gemini", "tmp");
}

function walkGeminiFiles(root: string): string[] {
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
      } else if (entry.isFile() && entry.name.startsWith("session-") && entry.name.endsWith(".json") && full.includes(`${path.sep}chats${path.sep}`)) {
        result.push(full);
      }
    }
  }
  return result;
}

export function countGeminiSessionFiles(): number {
  return walkGeminiFiles(geminiSessionsDir()).length;
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

function asText(input: unknown): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input
      .map((item) => (typeof item === "string" ? item : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
  }
  return "";
}

function asUsageNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function readProjectFromDotFile(filePath: string): string | null {
  const baseDir = path.dirname(path.dirname(filePath));
  const projectFile = path.join(baseDir, ".project_root");
  if (!fs.existsSync(projectFile)) return null;
  try {
    const content = fs.readFileSync(projectFile, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}

function parseGeminiFile(filePath: string, stat: fs.Stats): ParsedGeminiFile {
  const raw = fs.readFileSync(filePath, "utf8");
  const root = JSON.parse(raw) as Record<string, unknown>;
  const list = Array.isArray(root.messages) ? (root.messages as Array<Record<string, unknown>>) : [];

  const extracted: Array<{ role: ChatRole; ts: string; content: string }> = [];
  const usage: UsageInput[] = [];
  for (const item of list) {
    const rawType = String(item.type ?? "").toLowerCase();
    const role: ChatRole =
      rawType === "user"
        ? "user"
        : rawType === "gemini" || rawType === "assistant" || rawType === "model"
          ? "assistant"
          : "system";
    if (role !== "user" && role !== "assistant") continue;
    const content = asText(item.content).trimEnd();
    if (!content) continue;
    const ts = parseTimestamp(item.timestamp, stat.mtime);
    extracted.push({ role, ts, content });
    const tokens = (item.tokens ?? null) as Record<string, unknown> | null;
    if (tokens && role === "assistant") {
      const inputTokens = asUsageNumber(tokens.input);
      const outputTokens = asUsageNumber(tokens.output);
      const cacheTokens = asUsageNumber(tokens.cached);
      const reasoningTokens = asUsageNumber(tokens.thoughts);
      const toolTokens = asUsageNumber(tokens.tool);
      const totalTokens = asUsageNumber(tokens.total) || inputTokens + outputTokens + cacheTokens + reasoningTokens + toolTokens;
      if (totalTokens > 0) {
        usage.push({
          session_id: "",
          tool: "gemini",
          project: null,
          provider: "google",
          model: typeof item.model === "string" ? item.model : null,
          record_type: "message",
          source_type: "native_exact",
          usage_semantics: "delta",
          usage_time: ts,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          reasoning_tokens: reasoningTokens,
          cache_read_tokens: cacheTokens,
          cache_write_tokens: 0,
          tool_tokens: toolTokens,
          total_tokens: totalTokens,
          cost: null,
          raw_ref: `gemini:tokens:${ts}:${usage.length}`,
        });
      }
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
        .update(`gemini:${filePath}:${idx}:${msg.ts}:${msg.role}:${msg.content.slice(0, 64)}`)
        .digest("hex"),
      session_id: "",
      role: msg.role,
      ts: msg.ts,
      content: msg.content,
      turn_index: turn === 0 ? 1 : turn,
      seq_in_session: idx,
    } satisfies MessageRecord;
  });

  const sessionIdHint =
    typeof root.sessionId === "string" && root.sessionId.trim().length > 0 ? root.sessionId.trim() : null;
  const projectHash =
    typeof root.projectHash === "string" && root.projectHash.trim().length > 0 ? root.projectHash.trim() : null;
  const project = readProjectFromDotFile(filePath);
  return { sessionIdHint, projectHash, project, messages, usage: usage.map((item) => ({ ...item, project })) };
}

function fileToSessionId(root: string, filePath: string, hint: string | null, projectHash: string | null): string {
  if (hint && projectHash) return `gemini:${projectHash}:${hint}`;
  if (hint) return `gemini:${hint}`;
  const relative = path.relative(root, filePath);
  return `gemini:${relative.replaceAll(path.sep, "/")}`;
}

export function syncGeminiSessions(
  onProgress?: (progress: SyncProgress) => void,
  options?: { onlyPaths?: Set<string> }
): SyncStats {
  const root = geminiSessionsDir();
  const onlyPaths = options?.onlyPaths;
  const files = walkGeminiFiles(root).filter((p) => !onlyPaths || onlyPaths.has(p));
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
    const parsed = parseGeminiFile(filePath, stat);
    const sessionId = fileToSessionId(root, filePath, parsed.sessionIdHint, parsed.projectHash);
    const messages = parsed.messages;
    const usage = parsed.usage;

    if (messages.length === 0) {
      stats.warnings += 1;
      stats.warningDetails.push(`[gemini] empty messages: ${filePath}`);
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
      "gemini",
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

    replaceSessionUsage(
      sessionId,
      usage.map((record) => ({
        ...record,
        session_id: sessionId,
        project: parsed.project,
      }))
    );

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
      stats.warningDetails.push(`[gemini] ingest failed: ${filePath} (${detail})`);
    }
    processedFiles += 1;
    emitProgress();
  }

  return stats;
}
