import type { CaseHistory, ProcessedFile, RunHistory } from "@prisma/client";
import type { CaseHistoryItem, RunHistoryItem, StagedFile } from "./types";

/**
 * Prisma returns `BigInt` for large-range columns (file byte sizes, epoch-ms
 * timestamps) which `JSON.stringify`/`NextResponse.json` cannot serialize.
 * These helpers convert a Prisma row into the plain-number shape the
 * frontend/API contracts (`src/lib/types.ts`) expect.
 */
export function serializeProcessedFile(row: ProcessedFile): StagedFile {
  return {
    id: row.id,
    filename: row.filename ?? "",
    filepath: row.filepath ?? "",
    file_size_bytes: Number(row.file_size_bytes),
    status: row.status as StagedFile["status"],
    total_emails: row.total_emails,
    total_attachments: row.total_attachments,
    unique_emails: row.unique_emails,
    duplicate_emails: row.duplicate_emails,
    estimated_tokens: row.estimated_tokens,
    ai_status: row.ai_status as StagedFile["ai_status"],
    ai_approved_count: row.ai_approved_count,
    ai_discarded_count: row.ai_discarded_count,
    ai_batches_total: row.ai_batches_total,
    ai_batches_done: row.ai_batches_done,
    pdf_status: row.pdf_status as StagedFile["pdf_status"],
    metadata_duration_ms: row.metadata_duration_ms,
    analyze_duration_ms: row.analyze_duration_ms,
    extract_duration_ms: row.extract_duration_ms,
    ai_started_at:
      row.ai_started_at !== null ? Number(row.ai_started_at) : undefined,
    ai_duration_ms: row.ai_duration_ms,
    pdf_duration_ms: row.pdf_duration_ms,
    pdf_total: row.pdf_total,
    pdf_processed: row.pdf_processed,
    created_at: row.created_at.toISOString(),
    subject_name: row.subject_name,
    kind: row.kind as StagedFile["kind"],
    files_status: row.files_status as StagedFile["files_status"],
    files_total: row.files_total,
    files_progress_total: row.files_progress_total,
    files_progress_handled: row.files_progress_handled,
    files_processed: row.files_processed,
    files_skipped: row.files_skipped,
    files_duplicates: row.files_duplicates,
    files_duration_ms: row.files_duration_ms,
    files_started_at:
      row.files_started_at !== null ? Number(row.files_started_at) : undefined,
    files_paused_ms: row.files_paused_ms,
    upload_status: row.upload_status as StagedFile["upload_status"],
    upload_total: row.upload_total,
    upload_uploaded: row.upload_uploaded,
    upload_error: row.upload_error || undefined,
    upload_heartbeat_at:
      row.upload_heartbeat_at !== null
        ? Number(row.upload_heartbeat_at)
        : undefined,
  };
}

export function serializeRunHistory(row: RunHistory): RunHistoryItem {
  return {
    id: row.id,
    source_file_id: row.source_file_id,
    source_kind: (row.source_kind || "pst") as RunHistoryItem["source_kind"],
    filename: row.filename || "",
    filepath: row.filepath || "",
    case_key: row.case_key || "",
    request_key: row.request_key || "",
    status: row.status || "",
    ai_status: row.ai_status || "",
    pdf_status: row.pdf_status || "",
    files_status: row.files_status || "",
    total_emails: row.total_emails,
    unique_emails: row.unique_emails,
    duplicate_emails: row.duplicate_emails,
    ai_approved_count: row.ai_approved_count,
    ai_discarded_count: row.ai_discarded_count,
    files_total: row.files_total,
    files_processed: row.files_processed,
    files_skipped: row.files_skipped,
    files_duplicates: row.files_duplicates,
    metadata_duration_ms: row.metadata_duration_ms,
    analyze_duration_ms: row.analyze_duration_ms,
    extract_duration_ms: row.extract_duration_ms,
    ai_duration_ms: row.ai_duration_ms,
    pdf_duration_ms: row.pdf_duration_ms,
    files_duration_ms: row.files_duration_ms,
    terminal_outcome:
      row.terminal_outcome as RunHistoryItem["terminal_outcome"],
    archived_reason: row.archived_reason as RunHistoryItem["archived_reason"],
    finalized_at: row.finalized_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}

export function serializeCaseHistory(row: CaseHistory): CaseHistoryItem {
  return {
    id: row.id,
    case_key: row.case_key,
    request_key: row.request_key || "",
    source_rows: row.source_rows,
    pst_rows: row.pst_rows,
    files_rows: row.files_rows,
    total_emails: row.total_emails,
    unique_emails: row.unique_emails,
    duplicate_emails: row.duplicate_emails,
    emails_selected: row.emails_selected,
    emails_discarded: row.emails_discarded,
    files_total: row.files_total,
    files_processed: row.files_processed,
    files_skipped: row.files_skipped,
    files_duplicates: row.files_duplicates,
    metadata_duration_ms: row.metadata_duration_ms,
    analyze_duration_ms: row.analyze_duration_ms,
    extract_duration_ms: row.extract_duration_ms,
    ai_duration_ms: row.ai_duration_ms,
    pdf_duration_ms: row.pdf_duration_ms,
    files_duration_ms: row.files_duration_ms,
    total_duration_ms: row.total_duration_ms,
    terminal_outcome:
      row.terminal_outcome as CaseHistoryItem["terminal_outcome"],
    archived_reason: row.archived_reason as CaseHistoryItem["archived_reason"],
    finalized_at: row.finalized_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}
