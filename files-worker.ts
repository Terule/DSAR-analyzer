/**
 * Files phase worker.
 * Spawned by /api/files-process as a detached child process. Processes ONE
 * "Files" batch row (Teams messages + loose documents) for a [case]/[request]
 * using the shared standalone processor, updating its status + metrics in the DB.
 */

import path from "node:path";
import { db } from "./src/lib/db";
import { runStandaloneBatch } from "./src/lib/standalone-processor";

interface FilesRow {
  id: string;
  filepath: string;
  subject_name?: string;
  subject_email?: string;
  subject_aliases?: string;
  files_started_at?: number;
}

async function main() {
  const fileId = process.argv[2];
  if (!fileId) {
    console.error("[files-worker] Missing fileId argument.");
    process.exit(2);
  }

  const row = db
    .prepare(
      `SELECT id, filepath, subject_name, subject_email, subject_aliases, files_started_at
       FROM processed_files WHERE id = ? AND kind = 'files'`,
    )
    .get(fileId) as FilesRow | undefined;

  if (!row) {
    console.error(`[files-worker] Files row not found: ${fileId}`);
    process.exit(1);
  }

  const startedAt = row.files_started_at || Date.now();
  let lastProgressWrite = 0;

  const stagingBase =
    process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";
  const outputBaseDir =
    process.env.EXTRACTED_PATH || "/Users/rgomes/Projects/extracted_emails";

  // filepath is the ".../[case]/[request]/Files" directory.
  const caseRequest = path.dirname(path.relative(stagingBase, row.filepath));
  const messagesDir = path.join(outputBaseDir, caseRequest, "Messages");
  const documentsDir = path.join(outputBaseDir, caseRequest, "Documents");

  const aliases = row.subject_aliases
    ? row.subject_aliases
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean)
    : [];

  try {
    const result = await runStandaloneBatch(
      {
        inputDir: row.filepath,
        messagesDir,
        documentsDir,
        subjectCriteria: { name: row.subject_name || "", aliases },
      },
      (progress) => {
        // Throttle live progress writes so a large batch doesn't hammer the DB.
        const now = Date.now();
        if (now - lastProgressWrite < 1500) return;
        lastProgressWrite = now;
        db.prepare(
          "UPDATE processed_files SET files_processed = ?, files_skipped = ?, files_duplicates = ? WHERE id = ?",
        ).run(
          progress.processed,
          progress.skipped,
          progress.duplicates,
          fileId,
        );
      },
    );

    const durationMs = Date.now() - startedAt;

    if (result.success) {
      db.prepare(
        `UPDATE processed_files SET
           files_status = 'completed',
           files_processed = ?,
           files_skipped = ?,
           files_duplicates = ?,
           files_duration_ms = ?
         WHERE id = ?`,
      ).run(
        result.processedCount ?? 0,
        result.skippedCount ?? 0,
        result.duplicatesCount ?? 0,
        durationMs,
        fileId,
      );
      console.log(`[files-worker] Completed: ${fileId}`);
    } else {
      db.prepare(
        "UPDATE processed_files SET files_status = 'failed', files_duration_ms = ? WHERE id = ?",
      ).run(durationMs, fileId);
      console.error(`[files-worker] Failed: ${fileId} — ${result.error}`);
    }
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    db.prepare(
      "UPDATE processed_files SET files_status = 'failed', files_duration_ms = ? WHERE id = ?",
    ).run(durationMs, fileId);
    console.error(`[files-worker] Failed: ${fileId}`, error);
  }

  process.exit(0);
}

main();
