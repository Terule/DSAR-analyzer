import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPstFilename } from "./file-types";
import {
  insertCaseHistorySnapshots,
  insertRunHistorySnapshot,
} from "./history";
import { prisma } from "./prisma";

// Recursive function using async/promises to prevent blocking the Node.js event loop
async function getAllPstFiles(
  dirPath: string,
  arrayOfFiles: string[] = [],
): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    console.error(`[Scanner] Cannot read dir ${dirPath}:`, err);
    return arrayOfFiles;
  }

  for (const entry of entries) {
    const fullPath = path.resolve(dirPath, entry.name);

    if (entry.isDirectory()) {
      arrayOfFiles = await getAllPstFiles(fullPath, arrayOfFiles);
    } else if (isPstFilename(entry.name)) {
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
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    console.error(`[Scanner] Cannot read dir ${dirPath}:`, err);
    return found;
  }

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

  // Prune FIRST, before any directory walk. Pruning only needs the DB +
  // fs.existsSync, so running it up front guarantees that rows for deleted
  // cases are removed even if the walk/upsert below later throws (e.g. an
  // unreadable Files folder). Previously prune ran last, so a mid-scan error
  // meant adds succeeded but deletions were silently skipped.
  const pruned = await pruneMissingRows();

  const currentPstPaths = await getAllPstFiles(directoryPath);
  const filesDirs = await getAllFilesDirs(directoryPath);

  const hashId = (value: string) =>
    crypto.createHash("sha256").update(value).digest("hex").substring(0, 12);

  let newPst = 0;
  for (const fullPath of currentPstPaths) {
    try {
      const stats = fs.statSync(fullPath);
      const fileId = hashId(fullPath);
      const existed = await prisma.processedFile.findUnique({
        where: { id: fileId },
        select: { id: true },
      });

      await prisma.processedFile.upsert({
        where: { id: fileId },
        create: {
          id: fileId,
          filename: path.basename(fullPath),
          filepath: fullPath,
          file_size_bytes: BigInt(stats.size),
          status: "pending",
          kind: "pst",
        },
        update: {
          filename: path.basename(fullPath),
          filepath: fullPath,
          file_size_bytes: BigInt(stats.size),
        },
      });

      if (!existed) newPst++;
    } catch (err) {
      console.error(`[Scanner] Skipping PST ${fullPath}:`, err);
    }
  }

  let newFiles = 0;
  for (const filesDir of filesDirs) {
    try {
      const { count, totalBytes } = await summarizeFilesDir(filesDir);
      if (count === 0) continue; // Skip empty Files folders.

      const fileId = hashId(filesDir);
      const existed = await prisma.processedFile.findUnique({
        where: { id: fileId },
        select: { id: true },
      });

      await prisma.processedFile.upsert({
        where: { id: fileId },
        create: {
          id: fileId,
          filename: "Files",
          filepath: filesDir,
          file_size_bytes: BigInt(totalBytes),
          status: "completed",
          ai_status: "completed",
          pdf_status: "completed",
          kind: "files",
          files_total: count,
        },
        update: {
          filepath: filesDir,
          file_size_bytes: BigInt(totalBytes),
          files_total: count,
        },
      });

      if (!existed) newFiles++;
    } catch (err) {
      console.error(`[Scanner] Skipping Files dir ${filesDir}:`, err);
    }
  }

  console.log(
    `[Scanner] Sync complete. Added ${newPst} PST files and ${newFiles} Files batches. Pruned ${pruned} stale rows.`,
  );
}

/**
 * Removes rows whose backing file/directory no longer exists on disk.
 * Returns the number of rows deleted.
 */
export async function pruneMissingRows(): Promise<number> {
  const rows = await prisma.processedFile.findMany({
    select: { id: true, filepath: true },
  });

  const missingRows = rows.filter(
    (item) => !item.filepath || !fs.existsSync(item.filepath),
  );
  const missingIds = missingRows.map((item) => item.id);

  if (missingIds.length > 0) {
    await insertCaseHistorySnapshots(missingIds, "source_deleted");
  }

  let deleted = 0;
  await prisma.$transaction(async (tx) => {
    for (const item of missingRows) {
      await insertRunHistorySnapshot(item.id, "source_deleted");
      await tx.email.deleteMany({ where: { file_id: item.id } });
      await tx.processedFile.delete({ where: { id: item.id } });
      deleted++;
    }
  });

  return deleted;
}

/**
 * Backfills missing file sizes without reprocessing cases.
 * Returns number of rows updated.
 */
export async function backfillMissingFileSizes(limit = 500): Promise<number> {
  const rows = await prisma.processedFile.findMany({
    where: { file_size_bytes: { lte: 0 } },
    select: { id: true, filepath: true },
    take: limit,
  });

  if (rows.length === 0) return 0;

  let updatedCount = 0;
  await prisma.$transaction(async (tx) => {
    for (const item of rows) {
      if (!item.filepath || !fs.existsSync(item.filepath)) continue;
      const size = fs.statSync(item.filepath).size;
      if (size <= 0) continue;
      await tx.processedFile.update({
        where: { id: item.id },
        data: { file_size_bytes: BigInt(size) },
      });
      updatedCount++;
    }
  });

  if (updatedCount > 0) {
    console.log(`[Scanner] Backfilled file sizes for ${updatedCount} rows.`);
  }
  return updatedCount;
}

/**
 * Updates file size in the database, useful after a "purge".
 */
export async function updateFileSize(fileId: string) {
  const row = await prisma.processedFile.findUnique({
    where: { id: fileId },
    select: { filepath: true },
  });

  if (row?.filepath && fs.existsSync(row.filepath)) {
    const stats = fs.statSync(row.filepath);
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { file_size_bytes: BigInt(stats.size) },
    });
  }
}
