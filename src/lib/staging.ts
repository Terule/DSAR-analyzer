import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "./db";

// Recursive function using async/promises to prevent blocking the Node.js event loop
async function getAllPstFiles(
  dirPath: string,
  arrayOfFiles: string[] = [],
): Promise<string[]> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.resolve(dirPath, entry.name);

    if (entry.isDirectory()) {
      arrayOfFiles = await getAllPstFiles(fullPath, arrayOfFiles);
    } else if (entry.name.toLowerCase().endsWith(".pst")) {
      arrayOfFiles.push(fullPath);
    }
  }

  return arrayOfFiles;
}

export async function syncStagingArea(
  directoryPath: string = process.env.STAGING_PATH ||
    "/Users/rgomes/Projects/staging-area",
) {
  console.log(`[Scanner] Attempting to scan directory: ${directoryPath}`);

  if (!fs.existsSync(directoryPath)) {
    console.error(`[Scanner Error] Directory does not exist: ${directoryPath}`);
    return;
  }

  // 1. NO MORE GLOBAL WIPES!
  // We removed the DELETE FROM emails and processed_files transactions here.
  // The scanner is now 100% non-destructive.

  // 2. Get all current files asynchronously without freezing the server
  const currentFilePaths = await getAllPstFiles(directoryPath);

  // 3. Prepare fresh inserts using INSERT OR IGNORE
  // If the file hash already exists in the database, SQLite will simply ignore it and move on!
  const upsertStmt = db.prepare(`
    INSERT INTO processed_files (id, filename, filepath, file_size_bytes, status)
    VALUES (?, ?, ?, ?, 'pending')
    ON CONFLICT(id) DO UPDATE SET
      filename = excluded.filename,
      filepath = excluded.filepath,
      file_size_bytes = excluded.file_size_bytes
  `);

  // Wrapped in a transaction to execute disk operations instantly
  const insertTransaction = db.transaction(() => {
    let newFilesAdded = 0;
    for (const fullPath of currentFilePaths) {
      const stats = fs.statSync(fullPath);
      const filename = path.basename(fullPath);
      const fileId = crypto
        .createHash("sha256")
        .update(fullPath)
        .digest("hex")
        .substring(0, 12);

      const existed = db
        .prepare("SELECT 1 FROM processed_files WHERE id = ? LIMIT 1")
        .get(fileId);
      upsertStmt.run(fileId, filename, fullPath, stats.size);
      if (!existed) newFilesAdded++;
    }
    console.log(
      `[Scanner] Sync complete. Added ${newFilesAdded} new files. Ignored existing files.`,
    );
  });
  insertTransaction(); // Execute transaction
}

/**
 * Backfills missing file sizes without reprocessing cases.
 * Returns number of rows updated.
 */
export async function backfillMissingFileSizes(limit = 500): Promise<number> {
  const rows = db
    .prepare(
      `SELECT id, filepath FROM processed_files
       WHERE COALESCE(file_size_bytes, 0) <= 0
       LIMIT ?`,
    )
    .all(limit) as { id: string; filepath: string }[];

  if (rows.length === 0) return 0;

  const updateStmt = db.prepare(
    "UPDATE processed_files SET file_size_bytes = ? WHERE id = ?",
  );

  const tx = db.transaction((items: { id: string; filepath: string }[]) => {
    let updated = 0;
    for (const item of items) {
      if (!item.filepath || !fs.existsSync(item.filepath)) continue;
      const size = fs.statSync(item.filepath).size;
      if (size <= 0) continue;
      updateStmt.run(size, item.id);
      updated++;
    }
    return updated;
  });

  const updatedCount = tx(rows);
  if (updatedCount > 0) {
    console.log(`[Scanner] Backfilled file sizes for ${updatedCount} rows.`);
  }
  return updatedCount;
}

/**
 * Updates file size in the database, useful after a "purge".
 */
export async function updateFileSize(fileId: string) {
  const row = db
    .prepare("SELECT filepath FROM processed_files WHERE id = ?")
    .get(fileId) as { filepath: string } | undefined;

  if (row && fs.existsSync(row.filepath)) {
    const stats = fs.statSync(row.filepath);
    db.prepare(
      "UPDATE processed_files SET file_size_bytes = ? WHERE id = ?",
    ).run(stats.size, fileId);
  }
}
