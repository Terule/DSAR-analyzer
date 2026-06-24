import { NextResponse } from "next/server";
import { pollBatchStatus } from "@/lib/batch-worker";
import { db } from "@/lib/db";

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

    // 🔥 ORPHANED BATCH AUTO-HEALER 🔥
    // If the worker returns "no_batch", the file is missing its OpenAI ID.
    if (status === "no_batch") {
      const row = db
        .prepare("SELECT ai_status FROM processed_files WHERE id = ?")
        .get(fileId) as { ai_status: string } | undefined;

      if (row && row.ai_status === "batch_ready") {
        console.log(
          `[Auto-Heal] File ${fileId} was stuck in 'batch_ready' without an OpenAI batch_id! Reverting to 'pending'...`,
        );

        // Push the file back to pending so the UI orchestrator can restart it instantly
        db.prepare(
          "UPDATE processed_files SET ai_status = 'pending' WHERE id = ?",
        ).run(fileId);

        return NextResponse.json(
          {
            success: true,
            status: "reverted",
            message:
              "Ghost file reverted to pending to allow orchestrator to retry.",
          },
          { status: 200 },
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
