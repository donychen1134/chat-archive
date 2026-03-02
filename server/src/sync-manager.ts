import { estimateTotalSourceFiles } from "./sync.js";
import type { SyncProgress, SyncStats } from "./types.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

export type SyncMode = "sync" | "reindex";

export interface SyncTaskState {
  running: boolean;
  mode: SyncMode;
  startedAt: string;
  finishedAt: string;
  totalFiles: number;
  processedFiles: number;
  updatedSessions: number;
  skippedFiles: number;
  warnings: number;
  warningDetails: string[];
  currentFile: string;
  lastError: string;
}

const state: SyncTaskState = {
  running: false,
  mode: "sync",
  startedAt: "",
  finishedAt: "",
  totalFiles: 0,
  processedFiles: 0,
  updatedSessions: 0,
  skippedFiles: 0,
  warnings: 0,
  warningDetails: [],
  currentFile: "",
  lastError: "",
};

let workerProcess: ReturnType<typeof spawn> | null = null;
const EVENT_PREFIX = "__SYNC_EVENT__";

function spawnSyncWorker(mode: SyncMode): ReturnType<typeof spawn> {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const jsWorker = path.join(currentDir, "sync-worker.js");
  if (fs.existsSync(jsWorker)) {
    return spawn(process.execPath, [jsWorker, mode], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
  }

  const tsWorker = path.join(currentDir, "sync-worker.ts");
  const tsxBin = path.resolve(currentDir, "..", "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  if (fs.existsSync(tsWorker) && fs.existsSync(tsxBin)) {
    return spawn(tsxBin, [tsWorker, mode], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
  }

  throw new Error(`sync worker entry not found (checked: ${jsWorker}, ${tsWorker})`);
}

function resetForStart(mode: SyncMode) {
  state.running = true;
  state.mode = mode;
  state.startedAt = new Date().toISOString();
  state.finishedAt = "";
  state.totalFiles = 0;
  state.processedFiles = 0;
  state.updatedSessions = 0;
  state.skippedFiles = 0;
  state.warnings = 0;
  state.warningDetails = [];
  state.currentFile = "";
  state.lastError = "";
  state.totalFiles = estimateTotalSourceFiles();
}

function applyProgress(progress: SyncProgress) {
  state.totalFiles = progress.totalFiles;
  state.processedFiles = progress.processedFiles;
  state.updatedSessions = progress.updatedSessions;
  state.skippedFiles = progress.skippedFiles;
  state.warnings = progress.warnings;
  state.warningDetails = progress.warningDetails.slice(-12);
  state.currentFile = progress.currentFile;
}

function applyFinal(stats: SyncStats) {
  state.updatedSessions = stats.updatedSessions;
  state.skippedFiles = stats.skippedFiles;
  state.warnings = stats.warnings;
  state.warningDetails = stats.warningDetails.slice(-20);
  state.processedFiles = stats.scannedFiles;
  state.totalFiles = stats.scannedFiles;
  state.currentFile = "";
  state.finishedAt = new Date().toISOString();
  state.running = false;
}

export function getSyncTaskState(): SyncTaskState {
  return { ...state };
}

export function startSyncTask(mode: SyncMode): { started: boolean; state: SyncTaskState } {
  if (state.running) {
    return { started: false, state: getSyncTaskState() };
  }

  resetForStart(mode);
  try {
    workerProcess = spawnSyncWorker(mode);
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    state.running = false;
    state.finishedAt = new Date().toISOString();
    return { started: false, state: getSyncTaskState() };
  }

  let stdoutBuffer = "";
  let finished = false;

  const markFailed = (message: string) => {
    if (finished) return;
    finished = true;
    state.lastError = message;
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.currentFile = "";
  };

  workerProcess.stdout?.on("data", (chunk: Buffer | string) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (!text.startsWith(EVENT_PREFIX)) continue;
      try {
        const event = JSON.parse(text.slice(EVENT_PREFIX.length)) as
          | { type: "progress"; progress: SyncProgress }
          | { type: "done"; stats: SyncStats }
          | { type: "error"; error: string };
        if (event.type === "progress") {
          applyProgress(event.progress);
        } else if (event.type === "done") {
          finished = true;
          applyFinal(event.stats);
        } else if (event.type === "error") {
          markFailed(event.error || "sync worker failed");
        }
      } catch {
        // Ignore malformed worker lines to keep task robust.
      }
    }
  });

  workerProcess.stderr?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString().trim();
    if (!text) return;
    state.lastError = text.slice(-500);
  });

  workerProcess.on("error", (error) => {
    markFailed(error instanceof Error ? error.message : String(error));
  });

  workerProcess.on("close", (code) => {
    workerProcess = null;
    if (finished) return;
    if (code === 0) {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      state.currentFile = "";
      return;
    }
    markFailed(state.lastError || `sync worker exited with code ${String(code)}`);
  });

  return { started: true, state: getSyncTaskState() };
}
