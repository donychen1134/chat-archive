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

export type UsageRecordType = "message" | "turn" | "session";
export type UsageSourceType = "native_exact" | "native_partial";
export type UsageStatus = "exact" | "partial" | "unavailable";
export type UsageSemantics = "delta" | "snapshot" | "session_total";

export interface UsageInput {
  session_id: string;
  tool: string;
  project: string | null;
  provider: string | null;
  model: string | null;
  record_type: UsageRecordType;
  source_type: UsageSourceType;
  usage_semantics: UsageSemantics;
  usage_time: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  tool_tokens: number;
  total_tokens: number;
  cost: number | null;
  raw_ref: string;
}
