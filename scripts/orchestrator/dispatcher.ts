import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { runBatchSweep } from "../../src/lib/batch-scheduler";
import { getCasePstFileIds } from "../../src/lib/case-utils";
import {
  containerLogs,
  createJobContainer,
  dockerHostCpuCount,
  inspectContainer,
  listPhaseJobContainers,
  removeContainer,
  safeDispatcherBinds,
} from "../../src/lib/control-plane/docker-engine";
import {
  acknowledgeCancelledJob,
  claimNextJob,
  completeJob,
  failJob,
  getFilesFinalizerState,
  getJob,
  getLatestFilesBatchParentState,
  hasActiveJobForFilePhase,
  heartbeatJob,
  listActiveCaseKeys,
  listAwaitingExternalAiJobs,
  markJobAwaitingExternal,
  markJobRunning,
  requeueDispatcherOrphans,
  requeueExpiredLeases,
  setWorkerContainer,
} from "../../src/lib/control-plane/job-store";
import { enqueueFilePhase } from "../../src/lib/control-plane/pipeline";
import type {
  ControlJobRecord,
  ControlPhase,
} from "../../src/lib/control-plane/types";
import { prisma } from "../../src/lib/prisma";

const workerId = `dispatcher-${os.hostname()}-${process.pid}`;
const phases: ControlPhase[] = ["parse", "extract", "ai", "render", "files"];
function concurrencyCaps(cpuCount: number): Record<ControlPhase, number> {
  return {
    // Parsing large PSTs is memory-intensive. Two concurrent parses preserve a
    // responsive local machine; operators can raise this to four explicitly.
    parse: Number(process.env.PARSE_CONCURRENCY || Math.min(2, cpuCount)),
    extract: Number(process.env.EXTRACT_CONCURRENCY || Math.min(4, cpuCount)),
    ai: 1,
    render: Number(process.env.RENDER_CONCURRENCY || Math.min(2, cpuCount)),
    // A single active case can process independent Files batches in parallel.
    files: Number(process.env.FILES_CONCURRENCY || Math.min(2, cpuCount)),
  };
}
let caps: Record<ControlPhase, number> = concurrencyCaps(1);
function timeoutMsForPhase(phase: ControlPhase): number {
  const defaults: Record<ControlPhase, number> = {
    parse: 2 * 60 * 60_000,
    extract: 2 * 60 * 60_000,
    ai: 30 * 60_000,
    render: 2 * 60 * 60_000,
    // Large Files folders can contain thousands of Office/PDF conversions.
    files: 8 * 60 * 60_000,
  };
  const configured = process.env[`${phase.toUpperCase()}_JOB_TIMEOUT_MS`];
  return Number(configured || process.env.JOB_TIMEOUT_MS || defaults[phase]);
}
function memoryMbForPhase(phase: ControlPhase): number {
  const defaults: Record<ControlPhase, number> = {
    parse: 3072,
    extract: 1536,
    ai: 1024,
    render: 2048,
    files: 1536,
  };
  const configured = process.env[`${phase.toUpperCase()}_JOB_MEMORY_MB`];
  return Number(configured || process.env.JOB_MEMORY_MB || defaults[phase]);
}

function cpuNanoForPhase(phase: ControlPhase): number {
  const configured = process.env[`${phase.toUpperCase()}_JOB_CPU_NANO`];
  return Number(configured || process.env.JOB_CPU_NANO || 1_000_000_000);
}
const network = process.env.WORKER_NETWORK || "pst-analyser-network";
const image = process.env.WORKER_IMAGE || "pst-analyser:local";
const dispatcherContainer = process.env.HOSTNAME || "";
let workerBinds: string[] | null = null;
const workerEnvironment = [
  "NODE_ENV",
  "OPENAI_API_KEY",
  "POSTGRES_URL",
  "POSTGRES_URL_DOCKER",
  "REDIS_URL",
  "STAGING_PATH",
  "EXTRACTED_PATH",
  "CONTROL_PLANE_PIPELINE_ENABLED",
  "QUEUE_PROVIDER",
  "ORCHESTRATOR_QUEUE_NAME",
  "PDF_FONT_DIR",
].flatMap((name) => {
  const value = process.env[name];
  return value === undefined ? [] : [`${name}=${value}`];
});

interface Running {
  job: ControlJobRecord;
  containerId: string;
  startedAt: number;
  timeoutMs: number;
}
const running = new Map<string, Running>();
let ticking = false;

async function writeLog(jobId: string, content: string): Promise<string> {
  const logPath = path.join(process.cwd(), "logs", "jobs", `${jobId}.log`);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, content);
  return logPath;
}

function active(phase: ControlPhase): number {
  return [...running.values()].filter((entry) => entry.job.phase === phase)
    .length;
}

async function canStartAi(): Promise<boolean> {
  const activeAi = await prisma.processedFile.findFirst({
    // `processing` is set by the short-lived submitting container itself.
    // A submitted `batch_ready` coordinator owns the one global OpenAI slot
    // until the external batch settles.
    where: { kind: "pst", ai_status: "batch_ready" },
    select: { id: true },
  });
  return !activeAi;
}

async function startOne(phase: ControlPhase): Promise<boolean> {
  if (active(phase) >= caps[phase]) return false;
  if (phase === "ai" && !(await canStartAi())) return false;
  const phaseTimeoutMs = timeoutMsForPhase(phase);
  // The local pipeline intentionally works on one case at a time. Jobs within
  // that case may still fan out (for example, several PST parse/extract jobs),
  // but a queued job from another case is not admitted until the active case has
  // no leased, running, or externally-waiting work left.
  const activeCases = await listActiveCaseKeys();
  // A previous version may have admitted several cases before this policy was
  // enabled. Let those already-running workers finish, but only admit further
  // work for the longest-running case until the system has serialized again.
  const activeCaseKey = activeCases[0];
  const job = await claimNextJob(
    phase,
    workerId,
    Math.ceil(phaseTimeoutMs / 1000) + 60,
    activeCaseKey,
  );
  if (!job) return false;
  if (!(await markJobRunning(job.id, workerId))) return false;
  try {
    const containerId = await createJobContainer({
      jobId: job.id,
      phase,
      cpuNano: cpuNanoForPhase(phase),
      memoryBytes: memoryMbForPhase(phase) * 1024 * 1024,
      network,
      binds: workerBinds || [],
      image,
      environment: workerEnvironment,
    });
    await setWorkerContainer(job.id, workerId, containerId);
    // Reset may have cancelled this job while Docker was creating the worker.
    // In that case, remove it before it can write to the case folders and
    // acknowledge cancellation so the reset endpoint can proceed safely.
    const currentJob = await getJob(job.id);
    if (currentJob?.status === "cancelled") {
      await removeContainer(containerId).catch(() => undefined);
      await acknowledgeCancelledJob(job.id);
      return false;
    }
    running.set(job.id, {
      job,
      containerId,
      startedAt: Date.now(),
      timeoutMs: phaseTimeoutMs,
    });
    return true;
  } catch (error) {
    const currentJob = await getJob(job.id);
    if (currentJob?.status === "cancelled") {
      await acknowledgeCancelledJob(job.id);
      return false;
    }
    await failJob(
      job.id,
      workerId,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

async function reap(entry: Running, message?: string): Promise<void> {
  const logs = await containerLogs(entry.containerId).catch(
    () => "No worker logs available.",
  );
  const logPath = await writeLog(entry.job.id, logs);
  if (message)
    await failJob(entry.job.id, workerId, `${message}; logs: ${logPath}`);
  else if (entry.job.phase === "ai") {
    const aiState = entry.job.payload.fileId
      ? await prisma.processedFile.findUnique({
          where: { id: entry.job.payload.fileId },
          select: { ai_status: true, batch_id: true },
        })
      : null;
    // Only a submitted Batch holds the global AI slot after its one-shot
    // submission container exits. A fan-in no-op is an ordinary completion.
    if (aiState?.ai_status === "batch_ready" && aiState.batch_id) {
      await markJobAwaitingExternal(entry.job.id, workerId, { logPath });
    } else {
      await completeJob(entry.job.id, workerId, { logPath });
    }
  } else await completeJob(entry.job.id, workerId, { logPath });
  running.delete(entry.job.id);
}

async function resultMessage(jobId: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(
      path.join(process.cwd(), "logs", "jobs", `${jobId}.result.json`),
      "utf8",
    );
    const result = JSON.parse(raw) as { success?: boolean; error?: string };
    return result.success
      ? undefined
      : result.error || "Worker failed without an error message.";
  } catch {
    return "Worker container disappeared before reporting a result.";
  }
}

async function observeRunning(): Promise<void> {
  for (const entry of [...running.values()]) {
    const current = await getJob(entry.job.id);
    if (current?.status === "cancelled") {
      await removeContainer(entry.containerId).catch(() => undefined);
      await acknowledgeCancelledJob(entry.job.id);
      running.delete(entry.job.id);
      continue;
    }
    await heartbeatJob(
      entry.job.id,
      workerId,
      Math.ceil(entry.timeoutMs / 1000) + 60,
    );
    if (Date.now() - entry.startedAt > entry.timeoutMs) {
      await removeContainer(entry.containerId).catch(() => undefined);
      await reap(entry, `Worker timed out after ${entry.timeoutMs}ms`);
      continue;
    }
    try {
      const state = await inspectContainer(entry.containerId);
      if (state.State.Running) continue;
      await reap(
        entry,
        state.State.ExitCode === 0
          ? undefined
          : `Worker exited ${state.State.ExitCode}: ${state.State.Error || "unknown error"}`,
      );
    } catch {
      // AutoRemove can remove the container before inspection; the one-shot
      // runner writes its result into the shared logs mount first.
      await reap(entry, await resultMessage(entry.job.id));
    }
  }
}

async function settleExternalAi(): Promise<void> {
  for (const job of await listAwaitingExternalAiJobs()) {
    if (!job.payload.fileId) continue;
    const row = await prisma.processedFile.findUnique({
      where: { id: job.payload.fileId },
      select: { ai_status: true },
    });
    if (row?.ai_status === "completed") await completeJob(job.id, workerId);
    if (row?.ai_status === "failed")
      await failJob(job.id, workerId, "OpenAI Batch processing failed.", false);
    if (
      row &&
      row.ai_status !== "batch_ready" &&
      row.ai_status !== "completed" &&
      row.ai_status !== "failed"
    ) {
      await completeJob(job.id, workerId);
    }
  }
}

async function settleFilesBatches(): Promise<void> {
  const filesRows = await prisma.processedFile.findMany({
    where: { kind: "files", files_status: { in: ["processing", "failed"] } },
    select: {
      id: true,
      files_total: true,
      files_processed: true,
      files_skipped: true,
    },
  });
  for (const row of filesRows) {
    const state = await getLatestFilesBatchParentState(row.id);
    if (!state) continue;
    if (state.active > 0) continue;
    if (state.failed > 0) {
      await prisma.processedFile.updateMany({
        where: { id: row.id, files_status: "processing" },
        data: { files_status: "failed" },
      });
      continue;
    }
    if (state.completed > 0) {
      const finalizer = await getFilesFinalizerState(row.id, state.runKey);
      if (finalizer.active > 0) continue;
      if (finalizer.failed > 0) {
        await prisma.processedFile.update({
          where: { id: row.id },
          data: { files_status: "failed" },
        });
        continue;
      }
      if (finalizer.completed > 0) continue;
      await enqueueFilePhase({
        fileId: row.id,
        phase: "files",
        dedupeKey: `files-finalize:${row.id}:${state.runKey}`,
        metadata: { filesFinalize: true, runKey: state.runKey },
      });
    }
  }
}

/**
 * A laptop shutdown can kill an AutoRemove worker after its domain row was set
 * to an in-progress state but before the dispatcher records a terminal result.
 * Rebuild the missing durable job from that state. Each admission is guarded by
 * the job store, so this is safe to run on every dispatcher tick.
 */
async function reconcileInterruptedWork(): Promise<void> {
  const pstRows = await prisma.processedFile.findMany({
    where: { kind: "pst" },
    select: {
      id: true,
      status: true,
      ai_status: true,
      batch_id: true,
      pdf_status: true,
    },
  });

  for (const row of pstRows) {
    if (
      ["scanning_metadata", "pending_analysis", "processing"].includes(
        row.status,
      ) &&
      !(await hasActiveJobForFilePhase(row.id, "parse"))
    ) {
      await enqueueFilePhase({ fileId: row.id, phase: "parse" });
      continue;
    }
    if (
      ["analyzed", "extracting"].includes(row.status) &&
      !(await hasActiveJobForFilePhase(row.id, "extract"))
    ) {
      // Extraction is restartable from its raw EML artifact. Put an interrupted
      // row back at its stable pre-extract checkpoint before re-enqueuing it.
      if (row.status === "extracting") {
        await prisma.processedFile.update({
          where: { id: row.id },
          data: { status: "analyzed" },
        });
      }
      await enqueueFilePhase({ fileId: row.id, phase: "extract" });
    }
    if (
      row.pdf_status === "processing" &&
      !(await hasActiveJobForFilePhase(row.id, "render"))
    ) {
      await prisma.processedFile.update({
        where: { id: row.id },
        data: { pdf_status: "pending" },
      });
      await enqueueFilePhase({ fileId: row.id, phase: "render" });
    }
  }

  // AI submission is case-level. A row with no Batch id was interrupted before
  // OpenAI accepted the batch, so it is safe to resubmit the coordinator.
  const recoveringAi = pstRows.filter(
    (row) => row.ai_status === "processing" && !row.batch_id,
  );
  const seenAiCases = new Set<string>();
  for (const row of recoveringAi) {
    const caseIds = await getCasePstFileIds(row.id);
    const coordinatorId = [...caseIds].sort()[0];
    if (!coordinatorId || seenAiCases.has(coordinatorId)) continue;
    seenAiCases.add(coordinatorId);
    if (await hasActiveJobForFilePhase(coordinatorId, "ai")) continue;
    await prisma.processedFile.update({
      where: { id: coordinatorId },
      data: { ai_status: "pending", ai_started_at: null },
    });
    await enqueueFilePhase({ fileId: coordinatorId, phase: "ai" });
  }

  const filesRows = await prisma.processedFile.findMany({
    where: { kind: "files", files_status: "processing" },
    select: { id: true },
  });
  for (const row of filesRows) {
    if (await hasActiveJobForFilePhase(row.id, "files")) continue;
    await enqueueFilePhase({ fileId: row.id, phase: "files" });
  }
}

/** A restarted dispatcher owns no workers yet, so every labeled job container
 * found at startup belongs to its predecessor and must be stopped before the
 * durable lease is reclaimed. */
async function removeOrphanedWorkerContainers(): Promise<number> {
  const containers = await listPhaseJobContainers();
  await Promise.all(
    containers.map((container) =>
      removeContainer(container.Id).catch(() => undefined),
    ),
  );
  return containers.length;
}

async function tick(): Promise<void> {
  await requeueExpiredLeases();
  await observeRunning();
  await reconcileInterruptedWork();
  await runBatchSweep();
  await settleExternalAi();
  await settleFilesBatches();
  for (const phase of phases) {
    while (active(phase) < caps[phase]) {
      if (!(await startOne(phase))) break;
    }
  }
}

async function safeTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await tick();
  } finally {
    ticking = false;
  }
}

async function main(): Promise<void> {
  if (!dispatcherContainer)
    throw new Error(
      "Dispatcher container identity is required for VolumesFrom.",
    );
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl)
    throw new Error("REDIS_URL is required by the local dispatcher.");
  workerBinds = await safeDispatcherBinds(dispatcherContainer);
  if (workerBinds.length === 0)
    throw new Error(
      "Dispatcher data mounts could not be resolved for job workers.",
    );
  const hostCpuCount = await dockerHostCpuCount();
  caps = concurrencyCaps(Math.max(1, hostCpuCount - 1));
  console.log(
    `[dispatcher] host CPUs=${hostCpuCount}, caps=${JSON.stringify(caps)}`,
  );
  const removed = await removeOrphanedWorkerContainers();
  if (removed > 0)
    console.log(
      `[dispatcher] removed ${removed} orphaned worker container(s).`,
    );
  const reclaimed = await requeueDispatcherOrphans();
  if (reclaimed > 0)
    console.log(`[dispatcher] requeued ${reclaimed} orphaned job(s).`);
  const wakeConnection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  const wakeWorker = new Worker(
    process.env.ORCHESTRATOR_QUEUE_NAME || "pst-analyser-orchestrator",
    async () => {
      await safeTick();
    },
    { connection: wakeConnection, concurrency: 1 },
  );
  wakeWorker.on("error", (error) => console.error("[dispatcher] queue", error));
  for (;;) {
    try {
      await safeTick();
    } catch (error) {
      console.error("[dispatcher]", error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

main().catch((error) => {
  console.error("[dispatcher] fatal", error);
  process.exitCode = 1;
});
