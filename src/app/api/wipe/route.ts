import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Kill any running files-worker for a given files row so a wipe/reset never
// leaves an orphaned detached worker writing progress counters to the DB.
function killFilesWorker(fileId: string): void {
  execFile("pkill", ["-9", "-f", `files-worker.ts ${fileId}`], () => {
    // pkill exits non-zero when no process matches — safe to ignore.
  });
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

    const placeholders = fileIds.map(() => "?").join(",");

    // Retrieve the exact file paths to correctly identify the extracted folders
    const filesToReset = db
      .prepare(
        `SELECT id, filepath FROM processed_files WHERE id IN (${placeholders})`,
      )
      .all(...fileIds) as { id: string; filepath: string }[];

    // 1. Delete all child emails from the database for this case
    db.prepare(`DELETE FROM emails WHERE file_id IN (${placeholders})`).run(
      ...fileIds,
    );

    // 1b. Kill any running Files worker for these rows before resetting, so it
    // can't keep writing progress counters after the wipe (orphan prevention).
    for (const file of filesToReset) {
      killFilesWorker(file.id);
    }

    // 2a. Reset PST rows completely back to zero.
    db.prepare(`
      UPDATE processed_files 
      SET status = 'pending', 
          ai_status = 'pending', 
          pdf_status = 'pending',
          file_size_bytes = 0,
          subject_name = NULL,
          subject_email = NULL,
          subject_aliases = NULL,
          total_emails = 0,
          total_attachments = 0,
          unique_emails = 0,
          duplicate_emails = 0,
          estimated_tokens = 0,
          ai_approved_count = 0,
          ai_discarded_count = 0,
          ai_batches_total = 0,
          ai_batches_done = 0,
          metadata_duration_ms = 0,
          analyze_duration_ms = 0,
          extract_duration_ms = 0,
          ai_duration_ms = 0,
          pdf_duration_ms = 0,
          ai_started_at = NULL,
          batch_id = NULL
      WHERE id IN (${placeholders}) AND kind != 'files'
    `).run(...fileIds);

    // 2b. Reset Files rows: keep them inert to the email phases (all email
    // columns 'completed') and reset only the Files-phase status/metrics.
    db.prepare(`
      UPDATE processed_files
      SET status = 'completed',
          ai_status = 'completed',
          pdf_status = 'completed',
          subject_name = NULL,
          subject_email = NULL,
          subject_aliases = NULL,
          files_status = 'pending',
          files_processed = 0,
          files_skipped = 0,
          files_duplicates = 0,
          files_duration_ms = 0,
          files_started_at = NULL
      WHERE id IN (${placeholders}) AND kind = 'files'
    `).run(...fileIds);

    // 3. Wipe the hard drive working folders for these specific files
    for (const file of filesToReset) {
      let relativeSystemPath = path.relative(stagingPath, file.filepath);
      if (
        relativeSystemPath.startsWith("..") ||
        path.isAbsolute(relativeSystemPath)
      ) {
        relativeSystemPath = file.id;
      }

      let cleanRelativePath = path.dirname(relativeSystemPath);
      if (cleanRelativePath === "." || cleanRelativePath === "") {
        cleanRelativePath = path.parse(relativeSystemPath).name;
      }

      // Normalize to the [case]/[request] deliverables root regardless of
      // whether the row is a PST file (.../PST/x.pst) or a Files batch (.../Files).
      if (path.basename(cleanRelativePath).toLowerCase() === "pst") {
        cleanRelativePath = path.dirname(cleanRelativePath);
      }

      const targetFolder = path.join(extractedPath, cleanRelativePath);
      if (fs.existsSync(targetFolder)) {
        fs.rmSync(targetFolder, { recursive: true, force: true });
      }
    }

    console.log(
      `[Reset Engine] Successfully wiped and reset files for Case: ${caseName || "Unknown"}`,
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
