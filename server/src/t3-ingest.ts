import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { db, nowIso } from "./db.js";
import {
  buildSessionMetadataForSync,
  shouldRefreshUnchangedSummary,
  type CachedSummaryRecord,
} from "./summary-provider.js";
import { resolveSessionTarget } from "./session-target.js";
import { getSummarySettings } from "./settings.js";
import type { ChatRole, MessageRecord, SessionKind, SyncProgress, SyncStats, UsageInput } from "./types.js";
import { replaceSessionUsage } from "./usage.js";

const T3_METADATA_VERSION = 2;
const HIDDEN_RUN_STATUSES = new Set(["rolled_back", "cancelled"]);

type T3ThreadRow = {
  thread_id: string;
  project_id: string;
  title: string;
  default_provider: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  deleted_at: string | null;
  payload_json: string;
  project_title: string | null;
  workspace_root: string | null;
};

type T3MessageRow = {
  message_id: string;
  thread_id: string;
  run_id: string | null;
  role: string;
  streaming: number;
  created_at: string;
  updated_at: string;
  payload_json: string;
  run_status: string | null;
};

type T3TurnItemRow = {
  turn_item_id: string;
  run_id: string | null;
  ordinal: number;
  type: string;
  status: string;
  updated_at: string;
  payload_json: string;
  run_status: string | null;
};

type T3ProviderTurnRow = {
  provider_turn_id: string;
  thread_id: string;
  ordinal: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  payload_json: string;
  run_provider: string | null;
  run_status: string | null;
  run_payload_json: string | null;
};

type ParsedT3Thread = {
  project: string | null;
  title: string;
  messages: MessageRecord[];
  usage: UsageInput[];
  sessionKind: SessionKind;
  nativeThreadId: string;
  parentNativeThreadId: string | null;
  toolItemCount: number;
};

export function t3StateDbPath(): string {
  const explicit = process.env.T3_STATE_DB_PATH?.trim();
  if (explicit) return explicit;
  const home = process.env.T3CODE_HOME?.trim();
  if (home) return path.join(home, "userdata", "statev2.sqlite");
  return path.join(os.homedir(), ".t3", "userdata", "statev2.sqlite");
}

function threadSourcePath(dbPath: string, threadId: string): string {
  return `${dbPath}#thread:${threadId}`;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseIsoTimestamp(input: unknown, fallback = new Date(0).toISOString()): string {
  if (typeof input === "string" && input.trim()) {
    const date = new Date(input);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  if (typeof input === "number" && Number.isFinite(input)) {
    const millis = input > 1e12 ? input : input * 1000;
    return new Date(millis).toISOString();
  }
  return fallback;
}

function toEpochMs(input: unknown): number {
  if (typeof input === "string" && input.trim()) {
    const parsed = Date.parse(input);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof input === "number" && Number.isFinite(input)) {
    return Math.floor(input);
  }
  return 0;
}

function asUsageNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  return 0;
}

function normalizeRole(raw: unknown): ChatRole {
  const role = String(raw ?? "").toLowerCase();
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  if (role === "tool") return "tool";
  return "system";
}

function isScratchProject(projectTitle: string | null, workspaceRoot: string | null): boolean {
  const title = (projectTitle ?? "").trim().toLowerCase();
  if (title === "no project") return true;
  const root = (workspaceRoot ?? "").replace(/\\/g, "/").trim().toLowerCase();
  if (!root) return true;
  return root.endsWith("/.t3/scratch") || root.includes("/.t3/scratch/");
}

function resolveT3Project(thread: T3ThreadRow): string | null {
  if (isScratchProject(thread.project_title, thread.workspace_root)) {
    return null;
  }
  const workspace = (thread.workspace_root ?? "").trim();
  return workspace || null;
}

function normalizeT3Title(rawTitle: string, messages: MessageRecord[]): string {
  const title = rawTitle.replace(/\s+/g, " ").trim();
  if (title && !/^(new thread|untitled(?: thread| session)?)$/i.test(title)) {
    return title.length <= 120 ? title : `${title.slice(0, 117).trim()}...`;
  }
  const firstUser = messages.find((msg) => msg.role === "user")?.content.trim() ?? "";
  const firstLine = firstUser
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "";
  return firstLine.length <= 88 ? firstLine : `${firstLine.slice(0, 85).trim()}...`;
}

function extractAttachmentLabels(payload: Record<string, unknown> | null): string[] {
  const attachments = payload?.attachments;
  if (!Array.isArray(attachments)) return [];
  const labels: string[] = [];
  for (const item of attachments) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : "";
    const type = typeof obj.type === "string" && obj.type.trim() ? obj.type.trim() : "file";
    labels.push(name ? `[${type}: ${name}]` : `[${type}]`);
  }
  return labels;
}

function extractToolLabel(item: T3TurnItemRow): string | null {
  const payload = parseJsonObject(item.payload_json);
  if (item.type === "dynamic_tool") {
    const toolName = typeof payload?.toolName === "string" ? payload.toolName.trim() : "";
    return toolName || "tool";
  }
  if (item.type === "command_execution") {
    const title = typeof payload?.title === "string" ? payload.title.trim() : "";
    if (title.toLowerCase() === "workspace ready" && !payload?.input) {
      return null;
    }
    return "command_execution";
  }
  if (item.type === "file_search") {
    return "file_search";
  }
  return null;
}

function extractModelSelection(payload: Record<string, unknown> | null): { provider: string | null; model: string | null } {
  const selection =
    payload?.modelSelection && typeof payload.modelSelection === "object"
      ? (payload.modelSelection as Record<string, unknown>)
      : null;
  if (!selection) return { provider: null, model: null };
  const provider =
    typeof selection.provider === "string" && selection.provider.trim()
      ? selection.provider.trim()
      : typeof selection.instanceId === "string" && selection.instanceId.trim()
        ? selection.instanceId.trim()
        : null;
  const model = typeof selection.model === "string" && selection.model.trim() ? selection.model.trim() : null;
  return { provider, model };
}

function t3StateMarker(
  thread: T3ThreadRow,
  title: string,
  messageCount: number,
  turnCount: number,
  toolItemCount: number
): number {
  const sig = `${title}|${thread.project_id}|${thread.workspace_root ?? ""}|${thread.archived_at ?? ""}|${messageCount}|${turnCount}|${toolItemCount}`;
  return crypto.createHash("sha1").update(sig).digest().readUInt32BE(0);
}

type SqliteDb = InstanceType<typeof Database>;

function openT3SourceDatabase(file: string): { db: SqliteDb; cleanup: () => void } {
  try {
    const source = new Database(file, { readonly: true, fileMustExist: true });
    source.pragma("busy_timeout = 3000");
    return {
      db: source,
      cleanup: () => {
        source.close();
      },
    };
  } catch {
    // Fallback: copy DB + WAL/SHM into a temp snapshot so readonly access never blocks or fails on WAL permissions.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-archive-t3-"));
    const baseName = path.basename(file);
    const snapshotPath = path.join(tmpDir, baseName);
    fs.copyFileSync(file, snapshotPath);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${file}${suffix}`;
      if (fs.existsSync(sidecar)) {
        fs.copyFileSync(sidecar, `${snapshotPath}${suffix}`);
      }
    }
    const source = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    return {
      db: source,
      cleanup: () => {
        try {
          source.close();
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      },
    };
  }
}

function hasV2Tables(source: SqliteDb): boolean {
  const row = source
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_projection_threads'")
    .get() as { name?: string } | undefined;
  return Boolean(row?.name);
}

function parseT3Thread(
  thread: T3ThreadRow,
  messageRows: T3MessageRow[],
  turnItemRows: T3TurnItemRow[],
  providerTurnRows: T3ProviderTurnRow[]
): ParsedT3Thread {
  const project = resolveT3Project(thread);
  const threadPayload = parseJsonObject(thread.payload_json);
  const threadModel = extractModelSelection(threadPayload);
  const lineage =
    threadPayload?.lineage && typeof threadPayload.lineage === "object"
      ? (threadPayload.lineage as Record<string, unknown>)
      : null;
  const parentNativeThreadId =
    typeof lineage?.parentThreadId === "string" && lineage.parentThreadId.trim()
      ? lineage.parentThreadId.trim()
      : null;
  const sessionKind: SessionKind = parentNativeThreadId ? "subagent" : "user";

  const toolsByRun = new Map<string, { tools: string[]; ts: string }>();
  let toolItemCount = 0;
  for (const item of turnItemRows) {
    if (item.run_status && HIDDEN_RUN_STATUSES.has(item.run_status)) continue;
    if (!item.run_id) continue;
    const label = extractToolLabel(item);
    if (!label) continue;
    toolItemCount += 1;
    const entry = toolsByRun.get(item.run_id) ?? { tools: [], ts: parseIsoTimestamp(item.updated_at) };
    entry.tools.push(label);
    const ts = parseIsoTimestamp(item.updated_at);
    if (ts > entry.ts) entry.ts = ts;
    toolsByRun.set(item.run_id, entry);
  }

  const visibleMessages = messageRows.filter((row) => {
    if (row.run_status && HIDDEN_RUN_STATUSES.has(row.run_status)) return false;
    const role = normalizeRole(row.role);
    return role === "user" || role === "assistant";
  });

  // Track the last assistant message index for each run so tool summaries attach to the right turn.
  const lastAssistantIdxByRun = new Map<string, number>();
  visibleMessages.forEach((row, idx) => {
    if (normalizeRole(row.role) === "assistant" && row.run_id) {
      lastAssistantIdxByRun.set(row.run_id, idx);
    }
  });

  const extracted: Array<{ role: ChatRole; ts: string; content: string; sourceId: string }> = [];
  const emittedToolRuns = new Set<string>();

  visibleMessages.forEach((row, idx) => {
    const role = normalizeRole(row.role);
    const payload = parseJsonObject(row.payload_json);
    const rawText = typeof payload?.text === "string" ? payload.text.trimEnd() : "";
    const attachmentLabels = role === "user" ? extractAttachmentLabels(payload) : [];
    const contentParts: string[] = [];
    if (rawText.trim()) contentParts.push(rawText);
    if (attachmentLabels.length > 0) {
      contentParts.push(attachmentLabels.join(" "));
    }
    const content = contentParts.join("\n\n").trimEnd();
    const ts = parseIsoTimestamp(row.created_at, parseIsoTimestamp(thread.created_at));

    if (content) {
      extracted.push({ role, ts, content, sourceId: row.message_id });
    }

    if (row.run_id && lastAssistantIdxByRun.get(row.run_id) === idx) {
      const toolInfo = toolsByRun.get(row.run_id);
      if (toolInfo && toolInfo.tools.length > 0) {
        const uniqueTools = Array.from(new Set(toolInfo.tools));
        extracted.push({
          role: "tool",
          ts: toolInfo.ts || ts,
          content: `Tools: ${uniqueTools.join(", ")}`,
          sourceId: `${row.run_id}:tools`,
        });
        emittedToolRuns.add(row.run_id);
      }
    }
  });

  let currentTurn = 0;
  const messages: MessageRecord[] = extracted.map((msg, idx) => {
    if (msg.role === "user") {
      currentTurn += 1;
    }
    return {
      id: crypto
        .createHash("sha1")
        .update(`t3:${thread.thread_id}:${idx}:${msg.sourceId}:${msg.role}:${msg.content.slice(0, 64)}`)
        .digest("hex"),
      session_id: "",
      role: msg.role,
      ts: msg.ts,
      content: msg.content,
      turn_index: Math.max(1, currentTurn),
      seq_in_session: idx,
    };
  });

  const usage: UsageInput[] = [];
  for (const turn of providerTurnRows) {
    if (turn.run_status && HIDDEN_RUN_STATUSES.has(turn.run_status)) continue;
    const payload = parseJsonObject(turn.payload_json);
    const tokenUsage =
      payload?.turnTokenUsage && typeof payload.turnTokenUsage === "object"
        ? (payload.turnTokenUsage as Record<string, unknown>)
        : null;
    if (!tokenUsage) continue;

    const usageStatus = String(tokenUsage.usageStatus ?? "").toLowerCase();
    const inputTokens = asUsageNumber(tokenUsage.inputTokens);
    const outputTokens = asUsageNumber(tokenUsage.outputTokens);
    const reasoningTokens = asUsageNumber(tokenUsage.reasoningTokens);
    const cacheReadTokens = asUsageNumber(tokenUsage.cachedInputTokens);
    const cacheWriteTokens = asUsageNumber(tokenUsage.cacheCreationTokens);
    // T3 turnTokenUsage.inputTokens already includes cachedInputTokens, and outputTokens includes reasoningTokens.
    const totalTokens = inputTokens + outputTokens;
    if (totalTokens <= 0) continue;

    const runModel = extractModelSelection(parseJsonObject(turn.run_payload_json));
    const provider =
      turn.run_provider?.trim() ||
      runModel.provider ||
      threadModel.provider ||
      thread.default_provider?.trim() ||
      null;
    const model = runModel.model || threadModel.model || null;
    const usageTime = parseIsoTimestamp(
      turn.completed_at ?? turn.started_at ?? thread.updated_at,
      parseIsoTimestamp(thread.updated_at)
    );

    usage.push({
      session_id: "",
      tool: "t3",
      project,
      provider,
      model,
      record_type: "turn",
      source_type: usageStatus === "complete" ? "native_exact" : "native_partial",
      usage_semantics: "delta",
      usage_time: usageTime,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      reasoning_tokens: reasoningTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      tool_tokens: 0,
      total_tokens: totalTokens,
      cost: null,
      raw_ref: `t3:turn:${turn.provider_turn_id}`,
    });
  }

  return {
    project,
    title: normalizeT3Title(thread.title, messages),
    messages,
    usage,
    sessionKind,
    nativeThreadId: thread.thread_id,
    parentNativeThreadId,
    toolItemCount,
  };
}

export function countT3SessionFiles(): number {
  const file = t3StateDbPath();
  if (!fs.existsSync(file)) return 0;
  const { db: source, cleanup } = openT3SourceDatabase(file);
  try {
    if (!hasV2Tables(source)) return 0;
    const row = source
      .prepare("SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL")
      .get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  } finally {
    cleanup();
  }
}

export function syncT3Sessions(
  onProgress?: (progress: SyncProgress) => void,
  options?: { onlyPaths?: Set<string>; forceSummaryRefresh?: boolean }
): SyncStats {
  const file = t3StateDbPath();
  const forceSummaryRefresh = Boolean(options?.forceSummaryRefresh);
  const onlyPaths = options?.onlyPaths;
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
  const { db: source, cleanup } = openT3SourceDatabase(file);

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
    if (!hasV2Tables(source)) {
      emitProgress();
      return stats;
    }

    const allThreads = source
      .prepare(
        `SELECT
          t.thread_id,
          t.project_id,
          t.title,
          t.default_provider,
          t.created_at,
          t.updated_at,
          t.archived_at,
          t.deleted_at,
          t.payload_json,
          p.title AS project_title,
          p.workspace_root
        FROM orchestration_v2_projection_threads t
        LEFT JOIN projection_projects p ON p.project_id = t.project_id
        ORDER BY t.updated_at DESC`
      )
      .all() as T3ThreadRow[];

    const activeThreads = allThreads.filter(
      (thread) => thread.deleted_at === null && (!onlyPaths || onlyPaths.has(threadSourcePath(file, thread.thread_id)))
    );
    stats.scannedFiles = activeThreads.length;
    emitProgress();

    // Remove threads that were soft-deleted in T3 after being archived here.
    if (!onlyPaths) {
      const deletedThreadIds = allThreads
        .filter((thread) => thread.deleted_at !== null)
        .map((thread) => thread.thread_id);
      if (deletedThreadIds.length > 0) {
        const deleteSession = db.prepare("DELETE FROM sessions WHERE id = ?");
        const deleteMessages = db.prepare("DELETE FROM messages WHERE session_id = ?");
        const deleteFts = db.prepare("DELETE FROM message_fts WHERE session_id = ?");
        const deleteUsageRecords = db.prepare("DELETE FROM usage_records WHERE session_id = ?");
        const deleteUsageSummary = db.prepare("DELETE FROM session_usage_summary WHERE session_id = ?");
        const deleteIngestState = db.prepare("DELETE FROM ingest_state WHERE source_path = ?");
        const cleanupDeleted = db.transaction((ids: string[]) => {
          for (const threadId of ids) {
            const sessionPk = `t3:${threadId}`;
            deleteFts.run(sessionPk);
            deleteMessages.run(sessionPk);
            deleteUsageRecords.run(sessionPk);
            deleteUsageSummary.run(sessionPk);
            deleteSession.run(sessionPk);
            deleteIngestState.run(threadSourcePath(file, threadId));
          }
        });
        cleanupDeleted(deletedThreadIds);
      }
    }

    const selectMessages = source.prepare(`
      SELECT
        m.message_id,
        m.thread_id,
        m.run_id,
        m.role,
        m.streaming,
        m.created_at,
        m.updated_at,
        m.payload_json,
        r.status AS run_status
      FROM orchestration_v2_projection_messages m
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = m.run_id
      WHERE m.thread_id = ?
      ORDER BY m.created_at ASC, m.message_id ASC
    `);

    const selectTurnItems = source.prepare(`
      SELECT
        i.turn_item_id,
        i.run_id,
        i.ordinal,
        i.type,
        i.status,
        i.updated_at,
        i.payload_json,
        r.status AS run_status
      FROM orchestration_v2_projection_turn_items i
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = i.run_id
      WHERE i.thread_id = ?
        AND i.type IN ('dynamic_tool', 'command_execution', 'file_search')
      ORDER BY i.ordinal ASC, i.turn_item_id ASC
    `);

    const selectProviderTurns = source.prepare(`
      SELECT
        pt.provider_turn_id,
        pt.thread_id,
        pt.ordinal,
        pt.status,
        pt.started_at,
        pt.completed_at,
        pt.payload_json,
        r.provider AS run_provider,
        r.status AS run_status,
        r.payload_json AS run_payload_json
      FROM orchestration_v2_projection_provider_turns pt
      LEFT JOIN orchestration_v2_projection_runs r
        ON r.thread_id = pt.thread_id AND r.ordinal = pt.ordinal
      WHERE pt.thread_id = ?
      ORDER BY pt.ordinal ASC, pt.provider_turn_id ASC
    `);

    const getState = db.prepare("SELECT last_mtime_ms, last_size FROM ingest_state WHERE source_path = ?");
    const getExistingSession = db.prepare(`
      SELECT title, summary, summary_provider, summary_status, session_purpose, session_target,
        session_outcome, keywords_json, entities_json, summary_content_hash, summary_model,
        summary_prompt_version, end_time
      FROM sessions WHERE id = ?
    `);
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
        title, summary, summary_provider, summary_status, session_purpose, session_target,
        session_outcome, keywords_json, entities_json, metadata_version,
        summary_content_hash, summary_model, summary_prompt_version,
        session_kind, native_thread_id, parent_native_thread_id, archive_visible,
        message_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMessage = db.prepare(`
      INSERT INTO messages(id, session_id, role, ts, content, turn_index, seq_in_session)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(
      "INSERT INTO message_fts(message_id, session_id, role, content) VALUES (?, ?, ?, ?)"
    );

    const tx = db.transaction(
      (thread: T3ThreadRow, parsed: ParsedT3Thread, updatedMs: number, sizeMarker: number) => {
        const sourcePath = threadSourcePath(file, thread.thread_id);
        const sessionPk = `t3:${thread.thread_id}`;
        const now = nowIso();

        if (parsed.messages.length === 0) {
          stats.warnings += 1;
          stats.warningDetails.push(`[t3] empty messages: ${thread.thread_id}`);
          return;
        }

        for (const msg of parsed.messages) {
          msg.session_id = sessionPk;
        }

        const start = parsed.messages[0]?.ts ?? parseIsoTimestamp(thread.created_at);
        const end = parsed.messages[parsed.messages.length - 1]?.ts ?? parseIsoTimestamp(thread.updated_at);
        const durationSec = Math.max(0, Math.floor((new Date(end).valueOf() - new Date(start).valueOf()) / 1000));
        const allowCodex = settings.provider !== "hybrid" || codexBudget > 0;
        const existing = getExistingSession.get(sessionPk) as CachedSummaryRecord | undefined;
        const metadata = buildSessionMetadataForSync(parsed.messages, existing, {
          allowCodex,
          startTime: start,
          endTime: end,
          forceSummaryRefresh,
        });
        if (!metadata.fromCache && metadata.providerUsed === "codex" && settings.provider === "hybrid" && codexBudget > 0) {
          codexBudget -= 1;
        }

        deleteFts.run(sessionPk);
        deleteMessages.run(sessionPk);
        deleteSession.run(sessionPk);

        metadata.target = resolveSessionTarget(parsed.project, metadata.target);

        insertSession.run(
          sessionPk,
          "t3",
          sourcePath,
          parsed.project,
          start,
          end,
          durationSec,
          parsed.title || metadata.title || thread.title || "Untitled Session",
          metadata.summary,
          metadata.providerUsed,
          metadata.status,
          metadata.purpose,
          metadata.target,
          metadata.outcome,
          JSON.stringify(metadata.keywords),
          JSON.stringify(metadata.entities),
          T3_METADATA_VERSION,
          metadata.contentHash,
          metadata.model,
          metadata.promptVersion,
          parsed.sessionKind,
          parsed.nativeThreadId,
          parsed.parentNativeThreadId,
          1,
          parsed.messages.length,
          now,
          now
        );

        for (const msg of parsed.messages) {
          insertMessage.run(msg.id, msg.session_id, msg.role, msg.ts, msg.content, msg.turn_index, msg.seq_in_session);
          insertFts.run(msg.id, msg.session_id, msg.role, msg.content);
        }

        replaceSessionUsage(
          sessionPk,
          parsed.usage.map((record) => ({
            ...record,
            session_id: sessionPk,
            project: parsed.project,
          }))
        );

        upsertState.run(sourcePath, updatedMs, sizeMarker, now);
        stats.updatedSessions += 1;
      }
    );

    for (const thread of activeThreads) {
      currentFile = threadSourcePath(file, thread.thread_id);
      try {
        const messageRows = selectMessages.all(thread.thread_id) as T3MessageRow[];
        const turnItemRows = selectTurnItems.all(thread.thread_id) as T3TurnItemRow[];
        const providerTurnRows = selectProviderTurns.all(thread.thread_id) as T3ProviderTurnRow[];
        const parsed = parseT3Thread(thread, messageRows, turnItemRows, providerTurnRows);
        const updatedMs = toEpochMs(thread.updated_at);
        const sizeMarker = t3StateMarker(
          thread,
          parsed.title,
          parsed.messages.length,
          parsed.usage.length,
          parsed.toolItemCount
        );
        const state = getState.get(currentFile) as { last_mtime_ms: number; last_size: number } | undefined;
        if (state && state.last_mtime_ms === updatedMs && state.last_size === sizeMarker) {
          const existing = getExistingSession.get(`t3:${thread.thread_id}`) as CachedSummaryRecord | undefined;
          if (shouldRefreshUnchangedSummary(existing)) {
            tx(thread, parsed, updatedMs, sizeMarker);
            processedFiles += 1;
            emitProgress();
            continue;
          }
          stats.skippedFiles += 1;
          processedFiles += 1;
          emitProgress();
          continue;
        }
        tx(thread, parsed, updatedMs, sizeMarker);
      } catch (error) {
        stats.warnings += 1;
        const detail = error instanceof Error ? error.message : String(error);
        stats.warningDetails.push(`[t3] ingest failed: ${thread.thread_id} (${detail})`);
      }
      processedFiles += 1;
      emitProgress();
    }

    return stats;
  } finally {
    cleanup();
  }
}
