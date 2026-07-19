/**
 * Standalone PDF conversion worker.
 * Spawned by /api/convert as a detached child process. Processes ALL files
 * with ai_status='completed' and pdf_status='pending' one by one, then exits.
 * Only one instance of this worker should run at a time.
 */

import { isCaseAiSettled } from "../../src/lib/case-utils";
import { convertToPdfBatch } from "../../src/lib/converter";
import { prisma } from "../../src/lib/prisma";

let shouldStop = false;

function requestShutdown(signal: string) {
  if (shouldStop) return;
  shouldStop = true;
  console.log(
    `[convert-worker] Received ${signal}. Will stop after current job completes.`,
  );
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

async function pickNext(): Promise<
  { id: string; ai_status: string; pdf_status: string } | undefined
> {
  // Render is case-level. Only claim a file whose entire case has settled its
  // AI phase, so we never render (and prematurely mark completed) a case while a
  // sibling PST file is still being audited.
  const candidates = await prisma.processedFile.findMany({
    where: { ai_status: "completed", pdf_status: "pending" },
    orderBy: { created_at: "asc" },
    select: { id: true, ai_status: true, pdf_status: true },
  });

  for (const candidate of candidates) {
    if (await isCaseAiSettled(candidate.id)) return candidate;
  }
  return undefined;
}

async function run() {
  let file = await pickNext();

  while (file && !shouldStop) {
    const { id } = file;

    // Atomically claim this file so no other worker picks it up.
    const claim = await prisma.processedFile.updateMany({
      where: { id, pdf_status: "pending" },
      data: { pdf_status: "processing", pdf_duration_ms: 0 },
    });

    if (claim.count === 0) {
      console.log(
        `[convert-worker] File ${id} claimed by another worker, skipping.`,
      );
      file = await pickNext();
      continue;
    }

    console.log(`[convert-worker] Converting file: ${id}`);
    try {
      await convertToPdfBatch(id);
      console.log(`[convert-worker] Completed: ${id}`);
    } catch (err) {
      console.error(`[convert-worker] Failed: ${id}`, err);
      await prisma.processedFile.update({
        where: { id },
        data: { pdf_status: "failed" },
      });
    }

    if (shouldStop) break;
    file = await pickNext();
  }

  if (shouldStop) {
    console.log("[convert-worker] Shutdown complete. Exiting.");
  } else {
    console.log("[convert-worker] No more pending files. Exiting.");
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[convert-worker] Fatal error:", err);
    process.exit(1);
  });
