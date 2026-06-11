import { PSTFile, type PSTFolder } from "pst-extractor";
import { db } from "./db";

interface ScanResults {
  totalEmails: number;
  totalAttachments: number;
}

/**
 * Recursively walks through a PST folder structure to gather superficial metadata
 * without processing or extracting heavy email body strings into memory.
 */
function walkPSTFolder(folder: PSTFolder, results: ScanResults): void {
  // Add emails count in this specific folder layer
  if (folder.contentCount > 0) {
    results.totalEmails += folder.contentCount;

    // Superficial parsing loop to count attachments
    let email = folder.getNextChild();
    while (email !== null) {
      if (email.hasAttachments) {
        // Increment total attachments count safely
        results.totalAttachments += 1;
      }
      email = folder.getNextChild();
    }
  }

  // Traverse subdirectories recursively
  if (folder.hasSubfolders) {
    const subFolders = folder.getSubFolders();
    for (const subFolder of subFolders) {
      walkPSTFolder(subFolder, results);
    }
  }
}

/**
 * Opens a local PST file, retrieves its profile metrics,
 * and updates its metadata status inside the SQLite database.
 */
export async function scanFileMetadata(fileId: string): Promise<void> {
  // 1. Fetch file path from DB
  const row = db
    .prepare("SELECT filepath FROM processed_files WHERE id = ?")
    .get(fileId) as { filepath: string } | undefined;

  if (!row) {
    throw new Error(`File with ID ${fileId} not found in tracking records.`);
  }

  // 2. Explicitly update DB state to processing
  db.prepare(
    "UPDATE processed_files SET status = 'processing' WHERE id = ?",
  ).run(fileId);

  try {
    const results: ScanResults = { totalEmails: 0, totalAttachments: 0 };

    // 3. Initialize the PST instance pointer directly from disk
    const pstFile = new PSTFile(row.filepath);
    const rootFolder = pstFile.getRootFolder();

    // 4. Collect file content tallies
    walkPSTFolder(rootFolder, results);

    // 5. Commit stats to SQLite record and flip status to pending analysis
    db.prepare(`
      UPDATE processed_files 
      SET total_emails = ?, total_attachments = ?, status = 'pending_analysis'
      WHERE id = ?
    `).run(results.totalEmails, results.totalAttachments, fileId);
  } catch (error) {
    // Catch faults and flag the file status safely to avoid pipeline locks
    db.prepare("UPDATE processed_files SET status = 'failed' WHERE id = ?").run(
      fileId,
    );
    console.error(`Metadata scanning engine failed for ID ${fileId}:`, error);
    throw error;
  }
}
