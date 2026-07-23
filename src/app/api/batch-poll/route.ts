import { NextResponse } from "next/server";
import { pollBatchStatus } from "@/lib/batch-worker";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { fileId } = await request.json();

    if (!fileId) {
      return NextResponse.json(
        { success: false, error: "Missing required parameter: fileId" },
        { status: 400 },
      );
    }

    // Trigger the manual poll and CAPTURE the status
    // We cast to 'unknown' to satisfy Biome's noExplicitAny rule while still
    // stopping TypeScript from complaining about a void overlap if the cache is stale.
    const status = (await pollBatchStatus(fileId)) as unknown;

    // A coordinator can legitimately have no *currently submitted* Batch while
    // another worker is filling slots or all rows are already settled.  Do not
    // revert it based on the legacy processed_files.batch_id pointer.
    if (status === "no_batch") {
      const activeRun = await prisma.aiBatchRun.findFirst({
        where: {
          coordinator_id: fileId,
          status: { in: ["claiming", "submitted", "processing"] },
        },
        select: { id: true },
      });

      if (!activeRun) {
        console.log(
          `[Batch Poll] No active durable batch run for ${fileId}; leaving its coordinator state unchanged.`,
        );
      }
    }

    return NextResponse.json(
      { success: true, status, message: "Status sync complete" },
      { status: 200 },
    );
  } catch (error) {
    console.error("API route /api/batch-poll encountered an error:", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
