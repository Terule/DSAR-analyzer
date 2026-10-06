import { appendFileSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getJob } from "../../src/lib/control-plane/job-store";
import { runPhaseJob } from "../../src/lib/control-plane/phase-runner";
import { closeControlPlanePool } from "../../src/lib/control-plane/postgres";
import { workerLogPath } from "../../src/lib/job-log";
import { prisma } from "../../src/lib/prisma";
import { closeQueueAdapter } from "../../src/lib/queue/factory";

/** Executes exactly one already-claimed control-plane job, then exits. */

/**
 * Workers are AutoRemove containers, so Docker's own logs vanish with them.
 * Mirror everything this process prints into a file on the shared logs mount
 * so the dispatcher can still attach it to a failed job.
 */
function mirrorOutputToFile(jobId: string): void {
  const file = workerLogPath(process.cwd(), jobId);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return;
  }
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (
      chunk: string | Uint8Array,
      ...rest: unknown[]
    ) => boolean;
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      try {
        appendFileSync(file, chunk);
      } catch {
        // Logging must never break the job.
      }
      return write(chunk, ...rest);
    }) as typeof stream.write;
  }
}

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) throw new Error("Missing control-plane job id.");
  mirrorOutputToFile(jobId);
  const resultPath = path.join(
    process.cwd(),
    "logs",
    "jobs",
    `${jobId}.result.json`,
  );
  try {
    const job = await getJob(jobId);
    if (!job) throw new Error(`Control-plane job not found: ${jobId}`);
    await runPhaseJob(job);
    await fs.mkdir(path.dirname(resultPath), { recursive: true });
    await fs.writeFile(resultPath, JSON.stringify({ success: true }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await fs.mkdir(path.dirname(resultPath), { recursive: true });
    await fs.writeFile(
      resultPath,
      JSON.stringify({
        success: false,
        error: message,
        // Configuration cannot be repaired by retrying the same worker.
        retryable: !message.startsWith("Configuration required:"),
      }),
    );
    throw error;
  } finally {
    // A worker is deliberately one-shot. Each phase can enqueue follow-up
    // work, which creates a BullMQ/Redis connection. Close every client so
    // Node has no live handles keeping an otherwise-complete container alive.
    await Promise.allSettled([
      prisma.$disconnect(),
      closeControlPlanePool(),
      closeQueueAdapter(),
    ]);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error("[job-runner]", error);
    process.exit(1);
  },
);
