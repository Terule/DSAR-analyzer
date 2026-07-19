import { NextResponse } from "next/server";
import { requeueExpiredLeases } from "@/lib/control-plane/job-store";
import { isControlPlaneEnabled } from "@/lib/control-plane/postgres";

export const dynamic = "force-dynamic";

/**
 * Manual/external trigger for the lease-expiry janitor sweep. Reclaims jobs whose
 * worker lease expired without a heartbeat (crashed/killed worker) so they can be
 * requeued (or moved to dead_letter once max_attempts is exhausted).
 */
export async function POST() {
  if (!isControlPlaneEnabled()) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Control plane is disabled. Configure POSTGRES_URL (or POSTGRES_URL_DOCKER in Docker) to enable orchestrator sweeps.",
      },
      { status: 412 },
    );
  }

  try {
    const reclaimed = await requeueExpiredLeases();
    return NextResponse.json({ success: true, reclaimed }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to sweep expired orchestrator leases.",
      },
      { status: 500 },
    );
  }
}
