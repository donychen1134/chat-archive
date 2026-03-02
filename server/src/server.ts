import Fastify from "fastify";
import cors from "@fastify/cors";
import { db, getDbPath } from "./db.js";
import { getSummarySettings, setSummaryLastError, setSummarySettings } from "./settings.js";
import { testCodexSummaryConnection } from "./summary-provider.js";
import { getSyncTaskState, startSyncTask } from "./sync-manager.js";

const app = Fastify({ logger: false });
const port = Number(process.env.PORT ?? 8765);

await app.register(cors, { origin: true });

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
      .all(...toolFilters, pageSize, offset);
    const total = db
      .prepare(`SELECT COUNT(*) as c FROM sessions s WHERE 1=1 ${toolClause}`)
      .get(...toolFilters) as { c: number };
    return { items: rows, total: total.c };
  }

  const roleFilter = scope === "question" ? "AND f.role = 'user'" : scope === "answer" ? "AND f.role = 'assistant'" : "";
  const queryParams = [query, ...toolFilters, pageSize, offset];
  const totalParams = [query, ...toolFilters];

  const rows = db
    .prepare(
      `
      SELECT DISTINCT s.*
      FROM sessions s
      JOIN message_fts f ON f.session_id = s.id
      WHERE f.content MATCH ? ${roleFilter} ${toolClause}
      ORDER BY datetime(s.start_time) DESC
      LIMIT ? OFFSET ?
    `
    )
    .all(...queryParams);

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

  return { items: rows, total: total.c };
});

app.get("/api/session", async (request, reply) => {
  const id = ((request.query as Record<string, string | undefined>).id ?? "").trim();
  if (!id) {
    reply.status(400);
    return { error: "Missing id" };
  }

  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
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
  }
});
