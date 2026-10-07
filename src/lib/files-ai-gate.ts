import fs from "node:fs";
import path from "node:path";
import {
  getFilesStageJobState,
  recordFilesBatchResult,
} from "./control-plane/job-store";
import { enqueueFilePhase } from "./control-plane/pipeline";
import {
  type FilesAiClient,
  getFilesAiState,
  isFilesAiSettled,
  keepUnsubmittedFiles,
  openAiFilesAiClient,
  prepareFilesAi,
} from "./files-ai";
import { applyDiscards, writeVerdictsCsv } from "./files-ai-apply";
import type { FilesAiCriteria } from "./files-ai-prompt";
import { getAiBatchSettings } from "./pipeline-settings";
import { prisma } from "./prisma";

export type FilesAiGate = "waiting" | "ready" | "failed";

/** The AI check runs for employee cases with the setting on; client cases never. */
export async function filesAiRequired(fileId: string): Promise<boolean> {
  if (!(await getAiBatchSettings()).filesAiEnabled) return false;
  const row = await prisma.processedFile.findUnique({
    where: { id: fileId },
    select: {
      case_request: { select: { case: { select: { case_type: true } } } },
    },
  });
  const caseType = row?.case_request?.case.case_type;
  return caseType !== undefined && caseType !== "client";
}

/**
 * Called on every dispatcher sweep once all Files batches settled. Walks the
 * AI step prepare -> (poller) -> apply and reports whether finalize may run.
 * A prepare that dead-letters never blocks delivery (everything is kept); an
 * apply that dead-letters may have moved some files, so it fails the run.
 */
export async function advanceFilesAi(
  fileId: string,
  runKey: string,
): Promise<FilesAiGate> {
  const prepare = await getFilesStageJobState(fileId, runKey, "filesAiPrepare");
  if (prepare.active > 0) return "waiting";
  if (prepare.completed === 0) {
    if (prepare.failed === 0) {
      await enqueueFilePhase({
        fileId,
        phase: "files",
        dedupeKey: `files-ai-prepare:${fileId}:${runKey}`,
        metadata: { filesAiPrepare: true, runKey },
      });
      return "waiting";
    }
    // Prepare dead-lettered. If it never submitted anything, deliver
    // everything. If some batches already went out, still read them (their
    // discards must not be dropped) and keep the files that were never sent.
    const state = await getFilesAiState(fileId);
    if (state.total === 0 && state.activeRuns === 0) return "ready";
    await keepUnsubmittedFiles(fileId);
  }
  if (!(await isFilesAiSettled(fileId))) return "waiting";

  const apply = await getFilesStageJobState(fileId, runKey, "filesAiApply");
  if (apply.active > 0) return "waiting";
  if (apply.failed > 0) return "failed";
  if (apply.completed > 0) return "ready";
  await enqueueFilePhase({
    fileId,
    phase: "files",
    dedupeKey: `files-ai-apply:${fileId}:${runKey}`,
    metadata: { filesAiApply: true, runKey },
  });
  return "waiting";
}

/** Body of the `filesAiPrepare` job. Never throws: the AI must not block delivery. */
export async function runFilesAiPrepare(input: {
  fileId: string;
  dirs: { messagesDir: string; documentsDir: string };
  criteria: FilesAiCriteria;
  /** `undefined` opens the real client; `null` means no OpenAI key. */
  client?: FilesAiClient | null;
  readText?: (absPath: string) => Promise<string>;
}): Promise<Record<string, unknown>> {
  const client =
    input.client === undefined
      ? await openAiFilesAiClient().catch(() => null)
      : input.client;
  if (!client) {
    console.warn("[Files AI] No OpenAI client; delivering everything.");
    return { operation: "files-ai-skipped" };
  }
  try {
    const result = await prepareFilesAi({
      fileId: input.fileId,
      dirs: input.dirs,
      criteria: input.criteria,
      client,
      readText: input.readText,
    });
    return { operation: "files-ai-prepared", ...result };
  } catch (error) {
    console.warn(`[Files AI] prepare failed: ${error}; delivering everything.`);
    await prisma.filesAiVerdict.updateMany({
      where: { file_id: input.fileId, verdict: null },
      data: {
        verdict: "keep",
        reason: "AI step failed; kept.",
        resolved_at: new Date(),
      },
    });
    return { operation: "files-ai-prepare-failed" };
  }
}

/**
 * Body of the `filesAiApply` job: moves discarded files to `Discarded/`, writes
 * the verdict CSV and shifts the counters from processed to skipped. Safe to
 * run twice: moves are idempotent and the counter shift is recorded once per job.
 */
export async function applyFilesAiVerdicts(input: {
  jobId: string;
  fileId: string;
  requestOutputDir: string;
}): Promise<{ discarded: number; moved: number; alreadyMoved: number }> {
  const verdicts = await prisma.filesAiVerdict.findMany({
    where: { file_id: input.fileId, verdict: "discard" },
    select: { rel_path: true, reason: true },
    orderBy: { rel_path: "asc" },
  });
  if (verdicts.length === 0) return { discarded: 0, moved: 0, alreadyMoved: 0 };

  const discards = verdicts.map((v) => ({
    relPath: v.rel_path,
    reason: v.reason ?? "",
  }));
  const { moved, alreadyMoved } = applyDiscards({
    requestOutputDir: input.requestOutputDir,
    discards,
  });
  // The CSV lists every discard of the request, so a later wave does not erase
  // the rows an earlier wave wrote.
  const owner = await prisma.processedFile.findUnique({
    where: { id: input.fileId },
    select: { case_request_id: true },
  });
  const requestDiscards = owner?.case_request_id
    ? await prisma.filesAiVerdict.findMany({
        where: {
          verdict: "discard",
          file: { case_request_id: owner.case_request_id, kind: "files" },
        },
        select: { rel_path: true, reason: true },
        orderBy: [{ file_id: "asc" }, { rel_path: "asc" }],
      })
    : verdicts;
  writeVerdictsCsv({
    requestOutputDir: input.requestOutputDir,
    rows: requestDiscards.map((v) => ({
      relPath: v.rel_path,
      verdict: "discard",
      reason: v.reason ?? "",
    })),
  });
  const effective = moved + alreadyMoved;
  const totals = await recordFilesBatchResult({
    jobId: input.jobId,
    fileId: input.fileId,
    processed: -effective,
    skipped: effective,
    duplicates: 0,
  });
  await prisma.processedFile.update({
    where: { id: input.fileId },
    data: {
      files_processed: totals.processed,
      files_skipped: totals.skipped,
      files_duplicates: totals.duplicates,
    },
  });
  return { discarded: verdicts.length, moved, alreadyMoved };
}

/**
 * Forgets one Files row's AI state before its run is retried: its verdicts and
 * batch runs, and the files it moved to `Discarded/` (other waves' discards stay).
 * In-flight OpenAI batches are not cancelled; their results are never read.
 */
export async function clearFilesAiState(input: {
  fileId: string;
  requestOutputDir: string;
}): Promise<void> {
  const discarded = await prisma.filesAiVerdict.findMany({
    where: { file_id: input.fileId, verdict: "discard" },
    select: { rel_path: true },
  });
  for (const { rel_path } of discarded) {
    fs.rmSync(path.join(input.requestOutputDir, "Discarded", rel_path), {
      force: true,
    });
  }
  await prisma.$transaction([
    prisma.filesAiVerdict.deleteMany({ where: { file_id: input.fileId } }),
    prisma.filesAiBatchRun.deleteMany({ where: { file_id: input.fileId } }),
  ]);
}
