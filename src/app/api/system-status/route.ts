import { statfs } from "node:fs/promises";
import os from "node:os";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Free and total bytes on the disk that holds a folder, or null when unreadable. */
async function disk(
  path: string | undefined,
): Promise<{ free: number; total: number } | null> {
  if (!path) return null;
  try {
    const stats = await statfs(path);
    return {
      free: Number(stats.bavail) * Number(stats.bsize),
      total: Number(stats.blocks) * Number(stats.bsize),
    };
  } catch {
    return null;
  }
}

export async function GET() {
  const output = await disk(
    process.env.EXTRACTED_PATH || process.env.STAGING_PATH,
  );
  return NextResponse.json({
    freeBytes: output?.free ?? null,
    totalBytes: output?.total ?? null,
    memoryTotalBytes: os.totalmem(),
    memoryUsedBytes: os.totalmem() - os.freemem(),
    stagingPath: process.env.STAGING_PATH ?? null,
    extractedPath: process.env.EXTRACTED_PATH ?? null,
  });
}
