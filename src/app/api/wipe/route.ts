import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  cancelJobsForFiles,
  countPendingCancellation,
} from "@/lib/control-plane/job-store";
import {
  insertCaseHistorySnapshots,
  insertRunHistorySnapshots,
} from "@/lib/history";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Kill any running files-worker for a given files row so a wipe/reset never
// leaves an orphaned detached worker writing progress counters to the DB.
function killFilesWorker(fileId: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      "pkill",
      ["-9", "-f", `scripts/workers/files-worker.ts ${fileId}`],
      () => {
        // pkill exits non-zero when no process matches — safe to ignore.
        resolve();
      },
    );
  });
}

async function waitForWorkerCancellation(fileIds: string[]): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await countPendingCancellation(fileIds)) === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function outputFolderForFile(
  filepath: string,
  fileId: string,
  stagingPath: string,
  extractedPath: string,
): string {
  let relativeSystemPath = path.relative(stagingPath, filepath);
  if (
    relativeSystemPath.startsWith("..") ||
    path.isAbsolute(relativeSystemPath)
  ) {
    relativeSystemPath = fileId;
  }

  let cleanRelativePath = path.dirname(relativeSystemPath);
  if (cleanRelativePath === "." || cleanRelativePath === "") {
    cleanRelativePath = path.parse(relativeSystemPath).name;
  }

  // Normalize to [case]/[request], whether the input is a PST file
  // (.../PST/file.pst) or its Files directory (.../Files).
  if (path.basename(cleanRelativePath).toLowerCase() === "pst") {
    cleanRelativePath = path.dirname(cleanRelativePath);
  }

  return path.join(extractedPath, cleanRelativePath);
}

function deleteCaseOutput(
  files: Array<{ id: string; filepath: string | null }>,
  stagingPath: string,
  extractedPath: string,
): void {
  const targets = new Set<string>();
  for (const file of files) {
    if (file.filepath) {
      targets.add(
        outputFolderForFile(file.filepath, file.id, stagingPath, extractedPath),
      );
    }
  }

  for (const targetFolder of targets) {
    if (!fs.existsSync(targetFolder)) continue;
    // A worker has already exited before this point. Retries cover short-lived
    // Docker volume bookkeeping without leaving a half-reset database behind.
    fs.rmSync(targetFolder, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  }
}

export async function POST(request: Request) {
  try {
    const { caseName, fileIds } = await request.json();

    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return NextResponse.json(
        { success: false, error: "Missing fileIds" },
        { status: 400 },
      );
    }

    const stagingPath =
      process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";
    const extractedPath =
      process.env.EXTRACTED_PATH || "/Users/rgomes/Projects/extracted_emails";

    // Retrieve the exact file paths to correctly identify the extracted folders
    const filesToReset = await prisma.processedFile.findMany({
      where: { id: { in: fileIds } },
      select: { id: true, filepath: true },
    });
    if (filesToReset.length !== fileIds.length) {
      return NextResponse.json(
        { success: false, error: "One or more case files no longer exist." },
        { status: 404 },
      );
    }

    // The dispatcher owns Docker-socket access. Request cancellation through
    // the durable job store, then wait until it has removed active containers
    // before deleting folders those containers may still be writing to.
    await cancelJobsForFiles(fileIds, "Cancelled by case reset");
    if (!(await waitForWorkerCancellation(fileIds))) {
      return NextResponse.json(
        {
          success: false,
          error: "Active workers did not stop in time; reset was not applied.",
        },
        { status: 409 },
      );
    }

    // Defensive cleanup for legacy detached Files workers, then remove all
    // deliverables while DB state is still intact. If deletion fails, no state
    // is reset and the operator can safely retry rather than getting a partial
    // reset that needs manual repair.
    // It can't keep writing progress counters after the wipe (orphan prevention).
    await Promise.all(filesToReset.map((file) => killFilesWorker(file.id)));
    deleteCaseOutput(filesToReset, stagingPath, extractedPath);

    const archivedRuns = await insertRunHistorySnapshots(
      fileIds,
      "manual_reset",
    );
    const archivedCases = await insertCaseHistorySnapshots(
      fileIds,
      "manual_reset",
    );

    await prisma.$transaction([
      // 1. Delete all child emails from the database for this case
      prisma.email.deleteMany({ where: { file_id: { in: fileIds } } }),

      // 2a. Reset PST rows completely back to zero.
      prisma.processedFile.updateMany({
        where: { id: { in: fileIds }, kind: { not: "files" } },
        data: {
          status: "pending",
          ai_status: "pending",
          pdf_status: "pending",
          subject_name: null,
          subject_email: null,
          subject_personal_email: null,
          subject_aliases: null,
          total_emails: 0,
          total_attachments: 0,
          unique_emails: 0,
          duplicate_emails: 0,
          estimated_tokens: 0,
          ai_approved_count: 0,
          ai_discarded_count: 0,
          ai_batches_total: 0,
          ai_batches_done: 0,
          metadata_duration_ms: 0,
          analyze_duration_ms: 0,
          extract_duration_ms: 0,
          ai_duration_ms: 0,
          pdf_duration_ms: 0,
          pdf_total: 0,
          pdf_processed: 0,
          ai_started_at: null,
          batch_id: null,
        },
      }),

      // 2b. Reset Files rows: keep them inert to the email phases (all email
      // columns 'completed') and reset only the Files-phase status/metrics.
      prisma.processedFile.updateMany({
        where: { id: { in: fileIds }, kind: "files" },
        data: {
          status: "completed",
          ai_status: "completed",
          pdf_status: "completed",
          subject_name: null,
          subject_email: null,
          subject_personal_email: null,
          subject_aliases: null,
          files_status: "pending",
          files_processed: 0,
          files_skipped: 0,
          files_duplicates: 0,
          files_duration_ms: 0,
          files_started_at: null,
        },
      }),
    ]);

    console.log(
      `[Reset Engine] Successfully wiped and reset files for Case: ${caseName || "Unknown"}`,
    );
    console.log(
      `[Reset Engine] Archived ${archivedRuns} run history snapshots before reset.`,
    );
    console.log(
      `[Reset Engine] Archived ${archivedCases} case history snapshots before reset.`,
    );

    return NextResponse.json(
      { success: true, message: `Case reset successfully.` },
      { status: 200 },
    );
  } catch (error) {
    console.error("API route /api/wipe encountered an error:", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
