import { db, nowIso } from "./db.js";

export type SummaryProvider = "codex" | "qwen" | "rule" | "hybrid";

export interface SummarySettings {
  provider: SummaryProvider;
  model: string;
  timeoutMs: number;
  codexLimitPerRun: number;
  lastError: string;
}

const DEFAULTS: SummarySettings = {
  provider: ((): SummaryProvider => {
    const raw = (process.env.CHAT_ARCHIVE_SUMMARY_PROVIDER ?? "rule").toLowerCase();
    if (raw === "rule") return "rule";
    if (raw === "hybrid") return "hybrid";
    if (raw === "qwen") return "qwen";
    return "codex";
  })(),
  model: process.env.CHAT_ARCHIVE_SUMMARY_MODEL ?? "gpt-5-codex",
  timeoutMs: Number(process.env.CHAT_ARCHIVE_SUMMARY_TIMEOUT_MS ?? "30000"),
  codexLimitPerRun: Number(process.env.CHAT_ARCHIVE_CODEX_LIMIT_PER_RUN ?? "8"),
  lastError: "",
};

const getStmt = db.prepare("SELECT value FROM app_config WHERE key = ?");
const upsertStmt = db.prepare(`
  INSERT INTO app_config(key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);

function getString(key: string, fallback: string): string {
  const row = getStmt.get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

function getNumber(key: string, fallback: number): number {
  const row = getStmt.get(key) as { value: string } | undefined;
  if (!row) return fallback;
  const n = Number(row.value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getSummarySettings(): SummarySettings {
  const provider = getString("summary.provider", DEFAULTS.provider);
  return {
    provider: provider === "rule" ? "rule" : provider === "hybrid" ? "hybrid" : provider === "qwen" ? "qwen" : "codex",
    model: getString("summary.model", DEFAULTS.model),
    timeoutMs: getNumber("summary.timeout_ms", DEFAULTS.timeoutMs),
    codexLimitPerRun: getNumber("summary.codex_limit_per_run", DEFAULTS.codexLimitPerRun),
    lastError: getString("summary.last_error", DEFAULTS.lastError),
  };
}

export function setSummarySettings(input: Partial<SummarySettings>): SummarySettings {
  const current = getSummarySettings();
  const next: SummarySettings = {
    provider:
      input.provider === "rule"
        ? "rule"
        : input.provider === "hybrid"
          ? "hybrid"
          : input.provider === "qwen"
            ? "qwen"
            : input.provider === "codex"
              ? "codex"
              : current.provider,
    model: input.model?.trim() ? input.model.trim() : current.model,
    timeoutMs:
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? Math.floor(input.timeoutMs)
        : current.timeoutMs,
    codexLimitPerRun:
      typeof input.codexLimitPerRun === "number" && Number.isFinite(input.codexLimitPerRun) && input.codexLimitPerRun >= 0
        ? Math.floor(input.codexLimitPerRun)
        : current.codexLimitPerRun,
    lastError: typeof input.lastError === "string" ? input.lastError : current.lastError,
  };

  const now = nowIso();
  upsertStmt.run("summary.provider", next.provider, now);
  upsertStmt.run("summary.model", next.model, now);
  upsertStmt.run("summary.timeout_ms", String(next.timeoutMs), now);
  upsertStmt.run("summary.codex_limit_per_run", String(next.codexLimitPerRun), now);
  upsertStmt.run("summary.last_error", next.lastError, now);

  return next;
}

export function setSummaryLastError(message: string): void {
  const now = nowIso();
  upsertStmt.run("summary.last_error", message.slice(0, 500), now);
}
