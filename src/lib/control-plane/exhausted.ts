import { markCaseAiFailed } from "../case-utils";
import { prisma } from "../prisma";
import { getControlPlanePool } from "./postgres";
import type { ControlPhase } from "./types";

export interface LatestJob {
  status: string;
  lastError: string | null;
}

const PHASE_LABEL: Partial<Record<ControlPhase, string>> = {
  parse: "Parse",
  extract: "Extract",
  ai: "AI audit",
  render: "Render",
  files: "Files",
};
const MAX_ERROR_CHARS = 300;

/**
 * The message to record when a phase's latest job has used up all of its
 * attempts, or null when that job can still make progress.
 */
export function exhaustedMessage(
  phase: ControlPhase,
  latest: LatestJob | null,
): string | null {
  if (latest?.status !== "dead_letter") return null;
  const label = PHASE_LABEL[phase] ?? phase;
  const detail = latest.lastError?.trim().slice(0, MAX_ERROR_CHARS);
  return `${label} failed after repeated attempts${detail ? `: ${detail}` : "."}`;
}

async function latestJobForFilePhase(
  fileId: string,
  phase: ControlPhase,
): Promise<LatestJob | null> {
  const result = await getControlPlanePool().query<{
    status: string;
    last_error: string | null;
  }>(
    `SELECT status, last_error
       FROM orchestrator_jobs
      WHERE phase = $1 AND payload->>'fileId' = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [phase, fileId],
  );
  const row = result.rows[0];
  return row ? { status: row.status, lastError: row.last_error } : null;
}

/**
 * Stops the "re-queue anything that looks interrupted" recovery from looping
 * forever. A job that dead-lettered (all attempts used) is not an interruption:
 * re-enqueuing it just resets its attempt count and fails the same way again.
 * When the phase's latest job dead-lettered, mark the row failed (so the
 * dashboard shows it and Retry works) and return true so the caller skips it.
 * A newer queued/running job (a Retry) means the row is not exhausted.
 */
export async function failRowIfJobExhausted(
  fileId: string,
  phase: ControlPhase,
): Promise<boolean> {
  const message = exhaustedMessage(
    phase,
    await latestJobForFilePhase(fileId, phase),
  );
  if (!message) return false;

  if (phase === "render") {
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { pdf_status: "failed" },
    });
  } else if (phase === "ai") {
    await markCaseAiFailed(fileId, 0);
  } else if (phase === "files") {
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { files_status: "failed" },
    });
  } else if (phase === "parse" || phase === "extract") {
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { status: "failed" },
    });
  } else {
    return false;
  }
  console.error(`[dispatcher] ${fileId}: ${message} Marked failed; use Retry.`);
  return true;
}
