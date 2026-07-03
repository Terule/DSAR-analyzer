import { NextResponse } from "next/server";
import { runBatchSweep } from "@/lib/batch-scheduler";

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

    // Delegate to the shared sweep used by the in-server poller. This route
    // remains available as a manual/external trigger, but the app no longer
    // depends on a standalone cron process during normal operation.
    const { polledBatches, renderWorkerStarted } = await runBatchSweep();

    return NextResponse.json({
      success: true,
      message:
        polledBatches > 0
          ? "Cron sweep completed successfully."
          : renderWorkerStarted
            ? "No pending batches to sync. Render worker triggered."
            : "No pending batches to sync.",
      processed_count: polledBatches,
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
