import { spawn } from "node:child_process";
import path from "node:path";
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

    // 2. Safety net: if AI is complete but rendering is still pending, trigger PDF worker.
    const hasPendingRender = db
      .prepare(
        `SELECT 1 FROM processed_files
         WHERE ai_status = 'completed' AND pdf_status = 'pending'
         LIMIT 1`,
      )
      .get();

    let renderWorkerStarted = false;
    if (hasPendingRender) {
      const workerPath = path.resolve(process.cwd(), "convert-worker.ts");
      const child = spawn("bun", [workerPath], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      renderWorkerStarted = true;
      console.log(
        "[Cron Engine] Triggered PDF worker for pending render jobs.",
      );
    }

    // 3. Find all files that were sent to OpenAI but are waiting for sync.
    const pendingFiles = db
      .prepare(`
      SELECT id FROM processed_files 
      WHERE ai_status = 'batch_ready' AND batch_id IS NOT NULL
    `)
      .all() as { id: string }[];

    if (pendingFiles.length === 0) {
      return NextResponse.json({
        success: true,
        message: renderWorkerStarted
          ? "No pending batches to sync. Render worker triggered."
          : "No pending batches to sync.",
        render_worker_started: renderWorkerStarted,
      });
    }

    console.log(
      `[Cron Engine] Waking up. Found ${pendingFiles.length} pending batches.`,
    );

    // 4. Loop through and poll each one safely.
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
      render_worker_started: renderWorkerStarted,
    });
  } catch (error) {
    console.error("[Cron Engine] Fatal error:", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
