import Fastify from "fastify";
import cors from "@fastify/cors";
import { db, getDbPath } from "./db.js";
import {
  getPurposeSettings,
  getSummarySettings,
  setPurposeSettings,
  setSummaryLastError,
  setSummarySettings,
  type PurposeSettings,
} from "./settings.js";
import { testCodexSummaryConnection } from "./summary-provider.js";
import { getSyncTaskState, startSyncTask } from "./sync-manager.js";

const app = Fastify({ logger: false });
const port = Number(process.env.PORT ?? 8765);
const AUTO_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const DB_RETRY_ATTEMPTS = Math.max(1, Number(process.env.DB_RETRY_ATTEMPTS ?? "6"));
const DB_RETRY_DELAY_MS = Math.max(10, Number(process.env.DB_RETRY_DELAY_MS ?? "120"));

await app.register(cors, { origin: true });

type SessionRow = {
  id: string;
  tool: "codex" | "claude" | "copilot" | "gemini" | string;
  source_path: string;
  [key: string]: unknown;
};

type SessionEnriched = SessionRow & {
  native_session_id: string | null;
  resume_command: string;
  resume_label: string;
  session_purpose: string;
  session_target: string;
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

function isBusyDbError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = String((error as { code?: unknown }).code ?? "");
  const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    message.includes("database is locked") ||
    message.includes("database is busy")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenizeSearchInput(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function buildFtsMatchQuery(raw: string): string {
  const tokens = tokenizeSearchInput(raw);
  if (tokens.length === 0) return "";
  const quoted = tokens.map((token) => `"${token.replaceAll(`"`, `""`)}"`);
  return quoted.join(" AND ");
}

function isFtsQuerySyntaxError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
  return message.includes("fts5") && message.includes("syntax");
}

async function withDbRetry<T>(fn: () => T): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < DB_RETRY_ATTEMPTS; i += 1) {
    try {
      return fn();
    } catch (error) {
      if (!isBusyDbError(error) || i === DB_RETRY_ATTEMPTS - 1) {
        throw error;
      }
      lastError = error;
      await sleep(DB_RETRY_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "database retry failed"));
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

function parseCustomPurposeRules(raw: string): Array<{ label: string; re: RegExp }> {
  const rules: Array<{ label: string; re: RegExp }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const idx = text.indexOf("=");
    if (idx <= 0 || idx >= text.length - 1) continue;
    const label = text.slice(0, idx).trim();
    const pattern = text.slice(idx + 1).trim();
    if (!label || !pattern) continue;
    try {
      rules.push({ label, re: new RegExp(pattern, "i") });
    } catch {
      // Ignore invalid custom regex rows.
    }
  }
  return rules;
}

function sanitizeDisplayTitle(title: string, target: string): string {
  const t = title.trim();
  if (!t) return target || "Untitled Session";
  const lower = t.toLowerCase();
  if (
    lower.startsWith("<image name=") ||
    lower.startsWith("[image #") ||
    lower.startsWith("</image>") ||
    lower === "<instructions>" ||
    lower === "<permissions instructions>"
  ) {
    return target ? `${target} 会话` : "Untitled Session";
  }
  return t;
}

function inferSessionPurposeAndTarget(row: SessionRow, settings: PurposeSettings): {
  session_purpose: string;
  session_target: string;
} {
  const title = String(row.title ?? "");
  const summary = String(row.summary ?? "");
  const merged = `${title}\n${summary}`.toLowerCase();
  const project = typeof row.project === "string" ? row.project.trim() : "";

  const codeReviewRe = new RegExp(settings.ruleCodeReview, "i");
  const troubleshootingRe = new RegExp(settings.ruleTroubleshooting, "i");
  const developmentRe = new RegExp(settings.ruleDevelopment, "i");
  const understandingRe = new RegExp(settings.ruleUnderstanding, "i");

  const customRules = parseCustomPurposeRules(settings.customRules ?? "");
  let session_purpose = "问题咨询";
  const matchedCustom = customRules.find((rule) => rule.re.test(merged));
  if (matchedCustom) {
    session_purpose = matchedCustom.label;
  } else if (codeReviewRe.test(merged)) {
    session_purpose = "代码评审";
  } else if (troubleshootingRe.test(merged)) {
    session_purpose = "问题排查";
  } else if (developmentRe.test(merged)) {
    session_purpose = "功能开发";
  } else if (understandingRe.test(merged)) {
    session_purpose = "代码理解";
  }

  const titleNorm = title.replace(/\s+/g, " ").trim();
  const summaryNorm = summary.replace(/\s+/g, " ").trim();
  const projectName = project.split("/").pop()?.trim() ?? "";
  const noiseWords = new Set(
    settings.noiseWords
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
  );
  const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
  const isNoise = (value: string): boolean => {
    const v = normalize(value).toLowerCase();
    if (!v || v.length < 2) return true;
    if (noiseWords.has(v)) return true;
    if (v.startsWith(".") && !v.includes("-") && !v.includes("_")) return true;
    return false;
  };

  const extractModuleToken = (text: string): string => {
    const matches = text.match(/[a-z0-9]+(?:[-_][a-z0-9]+){1,}/gi) ?? [];
    for (const item of matches) {
      if (!isNoise(item)) return normalize(item);
    }
    return "";
  };
  const moduleName = (() => {
    const sourcePath = String(row.source_path ?? "").replace(/\\/g, "/");
    const parts = sourcePath.split("/").filter(Boolean);
    if (parts.length === 0) return "";
    const filePart = parts[parts.length - 1] ?? "";
    const name = normalize(filePart.replace(/\.(jsonl|json)$/i, ""));
    if (name && !/^rollout-/i.test(name) && !/^session-/i.test(name) && !isNoise(name)) {
      return name;
    }
    for (let i = parts.length - 2; i >= 0; i -= 1) {
      const v = normalize(parts[i] ?? "");
      if (!v || /^\d{4}$/.test(v) || /^\d{2}$/.test(v) || isNoise(v)) {
        continue;
      }
      if (v.length >= 2) return v;
    }
    return "";
  })();
  const titleModule = extractModuleToken(titleNorm);
  const summaryModule = extractModuleToken(summaryNorm);
  const summaryKeyword = (() => {
    const m = summaryNorm.match(/(?:关键词|keywords)\s*[:：]\s*([^|\n]+)/i);
    if (!m?.[1]) return "";
    const first = m[1]
      .split(/[,，]/)
      .map((v) => v.trim())
      .filter(Boolean)
      .find((v) => v.length >= 2);
    return first ?? "";
  })();

  const candidates: Array<{ value: string; kind: "module" | "keyword" | "fallback" }> = [
    { value: projectName, kind: "module" },
    { value: titleModule, kind: "module" },
    { value: summaryModule, kind: "module" },
    { value: moduleName, kind: "module" },
    { value: summaryKeyword, kind: "keyword" },
    { value: summaryNorm.split(/[。.!?]/)[0]?.trim() ?? "", kind: "fallback" },
    { value: titleNorm.split(/[。.!?]/)[0]?.trim() ?? "", kind: "fallback" },
  ];

  const picked = candidates.find((item) => {
    const v = normalize(item.value);
    if (isNoise(v)) return false;
    if (item.kind !== "module" && titleNorm && titleNorm.includes(v)) return false;
    return true;
  });

  let session_target = normalize(picked?.value ?? "");
  if (!session_target) session_target = projectName || titleModule || summaryModule || "会话目标";
  if (isNoise(session_target)) session_target = "会话目标";

  if ((picked?.kind ?? "fallback") !== "module" && session_target.length > settings.shortTargetMaxLen) {
    session_target = `${session_target.slice(0, settings.shortTargetMaxLen).trim()}…`;
  }
  return { session_purpose, session_target };
}

function withResumeHint(row: SessionRow, purposeSettings: PurposeSettings): SessionEnriched {
  const nativeSessionId = extractNativeSessionId(row.tool, row.id, String(row.source_path ?? ""));
  const project = typeof row.project === "string" ? row.project : null;
  const hint = buildResumeHint(row.tool, nativeSessionId, project);
  const inferred = inferSessionPurposeAndTarget(row, purposeSettings);
  const savedPurpose = typeof row.session_purpose === "string" ? row.session_purpose.trim() : "";
  const savedTarget = typeof row.session_target === "string" ? row.session_target.trim() : "";
  const displayTitle = sanitizeDisplayTitle(String(row.title ?? ""), savedTarget || inferred.session_target);
  return {
    ...row,
    title: displayTitle,
    native_session_id: nativeSessionId,
    resume_command: hint.command,
    resume_label: hint.label,
    session_purpose: savedPurpose || inferred.session_purpose,
    session_target: savedTarget || inferred.session_target,
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

app.get("/api/purpose/settings", async () => {
  return { ok: true, settings: getPurposeSettings() };
});

app.post("/api/purpose/settings", async (request) => {
  const body = (request.body ?? {}) as Partial<PurposeSettings>;
  const settings = setPurposeSettings(body);
  return { ok: true, settings };
});

app.post("/api/purpose/reclassify", async () => {
  const settings = getPurposeSettings();
  const rows = db
    .prepare("SELECT id, tool, source_path, title, summary, project, session_purpose, session_target FROM sessions")
    .all() as SessionRow[];
  const update = db.prepare(
    "UPDATE sessions SET session_purpose = ?, session_target = ?, updated_at = ? WHERE id = ?"
  );
  const now = new Date().toISOString();
  const tx = db.transaction((items: SessionRow[]) => {
    let changed = 0;
    for (const row of items) {
      const inferred = inferSessionPurposeAndTarget(row, settings);
      const currentPurpose = typeof row.session_purpose === "string" ? row.session_purpose : "";
      const currentTarget = typeof row.session_target === "string" ? row.session_target : "";
      if (currentPurpose === inferred.session_purpose && currentTarget === inferred.session_target) continue;
      update.run(inferred.session_purpose, inferred.session_target, now, row.id);
      changed += 1;
    }
    return changed;
  });
  const changed = tx(rows);
  return { ok: true, total: rows.length, changed };
});

app.get("/api/sessions", async (request, reply) => {
  const query = (request.query as Record<string, string | undefined>).query?.trim() ?? "";
  const ftsQuery = buildFtsMatchQuery(query);
  const likeQuery = `%${query.replace(/[%_]/g, "\\$&")}%`;
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
  const purposeSettings = getPurposeSettings();

  if (!query) {
    const rows = (await withDbRetry(() =>
      db
        .prepare(
          `SELECT * FROM sessions s WHERE 1=1 ${toolClause} ORDER BY datetime(start_time) DESC LIMIT ? OFFSET ?`
        )
        .all(...toolFilters, pageSize, offset)
    )) as SessionRow[];
    const total = (await withDbRetry(() =>
      db
        .prepare(`SELECT COUNT(*) as c FROM sessions s WHERE 1=1 ${toolClause}`)
        .get(...toolFilters)
    )) as { c: number };
    return { items: rows.map((row) => withResumeHint(row, purposeSettings)), total: total.c };
  }

  if (!ftsQuery && scope !== "all") {
    return { items: [], total: 0 };
  }

  const roleFilter = scope === "question" ? "AND f.role = 'user'" : scope === "answer" ? "AND f.role = 'assistant'" : "";

  let rows: SessionRow[] = [];
  let total: { c: number } = { c: 0 };
  try {
    if (scope === "all") {
      rows = (await withDbRetry(() =>
        db
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
          s.session_purpose,
          s.session_target,
          s.message_count,
          s.created_at,
          s.updated_at,
          f.role AS hit_role,
          substr(f.content, 1, 120) AS hit_excerpt
        FROM sessions s
        JOIN message_fts f ON f.session_id = s.id
        WHERE f.content MATCH ? ${toolClause}
        UNION ALL
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
          s.session_purpose,
          s.session_target,
          s.message_count,
          s.created_at,
          s.updated_at,
          'meta' AS hit_role,
          substr(
            COALESCE(NULLIF(s.title,''), NULLIF(s.summary,''), NULLIF(s.project,''), s.source_path),
            1, 120
          ) AS hit_excerpt
        FROM sessions s
        WHERE (
          s.title LIKE ? ESCAPE '\\' OR
          s.summary LIKE ? ESCAPE '\\' OR
          COALESCE(s.project,'') LIKE ? ESCAPE '\\' OR
          s.source_path LIKE ? ESCAPE '\\'
        ) ${toolClause}
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
        session_purpose,
        session_target,
        message_count,
        created_at,
        updated_at,
        0.0 AS hit_score,
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
        session_purpose,
        session_target,
        message_count,
        created_at,
        updated_at
      ORDER BY datetime(start_time) DESC
      LIMIT ? OFFSET ?
    `
          )
          .all(ftsQuery, ...toolFilters, likeQuery, likeQuery, likeQuery, likeQuery, ...toolFilters, pageSize, offset)
      )) as SessionRow[];

      total = (await withDbRetry(() =>
        db
          .prepare(
            `
      WITH matched_ids AS (
        SELECT s.id
        FROM sessions s
        JOIN message_fts f ON f.session_id = s.id
        WHERE f.content MATCH ? ${toolClause}
        UNION
        SELECT s.id
        FROM sessions s
        WHERE (
          s.title LIKE ? ESCAPE '\\' OR
          s.summary LIKE ? ESCAPE '\\' OR
          COALESCE(s.project,'') LIKE ? ESCAPE '\\' OR
          s.source_path LIKE ? ESCAPE '\\'
        ) ${toolClause}
      )
      SELECT COUNT(*) as c FROM matched_ids
    `
          )
          .get(ftsQuery, ...toolFilters, likeQuery, likeQuery, likeQuery, likeQuery, ...toolFilters)
      )) as { c: number };
    } else {
      const queryParams = [ftsQuery, ...toolFilters, pageSize, offset];
      const totalParams = [ftsQuery, ...toolFilters];
      rows = (await withDbRetry(() =>
        db
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
          s.session_purpose,
          s.session_target,
          s.message_count,
          s.created_at,
          s.updated_at,
          f.role AS hit_role,
          substr(f.content, 1, 120) AS hit_excerpt
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
        session_purpose,
        session_target,
        message_count,
        created_at,
        updated_at,
        0.0 AS hit_score,
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
        session_purpose,
        session_target,
        message_count,
        created_at,
        updated_at
      ORDER BY datetime(start_time) DESC
      LIMIT ? OFFSET ?
    `
          )
          .all(...queryParams)
      )) as SessionRow[];

      total = (await withDbRetry(() =>
        db
          .prepare(
            `
      SELECT COUNT(DISTINCT s.id) as c
      FROM sessions s
      JOIN message_fts f ON f.session_id = s.id
      WHERE f.content MATCH ? ${roleFilter} ${toolClause}
    `
          )
          .get(...totalParams)
      )) as { c: number };
    }
  } catch (error) {
    if (isFtsQuerySyntaxError(error)) {
      reply.status(400);
      return { error: "搜索语法不合法，请输入普通关键词（空格分隔）。" };
    }
    throw error;
  }

  return { items: rows.map((row) => withResumeHint(row, purposeSettings)), total: total.c };
});

app.get("/api/session", async (request, reply) => {
  const id = ((request.query as Record<string, string | undefined>).id ?? "").trim();
  if (!id) {
    reply.status(400);
    return { error: "Missing id" };
  }

  const rawSession = (await withDbRetry(() =>
    db.prepare("SELECT * FROM sessions WHERE id = ?").get(id)
  )) as SessionRow | undefined;
  const session = rawSession ? withResumeHint(rawSession, getPurposeSettings()) : null;
  if (!session) {
    reply.status(404);
    return { error: "Session not found" };
  }

  const messages = await withDbRetry(() =>
    db
      .prepare(
        `SELECT id, session_id, role, ts, content, turn_index, seq_in_session
         FROM messages WHERE session_id = ? ORDER BY seq_in_session ASC`
      )
      .all(id)
  );

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
