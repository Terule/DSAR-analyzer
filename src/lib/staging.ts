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

// Finds every directory named "Files" (case-insensitive) anywhere under the root.
// Each such folder is a "Files" batch for its [case]/[request].
async function getAllFilesDirs(
  dirPath: string,
  found: string[] = [],
): Promise<string[]> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.resolve(dirPath, entry.name);

    if (entry.name.toLowerCase() === "files") {
      found.push(fullPath);
      continue; // Do not descend into a Files batch folder.
    }
    found = await getAllFilesDirs(fullPath, found);
  }

  return found;
}

// Counts non-hidden, non-metadata files and sums their sizes within a Files dir.
async function summarizeFilesDir(
  dirPath: string,
): Promise<{ count: number; totalBytes: number }> {
  let count = 0;
  let totalBytes = 0;

  const walk = async (current: string) => {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.resolve(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (
        !entry.name.startsWith(".") &&
        !entry.name.toLowerCase().endsWith(".json")
      ) {
        count++;
        try {
          totalBytes += (await fs.promises.stat(fullPath)).size;
        } catch {
          // Ignore unreadable files.
        }
      }
    }
  };

  await walk(dirPath);
  return { count, totalBytes };
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

  const currentPstPaths = await getAllPstFiles(directoryPath);
  const filesDirs = await getAllFilesDirs(directoryPath);

  const upsertPst = db.prepare(`
    INSERT INTO processed_files (id, filename, filepath, file_size_bytes, status, kind)
    VALUES (?, ?, ?, ?, 'pending', 'pst')
    ON CONFLICT(id) DO UPDATE SET
      filename = excluded.filename,
      filepath = excluded.filepath,
      file_size_bytes = excluded.file_size_bytes
  `);

  const upsertFiles = db.prepare(`
    INSERT INTO processed_files (id, filename, filepath, file_size_bytes, status, ai_status, pdf_status, kind, files_total)
    VALUES (?, 'Files', ?, ?, 'completed', 'completed', 'completed', 'files', ?)
    ON CONFLICT(id) DO UPDATE SET
      filepath = excluded.filepath,
      file_size_bytes = excluded.file_size_bytes,
      files_total = excluded.files_total
  `);

  const hashId = (value: string) =>
    crypto.createHash("sha256").update(value).digest("hex").substring(0, 12);

  let newPst = 0;
  for (const fullPath of currentPstPaths) {
    const stats = fs.statSync(fullPath);
    const fileId = hashId(fullPath);
    const existed = db
      .prepare("SELECT 1 FROM processed_files WHERE id = ? LIMIT 1")
      .get(fileId);
    upsertPst.run(fileId, path.basename(fullPath), fullPath, stats.size);
    if (!existed) newPst++;
  }

  let newFiles = 0;
  for (const filesDir of filesDirs) {
    const { count, totalBytes } = await summarizeFilesDir(filesDir);
    if (count === 0) continue; // Skip empty Files folders.

    const fileId = hashId(filesDir);
    const existed = db
      .prepare("SELECT 1 FROM processed_files WHERE id = ? LIMIT 1")
      .get(fileId);
    upsertFiles.run(fileId, filesDir, totalBytes, count);
    if (!existed) newFiles++;
  }

  // Prune orphaned rows whose source no longer exists on disk. This happens
  // when a PST/Files path is moved or renamed (the id is a hash of the path),
  // leaving a stale record that would otherwise fail the pipeline (readpst
  // "No such file or directory"). PST rows point at a file; Files rows point
  // at a directory — both must still exist to be kept.
  const pruned = pruneMissingRows();

  console.log(
    `[Scanner] Sync complete. Added ${newPst} PST files and ${newFiles} Files batches. Pruned ${pruned} stale rows.`,
  );
}

/**
 * Removes rows whose backing file/directory no longer exists on disk.
 * Returns the number of rows deleted.
 */
export function pruneMissingRows(): number {
  const rows = db.prepare("SELECT id, filepath FROM processed_files").all() as {
    id: string;
    filepath: string;
  }[];

  const deleteFile = db.prepare("DELETE FROM processed_files WHERE id = ?");
  const deleteEmails = db.prepare("DELETE FROM emails WHERE file_id = ?");

  const tx = db.transaction((items: { id: string; filepath: string }[]) => {
    let deleted = 0;
    for (const item of items) {
      if (item.filepath && fs.existsSync(item.filepath)) continue;
      deleteEmails.run(item.id);
      deleteFile.run(item.id);
      deleted++;
    }
    return deleted;
  });

  return tx(rows);
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
