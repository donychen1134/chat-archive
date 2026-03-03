import { db, nowIso } from "./db.js";

export type SummaryProvider = "codex" | "qwen" | "rule" | "hybrid";
export type PurposeKey = "code_review" | "troubleshooting" | "development" | "understanding" | "consulting";

export interface SummarySettings {
  provider: SummaryProvider;
  model: string;
  timeoutMs: number;
  codexLimitPerRun: number;
  lastError: string;
}

export interface PurposeSettings {
  ruleCodeReview: string;
  ruleTroubleshooting: string;
  ruleDevelopment: string;
  ruleUnderstanding: string;
  customRules: string;
  noiseWords: string;
  shortTargetMaxLen: number;
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

const PURPOSE_DEFAULTS: PurposeSettings = {
  ruleCodeReview:
    "代码审查|代码评审|code review|review the code|review the current code|review the code changes|git diff|pull request|\\bpr\\b|merge base|staged|unstaged|code changes|变更评审|审查变更|审查代码",
  ruleTroubleshooting: "排查|故障|报错|error|invalid|timeout|failed|panic|异常|修复|debug|诊断|定位",
  ruleDevelopment: "实现|开发|重构|新增|优化|设计|build|feature|mvp|页面|ui|功能",
  ruleUnderstanding: "分析|理解|解释|阅读|看懂|作用|原理|流程",
  customRules: "",
  noiseWords: "mt,.codex,codex,sessions,session,tmp,chats,users,user,home,src,go,github,projects,rollout",
  shortTargetMaxLen: 12,
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

export function getPurposeSettings(): PurposeSettings {
  return {
    ruleCodeReview: getString("purpose.rule.code_review", PURPOSE_DEFAULTS.ruleCodeReview),
    ruleTroubleshooting: getString("purpose.rule.troubleshooting", PURPOSE_DEFAULTS.ruleTroubleshooting),
    ruleDevelopment: getString("purpose.rule.development", PURPOSE_DEFAULTS.ruleDevelopment),
    ruleUnderstanding: getString("purpose.rule.understanding", PURPOSE_DEFAULTS.ruleUnderstanding),
    customRules: getString("purpose.rule.custom", PURPOSE_DEFAULTS.customRules),
    noiseWords: getString("purpose.noise_words", PURPOSE_DEFAULTS.noiseWords),
    shortTargetMaxLen: getNumber("purpose.short_target_max_len", PURPOSE_DEFAULTS.shortTargetMaxLen),
  };
}

export function setPurposeSettings(input: Partial<PurposeSettings>): PurposeSettings {
  const current = getPurposeSettings();
  const next: PurposeSettings = {
    ruleCodeReview: input.ruleCodeReview?.trim() ? input.ruleCodeReview.trim() : current.ruleCodeReview,
    ruleTroubleshooting: input.ruleTroubleshooting?.trim()
      ? input.ruleTroubleshooting.trim()
      : current.ruleTroubleshooting,
    ruleDevelopment: input.ruleDevelopment?.trim() ? input.ruleDevelopment.trim() : current.ruleDevelopment,
    ruleUnderstanding: input.ruleUnderstanding?.trim() ? input.ruleUnderstanding.trim() : current.ruleUnderstanding,
    customRules: typeof input.customRules === "string" ? input.customRules.trim() : current.customRules,
    noiseWords: typeof input.noiseWords === "string" ? input.noiseWords.trim() : current.noiseWords,
    shortTargetMaxLen:
      typeof input.shortTargetMaxLen === "number" &&
      Number.isFinite(input.shortTargetMaxLen) &&
      input.shortTargetMaxLen >= 8 &&
      input.shortTargetMaxLen <= 48
        ? Math.floor(input.shortTargetMaxLen)
        : current.shortTargetMaxLen,
  };
  const now = nowIso();
  upsertStmt.run("purpose.rule.code_review", next.ruleCodeReview, now);
  upsertStmt.run("purpose.rule.troubleshooting", next.ruleTroubleshooting, now);
  upsertStmt.run("purpose.rule.development", next.ruleDevelopment, now);
  upsertStmt.run("purpose.rule.understanding", next.ruleUnderstanding, now);
  upsertStmt.run("purpose.rule.custom", next.customRules, now);
  upsertStmt.run("purpose.noise_words", next.noiseWords, now);
  upsertStmt.run("purpose.short_target_max_len", String(next.shortTargetMaxLen), now);
  return next;
}
