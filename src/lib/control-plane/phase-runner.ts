import fs from "node:fs";
import path from "node:path";
import { fillAiBatchSlots } from "@/lib/ai";
import { analyzePstDuplicates, scanFileMetadata } from "@/lib/analyzer";
import { getCasePstFileIds, markCaseAiCompleted } from "@/lib/case-utils";
import {
  clearFilesBatchResults,
  recordFilesBatchResult,
} from "@/lib/control-plane/job-store";
import { enqueueFilePhase } from "@/lib/control-plane/pipeline";
import { convertToPdfBatch } from "@/lib/converter";
import { extractUniqueEmails } from "@/lib/exporter";
import { archiveCompletedCase } from "@/lib/history";
import { prisma } from "@/lib/prisma";
import { getPstArtifactPaths } from "@/lib/pst-artifacts";
import { queueSharePointArtifacts } from "@/lib/sharepoint-artifact-outbox";
import { startSharePointArtifactWorker } from "@/lib/sharepoint-artifact-queue";
import {
  copyUnconvertedStandaloneFiles,
  finalizeStandaloneDeliverables,
  listFinalizedStandaloneDeliverables,
  listStandaloneInputFiles,
  runStandaloneBatch,
} from "@/lib/standalone-processor";
import type { ControlJobRecord } from "./types";

const LARGE_OFFICE_EXTENSIONS = new Set([".doc", ".docx", ".xls", ".xlsx"]);

function isLargeOfficeFile(filePath: string): boolean {
  if (!LARGE_OFFICE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return false;
  }
  const thresholdBytes =
    Math.max(1, Number(process.env.LARGE_OFFICE_FILE_MB || 25)) * 1024 * 1024;
  try {
    return fs.statSync(filePath).size >= thresholdBytes;
  } catch {
    // The manifest is intentionally resilient to a concurrent cleanup/move.
    // The batch worker will record the missing file as already handled.
    return false;
  }
}

function aliases(value: string | null): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export async function runPhaseJob(
  job: ControlJobRecord,
): Promise<Record<string, unknown>> {
  const fileId = job.payload.fileId;
  if (!fileId) throw new Error("Control-plane job has no fileId.");

  const row = await prisma.processedFile.findUnique({ where: { id: fileId } });
  if (!row) throw new Error(`Processed file not found: ${fileId}`);

  if (job.phase === "parse") {
    if (row.status === "scanning_metadata" || row.status === "pending") {
      await scanFileMetadata(fileId);
    }
    const current = await prisma.processedFile.findUnique({
      where: { id: fileId },
      select: { status: true },
    });
    if (
      current?.status !== "pending_analysis" &&
      current?.status !== "processing"
    ) {
      return { operation: "noop", status: current?.status || "missing" };
    }
    const started = Date.now();
    await analyzePstDuplicates(fileId);
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { analyze_duration_ms: { increment: Date.now() - started } },
    });
    const parsed = await prisma.processedFile.findUnique({
      where: { id: fileId },
      select: { filepath: true, status: true },
    });
    if (!parsed?.filepath || parsed.status !== "analyzed") {
      throw new Error("Parse did not reach the analyzed state.");
    }
    const artifacts = getPstArtifactPaths({
      fileId,
      filepath: parsed.filepath,
      stagingPath: process.env.STAGING_PATH || "",
      extractedPath: process.env.EXTRACTED_PATH || "",
    });
    if (!fs.existsSync(artifacts.rawEmlFolder)) {
      throw new Error(
        `Parse completed without its raw EML artifact at ${artifacts.rawEmlFolder}.`,
      );
    }
    await enqueueFilePhase({ fileId, phase: "extract" });
    return { operation: "parse" };
  }

  if (job.phase === "extract") {
    if (!row.filepath)
      throw new Error(`Extract row has no input path: ${fileId}`);
    const artifacts = getPstArtifactPaths({
      fileId,
      filepath: row.filepath,
      stagingPath: process.env.STAGING_PATH || "",
      extractedPath: process.env.EXTRACTED_PATH || "",
    });
    if (row.status !== "analyzed" || !fs.existsSync(artifacts.rawEmlFolder)) {
      // Extract never fabricates a missing Parse artifact. A fresh Parse job has
      // a new durable control-plane row because completed jobs do not dedupe.
      await prisma.processedFile.update({
        where: { id: fileId },
        data: { status: "pending_analysis" },
      });
      await enqueueFilePhase({ fileId, phase: "parse" });
      return { operation: "parse-recovery-scheduled" };
    }
    const started = Date.now();
    await extractUniqueEmails(fileId);
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { extract_duration_ms: { increment: Date.now() - started } },
    });
    const caseIds = await getCasePstFileIds(fileId);
    const unfinished = await prisma.processedFile.findFirst({
      where: { id: { in: caseIds }, status: { not: "completed" } },
      select: { id: true },
    });
    if (!unfinished) {
      const coordinatorId = [...caseIds].sort()[0];
      const coordinator = await prisma.processedFile.findUnique({
        where: { id: coordinatorId },
        select: {
          case_request: { select: { case: { select: { case_type: true } } } },
        },
      });
      if (coordinator?.case_request?.case.case_type === "client") {
        await markCaseAiCompleted(coordinatorId, 0);
        await prisma.processedFile.update({
          where: { id: coordinatorId },
          data: {
            pdf_status: "processing",
            pdf_duration_ms: 0,
            pdf_total: 0,
            pdf_processed: 0,
          },
        });
        await enqueueFilePhase({ fileId: coordinatorId, phase: "render" });
        return { operation: "client-dedup-ready-for-render" };
      }
      await prisma.processedFile.update({
        where: { id: coordinatorId },
        data: {
          // A queued AI coordinator is not yet consuming the global AI slot.
          // The one-shot AI worker marks it processing immediately before upload.
          ai_status: "pending",
          ai_started_at: null,
          ai_duration_ms: 0,
          ai_batches_total: 0,
          ai_batches_done: 0,
        },
      });
      await enqueueFilePhase({ fileId: coordinatorId, phase: "ai" });
    }
    return { operation: "extract" };
  }

  if (job.phase === "ai") {
    if (row.case_request_id) {
      const request = await prisma.caseRequest.findUnique({
        where: { id: row.case_request_id },
        select: { case: { select: { case_type: true } } },
      });
      if (request?.case.case_type === "client") {
        await markCaseAiCompleted(fileId, 0);
        await prisma.processedFile.update({
          where: { id: fileId },
          data: { pdf_status: "processing" },
        });
        await enqueueFilePhase({ fileId, phase: "render" });
        return { operation: "client-ai-skipped" };
      }
    }
    const caseIds = await getCasePstFileIds(fileId);
    const incompleteExtract = await prisma.processedFile.findFirst({
      where: { id: { in: caseIds }, status: { not: "completed" } },
      select: { id: true },
    });
    if (incompleteExtract) {
      await prisma.processedFile.update({
        where: { id: fileId },
        data: { ai_status: "pending", ai_started_at: null },
      });
      return { operation: "waiting-for-extract-fan-in" };
    }
    await prisma.processedFile.update({
      where: { id: fileId },
      data: {
        ai_status: "processing",
        ai_started_at: row.ai_started_at || BigInt(Date.now()),
      },
    });
    await fillAiBatchSlots(fileId, {
      name: row.subject_name || "",
      email: row.subject_email || "",
      personalEmail: row.subject_personal_email || undefined,
      aliases: aliases(row.subject_aliases),
    });
    return { operation: "batch-generated" };
  }

  if (job.phase === "render") {
    await convertToPdfBatch(fileId);
    // A combined request intentionally defers its independent Files source
    // until all email deliverables have rendered. Files-only requests are
    // admitted directly by the Run route; mail-only requests have no Files row.
    if (row.case_request_id) {
      const requestRows = await prisma.processedFile.findMany({
        where: { case_request_id: row.case_request_id },
        select: { id: true, kind: true, pdf_status: true, files_status: true },
      });
      const allMailRendered = requestRows
        .filter((item) => item.kind === "pst")
        .every((item) => item.pdf_status === "completed");
      if (allMailRendered) {
        const filesRows = requestRows.filter(
          (item) => item.kind === "files" && item.files_status === "pending",
        );
        for (const filesRow of filesRows) {
          const claim = await prisma.processedFile.updateMany({
            where: { id: filesRow.id, files_status: "pending" },
            data: {
              files_status: "processing",
              files_started_at: BigInt(Date.now()),
            },
          });
          if (claim.count > 0)
            await enqueueFilePhase({ fileId: filesRow.id, phase: "files" });
        }
      }
    }
    return { operation: "render" };
  }

  if (!row.filepath) throw new Error(`Files row has no input path: ${fileId}`);
  let subjectName = row.subject_name || "";
  let subjectAliases = row.subject_aliases;
  let subjectPersonalEmail = row.subject_personal_email;
  if (!subjectName.trim() && row.case_request_id) {
    const request = await prisma.caseRequest.findUnique({
      where: { id: row.case_request_id },
      include: { case: true },
    });
    if (request?.case.subject_name.trim()) {
      subjectName = request.case.subject_name;
      subjectAliases = request.case.subject_aliases;
      subjectPersonalEmail = request.case.subject_personal_email;
      await prisma.processedFile.update({
        where: { id: fileId },
        data: {
          subject_name: request.case.subject_name,
          subject_email: request.case.subject_email,
          subject_personal_email: request.case.subject_personal_email,
          subject_aliases: request.case.subject_aliases,
        },
      });
    }
  }
  if (!subjectName.trim()) {
    const error =
      "Configuration required: this Files request has no configured case subject.";
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { files_status: "failed" },
    });
    if (row.case_request_id) {
      await prisma.caseRequest.update({
        where: { id: row.case_request_id },
        data: { status: "failed", error },
      });
    }
    throw new Error(error);
  }
  const stagingBase = process.env.STAGING_PATH || "";
  const outputBase = process.env.EXTRACTED_PATH || "";
  const requestPath = path.dirname(path.relative(stagingBase, row.filepath));
  const filesBatch = job.payload.metadata?.filesBatch === true;
  const filesFallback = job.payload.metadata?.filesFallback === true;
  const filesFinalize = job.payload.metadata?.filesFinalize === true;
  const batchPaths = job.payload.metadata?.paths;
  const batchIndex = job.payload.metadata?.index;

  if (filesFinalize) {
    const directories = {
      messagesDir: path.join(outputBase, requestPath, "Messages"),
      documentsDir: path.join(outputBase, requestPath, "Documents"),
    };
    const result = finalizeStandaloneDeliverables(directories);
    const request = row.case_request_id
      ? await prisma.caseRequest.findUnique({
          where: { id: row.case_request_id },
          select: { case: { select: { case_type: true } } },
        })
      : null;
    const isClientCase = request?.case.case_type === "client";
    await prisma.processedFile.update({
      where: { id: fileId },
      data: isClientCase
        ? {
            files_status: "completed",
            upload_status: "idle",
            upload_total: 0,
            upload_uploaded: 0,
            upload_error: null,
          }
        : { files_status: "completed" },
    });
    const queued = isClientCase
      ? 0
      : await queueSharePointArtifacts(
          fileId,
          listFinalizedStandaloneDeliverables(directories),
        );
    if (queued > 0) startSharePointArtifactWorker();
    await archiveCompletedCase(fileId);
    return { operation: "files-finalized", queuedForUpload: queued, ...result };
  }

  if (filesFallback) {
    if (!Array.isArray(batchPaths) || !batchPaths.every(isString)) {
      throw new Error("Files fallback is missing its assigned input paths.");
    }
    const fallback = await copyUnconvertedStandaloneFiles({
      filePaths: batchPaths,
      messagesDir: path.join(outputBase, requestPath, "Messages"),
      documentsDir: path.join(outputBase, requestPath, "Documents"),
    });
    const totals = await recordFilesBatchResult({
      jobId: job.id,
      fileId,
      processed: fallback.copied,
      skipped: fallback.missing,
      duplicates: 0,
    });
    await prisma.processedFile.update({
      where: { id: fileId },
      data: {
        files_processed: totals.processed,
        files_skipped: totals.skipped,
        files_duplicates: totals.duplicates,
        files_progress_handled: Math.min(
          row.files_total,
          totals.processed + totals.skipped,
        ),
      },
    });
    return { operation: "files-fallback", ...fallback };
  }

  // The initial Files job is a fast coordinator. It captures a deterministic
  // input manifest, then fans it out into bounded one-shot worker jobs.
  if (!filesBatch) {
    const paths = listStandaloneInputFiles(row.filepath);
    const request = row.case_request_id
      ? await prisma.caseRequest.findUnique({
          where: { id: row.case_request_id },
          select: { case: { select: { case_type: true } } },
        })
      : null;
    const isClientCase = request?.case.case_type === "client";
    // Client deduplication must span the whole input. Keep it in one batch so
    // the in-memory content and byte-hash sets remain authoritative.
    const batchSize = isClientCase
      ? Math.max(1, paths.length)
      : Math.max(1, Number(process.env.FILES_BATCH_SIZE || 100));
    const runKey = String(row.files_started_at || BigInt(Date.now()));
    await clearFilesBatchResults(fileId);
    if (paths.length === 0) {
      await prisma.processedFile.update({
        where: { id: fileId },
        data: { files_status: "completed", files_total: 0 },
      });
      await archiveCompletedCase(fileId);
      return { operation: "files-empty" };
    }
    const largeOfficePaths = paths.filter(isLargeOfficeFile);
    const regularPaths = paths.filter(
      (filePath) => !isLargeOfficeFile(filePath),
    );
    const regularBatches = Array.from(
      { length: Math.ceil(regularPaths.length / batchSize) },
      (_, index) =>
        regularPaths.slice(index * batchSize, (index + 1) * batchSize),
    );
    // Each heavy Office document is its own job. This avoids a retry of one
    // workbook replaying an otherwise-successful group of normal documents.
    const batches = [
      ...regularBatches.map((paths) => ({ paths, largeOfficeBatch: false })),
      ...largeOfficePaths.map((filePath) => ({
        paths: [filePath],
        largeOfficeBatch: true,
      })),
    ];
    await prisma.processedFile.update({
      where: { id: fileId },
      data: {
        files_status: "processing",
        files_total: paths.length,
        files_progress_total: paths.length,
        files_progress_handled: 0,
        files_processed: 0,
        files_skipped: 0,
        files_duplicates: 0,
      },
    });
    await Promise.all(
      batches.map(({ paths, largeOfficeBatch }, index) =>
        enqueueFilePhase({
          fileId,
          phase: "files",
          dedupeKey: `files:${fileId}:${runKey}:${index}`,
          metadata: {
            filesBatch: true,
            index,
            totalBatches: batches.length,
            runKey,
            paths,
            largeOfficeBatch,
          },
          // Regular work stays ahead in the queue. The claim guard is the
          // safety net that prevents an early large-file start when a normal
          // worker is still running.
          priority: largeOfficeBatch ? 200 : 100,
        }),
      ),
    );
    return {
      operation: "files-batches-enqueued",
      batches: batches.length,
      largeOfficeBatches: largeOfficePaths.length,
    };
  }

  // A Files batch must receive the dispatcher-created slice explicitly. Never
  // fall back to scanning the full Files directory here: doing so makes every
  // parallel worker process the entire case and prevents batch progress from
  // ever settling.
  if (!Array.isArray(batchPaths) || !batchPaths.every(isString)) {
    throw new Error("Files batch is missing its assigned input paths.");
  }

  const started =
    typeof row.files_started_at === "bigint"
      ? Number(row.files_started_at)
      : Date.now();
  const result = await runStandaloneBatch(
    {
      inputDir: row.filepath,
      filePaths: batchPaths,
      messagesDir: path.join(outputBase, requestPath, "Messages"),
      documentsDir: path.join(outputBase, requestPath, "Documents"),
      subjectCriteria: {
        name: subjectName,
        personalEmail: subjectPersonalEmail || undefined,
        aliases: aliases(subjectAliases),
      },
      clientMode: row.case_request_id
        ? (
            await prisma.caseRequest.findUnique({
              where: { id: row.case_request_id },
              select: { case: { select: { case_type: true } } },
            })
          )?.case.case_type === "client"
        : false,
    },
    () => {
      // Final batch totals are persisted exactly once below. Per-file writes
      // would race with sibling workers and make aggregate progress regress.
    },
  );
  if (!result.success) throw new Error(result.error || "Files phase failed.");
  const totals = await recordFilesBatchResult({
    jobId: job.id,
    fileId,
    processed: result.processedCount ?? 0,
    // Some filters intentionally return early (e.g. unsupported files), so
    // normalize the aggregate count to the assigned manifest length. This
    // keeps durable UI progress honest: every batch input is processed or
    // skipped exactly once.
    skipped: Math.max(
      result.skippedCount ?? 0,
      batchPaths.length - (result.processedCount ?? 0),
    ),
    duplicates: result.duplicatesCount ?? 0,
  });
  await prisma.processedFile.update({
    where: { id: fileId },
    data: {
      files_processed: totals.processed,
      files_skipped: totals.skipped,
      files_duplicates: totals.duplicates,
      files_progress_handled: Math.min(
        row.files_total,
        totals.processed + totals.skipped,
      ),
      files_duration_ms: Date.now() - started,
    },
  });
  return {
    operation: "files-batch",
    batch: typeof batchIndex === "number" ? batchIndex : undefined,
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
