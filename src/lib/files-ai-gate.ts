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
  prepareFilesAi,
  reviewUnsubmittedFiles,
  sendCandidatesToReview,
} from "./files-ai";
import {
  applyDiscards,
  applyReviews,
  HUMAN_REVIEW_DIR,
  writeReviewCsv,
  writeVerdictsCsv,
} from "./files-ai-apply";
import type { FilesAiCriteria } from "./files-ai-prompt";
import { configuredFilesAiClient } from "./files-ai-provider";
import { exportAuditTrail, recordFileItems } from "./items";
import { getAiBatchSettings } from "./pipeline-settings";
import { prisma } from "./prisma";

export type FilesAiGate = "waiting" | "ready" | "failed";

/**
 * The AI check runs for every case type while the setting is on: employee cases
 * are screened for relevance and confidentiality, client cases for
 * confidentiality only.
 */
export async function filesAiRequired(fileId: string): Promise<boolean> {
  if (!(await getAiBatchSettings()).filesAiEnabled) return false;
  const row = await prisma.processedFile.findUnique({
    where: { id: fileId },
    select: { case_request_id: true },
  });
  return Boolean(row?.case_request_id);
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
    await reviewUnsubmittedFiles(fileId);
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
  /** `undefined` opens the real client; `null` means no AWS credentials. */
  client?: FilesAiClient | null;
  readText?: (absPath: string) => Promise<string>;
}): Promise<Record<string, unknown>> {
  const client =
    input.client === undefined
      ? await configuredFilesAiClient().catch(() => null)
      : input.client;
  if (!client) {
    console.warn(
      "[Files AI] No AI client; sending every file to human review.",
    );
    const reviewed = await sendCandidatesToReview(
      input.fileId,
      input.dirs,
      "No AI screening available; needs human review.",
    );
    return { operation: "files-ai-skipped", reviewed };
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
    console.warn(
      `[Files AI] prepare failed: ${error}; unreviewed files go to human review.`,
    );
    await prisma.filesAiVerdict.updateMany({
      where: { file_id: input.fileId, verdict: null },
      data: {
        verdict: "review",
        reason: "AI step failed; needs human review.",
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
}): Promise<{
  discarded: number;
  moved: number;
  alreadyMoved: number;
  reviewed: number;
}> {
  const owner = await prisma.processedFile.findUnique({
    where: { id: input.fileId },
    select: { case_request_id: true },
  });
  const requestScope = owner?.case_request_id
    ? { case_request_id: owner.case_request_id, kind: "files" }
    : undefined;

  // Audit trail (shadow): every settled verdict, keyed by its delivered path.
  const settled = await prisma.filesAiVerdict.findMany({
    where: { file_id: input.fileId, verdict: { not: null } },
    select: {
      rel_path: true,
      verdict: true,
      reason: true,
      reviewed_by_model: true,
    },
  });
  await recordFileItems(
    input.fileId,
    settled.map((v) => ({
      relPath: v.rel_path,
      state:
        v.verdict === "keep"
          ? "kept"
          : v.verdict === "discard"
            ? "discarded"
            : "review",
      rule: "ai_file",
      reason: v.reason ?? null,
      decidedBy: v.reviewed_by_model ?? "ai",
    })),
  );

  await exportAuditTrail(owner?.case_request_id, input.requestOutputDir);

  // Files the AI could not settle are held back from numbering and delivered
  // in their own folder. They stay delivered, so the counters do not move.
  const reviews = await prisma.filesAiVerdict.findMany({
    where: { file_id: input.fileId, verdict: "review" },
    select: { rel_path: true, reason: true },
    orderBy: { rel_path: "asc" },
  });
  if (reviews.length > 0) {
    applyReviews({
      requestOutputDir: input.requestOutputDir,
      reviews: reviews.map((v) => ({
        relPath: v.rel_path,
        reason: v.reason ?? "",
      })),
    });
    const requestReviews = requestScope
      ? await prisma.filesAiVerdict.findMany({
          where: { verdict: "review", file: requestScope },
          select: { rel_path: true, reason: true },
          orderBy: [{ file_id: "asc" }, { rel_path: "asc" }],
        })
      : reviews;
    writeReviewCsv({
      requestOutputDir: input.requestOutputDir,
      rows: requestReviews.map((v) => ({
        relPath: v.rel_path,
        reason: v.reason ?? "",
      })),
    });
  }

  const verdicts = await prisma.filesAiVerdict.findMany({
    where: { file_id: input.fileId, verdict: "discard" },
    select: { rel_path: true, reason: true },
    orderBy: { rel_path: "asc" },
  });
  if (verdicts.length === 0) {
    return {
      discarded: 0,
      moved: 0,
      alreadyMoved: 0,
      reviewed: reviews.length,
    };
  }

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
  const requestDiscards = requestScope
    ? await prisma.filesAiVerdict.findMany({
        where: { verdict: "discard", file: requestScope },
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
  return {
    discarded: verdicts.length,
    moved,
    alreadyMoved,
    reviewed: reviews.length,
  };
}

/**
 * Forgets one Files row's AI state before its run is retried: its verdicts and
 * batch runs, and the files it moved to `Discarded/` (other waves' discards stay).
 * In-flight batches are not cancelled; their results are never read.
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
  const reviewed = await prisma.filesAiVerdict.findMany({
    where: { file_id: input.fileId, verdict: "review" },
    select: { rel_path: true },
  });
  for (const { rel_path } of reviewed) {
    fs.rmSync(path.join(input.requestOutputDir, HUMAN_REVIEW_DIR, rel_path), {
      force: true,
    });
  }
  await prisma.$transaction([
    prisma.filesAiVerdict.deleteMany({ where: { file_id: input.fileId } }),
    prisma.filesAiBatchRun.deleteMany({ where: { file_id: input.fileId } }),
  ]);
}
