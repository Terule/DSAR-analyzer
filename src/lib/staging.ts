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
    } else if (entry.name.endsWith(".pst")) {
      arrayOfFiles.push(fullPath);
    }
  }

  return arrayOfFiles;
}

export async function syncStagingArea(
  directoryPath: string = process.env.STAGING_PATH ||
    "/Users/rafaelaguiar/Projects/staging-area",
) {
  if (!fs.existsSync(directoryPath)) return;

  // 1. Reset the entire database: Wipes all tracked emails and processed files.
  // This guarantees that replaced, renamed, or modified files are scanned completely fresh.
  const resetTransaction = db.transaction(() => {
    db.prepare("DELETE FROM emails").run();
    db.prepare("DELETE FROM processed_files").run();
  });
  resetTransaction();

  // 2. Get all current files asynchronously without freezing the server
  const currentFilePaths = await getAllPstFiles(directoryPath);

  // 3. Prepare fresh inserts
  const insertStmt = db.prepare(`
    INSERT INTO processed_files (id, filename, filepath, file_size_bytes, status)
    VALUES (?, ?, ?, ?, 'pending')
  `);

  // Wrapped in a transaction to execute disk operations instantly
  const insertTransaction = db.transaction(() => {
    for (const fullPath of currentFilePaths) {
      const stats = fs.statSync(fullPath);
      const filename = path.basename(fullPath);
      const fileId = crypto
        .createHash("sha256")
        .update(fullPath)
        .digest("hex")
        .substring(0, 12);

      insertStmt.run(fileId, filename, fullPath, stats.size);
    }
  });
  insertTransaction(); // Execute transaction
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
