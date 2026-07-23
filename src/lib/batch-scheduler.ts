/**
 * In-server AI batch poller.
 *
 * A single self-managing interval lives inside the Next.js server. It is
 * started when the AI phase begins (via `ensureBatchPollerRunning`) and stops
 * itself as soon as there is no more AI/render work to sweep — so nothing polls
 * OpenAI while the app is idle, and no separate long-lived cron process is needed.
 */

import path from "node:path";
import { pollBatchStatus } from "./batch-worker";
import { getCasePstFileIds } from "./case-utils";
import {
  enqueueFilePhase,
  isControlPlanePipelineEnabled,
} from "./control-plane/pipeline";
import { prisma } from "./prisma";

// OpenAI batches use a 24h completion window; a 1-minute cadence keeps the UI
// responsive without hammering the API.
const POLL_INTERVAL_MS = 60_000;
// Applying a completed Batch is local work and normally takes seconds. If a
// service restart interrupts it, its durable row would otherwise remain in
// `processing` forever because only `submitted` rows are polled. Give a very
// generous window before re-queueing it; re-applying an output file is
// idempotent because email decisions are ownership-guarded.
const STALE_BATCH_APPLICATION_MS = 30 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

interface SweepResult {
  polledBatches: number;
  renderWorkerStarted: boolean;
  workRemains: boolean;
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
async function startReadyFilesPhases(): Promise<number> {
  const filesRows = await prisma.processedFile.findMany({
    where: { kind: "files", files_status: "pending" },
    select: { id: true, filepath: true },
  });
  if (filesRows.length === 0) return 0;

  const pstRows = await prisma.processedFile.findMany({
    where: { kind: "pst" },
    select: {
      filepath: true,
      pdf_status: true,
      subject_name: true,
      subject_email: true,
      subject_personal_email: true,
      subject_aliases: true,
    },
  });

  let started = 0;
  for (const fr of filesRows) {
    if (!fr.filepath) continue;
    // The Files dir sits at [case]/[request]/Files; its PST siblings live under
    // [case]/[request]/... . Group by the [case]/[request] parent directory.
    const caseDir = `${path.dirname(fr.filepath)}${path.sep}`;
    const siblings = pstRows.filter((p) => p.filepath?.startsWith(caseDir));
    if (siblings.length === 0) continue; // Files-only case — UI must configure it.

    const allRendered = siblings.every(
      (p) => p.pdf_status === "completed" || p.pdf_status === "failed",
    );
    if (!allRendered) continue;

    const configured = siblings.find((p) => p.subject_name?.trim());
    if (!configured) continue; // No subject config persisted yet.

    // Claim atomically so we don't double-start or race the UI.
    const claim = await prisma.processedFile.updateMany({
      where: { id: fr.id, files_status: "pending" },
      data: {
        subject_name: configured.subject_name ?? "",
        subject_email: configured.subject_email ?? "",
        subject_personal_email: configured.subject_personal_email ?? null,
        subject_aliases: configured.subject_aliases ?? "",
        files_status: "processing",
        files_started_at: BigInt(Date.now()),
      },
    });
    if (claim.count === 0) continue;

    await enqueueFilePhase({ fileId: fr.id, phase: "files" });
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
  await startReadyFilesPhases();

  const staleBefore = new Date(Date.now() - STALE_BATCH_APPLICATION_MS);
  const recoveredApplications = await prisma.aiBatchRun.updateMany({
    where: {
      status: "processing",
      submitted_at: { lt: staleBefore },
      completed_at: null,
    },
    data: { status: "submitted" },
  });
  if (recoveredApplications.count > 0) {
    console.warn(
      `[Batch Scheduler] Re-queued ${recoveredApplications.count} stale completed-Batch application(s) after an interrupted local worker.`,
    );
  }

  // 0. Safety net: AI finished but render still pending -> enqueue the durable
  // local control-plane job. Lease recovery, not process inspection, handles
  // worker crashes in the new architecture.
  const pendingRenderRows = await prisma.processedFile.findMany({
    where: { ai_status: "completed", pdf_status: "pending" },
    select: { id: true },
  });

  let renderWorkerStarted = false;
  // Render is case-level: every PST row shares the same selected/ folder.
  // Only the deterministic coordinator (the lowest row id) may own that
  // folder. Scheduling an arbitrary completed sibling creates competing
  // render workers, which can race while reclaiming selected EML files.
  let renderCoordinatorId: string | undefined;
  for (const row of pendingRenderRows) {
    const coordinatorId = (await getCasePstFileIds(row.id)).sort()[0];
    if (coordinatorId && coordinatorId === row.id) {
      renderCoordinatorId = coordinatorId;
      break;
    }
  }
  if (renderCoordinatorId && isControlPlanePipelineEnabled()) {
    await enqueueFilePhase({ fileId: renderCoordinatorId, phase: "render" });
    renderWorkerStarted = true;
    console.log("[Batch Scheduler] Enqueued control-plane render job.");
  }

  // 2. Poll every durable submitted Batch. A coordinator can now have several
  // batches in flight, so processed_files.batch_id is only a compatibility
  // pointer and must not control polling.
  const pendingRuns = await prisma.aiBatchRun.findMany({
    where: { status: "submitted", openai_batch_id: { not: null } },
    select: { coordinator_id: true },
    distinct: ["coordinator_id"],
  });

  for (const run of pendingRuns) {
    try {
      await pollBatchStatus(run.coordinator_id);
    } catch (err) {
      console.error(
        `[Batch Scheduler] Failed to poll file ${run.coordinator_id}:`,
        err,
      );
    }
  }

  // 3. Decide whether to keep polling. Stay alive while any file is mid-AI
  // (generating the next chunk = 'processing', awaiting a batch = 'batch_ready')
  // or has a render pending OR in progress — so the poller can reclaim a render
  // that a dying worker leaves stuck in 'processing'.
  const remaining = await prisma.processedFile.findFirst({
    where: {
      OR: [
        { ai_status: { in: ["processing", "batch_ready"] } },
        {
          ai_status: "completed",
          pdf_status: { in: ["pending", "processing"] },
        },
      ],
    },
    select: { id: true },
  });

  return {
    polledBatches: pendingRuns.length,
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
