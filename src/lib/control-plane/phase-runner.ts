import fs from "node:fs";
import path from "node:path";
import { DEFAULT_MAX_TOKENS_PER_BATCH, generateBatchFile } from "@/lib/ai";
import { analyzePstDuplicates, scanFileMetadata } from "@/lib/analyzer";
import { getCasePstFileIds } from "@/lib/case-utils";
import {
  clearFilesBatchResults,
  recordFilesBatchResult,
} from "@/lib/control-plane/job-store";
import { enqueueFilePhase } from "@/lib/control-plane/pipeline";
import { convertToPdfBatch } from "@/lib/converter";
import { extractUniqueEmails } from "@/lib/exporter";
import { prisma } from "@/lib/prisma";
import { getPstArtifactPaths } from "@/lib/pst-artifacts";
import {
  finalizeStandaloneDeliverables,
  listStandaloneInputFiles,
  runStandaloneBatch,
} from "@/lib/standalone-processor";
import type { ControlJobRecord } from "./types";

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
      const totals = await prisma.processedFile.aggregate({
        where: { id: { in: caseIds } },
        _sum: { estimated_tokens: true, unique_emails: true },
      });
      const estimated = Math.max(
        1,
        Math.ceil(
          ((totals._sum.estimated_tokens ?? 0) +
            (totals._sum.unique_emails ?? 0) * 650) /
            DEFAULT_MAX_TOKENS_PER_BATCH,
        ),
      );
      await prisma.processedFile.update({
        where: { id: coordinatorId },
        data: {
          // A queued AI coordinator is not yet consuming the global AI slot.
          // The one-shot AI worker marks it processing immediately before upload.
          ai_status: "pending",
          ai_started_at: null,
          ai_duration_ms: 0,
          ai_batches_total: estimated,
          ai_batches_done: 0,
        },
      });
      await enqueueFilePhase({ fileId: coordinatorId, phase: "ai" });
    }
    return { operation: "extract" };
  }

  if (job.phase === "ai") {
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
    await generateBatchFile(fileId, {
      name: row.subject_name || "",
      email: row.subject_email || "",
      personalEmail: row.subject_personal_email || undefined,
      aliases: aliases(row.subject_aliases),
    });
    return { operation: "batch-generated" };
  }

  if (job.phase === "render") {
    await convertToPdfBatch(fileId);
    return { operation: "render" };
  }

  if (!row.filepath) throw new Error(`Files row has no input path: ${fileId}`);
  const stagingBase = process.env.STAGING_PATH || "";
  const outputBase = process.env.EXTRACTED_PATH || "";
  const requestPath = path.dirname(path.relative(stagingBase, row.filepath));
  const filesBatch = job.payload.metadata?.filesBatch === true;
  const filesFinalize = job.payload.metadata?.filesFinalize === true;
  const batchPaths = job.payload.metadata?.paths;
  const batchIndex = job.payload.metadata?.index;

  if (filesFinalize) {
    const result = finalizeStandaloneDeliverables({
      messagesDir: path.join(outputBase, requestPath, "Messages"),
      documentsDir: path.join(outputBase, requestPath, "Documents"),
    });
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { files_status: "completed" },
    });
    return { operation: "files-finalized", ...result };
  }

  // The initial Files job is a fast coordinator. It captures a deterministic
  // input manifest, then fans it out into bounded one-shot worker jobs.
  if (!filesBatch) {
    const paths = listStandaloneInputFiles(row.filepath);
    const batchSize = Math.max(1, Number(process.env.FILES_BATCH_SIZE || 100));
    const runKey = String(row.files_started_at || BigInt(Date.now()));
    await clearFilesBatchResults(fileId);
    if (paths.length === 0) {
      await prisma.processedFile.update({
        where: { id: fileId },
        data: { files_status: "completed", files_total: 0 },
      });
      return { operation: "files-empty" };
    }
    const batches = Array.from(
      { length: Math.ceil(paths.length / batchSize) },
      (_, index) => paths.slice(index * batchSize, (index + 1) * batchSize),
    );
    await prisma.processedFile.update({
      where: { id: fileId },
      data: {
        files_status: "processing",
        files_total: paths.length,
        files_processed: 0,
        files_skipped: 0,
        files_duplicates: 0,
      },
    });
    await Promise.all(
      batches.map((paths, index) =>
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
          },
        }),
      ),
    );
    return { operation: "files-batches-enqueued", batches: batches.length };
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
        name: row.subject_name || "",
        aliases: aliases(row.subject_aliases),
      },
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
