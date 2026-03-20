import { countCodexSessionFiles, syncCodexSessions } from "./codex-ingest.js";
import { countClaudeSessionFiles, syncClaudeSessions } from "./claude-ingest.js";
import { countCopilotSessionFiles, syncCopilotSessions } from "./copilot-ingest.js";
import { countGeminiSessionFiles, syncGeminiSessions } from "./gemini-ingest.js";
import { countOpencodeSessionFiles, syncOpencodeSessions } from "./opencode-ingest.js";
import type { SyncProgress, SyncStats } from "./types.js";

export function estimateTotalSourceFiles(): number {
  return (
    countCodexSessionFiles() +
    countClaudeSessionFiles() +
    countCopilotSessionFiles() +
    countGeminiSessionFiles() +
    countOpencodeSessionFiles()
  );
}

export function syncAll(onProgress?: (progress: SyncProgress) => void): SyncStats {
  const totalFiles = estimateTotalSourceFiles();
  const codexStats = syncCodexSessions((p) => {
    if (!onProgress) return;
    onProgress({ ...p, totalFiles });
  });
  const claudeStats = syncClaudeSessions((p) => {
    if (!onProgress) return;
    onProgress({
      totalFiles,
      processedFiles: codexStats.scannedFiles + p.processedFiles,
      updatedSessions: codexStats.updatedSessions + p.updatedSessions,
      skippedFiles: codexStats.skippedFiles + p.skippedFiles,
      warnings: codexStats.warnings + p.warnings,
      currentFile: p.currentFile,
      warningDetails: [...codexStats.warningDetails, ...p.warningDetails].slice(-12),
    });
  });
  const copilotStats = syncCopilotSessions((p) => {
    if (!onProgress) return;
    onProgress({
      totalFiles,
      processedFiles: codexStats.scannedFiles + claudeStats.scannedFiles + p.processedFiles,
      updatedSessions: codexStats.updatedSessions + claudeStats.updatedSessions + p.updatedSessions,
      skippedFiles: codexStats.skippedFiles + claudeStats.skippedFiles + p.skippedFiles,
      warnings: codexStats.warnings + claudeStats.warnings + p.warnings,
      currentFile: p.currentFile,
      warningDetails: [...codexStats.warningDetails, ...claudeStats.warningDetails, ...p.warningDetails].slice(-12),
    });
  });
  const geminiStats = syncGeminiSessions((p) => {
    if (!onProgress) return;
    onProgress({
      totalFiles,
      processedFiles: codexStats.scannedFiles + claudeStats.scannedFiles + copilotStats.scannedFiles + p.processedFiles,
      updatedSessions: codexStats.updatedSessions + claudeStats.updatedSessions + copilotStats.updatedSessions + p.updatedSessions,
      skippedFiles: codexStats.skippedFiles + claudeStats.skippedFiles + copilotStats.skippedFiles + p.skippedFiles,
      warnings: codexStats.warnings + claudeStats.warnings + copilotStats.warnings + p.warnings,
      currentFile: p.currentFile,
      warningDetails: [...codexStats.warningDetails, ...claudeStats.warningDetails, ...copilotStats.warningDetails, ...p.warningDetails].slice(-12),
    });
  });
  const opencodeStats = syncOpencodeSessions((p) => {
    if (!onProgress) return;
    onProgress({
      totalFiles,
      processedFiles:
        codexStats.scannedFiles + claudeStats.scannedFiles + copilotStats.scannedFiles + geminiStats.scannedFiles + p.processedFiles,
      updatedSessions:
        codexStats.updatedSessions +
        claudeStats.updatedSessions +
        copilotStats.updatedSessions +
        geminiStats.updatedSessions +
        p.updatedSessions,
      skippedFiles:
        codexStats.skippedFiles + claudeStats.skippedFiles + copilotStats.skippedFiles + geminiStats.skippedFiles + p.skippedFiles,
      warnings: codexStats.warnings + claudeStats.warnings + copilotStats.warnings + geminiStats.warnings + p.warnings,
      currentFile: p.currentFile,
      warningDetails: [
        ...codexStats.warningDetails,
        ...claudeStats.warningDetails,
        ...copilotStats.warningDetails,
        ...geminiStats.warningDetails,
        ...p.warningDetails,
      ].slice(-12),
    });
  });

  return {
    scannedFiles:
      codexStats.scannedFiles + claudeStats.scannedFiles + copilotStats.scannedFiles + geminiStats.scannedFiles + opencodeStats.scannedFiles,
    updatedSessions:
      codexStats.updatedSessions +
      claudeStats.updatedSessions +
      copilotStats.updatedSessions +
      geminiStats.updatedSessions +
      opencodeStats.updatedSessions,
    skippedFiles:
      codexStats.skippedFiles + claudeStats.skippedFiles + copilotStats.skippedFiles + geminiStats.skippedFiles + opencodeStats.skippedFiles,
    warnings: codexStats.warnings + claudeStats.warnings + copilotStats.warnings + geminiStats.warnings + opencodeStats.warnings,
    warningDetails: [
      ...codexStats.warningDetails,
      ...claudeStats.warningDetails,
      ...copilotStats.warningDetails,
      ...geminiStats.warningDetails,
      ...opencodeStats.warningDetails,
    ].slice(-20),
  };
}
