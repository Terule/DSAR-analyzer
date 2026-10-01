/**
 * Files phase worker.
 * Spawned by /api/files-process as a detached child process. Processes ONE
 * "Files" batch row (Teams messages + loose documents) for a [case]/[request]
 * using the shared standalone processor, updating its status + metrics in the DB.
 */

import fs from "node:fs";
import path from "node:path";
import { archiveCompletedCase } from "../../src/lib/history";
import { prisma } from "../../src/lib/prisma";
import { queueSharePointArtifacts } from "../../src/lib/sharepoint-artifact-outbox";
import { startSharePointArtifactWorker } from "../../src/lib/sharepoint-artifact-queue";
import { runStandaloneBatch } from "../../src/lib/standalone-processor";

interface FilesRow {
  id: string;
  filepath: string | null;
  subject_name: string | null;
  subject_email: string | null;
  subject_personal_email: string | null;
  subject_aliases: string | null;
  files_started_at: bigint | null;
}

async function main() {
  const fileId = process.argv[2];
  if (!fileId) {
    console.error("[files-worker] Missing fileId argument.");
    process.exit(2);
  }

  const row: FilesRow | null = await prisma.processedFile.findFirst({
    where: { id: fileId, kind: "files" },
    select: {
      id: true,
      filepath: true,
      subject_name: true,
      subject_email: true,
      subject_personal_email: true,
      subject_aliases: true,
      files_started_at: true,
    },
  });

  if (!row?.filepath) {
    console.error(`[files-worker] Files row not found: ${fileId}`);
    process.exit(1);
  }

  const filepath = row.filepath;
  const startedAt =
    typeof row.files_started_at === "bigint"
      ? Number(row.files_started_at)
      : Date.now();
  let lastProgressWrite = 0;

  const stagingBase =
    process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";
  const outputBaseDir =
    process.env.EXTRACTED_PATH || "/Users/rgomes/Projects/extracted_emails";

  // filepath is the ".../[case]/[request]/Files" directory.
  const caseRequest = path.dirname(path.relative(stagingBase, filepath));
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
        inputDir: filepath,
        messagesDir,
        documentsDir,
        subjectCriteria: {
          name: row.subject_name || "",
          aliases,
        },
      },
      (progress) => {
        // Throttle live progress writes so a large batch doesn't hammer the DB.
        const now = Date.now();
        if (now - lastProgressWrite < 1500) return;
        lastProgressWrite = now;
        prisma.processedFile
          .update({
            where: { id: fileId },
            data: {
              files_processed: progress.processed,
              files_skipped: progress.skipped,
              files_duplicates: progress.duplicates,
            },
          })
          .catch((err) => {
            console.error("[files-worker] Progress write failed:", err);
          });
      },
    );

    const durationMs = Date.now() - startedAt;

    if (result.success) {
      const finalized = [messagesDir, documentsDir].flatMap((directory) =>
        fs.existsSync(directory)
          ? fs
              .readdirSync(directory, { recursive: true })
              .map((entry) => path.join(directory, String(entry)))
              .filter(
                (entry) => fs.existsSync(entry) && fs.statSync(entry).isFile(),
              )
          : [],
      );
      await prisma.processedFile.update({
        where: { id: fileId },
        data: {
          files_status: "completed",
          files_processed: result.processedCount ?? 0,
          files_skipped: result.skippedCount ?? 0,
          files_duplicates: result.duplicatesCount ?? 0,
          files_duration_ms: durationMs,
        },
      });
      try {
        const queued = await queueSharePointArtifacts(fileId, finalized);
        if (queued > 0) startSharePointArtifactWorker();
      } catch (error) {
        console.error(
          "[files-worker] Could not queue final SharePoint artifacts:",
          error,
        );
      }
      await archiveCompletedCase(fileId);
      console.log(`[files-worker] Completed: ${fileId}`);
    } else {
      await prisma.processedFile.update({
        where: { id: fileId },
        data: { files_status: "failed", files_duration_ms: durationMs },
      });
      console.error(`[files-worker] Failed: ${fileId} — ${result.error}`);
    }
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { files_status: "failed", files_duration_ms: durationMs },
    });
    console.error(`[files-worker] Failed: ${fileId}`, error);
  }

  process.exit(0);
}

main();
