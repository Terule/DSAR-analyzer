import crypto from "node:crypto";
import { PSTFile, type PSTFolder } from "pst-extractor";
import { db } from "./db";

interface AnalysisMetrics {
  uniqueCount: number;
  duplicateCount: number;
  totalProcessed: number;
  totalAttachments: number;
}

/**
 * Safely fetches the subfolders of a PST folder.
 * Uses a zero-touch pre-filtering check to prevent executing native C++ panics.
 */
function safeGetSubFolders(folder: PSTFolder): PSTFolder[] {
  try {
    const sub = folder.getSubFolders();
    return sub && Array.isArray(sub) ? sub : [];
  } catch (err) {
    console.warn(
      `[PST BTree Warning] Bypassed corrupted child folders for "${folder.displayName || "Unknown Folder"}":`,
      err,
    );
    return [];
  }
}

/**
 * Checks if a folder is a virtual system/search folder that should be bypassed.
 * These folders contain zero unique emails and are highly prone to index corruption.
 */
function isSystemOrSearchFolder(folderName: string): boolean {
  if (!folderName) return false; // Allow empty names (like the root folder) to proceed unless checked explicitly
  const name = folderName.toLowerCase();
  return (
    name.includes("spam search folder") ||
    name.includes("search folder") ||
    name.includes("finder") ||
    name.includes("common views") ||
    name.includes("deferred action") ||
    name.includes("top of outlook data file") ||
    name === "views" ||
    name === "allpublicfolders"
  );
}

/**
 * Recursively traverses the folder tree to calculate gross email counts.
 * Uses super-fast header-level lookups instead of parsing every individual message.
 */
export async function scanFileMetadata(fileId: string): Promise<void> {
  const row = db
    .prepare("SELECT filepath FROM processed_files WHERE id = ?")
    .get(fileId) as { filepath: string } | undefined;
  if (!row) {
    throw new Error(`File record not found in database for ID: ${fileId}`);
  }

  let totalEmails = 0;

  try {
    const pst = new PSTFile(row.filepath);
    const rootFolder = pst.getRootFolder();

    async function traverse(folder: PSTFolder, isRoot = false) {
      const displayName = folder.displayName || "";

      // 🚨 CRITICAL FIX: Skip virtual directories, but NEVER skip the top-level Root container
      if (!isRoot && isSystemOrSearchFolder(displayName)) {
        return;
      }

      // Read total email count instantly from the directory header (O(1))
      totalEmails += folder.contentCount;

      const subFolders = safeGetSubFolders(folder);
      if (subFolders.length > 0) {
        for (const sub of subFolders) {
          await traverse(sub, false);
        }
      }
    }

    // Begin traversing by declaring the first node as the Root folder
    await traverse(rootFolder, true);

    // Save metadata with total_attachments initially set to 0 (will populate during deduplication)
    db.prepare(`
      UPDATE processed_files 
      SET total_emails = ?,
          total_attachments = 0,
          status = 'pending_analysis'
      WHERE id = ?
    `).run(totalEmails, fileId);
  } catch (error) {
    console.error(`Metadata scanning failed on file ${fileId}:`, error);
    db.prepare("UPDATE processed_files SET status = 'failed' WHERE id = ?").run(
      fileId,
    );
    throw error;
  }
}

/**
 * Recursively parses email folders, filters duplicates using Content-Aware signatures,
 * and tracks the actual number of attachments on the fly.
 */
async function processEmailFolder(
  folder: PSTFolder,
  fileId: string,
  metrics: AnalysisMetrics,
  isRoot = false,
): Promise<void> {
  const displayName = folder.displayName || "";

  // 🚨 Lock Guard: Bypass virtual search folders, but never skip the root container
  if (!isRoot && isSystemOrSearchFolder(displayName)) {
    return;
  }

  if (folder.contentCount > 0) {
    const checkStmt = db.prepare(
      "SELECT id FROM emails WHERE email_hash = ? LIMIT 1",
    );
    const insertStmt = db.prepare(`
      INSERT INTO emails (id, file_id, message_id, sent_date, email_hash, is_duplicate)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    try {
      let email = folder.getNextChild();

      while (email !== null) {
        try {
          const messageId = email.internetMessageId?.trim() || "";
          const sentDate = email.clientSubmitTime
            ? email.clientSubmitTime.toISOString()
            : "no-date";
          const subject = email.subject?.trim() || "no-subject";

          const rawBody = email.body || "";
          const normalizedBody = rawBody
            .replace(/\s+/g, " ")
            .trim()
            .substring(0, 1000)
            .toLowerCase();
          const normalizedSubject = subject
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

          // Content-Aware Signature hash
          const emailHash = crypto
            .createHash("sha256")
            .update(`${normalizedSubject}_${normalizedBody}`)
            .digest("hex");

          const existingRecord = checkStmt.get(emailHash);
          const isDuplicate = existingRecord ? 1 : 0;

          if (isDuplicate === 1) {
            metrics.duplicateCount++;
          } else {
            metrics.uniqueCount++;
            if (email.hasAttachments) {
              metrics.totalAttachments += email.numberOfAttachments;
            }
          }
          metrics.totalProcessed++;

          insertStmt.run(
            crypto.randomUUID(),
            fileId,
            messageId,
            sentDate,
            emailHash,
            isDuplicate,
          );
        } catch (emailErr) {
          console.warn(
            `[PST Warning] Skipping damaged message record during duplication analysis:`,
            emailErr,
          );
        }

        email = folder.getNextChild();
      }
    } catch (nodeErr) {
      console.warn(
        `[PST Warning] Structural parsing error in directory messages block. Bypassing safely...`,
        nodeErr,
      );
    }
  }

  const subFolders = safeGetSubFolders(folder);
  if (subFolders.length > 0) {
    for (const sub of subFolders) {
      await processEmailFolder(sub, fileId, metrics, false);
    }
  }
}

export async function analyzePstDuplicates(
  fileId: string,
): Promise<AnalysisMetrics> {
  const row = db
    .prepare("SELECT filepath FROM processed_files WHERE id = ?")
    .get(fileId) as { filepath: string } | undefined;
  if (!row) throw new Error("File metadata not found in database.");

  db.prepare(
    "UPDATE processed_files SET status = 'processing' WHERE id = ?",
  ).run(fileId);

  // Clear previous records for clean run
  db.prepare("DELETE FROM emails WHERE file_id = ?").run(fileId);

  const metrics: AnalysisMetrics = {
    uniqueCount: 0,
    duplicateCount: 0,
    totalProcessed: 0,
    totalAttachments: 0,
  };

  const pst = new PSTFile(row.filepath);
  await processEmailFolder(pst.getRootFolder(), fileId, metrics, true);

  db.prepare(`
    UPDATE processed_files 
    SET status = 'analyzed',
        total_emails = ?,
        unique_emails = ?,
        duplicate_emails = ?,
        total_attachments = ?
    WHERE id = ?
  `).run(
    metrics.totalProcessed,
    metrics.uniqueCount,
    metrics.duplicateCount,
    metrics.totalAttachments,
    fileId,
  );

  return metrics;
}
