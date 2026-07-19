import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getCaseKey, getRelativePath } from "./format";
import { prisma } from "./prisma";
import { serializeCaseHistory, serializeRunHistory } from "./serialize";
import type { CaseHistoryItem, RunHistoryItem } from "./types";

export type ArchiveReason = "source_deleted" | "manual_reset";

type ProcessedRow = {
  id: string;
  filename: string | null;
  filepath: string | null;
  kind: string;
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
};

const PROCESSED_ROW_SELECT = {
  id: true,
  filename: true,
  filepath: true,
  kind: true,
  status: true,
  ai_status: true,
  pdf_status: true,
  files_status: true,
  total_emails: true,
  unique_emails: true,
  duplicate_emails: true,
  ai_approved_count: true,
  ai_discarded_count: true,
  files_total: true,
  files_processed: true,
  files_skipped: true,
  files_duplicates: true,
  metadata_duration_ms: true,
  analyze_duration_ms: true,
  extract_duration_ms: true,
  ai_duration_ms: true,
  pdf_duration_ms: true,
  files_duration_ms: true,
} satisfies Prisma.ProcessedFileSelect;

async function getCaseRowsFromFileIds(
  tx: Prisma.TransactionClient,
  fileIds: string[],
): Promise<Map<string, ProcessedRow[]>> {
  const inputRows = await tx.processedFile.findMany({
    where: { id: { in: fileIds } },
    select: PROCESSED_ROW_SELECT,
  });
  const requestedCases = new Set(
    inputRows.map((row) => getCaseKey(row.filepath || "")),
  );

  const allRows = await tx.processedFile.findMany({
    select: PROCESSED_ROW_SELECT,
  });

  const grouped = new Map<string, ProcessedRow[]>();
  for (const row of allRows) {
    const caseKey = getCaseKey(row.filepath || "");
    if (!requestedCases.has(caseKey)) continue;
    const existing = grouped.get(caseKey) || [];
    existing.push(row);
    grouped.set(caseKey, existing);
  }

  return grouped;
}

function computeTerminalOutcome(
  row: ProcessedRow,
): "success" | "failed" | "partial" {
  if (
    row.status === "failed" ||
    row.ai_status === "failed" ||
    row.pdf_status === "failed" ||
    row.files_status === "failed"
  ) {
    return "failed";
  }

  if (row.kind === "files") {
    return row.files_status === "completed" ? "success" : "partial";
  }

  if (
    row.status === "completed" &&
    row.ai_status === "completed" &&
    row.pdf_status === "completed"
  ) {
    return "success";
  }

  return "partial";
}

function getRequestKey(filepath: string): string {
  const rel = getRelativePath(filepath);
  const parts = rel.split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts[1] : parts[0] || "";
}

function computeStateSignature(
  row: ProcessedRow,
  reason: ArchiveReason,
): string {
  const payload = [
    row.id,
    row.status || "",
    row.ai_status || "",
    row.pdf_status || "",
    row.files_status || "",
    String(row.total_emails || 0),
    String(row.unique_emails || 0),
    String(row.duplicate_emails || 0),
    String(row.ai_approved_count || 0),
    String(row.ai_discarded_count || 0),
    String(row.files_total || 0),
    String(row.files_processed || 0),
    String(row.files_skipped || 0),
    String(row.files_duplicates || 0),
    String(row.metadata_duration_ms || 0),
    String(row.analyze_duration_ms || 0),
    String(row.extract_duration_ms || 0),
    String(row.ai_duration_ms || 0),
    String(row.pdf_duration_ms || 0),
    String(row.files_duration_ms || 0),
    reason,
  ].join("|");

  return crypto.createHash("sha256").update(payload).digest("hex");
}

function isRowFailed(row: ProcessedRow): boolean {
  return (
    row.status === "failed" ||
    row.ai_status === "failed" ||
    row.pdf_status === "failed" ||
    row.files_status === "failed"
  );
}

function isRowSuccess(row: ProcessedRow): boolean {
  if (row.kind === "files") return row.files_status === "completed";
  return (
    row.status === "completed" &&
    row.ai_status === "completed" &&
    row.pdf_status === "completed"
  );
}

function computeCaseOutcome(
  rows: ProcessedRow[],
): "success" | "failed" | "partial" {
  if (rows.some(isRowFailed)) return "failed";
  if (rows.length > 0 && rows.every(isRowSuccess)) return "success";
  return "partial";
}

function computeCaseStateSignature(
  caseKey: string,
  rows: ProcessedRow[],
  reason: ArchiveReason,
): string {
  const rowBits = [...rows]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((row) =>
      [
        row.id,
        row.kind || "",
        row.status || "",
        row.ai_status || "",
        row.pdf_status || "",
        row.files_status || "",
        String(row.total_emails || 0),
        String(row.unique_emails || 0),
        String(row.duplicate_emails || 0),
        String(row.ai_approved_count || 0),
        String(row.ai_discarded_count || 0),
        String(row.files_total || 0),
        String(row.files_processed || 0),
        String(row.files_skipped || 0),
        String(row.files_duplicates || 0),
        String(row.metadata_duration_ms || 0),
        String(row.analyze_duration_ms || 0),
        String(row.extract_duration_ms || 0),
        String(row.ai_duration_ms || 0),
        String(row.pdf_duration_ms || 0),
        String(row.files_duration_ms || 0),
      ].join("|"),
    )
    .join("||");

  return crypto
    .createHash("sha256")
    .update(`${caseKey}|${reason}|${rowBits}`)
    .digest("hex");
}

async function insertCaseHistorySnapshot(
  tx: Prisma.TransactionClient,
  caseKey: string,
  rows: ProcessedRow[],
  reason: ArchiveReason,
): Promise<boolean> {
  if (rows.length === 0) return false;

  const signature = computeCaseStateSignature(caseKey, rows, reason);
  const exists = await tx.caseHistory.findUnique({
    where: {
      case_key_state_signature: {
        case_key: caseKey,
        state_signature: signature,
      },
    },
    select: { id: true },
  });
  if (exists) return false;

  const samplePath = rows[0]?.filepath || "";
  const requestKey = getRequestKey(samplePath);
  const pstRows = rows.filter((row) => row.kind !== "files");
  const filesRows = rows.filter((row) => row.kind === "files");
  const sum = (fn: (row: ProcessedRow) => number) =>
    rows.reduce((total, row) => total + fn(row), 0);

  const totalEmails = sum((r) => r.total_emails || 0);
  const uniqueEmails = sum((r) => r.unique_emails || 0);
  const duplicateEmails = sum((r) => r.duplicate_emails || 0);
  const emailsSelected = sum((r) => r.ai_approved_count || 0);
  const emailsDiscarded = sum((r) => r.ai_discarded_count || 0);
  const filesTotal = sum((r) => r.files_total || 0);
  const filesProcessed = sum((r) => r.files_processed || 0);
  const filesSkipped = sum((r) => r.files_skipped || 0);
  const filesDuplicates = sum((r) => r.files_duplicates || 0);
  const metadataDurationMs = sum((r) => r.metadata_duration_ms || 0);
  const analyzeDurationMs = sum((r) => r.analyze_duration_ms || 0);
  const extractDurationMs = sum((r) => r.extract_duration_ms || 0);
  const aiDurationMs = sum((r) => r.ai_duration_ms || 0);
  const pdfDurationMs = sum((r) => r.pdf_duration_ms || 0);
  const filesDurationMs = sum((r) => r.files_duration_ms || 0);
  const totalDurationMs =
    metadataDurationMs +
    analyzeDurationMs +
    extractDurationMs +
    aiDurationMs +
    pdfDurationMs +
    filesDurationMs;
  const outcome = computeCaseOutcome(rows);

  await tx.caseHistory.create({
    data: {
      id: crypto.randomUUID(),
      case_key: caseKey,
      request_key: requestKey,
      source_rows: rows.length,
      pst_rows: pstRows.length,
      files_rows: filesRows.length,
      total_emails: totalEmails,
      unique_emails: uniqueEmails,
      duplicate_emails: duplicateEmails,
      emails_selected: emailsSelected,
      emails_discarded: emailsDiscarded,
      files_total: filesTotal,
      files_processed: filesProcessed,
      files_skipped: filesSkipped,
      files_duplicates: filesDuplicates,
      metadata_duration_ms: metadataDurationMs,
      analyze_duration_ms: analyzeDurationMs,
      extract_duration_ms: extractDurationMs,
      ai_duration_ms: aiDurationMs,
      pdf_duration_ms: pdfDurationMs,
      files_duration_ms: filesDurationMs,
      total_duration_ms: totalDurationMs,
      terminal_outcome: outcome,
      archived_reason: reason,
      state_signature: signature,
      finalized_at: new Date(),
    },
  });

  return true;
}

async function insertRunHistorySnapshotTx(
  tx: Prisma.TransactionClient,
  fileId: string,
  reason: ArchiveReason,
): Promise<boolean> {
  const row = await tx.processedFile.findUnique({
    where: { id: fileId },
    select: PROCESSED_ROW_SELECT,
  });

  if (!row) return false;

  const signature = computeStateSignature(row, reason);
  const alreadyExists = await tx.runHistory.findUnique({
    where: {
      source_file_id_state_signature: {
        source_file_id: fileId,
        state_signature: signature,
      },
    },
    select: { id: true },
  });

  if (alreadyExists) return false;

  const outcome = computeTerminalOutcome(row);

  await tx.runHistory.create({
    data: {
      id: crypto.randomUUID(),
      source_file_id: row.id,
      source_kind: row.kind || "pst",
      filename: row.filename,
      filepath: row.filepath,
      case_key: getCaseKey(row.filepath || ""),
      request_key: getRequestKey(row.filepath || ""),
      status: row.status || "pending",
      ai_status: row.ai_status || "pending",
      pdf_status: row.pdf_status || "pending",
      files_status: row.files_status || "pending",
      total_emails: row.total_emails || 0,
      unique_emails: row.unique_emails || 0,
      duplicate_emails: row.duplicate_emails || 0,
      ai_approved_count: row.ai_approved_count || 0,
      ai_discarded_count: row.ai_discarded_count || 0,
      files_total: row.files_total || 0,
      files_processed: row.files_processed || 0,
      files_skipped: row.files_skipped || 0,
      files_duplicates: row.files_duplicates || 0,
      metadata_duration_ms: row.metadata_duration_ms || 0,
      analyze_duration_ms: row.analyze_duration_ms || 0,
      extract_duration_ms: row.extract_duration_ms || 0,
      ai_duration_ms: row.ai_duration_ms || 0,
      pdf_duration_ms: row.pdf_duration_ms || 0,
      files_duration_ms: row.files_duration_ms || 0,
      terminal_outcome: outcome,
      archived_reason: reason,
      state_signature: signature,
      finalized_at: new Date(),
    },
  });

  return true;
}

export async function insertRunHistorySnapshot(
  fileId: string,
  reason: ArchiveReason,
): Promise<boolean> {
  return prisma.$transaction((tx) =>
    insertRunHistorySnapshotTx(tx, fileId, reason),
  );
}

export async function insertRunHistorySnapshots(
  fileIds: string[],
  reason: ArchiveReason,
): Promise<number> {
  if (fileIds.length === 0) return 0;

  return prisma.$transaction(async (tx) => {
    let inserted = 0;
    for (const fileId of fileIds) {
      if (await insertRunHistorySnapshotTx(tx, fileId, reason)) inserted++;
    }
    return inserted;
  });
}

export async function insertCaseHistorySnapshots(
  fileIds: string[],
  reason: ArchiveReason,
): Promise<number> {
  if (fileIds.length === 0) return 0;

  return prisma.$transaction(async (tx) => {
    const caseRowsMap = await getCaseRowsFromFileIds(tx, fileIds);
    let inserted = 0;
    for (const [caseKey, rows] of caseRowsMap.entries()) {
      if (await insertCaseHistorySnapshot(tx, caseKey, rows, reason))
        inserted++;
    }
    return inserted;
  });
}

export async function listRunHistory(params?: {
  caseKey?: string;
  limit?: number;
  offset?: number;
}): Promise<{
  items: RunHistoryItem[];
  total: number;
  limit: number;
  offset: number;
}> {
  const caseKey = params?.caseKey?.trim() || "";
  const limit = Math.max(1, Math.min(params?.limit ?? 100, 500));
  const offset = Math.max(0, params?.offset ?? 0);
  const where = caseKey ? { case_key: caseKey } : {};

  const [total, rows] = await Promise.all([
    prisma.runHistory.count({ where }),
    prisma.runHistory.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: limit,
      skip: offset,
    }),
  ]);

  return {
    items: rows.map(serializeRunHistory),
    total,
    limit,
    offset,
  };
}

export async function listCaseHistory(params?: {
  caseKey?: string;
  limit?: number;
  offset?: number;
}): Promise<{
  items: CaseHistoryItem[];
  total: number;
  limit: number;
  offset: number;
}> {
  const caseKey = params?.caseKey?.trim() || "";
  const limit = Math.max(1, Math.min(params?.limit ?? 100, 500));
  const offset = Math.max(0, params?.offset ?? 0);

  const where: Prisma.CaseHistoryWhereInput = caseKey
    ? caseKey.includes("/")
      ? { case_key: caseKey }
      : {
          OR: [
            { case_key: caseKey },
            { case_key: { startsWith: `${caseKey}/` } },
          ],
        }
    : {};

  const [total, rows] = await Promise.all([
    prisma.caseHistory.count({ where }),
    prisma.caseHistory.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: limit,
      skip: offset,
    }),
  ]);

  return {
    items: rows.map(serializeCaseHistory),
    total,
    limit,
    offset,
  };
}
