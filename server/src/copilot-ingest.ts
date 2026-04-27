import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { db, nowIso } from "./db.js";
import { buildSessionMetadataWithOptions } from "./summary-provider.js";
import { getSummarySettings } from "./settings.js";
import type { ChatRole, MessageRecord, SyncProgress, SyncStats, UsageInput } from "./types.js";
import { replaceSessionUsage } from "./usage.js";

type ParsedCopilotFile = {
  sessionIdHint: string | null;
  project: string | null;
  messages: MessageRecord[];
  usage: UsageInput[];
};

function copilotSessionsDir(): string {
  return process.env.COPILOT_SESSIONS_DIR ?? path.join(os.homedir(), ".copilot", "session-state");
}

function walkCopilotFiles(root: string): string[] {
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
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && (entry.name === "events.jsonl" || !entry.name.includes(".lock"))) {
        result.push(full);
      }
    }
  }
  return result;
}

export function countCopilotSessionFiles(): number {
  return walkCopilotFiles(copilotSessionsDir()).length;
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
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.text === "string") return obj.text;
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

function parseCopilotFile(filePath: string, stat: fs.Stats): ParsedCopilotFile {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

  let sessionIdHint: string | null = null;
  let project: string | null = null;
  const extracted: Array<{ role: ChatRole; ts: string; content: string }> = [];
  const usage: UsageInput[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = String(event.type ?? "").toLowerCase();
      const data = (event.data ?? null) as Record<string, unknown> | null;
      const ts = parseTimestamp(event.timestamp, stat.mtime);

      if (type === "session.start") {
        const sid = data?.sessionId;
        if (!sessionIdHint && typeof sid === "string" && sid.trim().length > 0) {
          sessionIdHint = sid.trim();
        }
        const cwd = (data?.context as Record<string, unknown> | undefined)?.cwd;
        if (!project && typeof cwd === "string" && cwd.trim().length > 0) {
          project = cwd.trim();
        }
        continue;
      }

      if (type === "user.message") {
        const content = asText(data?.content).trimEnd();
        if (content) extracted.push({ role: "user", ts, content });
        continue;
      }

      if (type === "assistant.message") {
        const content = asText(data?.content).trimEnd();
        if (content) extracted.push({ role: "assistant", ts, content });
        const outputTokens = asUsageNumber(data?.outputTokens);
        const model = typeof data?.model === "string" ? data.model : null;
        if (outputTokens > 0) {
          usage.push({
            session_id: "",
            tool: "copilot",
            project,
            provider: "copilot",
            model,
            record_type: "message",
            source_type: "native_partial",
            usage_semantics: "delta",
            usage_time: ts,
            input_tokens: 0,
            output_tokens: outputTokens,
            reasoning_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            tool_tokens: 0,
            total_tokens: outputTokens,
            cost: null,
            raw_ref: `copilot:assistant.output:${ts}:${usage.length}`,
          });
        }
        continue;
      }

      if (type === "session.shutdown") {
        const modelMetrics = (data?.modelMetrics ?? null) as Record<string, unknown> | null;
        if (!modelMetrics) continue;
        for (const [model, metric] of Object.entries(modelMetrics)) {
          if (!metric || typeof metric !== "object") continue;
          const usageObj = ((metric as Record<string, unknown>).usage ?? null) as Record<string, unknown> | null;
          const requestsObj = ((metric as Record<string, unknown>).requests ?? null) as Record<string, unknown> | null;
          if (!usageObj) continue;
          const inputTokens = asUsageNumber(usageObj.inputTokens);
          const outputTokens = asUsageNumber(usageObj.outputTokens);
          const cacheReadTokens = asUsageNumber(usageObj.cacheReadTokens);
          const cacheWriteTokens = asUsageNumber(usageObj.cacheWriteTokens);
          const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
          if (totalTokens <= 0) continue;
          usage.push({
            session_id: "",
            tool: "copilot",
            project,
            provider: "copilot",
            model,
            record_type: "session",
            source_type: "native_partial",
            usage_semantics: "session_total",
            usage_time: ts,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            reasoning_tokens: 0,
            cache_read_tokens: cacheReadTokens,
            cache_write_tokens: cacheWriteTokens,
            tool_tokens: 0,
            total_tokens: totalTokens,
            cost: requestsObj ? asUsageNumber(requestsObj.cost) : null,
            raw_ref: `copilot:session.shutdown:${model}:${ts}`,
          });
        }
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
        .update(`copilot:${filePath}:${idx}:${msg.ts}:${msg.role}:${msg.content.slice(0, 64)}`)
        .digest("hex"),
      session_id: "",
      role: msg.role,
      ts: msg.ts,
      content: msg.content,
      turn_index: turn === 0 ? 1 : turn,
      seq_in_session: idx,
    } satisfies MessageRecord;
  });

  return { sessionIdHint, project, messages, usage: usage.map((item) => ({ ...item, project })) };
}

function fileToSessionId(root: string, filePath: string, hint: string | null): string {
  if (hint) return `copilot:${hint}`;
  const relative = path.relative(root, filePath);
  return `copilot:${relative.replaceAll(path.sep, "/")}`;
}

export function syncCopilotSessions(
  onProgress?: (progress: SyncProgress) => void,
  options?: { onlyPaths?: Set<string> }
): SyncStats {
  const root = copilotSessionsDir();
  const onlyPaths = options?.onlyPaths;
  const files = walkCopilotFiles(root).filter((p) => !onlyPaths || onlyPaths.has(p));
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
    const parsed = parseCopilotFile(filePath, stat);
    const sessionId = fileToSessionId(root, filePath, parsed.sessionIdHint);
    const messages = parsed.messages;
    const usage = parsed.usage;

    if (messages.length === 0) {
      stats.warnings += 1;
      stats.warningDetails.push(`[copilot] empty messages: ${filePath}`);
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
      "copilot",
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
      stats.warningDetails.push(`[copilot] ingest failed: ${filePath} (${detail})`);
    }
    processedFiles += 1;
    emitProgress();
  }

  return stats;
}
