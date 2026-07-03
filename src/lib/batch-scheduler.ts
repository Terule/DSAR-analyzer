/**
 * In-server AI batch poller.
 *
 * A single self-managing interval lives inside the Next.js server. It is
 * started when the AI phase begins (via `ensureBatchPollerRunning`) and stops
 * itself as soon as there is no more AI/render work to sweep — so nothing polls
 * OpenAI while the app is idle, and no separate long-lived cron process is needed.
 */

import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { pollBatchStatus } from "./batch-worker";
import { db } from "./db";
import { openWorkerLogFd } from "./worker-log";

// OpenAI batches use a 24h completion window; a 1-minute cadence keeps the UI
// responsive without hammering the API.
const POLL_INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

interface SweepResult {
  polledBatches: number;
  renderWorkerStarted: boolean;
  workRemains: boolean;
}

/** True if a convert-worker process is currently alive. */
function isConvertWorkerAlive(): boolean {
  try {
    // pgrep exits 0 (and prints PIDs) when a match exists, non-zero otherwise.
    execFileSync("pgrep", ["-f", "convert-worker.ts"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * One sweep pass: triggers the render worker for finished-AI/pending-render
 * files and polls every OpenAI batch awaiting sync. Returns whether any
 * AI/render work still remains (used to decide if polling should continue).
 */
export async function runBatchSweep(): Promise<SweepResult> {
  // 0. Reclaim render jobs orphaned by a dead worker. A file stuck in
  // 'processing' with no live convert-worker was abandoned (machine slept,
  // worker crashed/killed) — requeue it so the render resumes idempotently
  // instead of stranding the whole case.
  const stuckRender = db
    .prepare(
      "SELECT count(*) c FROM processed_files WHERE pdf_status = 'processing'",
    )
    .get() as { c: number };
  if (stuckRender.c > 0 && !isConvertWorkerAlive()) {
    db.prepare(
      "UPDATE processed_files SET pdf_status = 'pending' WHERE pdf_status = 'processing'",
    ).run();
    console.warn(
      `[Batch Scheduler] Reclaimed ${stuckRender.c} orphaned render job(s) — no worker was alive.`,
    );
  }

  // 1. Safety net: AI finished but render still pending -> kick the PDF worker.
  const hasPendingRender = db
    .prepare(
      `SELECT 1 FROM processed_files
       WHERE ai_status = 'completed' AND pdf_status = 'pending'
       LIMIT 1`,
    )
    .get();

  let renderWorkerStarted = false;
  if (hasPendingRender && !isConvertWorkerAlive()) {
    const workerPath = path.resolve(process.cwd(), "convert-worker.ts");
    const logFd = openWorkerLogFd("convert-worker");
    const child = spawn("bun", [workerPath], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    renderWorkerStarted = true;
    console.log("[Batch Scheduler] Triggered PDF worker for pending render.");
  }

  // 2. Poll every batch that was uploaded to OpenAI and awaits results.
  const pendingFiles = db
    .prepare(
      `SELECT id FROM processed_files
       WHERE ai_status = 'batch_ready' AND batch_id IS NOT NULL`,
    )
    .all() as { id: string }[];

  for (const file of pendingFiles) {
    try {
      await pollBatchStatus(file.id);
    } catch (err) {
      console.error(`[Batch Scheduler] Failed to poll file ${file.id}:`, err);
    }
  }

  // 3. Decide whether to keep polling. Stay alive while any file is mid-AI
  // (generating the next chunk = 'processing', awaiting a batch = 'batch_ready')
  // or has a render pending OR in progress — so the poller can reclaim a render
  // that a dying worker leaves stuck in 'processing'.
  const remaining = db
    .prepare(
      `SELECT 1 FROM processed_files
       WHERE ai_status IN ('processing', 'batch_ready')
          OR (ai_status = 'completed' AND pdf_status IN ('pending', 'processing'))
       LIMIT 1`,
    )
    .get();

  return {
    polledBatches: pendingFiles.length,
    renderWorkerStarted,
    workRemains: !!remaining,
  };
}

async function tick(): Promise<void> {
  if (sweeping) return; // never overlap sweeps
  sweeping = true;
  try {
    const { workRemains } = await runBatchSweep();
    if (!workRemains) stopBatchPoller();
  } catch (err) {
    console.error("[Batch Scheduler] Sweep error:", err);
  } finally {
    sweeping = false;
  }
}

/**
 * Starts the poller if it isn't already running. Idempotent and safe to call
 * from anywhere the AI phase begins or resumes. Runs an immediate sweep so a
 * just-uploaded batch is picked up without waiting a full interval.
 */
export function ensureBatchPollerRunning(): void {
  if (timer) return;
  console.log("[Batch Scheduler] Poller started.");
  timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  void tick();
}

export function stopBatchPoller(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  console.log("[Batch Scheduler] No pending work — poller stopped.");
}
