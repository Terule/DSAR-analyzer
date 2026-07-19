import path from "node:path";
import { enqueueJob } from "@/lib/control-plane/job-store";
import { isControlPlaneEnabled } from "@/lib/control-plane/postgres";
import { ensureControlPlaneSchema } from "@/lib/control-plane/schema";
import type {
  ControlJobPayload,
  ControlPhase,
} from "@/lib/control-plane/types";
import { prisma } from "@/lib/prisma";

/** The local control-plane is the primary pipeline when its dependencies exist. */
export function isControlPlanePipelineEnabled(): boolean {
  const configured = process.env.CONTROL_PLANE_PIPELINE_ENABLED;
  if (configured) return /^(1|true|yes|on)$/i.test(configured);
  return isControlPlaneEnabled();
}

function caseParts(filepath: string | null): {
  caseKey: string;
  requestKey?: string;
} {
  const staging = process.env.STAGING_PATH || "";
  const relative = filepath && staging ? path.relative(staging, filepath) : "";
  const parts = relative
    .split(path.sep)
    .filter((part) => part && part !== "..");
  return { caseKey: parts[0] || "unknown", requestKey: parts[1] };
}

/**
 * Persist work before waking the Docker dispatcher. Expensive PST/PDF work is
 * executed by one-shot job containers, never inside a Next route.
 */
export async function enqueueFilePhase(input: {
  fileId: string;
  phase: ControlPhase;
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
}): Promise<string> {
  const row = await prisma.processedFile.findUnique({
    where: { id: input.fileId },
    select: { filepath: true },
  });
  if (!row) throw new Error(`Processed file not found: ${input.fileId}`);

  await ensureControlPlaneSchema();
  const keys = caseParts(row.filepath);
  const payload: ControlJobPayload = {
    fileId: input.fileId,
    phase: input.phase,
    caseKey: keys.caseKey,
    requestKey: keys.requestKey,
    inputPath: row.filepath ?? undefined,
    metadata: input.metadata,
  };
  const job = await enqueueJob({
    phase: input.phase,
    dedupeKey: input.dedupeKey || `${input.phase}:${input.fileId}`,
    payload,
  });

  return job.id;
}
