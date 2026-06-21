import { NextResponse } from "next/server";
import { pollBatchStatus } from "@/lib/batch-worker";
import { db } from "@/lib/db";

// Prevent Next.js from caching this route
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    // 1. Optional Security: Prevent unauthorized hits if deployed publicly
    const authHeader = request.headers.get("authorization");
    if (
      process.env.CRON_SECRET &&
      authHeader !== `Bearer ${process.env.CRON_SECRET}`
    ) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    // 2. Find ALL files that have been sent to OpenAI but are waiting for sync
    const pendingFiles = db
      .prepare(`
      SELECT id FROM processed_files 
      WHERE ai_status = 'batch_ready' AND batch_id IS NOT NULL
    `)
      .all() as { id: string }[];

    if (pendingFiles.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No pending batches to sync.",
      });
    }

    console.log(
      `[Cron Engine] Waking up. Found ${pendingFiles.length} pending batches.`,
    );

    // 3. Loop through and poll each one safely
    for (const file of pendingFiles) {
      try {
        await pollBatchStatus(file.id);
      } catch (err) {
        console.error(`[Cron Engine] Failed to poll file ${file.id}:`, err);
      }
    }

    return NextResponse.json({
      success: true,
      message: "Cron sweep completed successfully.",
      processed_count: pendingFiles.length,
    });
  } catch (error) {
    console.error("[Cron Engine] Fatal error:", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
