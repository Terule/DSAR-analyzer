import { NextResponse } from "next/server";
import {
  isControlPlaneEnabled,
  pingControlPlaneDb,
} from "@/lib/control-plane/postgres";
import { getQueueAdapter, resolveQueueProvider } from "@/lib/queue/factory";

export const dynamic = "force-dynamic";

export async function GET() {
  const controlPlaneEnabled = isControlPlaneEnabled();
  const queueProvider = resolveQueueProvider();

  const postgres = {
    ok: false,
    message: controlPlaneEnabled
      ? "not checked"
      : "disabled (no Postgres control-plane config)",
  };

  const queue: {
    provider: string;
    ok: boolean;
    details: Record<string, unknown>;
  } = {
    provider: queueProvider,
    ok: false,
    details: {
      message: controlPlaneEnabled
        ? "not checked"
        : "disabled (no Postgres control-plane config)",
    },
  };

  if (controlPlaneEnabled) {
    try {
      await pingControlPlaneDb();
      postgres.ok = true;
      postgres.message = "connected";
    } catch (error) {
      postgres.ok = false;
      postgres.message =
        error instanceof Error ? error.message : "Postgres ping failed.";
    }

    try {
      const adapter = getQueueAdapter();
      const health = await adapter.health();
      queue.provider = health.provider;
      queue.ok = health.ok;
      queue.details = health.details || {};
    } catch (error) {
      queue.ok = false;
      queue.details = {
        message:
          error instanceof Error ? error.message : "Queue health check failed.",
      };
    }
  }

  return NextResponse.json(
    {
      success: true,
      controlPlaneEnabled,
      executionProvider: process.env.EXECUTION_PROVIDER || "local-process",
      queueProvider,
      postgres,
      queue,
    },
    { status: 200 },
  );
}
