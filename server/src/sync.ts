import { countCodexSessionFiles, syncCodexSessions } from "./codex-ingest.js";
import { countClaudeSessionFiles, syncClaudeSessions } from "./claude-ingest.js";
import { countCopilotSessionFiles, syncCopilotSessions } from "./copilot-ingest.js";
import { countGeminiSessionFiles, syncGeminiSessions } from "./gemini-ingest.js";
import { countOpencodeSessionFiles, syncOpencodeSessions } from "./opencode-ingest.js";
import { countCatpawSessionFiles, syncCatpawSessions } from "./catpaw-ingest.js";
import { countT3SessionFiles, syncT3Sessions } from "./t3-ingest.js";
import type { SyncProgress, SyncStats } from "./types.js";

type SyncSource = {
  count: () => number;
  sync: (onProgress?: (progress: SyncProgress) => void) => SyncStats;
};

const SYNC_SOURCES: SyncSource[] = [
  { count: countCodexSessionFiles, sync: syncCodexSessions },
  { count: countClaudeSessionFiles, sync: syncClaudeSessions },
  { count: countCopilotSessionFiles, sync: syncCopilotSessions },
  { count: countGeminiSessionFiles, sync: syncGeminiSessions },
  { count: countOpencodeSessionFiles, sync: syncOpencodeSessions },
  { count: countCatpawSessionFiles, sync: syncCatpawSessions },
  { count: countT3SessionFiles, sync: syncT3Sessions },
];

export function estimateTotalSourceFiles(): number {
  return SYNC_SOURCES.reduce((sum, source) => sum + source.count(), 0);
}

export function syncAll(onProgress?: (progress: SyncProgress) => void): SyncStats {
  const totalFiles = estimateTotalSourceFiles();
  const aggregate: SyncStats = {
    scannedFiles: 0,
    updatedSessions: 0,
    skippedFiles: 0,
    warnings: 0,
    warningDetails: [],
  };

  for (const source of SYNC_SOURCES) {
    const baseScanned = aggregate.scannedFiles;
    const baseUpdated = aggregate.updatedSessions;
    const baseSkipped = aggregate.skippedFiles;
    const baseWarnings = aggregate.warnings;
    const baseDetails = aggregate.warningDetails;

    const stats = source.sync((p) => {
      if (!onProgress) return;
      onProgress({
        totalFiles,
        processedFiles: baseScanned + p.processedFiles,
        updatedSessions: baseUpdated + p.updatedSessions,
        skippedFiles: baseSkipped + p.skippedFiles,
        warnings: baseWarnings + p.warnings,
        currentFile: p.currentFile,
        warningDetails: [...baseDetails, ...p.warningDetails].slice(-12),
      });
    });

    aggregate.scannedFiles += stats.scannedFiles;
    aggregate.updatedSessions += stats.updatedSessions;
    aggregate.skippedFiles += stats.skippedFiles;
    aggregate.warnings += stats.warnings;
    aggregate.warningDetails = [...aggregate.warningDetails, ...stats.warningDetails].slice(-20);
  }

  return aggregate;
}
