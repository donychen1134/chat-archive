import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { db, nowIso } from "./db.js";
import { buildSessionMetadataForSync, shouldRefreshUnchangedSummary, type CachedSummaryRecord } from "./summary-provider.js";
import { resolveSessionTarget } from "./session-target.js";
import { getSummarySettings } from "./settings.js";
import type { ChatRole, MessageRecord, SyncProgress, SyncStats } from "./types.js";

// CatPaw IDE (a VSCode-based AI IDE) writes one rendered transcript per chat
// session to ~/.catpaw/projects/<slug>/<uuid>/agent-transcripts/transcript.txt.
// The file is plain text with line markers (user: / assistant: / [Tool call] /
// [Tool result]) and carries no structured timestamps, so we approximate times
// from the file mtime. Tool results are intentionally dropped (matching the
// opencode-ingest approach); each tool call is recorded as a compact tool
// message holding the tool name and its key parameters.

type ExtractedMessage = { role: ChatRole; ts: string; content: string };

function catpawProjectsDir(): string {
  return process.env.CATPAW_PROJECTS_DIR ?? path.join(os.homedir(), ".catpaw", "projects");
}

function walkCatpawTranscripts(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === "transcript.txt" && full.includes(`${path.sep}agent-transcripts${path.sep}`)) {
        result.push(full);
      }
    }
  }
  return result;
}

export function countCatpawSessionFiles(): number {
  return walkCatpawTranscripts(catpawProjectsDir()).length;
}

// Slug form: "ide-Users-mt-go-src-git-sankuai-com-data-data-virtual-kubelet"
// or "Users-mt-Desktop-catpaw-desk". The IDE encodes the absolute cwd by
// replacing both "/" and "." with "-", so a repo named "data-virtual-kubelet"
// becomes "data-virtual-kubelet" in the slug — indistinguishable from three
// separate path segments "data/virtual/kubelet" by string inspection alone.
//
// We resolve the ambiguity by probing the real filesystem: the encoded cwd
// (almost always) still exists on disk, so we walk from "/" and greedily
// consume the longest run of tokens whose joined name matches an existing
// directory (trying both "-" and "." joiners, the latter for host dots like
// "git.sankuai.com"). This keeps hyphenated repo names intact. When the path
// no longer exists, we fall back to the older git.sankuai.com heuristic.
const slugPathCache = new Map<string, string | null>();

function directoryExists(full: string): boolean {
  try {
    return fs.statSync(full).isDirectory();
  } catch {
    return false;
  }
}

function restorePathByProbe(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  let current = "";
  let i = 0;
  while (i < tokens.length) {
    const maxK = Math.min(tokens.length - i, 12);
    let matched: { path: string; consumed: number } | null = null;
    for (let k = maxK; k >= 1; k -= 1) {
      const joined = tokens.slice(i, i + k).join("-");
      const candidates = joined.includes(".") ? [joined] : [joined, joined.replace(/-/g, ".")];
      for (const name of candidates) {
        const full = current ? `${current}/${name}` : `/${name}`;
        if (directoryExists(full)) {
          matched = { path: full, consumed: k };
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) return null; // can't disambiguate further; caller falls back
    current = matched.path;
    i += matched.consumed;
  }
  return current || null;
}

function fallbackPathFromSegments(segments: string[]): string | null {
  if (segments.length === 0) return null;
  const gitIdx = segments.indexOf("git");
  if (
    gitIdx >= 0 &&
    gitIdx + 2 < segments.length &&
    segments[gitIdx + 1] === "sankuai" &&
    segments[gitIdx + 2] === "com"
  ) {
    const rest = segments.slice(gitIdx + 3);
    return rest.length > 0 ? `git.sankuai.com/${rest.join("/")}` : "git.sankuai.com";
  }
  return segments.join("/");
}

function projectFromSlug(slug: string): string | null {
  const cached = slugPathCache.get(slug);
  if (cached !== undefined) return cached;
  let body = slug;
  const idePrefix = "ide-";
  if (body.startsWith(idePrefix)) body = body.slice(idePrefix.length);
  const segments = body.split("-").filter(Boolean);

  const probed = restorePathByProbe(segments);
  const result = probed ?? fallbackPathFromSegments(segments);
  slugPathCache.set(slug, result);
  return result;
}

function extractToolSummary(lines: string[], start: number, toolName: string): { content: string; next: number } {
  // Collect indented parameter lines that follow "[Tool call] <name>" until the
  // next marker. Keep only a few key parameters and cap total length.
  const params: string[] = [];
  let i = start;
  const KEY_PARAMS = /^(target_file|command|explanation|pattern|path|query|todos|url)\s*:/i;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    // Parameter lines are indented; markers begin at column 0.
    if (/^\s/.test(line)) {
      const trimmed = line.trim();
      if (KEY_PARAMS.test(trimmed)) {
        params.push(trimmed);
      }
      i += 1;
      continue;
    }
    break;
  }
  const detail = params.slice(0, 3).join("  ");
  let content = `Tool: ${toolName}`;
  if (detail) content += ` — ${detail}`;
  if (content.length > 240) content = `${content.slice(0, 237)}...`;
  return { content, next: i };
}

function parseTranscript(raw: string, stat: fs.Stats): ExtractedMessage[] {
  const lines = raw.split(/\r?\n/);
  const ts = stat.mtime.toISOString();
  const extracted: ExtractedMessage[] = [];

  const TOOL_CALL_RE = /^\[Tool call\]\s+(.+?)\s*$/;
  const TOOL_RESULT_RE = /^\[Tool result\]/;
  const ASSISTANT_RE = /^assistant:\s*$/;
  const USER_QUERY_OPEN_RE = /^<user_query>\s*$/;
  const USER_QUERY_CLOSE_RE = /^<\/user_query>\s*$/;
  const USER_RE = /^user:\s*$/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // user: followed by <user_query>...</user_query>
    if (USER_RE.test(line)) {
      // Find the user_query block (may start on the same or next line).
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j += 1;
      if (j < lines.length && USER_QUERY_OPEN_RE.test(lines[j])) {
        const body: string[] = [];
        j += 1;
        while (j < lines.length && !USER_QUERY_CLOSE_RE.test(lines[j])) {
          body.push(lines[j]);
          j += 1;
        }
        const content = body.join("\n").trim();
        if (content) extracted.push({ role: "user", ts, content });
        i = j + 1;
        continue;
      }
      // No user_query block; skip the bare "user:" marker.
      i += 1;
      continue;
    }

    if (ASSISTANT_RE.test(line)) {
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (USER_RE.test(next) || ASSISTANT_RE.test(next) || TOOL_CALL_RE.test(next) || TOOL_RESULT_RE.test(next)) break;
        body.push(next);
        j += 1;
      }
      const content = body.join("\n").trim();
      if (content) extracted.push({ role: "assistant", ts, content });
      i = j;
      continue;
    }

    const callMatch = line.match(TOOL_CALL_RE);
    if (callMatch) {
      const { content, next } = extractToolSummary(lines, i + 1, callMatch[1].trim());
      if (content) extracted.push({ role: "tool", ts, content });
      i = next;
      continue;
    }

    // Tool results are dropped entirely.
    if (TOOL_RESULT_RE.test(line)) {
      i += 1;
      continue;
    }

    i += 1;
  }

  return extracted;
}

type ParsedCatpawFile = {
  sessionIdHint: string;
  project: string | null;
  messages: MessageRecord[];
};

function parseCatpawFile(filePath: string, stat: fs.Stats): ParsedCatpawFile {
  const raw = fs.readFileSync(filePath, "utf8");
  const extracted = parseTranscript(raw, stat);

  // Collapse consecutive same-role duplicates (transcripts can repeat).
  const deduped: ExtractedMessage[] = [];
  for (const msg of extracted) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.role === msg.role && prev.content === msg.content) continue;
    deduped.push(msg);
  }

  let turn = 0;
  let prevRole: ChatRole | null = null;
  const messages = deduped.map((msg, idx) => {
    if (msg.role === "user") {
      turn += 1;
      prevRole = "user";
    } else if (msg.role === "assistant") {
      prevRole = "assistant";
    }
    return {
      id: crypto
        .createHash("sha1")
        .update(`catpaw:${filePath}:${idx}:${msg.role}:${msg.content.slice(0, 64)}`)
        .digest("hex"),
      session_id: "",
      role: msg.role,
      ts: msg.ts,
      content: msg.content,
      turn_index: turn === 0 ? 1 : turn,
      seq_in_session: idx,
    } satisfies MessageRecord;
  });

  // Session uuid is the directory two levels above "agent-transcripts".
  const sessionDir = path.basename(path.dirname(path.dirname(filePath)));
  const projectSlug = path.basename(path.dirname(path.dirname(path.dirname(filePath))));
  const project = projectFromSlug(projectSlug);
  return { sessionIdHint: sessionDir, project, messages };
}

function fileToSessionId(filePath: string, sessionIdHint: string): string {
  return `catpaw:${sessionIdHint}`;
}

export function syncCatpawSessions(
  onProgress?: (progress: SyncProgress) => void,
  options?: { onlyPaths?: Set<string>; forceSummaryRefresh?: boolean }
): SyncStats {
  const root = catpawProjectsDir();
  const onlyPaths = options?.onlyPaths;
  const forceSummaryRefresh = Boolean(options?.forceSummaryRefresh);
  const files = walkCatpawTranscripts(root).filter((p) => !onlyPaths || onlyPaths.has(p));
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
      message_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMessage = db.prepare(`
    INSERT INTO messages(id, session_id, role, ts, content, turn_index, seq_in_session)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(
    "INSERT INTO message_fts(message_id, session_id, role, content) VALUES (?, ?, ?, ?)"
  );

  const tx = db.transaction((filePath: string, stat: fs.Stats) => {
    const parsed = parseCatpawFile(filePath, stat);
    const sessionId = fileToSessionId(filePath, parsed.sessionIdHint);
    const messages = parsed.messages;

    if (messages.length === 0) {
      stats.warnings += 1;
      stats.warningDetails.push(`[catpaw] empty messages: ${filePath}`);
      return;
    }

    for (const msg of messages) {
      msg.session_id = sessionId;
    }

    // No per-message timestamps exist; approximate start/end from file times.
    // ctime reflects the earliest known metadata change, mtime the last write.
    const start = stat.ctime.toISOString();
    const end = stat.mtime.toISOString();
    const durationSec = Math.max(0, Math.floor((stat.mtime.valueOf() - stat.ctime.valueOf()) / 1000));
    const allowCodex = settings.provider !== "hybrid" || codexBudget > 0;
    const existing = getExistingSession.get(sessionId) as CachedSummaryRecord | undefined;
    const metadata = buildSessionMetadataForSync(messages, existing, {
      allowCodex,
      startTime: start,
      endTime: end,
      forceSummaryRefresh,
    });
    if (!metadata.fromCache && metadata.providerUsed === "codex" && settings.provider === "hybrid" && codexBudget > 0) {
      codexBudget -= 1;
    }
    const now = nowIso();

    deleteFts.run(sessionId);
    deleteMessages.run(sessionId);
    deleteSession.run(sessionId);

    // When the session maps to a real project, the project name is the target.
    metadata.target = resolveSessionTarget(parsed.project, metadata.target);

    insertSession.run(
      sessionId,
      "catpaw",
      filePath,
      parsed.project,
      start,
      end,
      durationSec,
      metadata.title,
      metadata.summary,
      metadata.providerUsed,
      metadata.status,
      metadata.purpose,
      metadata.target,
      metadata.outcome,
      JSON.stringify(metadata.keywords),
      JSON.stringify(metadata.entities),
      2,
      metadata.contentHash,
      metadata.model,
      metadata.promptVersion,
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
      const parsed = parseCatpawFile(filePath, stat);
      const sessionId = fileToSessionId(filePath, parsed.sessionIdHint);
      const existing = getExistingSession.get(sessionId) as CachedSummaryRecord | undefined;
      if (shouldRefreshUnchangedSummary(existing)) {
        try {
          tx(filePath, stat);
        } catch (error) {
          stats.warnings += 1;
          const detail = error instanceof Error ? error.message : String(error);
          stats.warningDetails.push(`[catpaw] metadata refresh failed: ${filePath} (${detail})`);
        }
        processedFiles += 1;
        emitProgress();
        continue;
      }
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
      stats.warningDetails.push(`[catpaw] ingest failed: ${filePath} (${detail})`);
    }
    processedFiles += 1;
    emitProgress();
  }

  return stats;
}
