import Fastify from "fastify";
import cors from "@fastify/cors";
import { db, getDbPath } from "./db.js";
import { syncClaudeSessions } from "./claude-ingest.js";
import { syncCodexSessions } from "./codex-ingest.js";
import { syncCopilotSessions } from "./copilot-ingest.js";
import { syncGeminiSessions } from "./gemini-ingest.js";
import { syncOpencodeSessions } from "./opencode-ingest.js";
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
import { computeUsageContributions } from "./usage.js";
import type { UsageInput } from "./types.js";

const app = Fastify({ logger: false });
const port = Number(process.env.PORT ?? 8765);
const AUTO_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const DB_RETRY_ATTEMPTS = Math.max(1, Number(process.env.DB_RETRY_ATTEMPTS ?? "6"));
const DB_RETRY_DELAY_MS = Math.max(10, Number(process.env.DB_RETRY_DELAY_MS ?? "120"));

await app.register(cors, { origin: true });

type SessionRow = {
  id: string;
  tool: "codex" | "claude" | "copilot" | "gemini" | "opencode" | string;
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

const SESSION_SELECT_COLUMNS = `
  s.*,
  u.usage_status,
  u.provider AS usage_provider,
  u.model AS usage_model,
  u.input_tokens AS usage_input_tokens,
  u.output_tokens AS usage_output_tokens,
  u.reasoning_tokens AS usage_reasoning_tokens,
  u.cache_read_tokens AS usage_cache_read_tokens,
  u.cache_write_tokens AS usage_cache_write_tokens,
  u.tool_tokens AS usage_tool_tokens,
  u.total_tokens AS usage_total_tokens,
  u.cost AS usage_cost,
  u.record_count AS usage_record_count,
  u.last_usage_time,
  (
    SELECT COUNT(*)
    FROM messages m
    WHERE m.session_id = s.id AND m.role = 'user'
  ) AS question_count
`;

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
  if (tool === "opencode") return tail;
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
  if (tool === "opencode" && nativeSessionId) {
    return { command: `${projectPrefix}opencode --session ${nativeSessionId}`, label: "Resume" };
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

function isWeakDisplayTitle(value: string): boolean {
  const t = value.replace(/\s+/g, " ").trim();
  if (!t) return true;
  const lower = t.toLowerCase();
  return (
    lower.startsWith("<image name=") ||
    lower.startsWith("[image #") ||
    lower.startsWith("</image>") ||
    lower === "<instructions>" ||
    lower === "<permissions instructions>" ||
    lower.startsWith("# ") ||
    lower.startsWith("## ") ||
    lower.startsWith("<command-message") ||
    lower.includes("instructions") ||
    lower === "hello" ||
    lower === "say hello" ||
    lower === "你好" ||
    lower === "你好，你是什么模型" ||
    lower === "/status" ||
    lower === "/status "
  );
}

function headlineFromSummary(summary: string): string {
  const s = summary.trim();
  if (!s) return "";
  const splitMatch = s.match(/^(.*?)\s*\|\s*(?:关键词|keywords)\s*[:：]/i);
  if (splitMatch?.[1]) return splitMatch[1].trim();
  if (/^(关键词|keywords)\s*[:：]/i.test(s)) return "";
  return s;
}

function sanitizeDisplayTitle(title: string, target: string, purpose: string, summary: string): string {
  const t = title.trim();
  if (!t || isWeakDisplayTitle(t)) {
    const cleanTarget = target && target !== "会话目标" ? target : "";
    const cleanSummary = headlineFromSummary(summary);
    if (cleanTarget && purpose) return `${cleanTarget}：${purpose}`;
    if (cleanSummary) return cleanSummary.length > 90 ? `${cleanSummary.slice(0, 87)}...` : cleanSummary;
    if (cleanTarget) return `${cleanTarget} 会话`;
    return "Untitled Session";
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
  const builtinNoise = new Set([
    "users",
    "user",
    "home",
    "src",
    "tmp",
    "sessions",
    "session",
    "events",
    "projects",
    "project",
    "workspace",
    "workspaces",
    "repos",
    "repo",
    "chat-archive",
    "share",
    "local",
    "state",
    "opencode",
    "opencode.db",
  ]);
  const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
  const looksLikeUuid = (value: string): boolean =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const looksLikeHash = (value: string): boolean =>
    /^[0-9a-f]{16,}$/i.test(value) ||
    /^([0-9a-f]{4,}[-_]){2,}[0-9a-f]{4,}$/i.test(value) ||
    (/^[a-z0-9_-]{20,}$/i.test(value) && !/[aeiou]/i.test(value));
  const looksLikeId = (value: string): boolean => looksLikeUuid(value) || looksLikeHash(value);
  const isNoise = (value: string): boolean => {
    const v = normalize(value).toLowerCase();
    if (!v || v.length < 2) return true;
    if (noiseWords.has(v)) return true;
    if (builtinNoise.has(v)) return true;
    if (looksLikeId(v)) return true;
    if (/^[a-z]{1,3}$/i.test(v)) return true;
    if (/^\d+$/.test(v)) return true;
    if (v.includes("#session:")) return true;
    if (v.endsWith(".db")) return true;
    if (v.includes(".db#")) return true;
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
  const extractEntityToken = (text: string): string => {
    const tokenStop = new Set([
      "session",
      "summary",
      "target",
      "task",
      "check",
      "trace",
      "inspect",
      "investigate",
      "install",
      "configure",
      "external",
      "behavior",
      "subagent",
      "review",
      "analysis",
      "problem",
      "issue",
      "question",
      "answer",
      "prompt",
      "default",
      "latest",
      "current",
      "system",
      "assistant",
      "user",
      "message",
      "messages",
    ]);
    const asciiTokens = (text.match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) ?? []).filter((raw) => {
      const v = raw.trim();
      if (!v) return false;
      if (isNoise(v)) return false;
      if (looksLikeId(v)) return false;
      if (tokenStop.has(v.toLowerCase())) return false;
      return true;
    });
    if (asciiTokens.length > 0) {
      let best = asciiTokens[0];
      let bestScore = -1;
      for (const token of asciiTokens) {
        let score = 0;
        if (/[A-Z]/.test(token) && /[a-z]/.test(token)) score += 2;
        if (/[-_.]/.test(token)) score += 2;
        if (/^[A-Za-z][A-Za-z0-9._-]{4,20}$/.test(token)) score += 1;
        if (/kube|pod|sched|daemon|queue|webhook|controller|linux|spark|etcd|apiserver|grpc|http/i.test(token)) {
          score += 3;
        }
        if (score > bestScore) {
          best = token;
          bestScore = score;
        }
      }
      return normalize(best);
    }

    const cleaned = text
      .replace(/[()（）[\]【】]/g, " ")
      .replace(/^(排查|分析|根据|关于|修复|优化|实现|支持|检查|查看|处理|定位|解决|总结|评审|代码审查)\s*/i, "");
    const segments = cleaned
      .split(/[，,。.!?？:：/|]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const cnStop = new Set(["问题", "根因", "分析", "排查", "咨询", "理解", "评审", "会话", "目标", "代码"]);
    for (const seg of segments) {
      const candidate = seg
        .replace(/^(排查|分析|根据|关于|修复|优化|实现|支持|检查|查看|处理|定位|解决|总结)\s*/i, "")
        .replace(/(原理|机制|方案|方法|流程|问题|根因|时间|状态|实现|设计|优化|分析|排查|咨询|评审|理解)$/i, "")
        .trim();
      if (!candidate) continue;
      if (cnStop.has(candidate)) continue;
      if (/^[\u4e00-\u9fa5]{2,14}$/.test(candidate)) return candidate;
    }
    return "";
  };
  const moduleName = (() => {
    const sourcePath = String(row.source_path ?? "").replace(/\\/g, "/");
    const parts = sourcePath.split("/").filter(Boolean);
    if (parts.length === 0) return "";
    let best = "";
    let bestScore = -1;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const raw = normalize(parts[i] ?? "");
      const v = normalize(raw.replace(/\.(jsonl|json|md|txt)$/i, ""));
      if (!v || /^\d{4}$/.test(v) || /^\d{2}$/.test(v) || /^rollout-/i.test(v) || /^session-/i.test(v) || isNoise(v)) {
        continue;
      }
      const lower = v.toLowerCase();
      let score = 0;
      if (/[-_]/.test(v)) score += 4;
      if (/[a-z]/i.test(v) && /\d/.test(v)) score += 1;
      if (/^[a-z][a-z0-9_-]{3,}$/i.test(v)) score += 2;
      if (/kube|sched|daemon|server|controller|webhook|operator|gateway|proxy/i.test(v)) score += 2;
      if (/\./.test(lower)) score -= 2;
      if (/#|:/.test(v)) score -= 6;
      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    return best;
  })();
  const titleModule = extractModuleToken(titleNorm);
  const summaryModule = extractModuleToken(summaryNorm);
  const titleEntity = extractEntityToken(titleNorm);
  const summaryEntity = extractEntityToken(summaryNorm);
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

  const candidates: Array<{ value: string; kind: "module" | "keyword" | "entity" }> = [
    { value: projectName, kind: "module" },
    { value: titleModule, kind: "module" },
    { value: summaryModule, kind: "module" },
    { value: moduleName, kind: "module" },
    { value: titleEntity, kind: "entity" },
    { value: summaryEntity, kind: "entity" },
    { value: summaryKeyword, kind: "keyword" },
  ];

  const picked = candidates.find((item) => {
    const v = normalize(item.value);
    if (isNoise(v)) return false;
    return true;
  });

  let session_target = normalize(picked?.value ?? "");
  if (!session_target) session_target = projectName || titleModule || summaryModule || "会话目标";
  if (isNoise(session_target)) session_target = "会话目标";

  return { session_purpose, session_target };
}

function withResumeHint(row: SessionRow, purposeSettings: PurposeSettings): SessionEnriched {
  const nativeSessionId = extractNativeSessionId(row.tool, row.id, String(row.source_path ?? ""));
  const project = typeof row.project === "string" ? row.project : null;
  const hint = buildResumeHint(row.tool, nativeSessionId, project);
  const inferred = inferSessionPurposeAndTarget(row, purposeSettings);
  const savedPurpose = typeof row.session_purpose === "string" ? row.session_purpose.trim() : "";
  const savedTarget = typeof row.session_target === "string" ? row.session_target.trim() : "";
  const effectiveTarget = !savedTarget || savedTarget === "会话目标" ? inferred.session_target : savedTarget;
  const effectivePurpose = savedPurpose || inferred.session_purpose;
  const displayTitle = sanitizeDisplayTitle(String(row.title ?? ""), effectiveTarget, effectivePurpose, String(row.summary ?? ""));
  return {
    ...row,
    title: displayTitle,
    native_session_id: nativeSessionId,
    resume_command: hint.command,
    resume_label: hint.label,
    session_purpose: effectivePurpose,
    session_target: effectiveTarget,
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

app.post("/api/reindex/session", async (request, reply) => {
  const body = (request.body ?? {}) as { sessionId?: string };
  const sessionId = String(body.sessionId ?? "").trim();
  if (!sessionId) {
    reply.code(400);
    return { ok: false, error: "sessionId is required" };
  }
  const taskState = getSyncTaskState();
  if (taskState.running) {
    reply.code(409);
    return { ok: false, error: "sync task running, try later" };
  }

  const row = db
    .prepare("SELECT id, tool, source_path FROM sessions WHERE id = ?")
    .get(sessionId) as { id: string; tool: string; source_path: string } | undefined;
  if (!row) {
    reply.code(404);
    return { ok: false, error: "session not found" };
  }
  if (!row.source_path) {
    reply.code(400);
    return { ok: false, error: "source_path missing for this session" };
  }

  db.prepare("DELETE FROM ingest_state WHERE source_path = ?").run(row.source_path);
  const onlyPaths = new Set([row.source_path]);
  const stats =
    row.tool === "codex"
      ? syncCodexSessions(undefined, { onlyPaths })
      : row.tool === "claude"
        ? syncClaudeSessions(undefined, { onlyPaths })
        : row.tool === "copilot"
          ? syncCopilotSessions(undefined, { onlyPaths })
          : row.tool === "gemini"
            ? syncGeminiSessions(undefined, { onlyPaths })
            : row.tool === "opencode"
              ? syncOpencodeSessions(undefined, { onlyPaths })
            : null;
  if (!stats) {
    reply.code(400);
    return { ok: false, error: `unsupported tool: ${row.tool}` };
  }
  const latest = db
    .prepare("SELECT id, tool, source_path, title, summary, project FROM sessions WHERE source_path = ? LIMIT 1")
    .get(row.source_path) as SessionRow | undefined;
  if (latest) {
    const inferred = inferSessionPurposeAndTarget(latest, getPurposeSettings());
    db.prepare("UPDATE sessions SET session_purpose = ?, session_target = ?, updated_at = ? WHERE id = ?").run(
      inferred.session_purpose,
      inferred.session_target,
      new Date().toISOString(),
      latest.id
    );
  }
  return { ok: true, stats, sessionId: row.id };
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
    | "gemini"
    | "opencode";
  const toolsRaw = (request.query as Record<string, string | undefined>).tools?.trim() ?? "";
  const fromTools = toolsRaw
    .split(",")
    .map((v) => v.trim())
    .filter(
      (v): v is "codex" | "claude" | "copilot" | "gemini" | "opencode" =>
        v === "codex" || v === "claude" || v === "copilot" || v === "gemini" || v === "opencode"
    );
  const legacyTool =
    tool === "codex" || tool === "claude" || tool === "copilot" || tool === "gemini" || tool === "opencode" ? [tool] : [];
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
          `SELECT ${SESSION_SELECT_COLUMNS}
           FROM sessions s
           LEFT JOIN session_usage_summary u ON u.session_id = s.id
           WHERE 1=1 ${toolClause}
           ORDER BY datetime(start_time) DESC LIMIT ? OFFSET ?`
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
          u.usage_status,
          u.provider AS usage_provider,
          u.model AS usage_model,
          u.input_tokens AS usage_input_tokens,
          u.output_tokens AS usage_output_tokens,
          u.reasoning_tokens AS usage_reasoning_tokens,
          u.cache_read_tokens AS usage_cache_read_tokens,
          u.cache_write_tokens AS usage_cache_write_tokens,
          u.tool_tokens AS usage_tool_tokens,
          u.total_tokens AS usage_total_tokens,
          u.cost AS usage_cost,
          u.record_count AS usage_record_count,
          u.last_usage_time,
          (
            SELECT COUNT(*)
            FROM messages m
            WHERE m.session_id = s.id AND m.role = 'user'
          ) AS question_count,
          s.created_at,
          s.updated_at,
          f.role AS hit_role,
          substr(f.content, 1, 120) AS hit_excerpt
        FROM sessions s
        LEFT JOIN session_usage_summary u ON u.session_id = s.id
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
          u.usage_status,
          u.provider AS usage_provider,
          u.model AS usage_model,
          u.input_tokens AS usage_input_tokens,
          u.output_tokens AS usage_output_tokens,
          u.reasoning_tokens AS usage_reasoning_tokens,
          u.cache_read_tokens AS usage_cache_read_tokens,
          u.cache_write_tokens AS usage_cache_write_tokens,
          u.tool_tokens AS usage_tool_tokens,
          u.total_tokens AS usage_total_tokens,
          u.cost AS usage_cost,
          u.record_count AS usage_record_count,
          u.last_usage_time,
          (
            SELECT COUNT(*)
            FROM messages m
            WHERE m.session_id = s.id AND m.role = 'user'
          ) AS question_count,
          s.created_at,
          s.updated_at,
          'meta' AS hit_role,
          substr(
            COALESCE(NULLIF(s.title,''), NULLIF(s.summary,''), NULLIF(s.project,''), s.source_path),
            1, 120
          ) AS hit_excerpt
        FROM sessions s
        LEFT JOIN session_usage_summary u ON u.session_id = s.id
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
        usage_status,
        usage_provider,
        usage_model,
        usage_input_tokens,
        usage_output_tokens,
        usage_reasoning_tokens,
        usage_cache_read_tokens,
        usage_cache_write_tokens,
        usage_tool_tokens,
        usage_total_tokens,
        usage_cost,
        usage_record_count,
        last_usage_time,
        question_count,
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
        usage_status,
        usage_provider,
        usage_model,
        usage_input_tokens,
        usage_output_tokens,
        usage_reasoning_tokens,
        usage_cache_read_tokens,
        usage_cache_write_tokens,
        usage_tool_tokens,
        usage_total_tokens,
        usage_cost,
        usage_record_count,
        last_usage_time,
        question_count,
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
          u.usage_status,
          u.provider AS usage_provider,
          u.model AS usage_model,
          u.input_tokens AS usage_input_tokens,
          u.output_tokens AS usage_output_tokens,
          u.reasoning_tokens AS usage_reasoning_tokens,
          u.cache_read_tokens AS usage_cache_read_tokens,
          u.cache_write_tokens AS usage_cache_write_tokens,
          u.tool_tokens AS usage_tool_tokens,
          u.total_tokens AS usage_total_tokens,
          u.cost AS usage_cost,
          u.record_count AS usage_record_count,
          u.last_usage_time,
          (
            SELECT COUNT(*)
            FROM messages m
            WHERE m.session_id = s.id AND m.role = 'user'
          ) AS question_count,
          s.created_at,
          s.updated_at,
          f.role AS hit_role,
          substr(f.content, 1, 120) AS hit_excerpt
        FROM sessions s
        LEFT JOIN session_usage_summary u ON u.session_id = s.id
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
        usage_status,
        usage_provider,
        usage_model,
        usage_input_tokens,
        usage_output_tokens,
        usage_reasoning_tokens,
        usage_cache_read_tokens,
        usage_cache_write_tokens,
        usage_tool_tokens,
        usage_total_tokens,
        usage_cost,
        usage_record_count,
        last_usage_time,
        question_count,
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
        usage_status,
        usage_provider,
        usage_model,
        usage_input_tokens,
        usage_output_tokens,
        usage_reasoning_tokens,
        usage_cache_read_tokens,
        usage_cache_write_tokens,
        usage_tool_tokens,
        usage_total_tokens,
        usage_cost,
        usage_record_count,
        last_usage_time,
        question_count,
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

app.get("/api/usage/overview", async (request) => {
  const toolsRaw = (request.query as Record<string, string | undefined>).tools?.trim() ?? "";
  const days = Math.max(1, Number((request.query as Record<string, string | undefined>).days ?? "30"));
  const toolFilters = toolsRaw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const toolClause =
    toolFilters.length === 0 ? "" : `WHERE tool IN (${new Array(toolFilters.length).fill("?").join(",")})`;
  const totals = (await withDbRetry(() =>
    db
      .prepare(
        `SELECT
          COUNT(*) AS sessions,
          SUM(total_tokens) AS total_tokens,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(reasoning_tokens) AS reasoning_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens,
          SUM(cache_write_tokens) AS cache_write_tokens,
          SUM(tool_tokens) AS tool_tokens,
          SUM(cost) AS cost
         FROM session_usage_summary ${toolClause}`
      )
      .get(...toolFilters)
  )) as Record<string, number | null>;
  const coverage = (await withDbRetry(() =>
    db
      .prepare(
        `SELECT
          COUNT(*) AS total_sessions,
          SUM(CASE WHEN usage_status IS NOT NULL THEN 1 ELSE 0 END) AS covered_sessions
         FROM sessions s
         LEFT JOIN session_usage_summary u ON u.session_id = s.id ${
           toolFilters.length === 0 ? "" : `WHERE s.tool IN (${new Array(toolFilters.length).fill("?").join(",")})`
         }`
      )
      .get(...toolFilters)
  )) as Record<string, number | null>;
  const byTool = (await withDbRetry(() =>
    db
      .prepare(
        `SELECT tool, COUNT(*) AS sessions, SUM(total_tokens) AS total_tokens, SUM(cost) AS cost
         FROM session_usage_summary
         ${toolClause}
         GROUP BY tool
         ORDER BY SUM(total_tokens) DESC`
      )
      .all(...toolFilters)
  )) as Array<Record<string, unknown>>;
  const recentRaw = (await withDbRetry(() =>
    db
      .prepare(
        `SELECT
          session_id, tool, project, provider, model, record_type, source_type, usage_semantics, usage_time,
          input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, tool_tokens,
          total_tokens, cost, raw_ref
         FROM usage_records
         WHERE usage_time >= datetime('now', ?) ${
           toolFilters.length === 0 ? "" : `AND tool IN (${new Array(toolFilters.length).fill("?").join(",")})`
         }
         ORDER BY datetime(usage_time) ASC`
      )
      .all(`-${days} days`, ...toolFilters)
  )) as UsageInput[];
  const recentContrib = computeUsageContributions(recentRaw);
  const recent = recentContrib.reduce(
    (acc, record) => ({
      total_tokens: acc.total_tokens + Number(record.total_tokens ?? 0),
      cost: (acc.cost ?? 0) + Number(record.cost ?? 0),
    }),
    { total_tokens: 0, cost: 0 }
  );

  return {
    ok: true,
    totals,
    recent,
    byTool,
    coverage: {
      totalSessions: Number(coverage.total_sessions ?? 0),
      coveredSessions: Number(coverage.covered_sessions ?? 0),
    },
  };
});

app.get("/api/usage/timeseries", async (request) => {
  const days = Math.max(1, Math.min(365, Number((request.query as Record<string, string | undefined>).days ?? "30")));
  const toolsRaw = (request.query as Record<string, string | undefined>).tools?.trim() ?? "";
  const toolFilters = toolsRaw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const toolClause =
    toolFilters.length === 0 ? "" : `AND tool IN (${new Array(toolFilters.length).fill("?").join(",")})`;
  const raw = (await withDbRetry(() =>
    db
      .prepare(
        `SELECT
          session_id, tool, project, provider, model, record_type, source_type, usage_semantics, usage_time,
          input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, tool_tokens,
          total_tokens, cost, raw_ref
         FROM usage_records
         WHERE usage_time >= datetime('now', ?) ${toolClause}
         ORDER BY datetime(usage_time) ASC`
      )
      .all(`-${days} days`, ...toolFilters)
  )) as UsageInput[];
  const contributions = computeUsageContributions(raw);
  const dayMap = new Map<string, Record<string, unknown>>();
  for (const record of contributions) {
    const day = record.usage_time.slice(0, 10);
    if (!day) continue;
    const prev =
      dayMap.get(day) ??
      ({
        day,
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        tool_tokens: 0,
        total_tokens: 0,
        cost: 0,
      } as Record<string, unknown>);
    prev.input_tokens = Number(prev.input_tokens) + record.input_tokens;
    prev.output_tokens = Number(prev.output_tokens) + record.output_tokens;
    prev.reasoning_tokens = Number(prev.reasoning_tokens) + record.reasoning_tokens;
    prev.cache_read_tokens = Number(prev.cache_read_tokens) + record.cache_read_tokens;
    prev.cache_write_tokens = Number(prev.cache_write_tokens) + record.cache_write_tokens;
    prev.tool_tokens = Number(prev.tool_tokens) + record.tool_tokens;
    prev.total_tokens = Number(prev.total_tokens) + record.total_tokens;
    prev.cost = Number(prev.cost) + Number(record.cost ?? 0);
    dayMap.set(day, prev);
  }
  const rows = Array.from(dayMap.values()).sort((a, b) => String(a.day).localeCompare(String(b.day)));
  return { ok: true, items: rows };
});

app.get("/api/usage/sessions", async (request) => {
  const page = Math.max(1, Number((request.query as Record<string, string | undefined>).page ?? "1"));
  const pageSize = Math.min(100, Math.max(1, Number((request.query as Record<string, string | undefined>).pageSize ?? "20")));
  const toolsRaw = (request.query as Record<string, string | undefined>).tools?.trim() ?? "";
  const sortBy = ((request.query as Record<string, string | undefined>).sortBy ?? "total_tokens").trim();
  const offset = (page - 1) * pageSize;
  const toolFilters = toolsRaw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const toolClause =
    toolFilters.length === 0 ? "" : `WHERE s.tool IN (${new Array(toolFilters.length).fill("?").join(",")})`;
  const orderClause =
    sortBy === "start_time" ? "datetime(s.start_time) DESC" : sortBy === "cost" ? "COALESCE(u.cost, 0) DESC" : "COALESCE(u.total_tokens, 0) DESC";
  const rows = (await withDbRetry(() =>
    db
      .prepare(
        `SELECT ${SESSION_SELECT_COLUMNS}
         FROM sessions s
         LEFT JOIN session_usage_summary u ON u.session_id = s.id
         ${toolClause}
         ORDER BY ${orderClause}, datetime(s.start_time) DESC
         LIMIT ? OFFSET ?`
      )
      .all(...toolFilters, pageSize, offset)
  )) as SessionRow[];
  const total = (await withDbRetry(() =>
    db
      .prepare(`SELECT COUNT(*) AS c FROM sessions s ${toolClause}`)
      .get(...toolFilters)
  )) as { c: number };
  return { ok: true, items: rows.map((row) => withResumeHint(row, getPurposeSettings())), total: total.c };
});

app.get("/api/session/usage", async (request, reply) => {
  const id = ((request.query as Record<string, string | undefined>).id ?? "").trim();
  if (!id) {
    reply.status(400);
    return { error: "Missing id" };
  }
  const summary = (await withDbRetry(() =>
    db.prepare("SELECT * FROM session_usage_summary WHERE session_id = ?").get(id)
  )) as Record<string, unknown> | undefined;
  const records = (await withDbRetry(() =>
    db
      .prepare(
        `SELECT session_id, tool, project, provider, model, record_type, source_type, usage_semantics, usage_time, input_tokens, output_tokens,
                reasoning_tokens, cache_read_tokens, cache_write_tokens, tool_tokens, total_tokens, cost, raw_ref
         FROM usage_records
         WHERE session_id = ?
         ORDER BY datetime(usage_time) ASC`
      )
      .all(id)
  )) as UsageInput[];
  const contributions = computeUsageContributions(records);
  const timelineMap = new Map<string, { day: string; total_tokens: number }>();
  for (const item of contributions) {
    const day = item.usage_time.slice(0, 10);
    if (!day) continue;
    const prev = timelineMap.get(day) ?? { day, total_tokens: 0 };
    prev.total_tokens += item.total_tokens;
    timelineMap.set(day, prev);
  }
  return {
    ok: true,
    summary: summary ?? null,
    records,
    contributions,
    timeline: Array.from(timelineMap.values()).sort((a, b) => a.day.localeCompare(b.day)),
  };
});

app.get("/api/session", async (request, reply) => {
  const id = ((request.query as Record<string, string | undefined>).id ?? "").trim();
  if (!id) {
    reply.status(400);
    return { error: "Missing id" };
  }

  const rawSession = (await withDbRetry(() =>
    db
      .prepare(`SELECT ${SESSION_SELECT_COLUMNS} FROM sessions s LEFT JOIN session_usage_summary u ON u.session_id = s.id WHERE s.id = ?`)
      .get(id)
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
