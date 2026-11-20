import { statfs } from "node:fs/promises";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Free space (bytes) on the disk that holds the staging and results folders. */
async function freeBytes(path: string | undefined): Promise<number | null> {
  if (!path) return null;
  try {
    const stats = await statfs(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export async function GET() {
  const free = await freeBytes(
    process.env.EXTRACTED_PATH || process.env.STAGING_PATH,
  );
  return NextResponse.json({ freeBytes: free });
}
