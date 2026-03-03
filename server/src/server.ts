import Fastify from "fastify";
import cors from "@fastify/cors";
import { db, getDbPath } from "./db.js";
import { getSummarySettings, setSummaryLastError, setSummarySettings } from "./settings.js";
import { testCodexSummaryConnection } from "./summary-provider.js";
import { getSyncTaskState, startSyncTask } from "./sync-manager.js";

const app = Fastify({ logger: false });
const port = Number(process.env.PORT ?? 8765);
const AUTO_SYNC_INTERVAL_MS = 60 * 60 * 1000;

await app.register(cors, { origin: true });

type SessionRow = {
  id: string;
  tool: "codex" | "claude" | "copilot" | "gemini" | string;
  source_path: string;
  [key: string]: unknown;
};

function extractNativeSessionId(tool: string, id: string, sourcePath: string): string | null {
  if (tool === "codex") {
    const m = sourcePath.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return m?.[0] ?? null;
  }
  const prefixed = id.match(/^[^:]+:(.+)$/);
  if (!prefixed) return null;
  const tail = prefixed[1];
  if (tool === "claude" || tool === "copilot") return tail;
  if (tool === "gemini") {
    const parts = tail.split(":");
    return parts[parts.length - 1] ?? null;
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildResumeHint(
  tool: string,
  nativeSessionId: string | null,
  project: string | null
): { command: string; label: string } {
  const projectPrefix =
    project && project.trim().length > 0 ? `cd ${shellQuote(project)} && ` : "";

  if (tool === "codex" && nativeSessionId) {
    return { command: `${projectPrefix}codex resume ${nativeSessionId}`, label: "Resume" };
  }
  if (tool === "claude" && nativeSessionId) {
    return { command: `${projectPrefix}claude --resume ${nativeSessionId}`, label: "Resume" };
  }
  if (tool === "copilot" && nativeSessionId) {
    if (projectPrefix) {
      return { command: `${projectPrefix}copilot` + "\n" + `/resume ${nativeSessionId}`, label: "Open + /resume" };
    }
    return { command: `copilot` + "\n" + `/resume ${nativeSessionId}`, label: "Open + /resume" };
  }
  if (tool === "gemini") {
    if (nativeSessionId) {
      return { command: `${projectPrefix}gemini -r ${nativeSessionId}`, label: "Resume" };
    }
    return { command: "gemini --list-sessions", label: "List sessions" };
  }
  return { command: "", label: "" };
}

function withResumeHint(row: SessionRow): SessionRow & {
  native_session_id: string | null;
  resume_command: string;
  resume_label: string;
} {
  const nativeSessionId = extractNativeSessionId(row.tool, row.id, String(row.source_path ?? ""));
  const project = typeof row.project === "string" ? row.project : null;
  const hint = buildResumeHint(row.tool, nativeSessionId, project);
  return {
    ...row,
    native_session_id: nativeSessionId,
    resume_command: hint.command,
    resume_label: hint.label,
  };
}

app.get("/api/health", async () => ({ ok: true, dbPath: getDbPath() }));

app.post("/api/sync", async () => {
  const result = startSyncTask("sync");
  return { ok: true, started: result.started, state: result.state };
});

app.post("/api/reindex", async () => {
  const result = startSyncTask("reindex");
  return { ok: true, started: result.started, state: result.state };
});

app.get("/api/sync/status", async () => {
  return { ok: true, state: getSyncTaskState() };
});

app.get("/api/summary/settings", async () => {
  return { ok: true, settings: getSummarySettings() };
});

app.post("/api/summary/settings", async (request) => {
  const body = (request.body ?? {}) as {
    provider?: "codex" | "qwen" | "rule" | "hybrid";
    model?: string;
    timeoutMs?: number;
    codexLimitPerRun?: number;
  };
  const settings = setSummarySettings({
    provider: body.provider,
    model: body.model,
    timeoutMs: body.timeoutMs,
    codexLimitPerRun: body.codexLimitPerRun,
  });
  return { ok: true, settings };
});

app.post("/api/summary/test", async () => {
  const result = testCodexSummaryConnection();
  setSummaryLastError(result.ok ? "" : result.detail);
  return { ok: result.ok, detail: result.detail };
});

app.get("/api/sessions", async (request) => {
  const query = (request.query as Record<string, string | undefined>).query?.trim() ?? "";
  const scope = ((request.query as Record<string, string | undefined>).scope ?? "all") as
    | "all"
    | "question"
    | "answer";
  const tool = ((request.query as Record<string, string | undefined>).tool ?? "all") as
    | "all"
    | "codex"
    | "claude"
    | "copilot"
    | "gemini";
  const toolsRaw = (request.query as Record<string, string | undefined>).tools?.trim() ?? "";
  const fromTools = toolsRaw
    .split(",")
    .map((v) => v.trim())
    .filter((v): v is "codex" | "claude" | "copilot" | "gemini" => v === "codex" || v === "claude" || v === "copilot" || v === "gemini");
  const legacyTool = tool === "codex" || tool === "claude" || tool === "copilot" || tool === "gemini" ? [tool] : [];
  const toolFilters = Array.from(new Set([...(fromTools.length > 0 ? fromTools : legacyTool)]));
  const page = Math.max(1, Number((request.query as Record<string, string | undefined>).page ?? "1"));
  const pageSize = Math.min(100, Math.max(1, Number((request.query as Record<string, string | undefined>).pageSize ?? "20")));
  const offset = (page - 1) * pageSize;
  const toolClause =
    toolFilters.length === 0 ? "" : `AND s.tool IN (${new Array(toolFilters.length).fill("?").join(",")})`;

  if (!query) {
    const rows = db
      .prepare(
        `SELECT * FROM sessions s WHERE 1=1 ${toolClause} ORDER BY datetime(start_time) DESC LIMIT ? OFFSET ?`
      )
      .all(...toolFilters, pageSize, offset) as SessionRow[];
    const total = db
      .prepare(`SELECT COUNT(*) as c FROM sessions s WHERE 1=1 ${toolClause}`)
      .get(...toolFilters) as { c: number };
    return { items: rows.map(withResumeHint), total: total.c };
  }

  const roleFilter = scope === "question" ? "AND f.role = 'user'" : scope === "answer" ? "AND f.role = 'assistant'" : "";
  const queryParams = [query, ...toolFilters, pageSize, offset];
  const totalParams = [query, ...toolFilters];

  const rows = db
    .prepare(
      `
      WITH matched AS (
        SELECT
          s.id AS session_id,
          s.tool,
          s.source_path,
          s.project,
          s.start_time,
          s.end_time,
          s.duration_sec,
          s.title,
          s.summary,
          s.summary_provider,
          s.summary_status,
          s.message_count,
          s.created_at,
          s.updated_at,
          f.role AS hit_role,
          bm25(message_fts) AS hit_score,
          snippet(message_fts, 3, '[', ']', ' … ', 14) AS hit_excerpt
        FROM sessions s
        JOIN message_fts f ON f.session_id = s.id
        WHERE f.content MATCH ? ${roleFilter} ${toolClause}
      )
      SELECT
        session_id AS id,
        tool,
        source_path,
        project,
        start_time,
        end_time,
        duration_sec,
        title,
        summary,
        summary_provider,
        summary_status,
        message_count,
        created_at,
        updated_at,
        MIN(hit_score) AS hit_score,
        GROUP_CONCAT(DISTINCT hit_role) AS hit_roles,
        COALESCE(
          MAX(CASE WHEN hit_role = 'user' THEN hit_excerpt END),
          MAX(hit_excerpt)
        ) AS hit_excerpt
      FROM matched
      GROUP BY
        session_id,
        tool,
        source_path,
        project,
        start_time,
        end_time,
        duration_sec,
        title,
        summary,
        summary_provider,
        summary_status,
        message_count,
        created_at,
        updated_at
      ORDER BY hit_score ASC, datetime(start_time) DESC
      LIMIT ? OFFSET ?
    `
    )
    .all(...queryParams) as SessionRow[];

  const total = db
    .prepare(
      `
      SELECT COUNT(DISTINCT s.id) as c
      FROM sessions s
      JOIN message_fts f ON f.session_id = s.id
      WHERE f.content MATCH ? ${roleFilter} ${toolClause}
    `
    )
    .get(...totalParams) as { c: number };

  return { items: rows.map(withResumeHint), total: total.c };
});

app.get("/api/session", async (request, reply) => {
  const id = ((request.query as Record<string, string | undefined>).id ?? "").trim();
  if (!id) {
    reply.status(400);
    return { error: "Missing id" };
  }

  const rawSession = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  const session = rawSession ? withResumeHint(rawSession) : null;
  if (!session) {
    reply.status(404);
    return { error: "Session not found" };
  }

  const messages = db
    .prepare(
      `SELECT id, session_id, role, ts, content, turn_index, seq_in_session
       FROM messages WHERE session_id = ? ORDER BY seq_in_session ASC`
    )
    .all(id);

  return { session, messages };
});

app.listen({ port, host: "127.0.0.1" }).then(() => {
  console.log(`chat-archive server running at http://127.0.0.1:${port}`);
  if (process.env.AUTO_SYNC_ON_START !== "false") {
    setTimeout(() => {
      try {
        startSyncTask("sync");
      } catch (error) {
        console.error("startup sync failed:", error);
      }
    }, 0);

    setInterval(() => {
      try {
        startSyncTask("sync");
      } catch (error) {
        console.error("scheduled sync failed:", error);
      }
    }, AUTO_SYNC_INTERVAL_MS);
  }
});
