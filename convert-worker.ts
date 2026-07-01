/**
 * Standalone PDF conversion worker.
 * Spawned by /api/convert as a detached child process. Processes ALL files
 * with ai_status='completed' and pdf_status='pending' one by one, then exits.
 * Only one instance of this worker should run at a time.
 */

import { convertToPdfBatch } from "./src/lib/converter";
import { db } from "./src/lib/db";

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

function pickNext():
  | { id: string; ai_status: string; pdf_status: string }
  | undefined {
  return db
    .prepare(
      `SELECT id, ai_status, pdf_status FROM processed_files
       WHERE ai_status = 'completed' AND pdf_status = 'pending'
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get() as { id: string; ai_status: string; pdf_status: string } | undefined;
}

async function run() {
  let file = pickNext();

  while (file && !shouldStop) {
    const { id } = file;

    // Atomically claim this file so no other worker picks it up.
    db.prepare(
      "UPDATE processed_files SET pdf_status = 'processing', pdf_duration_ms = 0 WHERE id = ? AND pdf_status = 'pending'",
    ).run(id);

    // Re-check that we actually claimed it (another process might have beaten us).
    const claimed = db
      .prepare("SELECT pdf_status FROM processed_files WHERE id = ?")
      .get(id) as { pdf_status: string } | undefined;

    if (claimed?.pdf_status !== "processing") {
      console.log(
        `[convert-worker] File ${id} claimed by another worker, skipping.`,
      );
      file = pickNext();
      continue;
    }

    console.log(`[convert-worker] Converting file: ${id}`);
    try {
      await convertToPdfBatch(id);
      console.log(`[convert-worker] Completed: ${id}`);
    } catch (err) {
      console.error(`[convert-worker] Failed: ${id}`, err);
      db.prepare(
        "UPDATE processed_files SET pdf_status = 'failed' WHERE id = ?",
      ).run(id);
    }

    if (shouldStop) break;
    file = pickNext();
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
