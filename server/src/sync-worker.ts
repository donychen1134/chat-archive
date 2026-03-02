import { db } from "./db.js";
import { syncAll } from "./sync.js";
import type { SyncProgress, SyncStats } from "./types.js";

type WorkerEvent =
  | { type: "progress"; progress: SyncProgress }
  | { type: "done"; stats: SyncStats }
  | { type: "error"; error: string };

const PREFIX = "__SYNC_EVENT__";

function emit(event: WorkerEvent): void {
  process.stdout.write(`${PREFIX}${JSON.stringify(event)}\n`);
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function main() {
  const mode = (process.argv[2] ?? "sync") as "sync" | "reindex";
  try {
    if (mode === "reindex") {
      db.prepare("DELETE FROM ingest_state").run();
    }
    const stats = syncAll((progress) => emit({ type: "progress", progress }));
    emit({ type: "done", stats });
    process.exit(0);
  } catch (error) {
    emit({ type: "error", error: normalizeError(error) });
    process.exit(1);
  }
}

void main();
