/**
 * Shared helpers for deriving a session's "对象" (session_target).
 *
 * The summarizer LLM often picks a generic noun ("文档", "分支", "测试用例") or a
 * single filename as the target even when the session clearly belongs to a
 * specific project repo. When we can map a session to a real project, we prefer
 * the project name as the target. These helpers centralize that decision so the
 * rule is applied consistently at ingest time, at read time, and in backfills.
 */

export const PLACEHOLDER_TARGET = "会话目标";

export const BUILTIN_TARGET_NOISE = new Set([
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
  "catpaw",
  "agent-transcripts",
  "transcript",
]);

export function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function looksLikeHash(value: string): boolean {
  return (
    /^[0-9a-f]{16,}$/i.test(value) ||
    /^([0-9a-f]{4,}[-_]){2,}[0-9a-f]{4,}$/i.test(value) ||
    (/^[a-z0-9_-]{20,}$/i.test(value) && !/[aeiou]/i.test(value))
  );
}

export function looksLikeId(value: string): boolean {
  return looksLikeUuid(value) || looksLikeHash(value);
}

/**
 * True for tokens that should never be shown as a target — path noise, ids,
 * very short alpha runs, pure numbers, db filenames, etc. `extraNoise` lets
 * callers fold in user-configured noise words (from purpose settings).
 */
export function isNoiseToken(value: string, extraNoise?: ReadonlySet<string>): boolean {
  const v = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (!v || v.length < 2) return true;
  if (BUILTIN_TARGET_NOISE.has(v)) return true;
  if (extraNoise && extraNoise.has(v)) return true;
  if (looksLikeId(v)) return true;
  if (/^[a-z]{1,3}$/i.test(v)) return true;
  if (/^\d+$/.test(v)) return true;
  if (v.includes("#session:")) return true;
  if (v.endsWith(".db")) return true;
  if (v.includes(".db#")) return true;
  if (v.startsWith(".") && !v.includes("-") && !v.includes("_")) return true;
  return false;
}

/**
 * The last path segment of a project cwd, when it looks like a real repo name
 * (not home/tmp/src/the tool itself/an id). Returns "" when there is no usable
 * project name — callers then fall back to the summarizer-provided target.
 */
export function realProjectName(project: string | null | undefined): string {
  const raw = typeof project === "string" ? project.trim() : "";
  if (!raw) return "";
  const parts = raw.replace(/\\/g, "/").split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  const name = last.replace(/\.git$/i, "").trim();
  if (!name || isNoiseToken(name)) return "";
  return name;
}

export function isPlaceholderTarget(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  return !v || v === PLACEHOLDER_TARGET;
}

/**
 * Resolve the target to persist/display for a session.
 *
 * - If the session maps to a real project, return the project name (this is the
 *   rule the user wants: 对象 should be the project name when one exists).
 * - Otherwise return the saved/LLM target, unless it is an empty placeholder.
 */
export function resolveSessionTarget(
  project: string | null | undefined,
  savedTarget: string | null | undefined
): string {
  const proj = realProjectName(project);
  if (proj) return proj;
  if (isPlaceholderTarget(savedTarget)) return "";
  return (savedTarget ?? "").trim();
}
