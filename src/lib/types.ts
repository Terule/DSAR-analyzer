export interface StagedFile {
  id: string;
  filename: string;
  filepath: string;
  file_size_bytes: number;
  status:
    | "pending"
    | "scanning_metadata"
    | "processing"
    | "pending_analysis"
    | "analyzed"
    | "extracting"
    | "completed"
    | "failed";
  total_emails: number;
  total_attachments: number;
  unique_emails: number;
  duplicate_emails: number;
  estimated_tokens?: number;
  ai_status?: "pending" | "processing" | "completed" | "failed" | "batch_ready";
  ai_approved_count?: number;
  ai_discarded_count?: number;
  ai_audited_count?: number;
  ai_batches_total?: number;
  ai_batches_done?: number;
  pdf_status?: "pending" | "processing" | "completed" | "failed";

  metadata_duration_ms?: number;
  analyze_duration_ms?: number;
  extract_duration_ms?: number;
  ai_started_at?: number;
  ai_duration_ms?: number;
  pdf_duration_ms?: number;
  pdf_total?: number;
  pdf_processed?: number;
  created_at?: string;
  subject_name?: string | null;

  // Merged pipeline: 'pst' rows go through the email phases; 'files' rows are a
  // single Files (Teams/docs) batch processed by the standalone processor.
  kind?: "pst" | "files";
  files_status?: "pending" | "processing" | "completed" | "failed";
  files_total?: number;
  files_processed?: number;
  files_skipped?: number;
  files_duplicates?: number;
  files_duration_ms?: number;
  files_started_at?: number;
}

export interface AiConfig {
  name: string;
  email: string;
  personalEmail?: string;
  aliases: string[];
}

export interface CaseStats {
  size: number;
  totalEmails: number;
  uniqueEmails: number;
  duplicateEmails: number;
  estimatedTokens: number;
  aiApproved: number;
  aiDiscarded: number;
  metadataTime: number;
  analyzeTime: number;
  extractTime: number;
  aiTime: number;
  pdfTime: number;
}

export type NotificationType = "info" | "success" | "error";

export interface AppNotification {
  type: NotificationType;
  message: string;
}

export interface RunHistoryItem {
  id: string;
  source_file_id: string;
  source_kind: "pst" | "files";
  filename: string;
  filepath: string;
  case_key: string;
  request_key: string;
  status: string;
  ai_status: string;
  pdf_status: string;
  files_status: string;
  total_emails: number;
  unique_emails: number;
  duplicate_emails: number;
  ai_approved_count: number;
  ai_discarded_count: number;
  files_total: number;
  files_processed: number;
  files_skipped: number;
  files_duplicates: number;
  metadata_duration_ms: number;
  analyze_duration_ms: number;
  extract_duration_ms: number;
  ai_duration_ms: number;
  pdf_duration_ms: number;
  files_duration_ms: number;
  terminal_outcome: "success" | "failed" | "partial";
  archived_reason: "completed" | "source_deleted" | "manual_reset";
  finalized_at: string;
  created_at: string;
}

export interface RunHistoryResponse {
  data: RunHistoryItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface CaseHistoryItem {
  id: string;
  case_key: string;
  request_key: string;
  source_rows: number;
  pst_rows: number;
  files_rows: number;
  total_emails: number;
  unique_emails: number;
  duplicate_emails: number;
  emails_selected: number;
  emails_discarded: number;
  files_total: number;
  files_processed: number;
  files_skipped: number;
  files_duplicates: number;
  metadata_duration_ms: number;
  analyze_duration_ms: number;
  extract_duration_ms: number;
  ai_duration_ms: number;
  pdf_duration_ms: number;
  files_duration_ms: number;
  total_duration_ms: number;
  terminal_outcome: "success" | "failed" | "partial";
  archived_reason: "completed" | "source_deleted" | "manual_reset";
  finalized_at: string;
  created_at: string;
}

export interface CaseHistoryResponse {
  data: CaseHistoryItem[];
  total: number;
  limit: number;
  offset: number;
}
