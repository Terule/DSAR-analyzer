import fs from "node:fs/promises";
import path from "node:path";
import { getJob } from "../../src/lib/control-plane/job-store";
import { runPhaseJob } from "../../src/lib/control-plane/phase-runner";
import { closeControlPlanePool } from "../../src/lib/control-plane/postgres";
import { prisma } from "../../src/lib/prisma";
import { closeQueueAdapter } from "../../src/lib/queue/factory";

/** Executes exactly one already-claimed control-plane job, then exits. */

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) throw new Error("Missing control-plane job id.");
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
