import { NextResponse } from "next/server";
import {
  isControlPlaneEnabled,
  pingControlPlaneDb,
} from "@/lib/control-plane/postgres";
import { ensureControlPlaneSchema } from "@/lib/control-plane/schema";

export const dynamic = "force-dynamic";

export async function POST() {
  if (!isControlPlaneEnabled()) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Control plane is disabled. Configure POSTGRES_URL (or POSTGRES_URL_DOCKER in Docker) to bootstrap Postgres schema.",
      },
      { status: 412 },
    );
  }

  try {
    await pingControlPlaneDb();
    await ensureControlPlaneSchema();

    return NextResponse.json(
      {
        success: true,
        message: "Control-plane schema ensured.",
      },
      { status: 200 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to bootstrap control-plane schema.",
      },
      { status: 500 },
    );
  }
}
