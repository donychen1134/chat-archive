import fs from "node:fs";
import path from "node:path";
import { codexSessionsDir, syncCodexSessions } from "./codex-ingest.js";
import { getSyncTaskState } from "./sync-manager.js";

const DEFAULT_DEBOUNCE_MS = 3000;
const DEFAULT_RETRY_MS = 5000;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function isEnabled(): boolean {
  const raw = process.env.CODEX_WATCH_ENABLED?.trim().toLowerCase();
  return raw !== "false" && raw !== "0";
}

function isCodexSessionFile(filePath: string): boolean {
  return filePath.endsWith(".jsonl") || filePath.endsWith(".json");
}

function resolveChangedPath(root: string, filename: string | Buffer | null): string | null {
  if (!filename) return null;
  const text = filename.toString();
  if (!text) return null;
  return path.isAbsolute(text) ? text : path.join(root, text);
}

export function startCodexSessionWatcher(): void {
  if (!isEnabled()) {
    console.log("codex session watcher disabled");
    return;
  }

  const root = codexSessionsDir();
  if (!fs.existsSync(root)) {
    console.log(`codex session watcher skipped: ${root} does not exist`);
    return;
  }

  const debounceMs = envNumber("CODEX_WATCH_DEBOUNCE_MS", DEFAULT_DEBOUNCE_MS);
  const retryMs = envNumber("CODEX_WATCH_RETRY_MS", DEFAULT_RETRY_MS);
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delay);
  };

  const enqueue = (filePath: string) => {
    if (!isCodexSessionFile(filePath)) return;
    pending.add(path.resolve(filePath));
    schedule(debounceMs);
  };

  const takeExistingPendingFiles = (): Set<string> => {
    const files = new Set<string>();
    for (const filePath of pending) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          files.add(filePath);
          pending.delete(filePath);
        }
      } catch {
        // Keep missing files out of the path-level sync; a later full sync is the deletion fallback.
        pending.delete(filePath);
      }
    }
    return files;
  };

  function flush() {
    timer = null;
    if (pending.size === 0) return;
    if (running || getSyncTaskState().running) {
      schedule(retryMs);
      return;
    }

    const files = takeExistingPendingFiles();
    if (files.size === 0) return;

    running = true;
    try {
      const stats = syncCodexSessions(undefined, { onlyPaths: files });
      if (stats.updatedSessions > 0 || stats.warnings > 0) {
        console.log(
          `codex watch sync: updated=${stats.updatedSessions}, skipped=${stats.skippedFiles}, warnings=${stats.warnings}`
        );
      }
    } catch (error) {
      for (const filePath of files) pending.add(filePath);
      console.error("codex watch sync failed:", error);
      schedule(retryMs);
    } finally {
      running = false;
    }
  }

  try {
    fs.watch(root, { recursive: true }, (_eventType, filename) => {
      const filePath = resolveChangedPath(root, filename);
      if (filePath) enqueue(filePath);
    });
    console.log(`codex session watcher running: ${root}`);
  } catch (error) {
    console.error("codex session watcher failed:", error);
  }
}
