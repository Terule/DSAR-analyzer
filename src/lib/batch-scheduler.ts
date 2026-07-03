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
 * Headlessly starts the Files phase for any case whose email pipeline is done.
 *
 * The Files phase is normally kicked off by the browser orchestrator, so if the
 * tab reloaded / the machine slept during a long AI+Render run it would never
 * start. This starts it in-server: for each Files row still pending whose sibling
 * PST files have all rendered, it copies the subject config from a rendered PST
 * row and spawns the detached files-worker. Files-only cases (no PST siblings /
 * no persisted config) are left to the UI. Returns how many were started.
 */
function startReadyFilesPhases(): number {
  const filesRows = db
    .prepare(
      "SELECT id, filepath FROM processed_files WHERE kind = 'files' AND files_status = 'pending'",
    )
    .all() as { id: string; filepath: string }[];
  if (filesRows.length === 0) return 0;

  const pstRows = db
    .prepare(
      `SELECT filepath, pdf_status, subject_name, subject_email, subject_aliases
       FROM processed_files WHERE kind = 'pst'`,
    )
    .all() as {
    filepath: string;
    pdf_status: string;
    subject_name?: string;
    subject_email?: string;
    subject_aliases?: string;
  }[];

  let started = 0;
  for (const fr of filesRows) {
    // The Files dir sits at [case]/[request]/Files; its PST siblings live under
    // [case]/[request]/... . Group by the [case]/[request] parent directory.
    const caseDir = `${path.dirname(fr.filepath)}${path.sep}`;
    const siblings = pstRows.filter((p) => p.filepath.startsWith(caseDir));
    if (siblings.length === 0) continue; // Files-only case — UI must configure it.

    const allRendered = siblings.every(
      (p) => p.pdf_status === "completed" || p.pdf_status === "failed",
    );
    if (!allRendered) continue;

    const configured = siblings.find((p) => p.subject_name?.trim());
    if (!configured) continue; // No subject config persisted yet.

    // Claim atomically so we don't double-start or race the UI.
    const claim = db
      .prepare(
        `UPDATE processed_files
         SET subject_name = ?, subject_email = ?, subject_aliases = ?,
             files_status = 'processing', files_started_at = ?
         WHERE id = ? AND files_status = 'pending'`,
      )
      .run(
        configured.subject_name ?? "",
        configured.subject_email ?? "",
        configured.subject_aliases ?? "",
        Date.now(),
        fr.id,
      );
    if (claim.changes === 0) continue;

    const workerPath = path.resolve(process.cwd(), "files-worker.ts");
    const logFd = openWorkerLogFd("files-worker");
    const child = spawn("bun", [workerPath, fr.id], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    started++;
    console.log(`[Batch Scheduler] Started headless Files phase for ${fr.id}.`);
  }
  return started;
}

/**
 * One sweep pass: triggers the render worker for finished-AI/pending-render
 * files and polls every OpenAI batch awaiting sync. Returns whether any
 * AI/render work still remains (used to decide if polling should continue).
 */
export async function runBatchSweep(): Promise<SweepResult> {
  // Kick off any case whose email pipeline finished but whose Files phase never
  // started (e.g. the UI orchestrator state was lost mid-run).
  startReadyFilesPhases();

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
