export type ChatRole = "user" | "assistant" | "tool" | "system";

export interface SessionRecord {
  id: string;
  tool: string;
  source_path: string;
  project: string | null;
  start_time: string;
  end_time: string;
  duration_sec: number;
  title: string;
  summary: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  session_id: string;
  role: ChatRole;
  ts: string;
  content: string;
  turn_index: number;
  seq_in_session: number;
}

export interface SyncStats {
  scannedFiles: number;
  updatedSessions: number;
  skippedFiles: number;
  warnings: number;
  warningDetails: string[];
}

export interface SyncProgress {
  totalFiles: number;
  processedFiles: number;
  updatedSessions: number;
  skippedFiles: number;
  warnings: number;
  currentFile: string;
  warningDetails: string[];
}
