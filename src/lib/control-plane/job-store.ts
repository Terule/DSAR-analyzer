import { randomUUID } from "node:crypto";
import type { QueryResult } from "pg";
import { getControlPlanePool } from "@/lib/control-plane/postgres";
import type {
  ControlJobPayload,
  ControlJobRecord,
  ControlJobStatus,
  ControlPhase,
  QueueEnqueueRequest,
} from "@/lib/control-plane/types";
import { getQueueAdapter } from "@/lib/queue/factory";

const DEFAULT_LEASE_SECONDS = 60;
// Exponential backoff for requeued failures, capped at 5 minutes.
const BASE_BACKOFF_SECONDS = 5;
const MAX_BACKOFF_SECONDS = 300;

interface JobRow {
  id: string;
  phase: ControlPhase;
  status: ControlJobStatus;
  dedupe_key: string;
  payload: ControlJobPayload;
  priority: number;
  max_attempts: number;
  attempts: number;
  available_at: Date;
  leased_by: string | null;
  lease_expires_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: JobRow): ControlJobRecord {
  return {
    id: row.id,
    phase: row.phase,
    status: row.status,
    dedupeKey: row.dedupe_key,
    payload: row.payload,
    priority: row.priority,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at.toISOString(),
    leaseExpiresAt: row.lease_expires_at
      ? row.lease_expires_at.toISOString()
      : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Enqueue a job for a given phase. Dedupes against any active (queued/leased/running)
 * job with the same (phase, dedupeKey) pair via the partial unique index — a repeat
 * enqueue for work already in flight is a safe no-op and returns the existing record.
 * Also notifies the queue adapter (BullMQ/SQS) so a worker wakes up to claim it.
 */
export async function enqueueJob(
  request: QueueEnqueueRequest,
): Promise<ControlJobRecord> {
  const pool = getControlPlanePool();
  const id = request.id || randomUUID();

  const result: QueryResult<JobRow> = await pool.query(
    `INSERT INTO orchestrator_jobs
       (id, phase, status, dedupe_key, payload, priority, max_attempts)
     VALUES ($1, $2, 'queued', $3, $4, $5, $6)
     ON CONFLICT (phase, dedupe_key) WHERE status IN ('queued', 'leased', 'running')
     DO UPDATE SET updated_at = orchestrator_jobs.updated_at
     RETURNING *`,
    [
      id,
      request.phase,
      request.dedupeKey,
      JSON.stringify(request.payload),
      request.priority ?? 100,
      request.maxAttempts ?? 5,
    ],
  );

  const record = mapRow(result.rows[0]);

  // Only notify the queue when this call actually created the row (not a dedupe hit).
  if (record.id === id) {
    await getQueueAdapter().enqueue({
      id: record.id,
      phase: record.phase,
      dedupeKey: record.dedupeKey,
      payload: record.payload,
      priority: record.priority,
      maxAttempts: record.maxAttempts,
    });
  }

  return record;
}

/**
 * Atomically claim the next available job for a phase using SELECT ... FOR UPDATE
 * SKIP LOCKED so multiple workers can poll concurrently without claiming the same row.
 */
export async function claimNextJob(
  phase: ControlPhase,
  workerId: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  caseKey?: string,
): Promise<ControlJobRecord | null> {
  const pool = getControlPlanePool();

  const result: QueryResult<JobRow> = await pool.query(
    `UPDATE orchestrator_jobs
     SET status = 'leased',
         leased_by = $1,
         lease_expires_at = NOW() + ($2 || ' seconds')::INTERVAL,
         attempts = attempts + 1,
         updated_at = NOW()
     WHERE id = (
       SELECT id FROM orchestrator_jobs
       WHERE phase = $3
         AND status = 'queued'
         AND available_at <= NOW()
         AND ($4::text IS NULL OR payload->>'caseKey' = $4)
       ORDER BY priority ASC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [workerId, String(leaseSeconds), phase, caseKey ?? null],
  );

  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]);
}

/**
 * Return the cases that currently own execution capacity. A case remains active
 * while a worker has a lease and while its OpenAI Batch is awaiting completion.
 * Queued jobs are deliberately excluded: they wait until an active case releases
 * the local pipeline.
 */
export async function listActiveCaseKeys(): Promise<string[]> {
  const result = await getControlPlanePool().query<{ case_key: string }>(
    `SELECT payload->>'caseKey' AS case_key
     FROM orchestrator_jobs
     WHERE status IN ('leased', 'running', 'awaiting_external')
       AND payload->>'caseKey' IS NOT NULL
     GROUP BY payload->>'caseKey'
     ORDER BY MIN(created_at) ASC`,
  );
  return result.rows.map((row) => row.case_key);
}

/**
 * Includes queued jobs as well as jobs already executing. This is the admission
 * view used by the case-start API: a case owns the local pipeline from the
 * moment its Parse jobs are persisted, not only after the dispatcher happens to
 * claim one of them.
 */
export async function findOtherAdmittedCase(
  caseKey: string,
): Promise<string | null> {
  const result = await getControlPlanePool().query<{ case_key: string }>(
    `SELECT payload->>'caseKey' AS case_key
     FROM orchestrator_jobs
     WHERE status IN ('queued', 'leased', 'running', 'awaiting_external')
       AND payload->>'caseKey' IS NOT NULL
       AND payload->>'caseKey' <> $1
     GROUP BY payload->>'caseKey'
     ORDER BY MIN(created_at) ASC
     LIMIT 1`,
    [caseKey],
  );
  return result.rows[0]?.case_key ?? null;
}

/**
 * Serialize case admission across concurrent browser/API requests. The lock is
 * held only while a start request validates, persists its domain state, and
 * creates its first durable Parse jobs; normal worker execution never holds it.
 */
export async function withCaseStartLock<T>(work: () => Promise<T>): Promise<T> {
  const client = await getControlPlanePool().connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [
      "pst-analyser:case-start",
    ]);
    return await work();
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext($1))", [
        "pst-analyser:case-start",
      ])
      .catch(() => undefined);
    client.release();
  }
}

export async function clearFilesBatchResults(fileId: string): Promise<void> {
  await getControlPlanePool().query(
    "DELETE FROM orchestrator_files_batch_results WHERE file_id = $1",
    [fileId],
  );
}

/** Records a batch once, making a retry safe to run without double-counting UI progress. */
export async function recordFilesBatchResult(input: {
  jobId: string;
  fileId: string;
  processed: number;
  skipped: number;
  duplicates: number;
}): Promise<{
  processed: number;
  skipped: number;
  duplicates: number;
}> {
  const pool = getControlPlanePool();
  await pool.query(
    `INSERT INTO orchestrator_files_batch_results
       (job_id, file_id, processed_count, skipped_count, duplicates_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (job_id) DO NOTHING`,
    [
      input.jobId,
      input.fileId,
      input.processed,
      input.skipped,
      input.duplicates,
    ],
  );
  const totals = await pool.query<{
    processed: string;
    skipped: string;
    duplicates: string;
  }>(
    `SELECT COALESCE(SUM(processed_count), 0)::text AS processed,
            COALESCE(SUM(skipped_count), 0)::text AS skipped,
            COALESCE(SUM(duplicates_count), 0)::text AS duplicates
     FROM orchestrator_files_batch_results
     WHERE file_id = $1`,
    [input.fileId],
  );
  const row = totals.rows[0];
  return {
    processed: Number(row?.processed || 0),
    skipped: Number(row?.skipped || 0),
    duplicates: Number(row?.duplicates || 0),
  };
}

export interface FilesBatchParentState {
  fileId: string;
  runKey: string;
  active: number;
  failed: number;
  completed: number;
}

export interface FilesFinalizerState {
  active: number;
  failed: number;
  completed: number;
}

/**
 * Status fan-in for the most recently created batch run of a Files row.
 * Historical/cancelled runs must never decide the state of a later retry.
 */
export async function getLatestFilesBatchParentState(
  fileId: string,
): Promise<FilesBatchParentState | null> {
  const result = await getControlPlanePool().query<{
    run_key: string;
    active: string;
    failed: string;
    completed: string;
  }>(
    `WITH latest_run AS (
       SELECT payload->'metadata'->>'runKey' AS run_key
       FROM orchestrator_jobs
       WHERE phase = 'files'
         AND payload->>'fileId' = $1
         AND payload->'metadata'->>'filesBatch' = 'true'
         AND payload->'metadata'->>'runKey' IS NOT NULL
       GROUP BY payload->'metadata'->>'runKey'
       ORDER BY MAX(created_at) DESC
       LIMIT 1
     )
     SELECT latest_run.run_key,
            COUNT(*) FILTER (WHERE status IN ('queued', 'leased', 'running'))::text AS active,
            COUNT(*) FILTER (WHERE status IN ('dead_letter', 'cancelled'))::text AS failed,
            COUNT(*) FILTER (WHERE status = 'completed')::text AS completed
     FROM orchestrator_jobs
     JOIN latest_run
       ON orchestrator_jobs.payload->'metadata'->>'runKey' = latest_run.run_key
     WHERE orchestrator_jobs.phase = 'files'
       AND orchestrator_jobs.payload->>'fileId' = $1
       AND orchestrator_jobs.payload->'metadata'->>'filesBatch' = 'true'
     GROUP BY latest_run.run_key`,
    [fileId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    fileId,
    runKey: row.run_key,
    active: Number(row.active),
    failed: Number(row.failed),
    completed: Number(row.completed),
  };
}

export async function getFilesFinalizerState(
  fileId: string,
  runKey: string,
): Promise<FilesFinalizerState> {
  const result = await getControlPlanePool().query<{
    active: string;
    failed: string;
    completed: string;
  }>(
    `SELECT COUNT(*) FILTER (WHERE status IN ('queued', 'leased', 'running'))::text AS active,
            COUNT(*) FILTER (WHERE status IN ('dead_letter', 'cancelled'))::text AS failed,
            COUNT(*) FILTER (WHERE status = 'completed')::text AS completed
     FROM orchestrator_jobs
     WHERE phase = 'files'
       AND payload->>'fileId' = $1
       AND payload->'metadata'->>'filesFinalize' = 'true'
       AND payload->'metadata'->>'runKey' = $2`,
    [fileId, runKey],
  );
  const row = result.rows[0];
  return {
    active: Number(row?.active || 0),
    failed: Number(row?.failed || 0),
    completed: Number(row?.completed || 0),
  };
}

/**
 * Extend a held lease and record a worker heartbeat. Returns false if the job is no
 * longer held by this worker (e.g. its lease already expired and was reclaimed).
 */
export async function heartbeatJob(
  jobId: string,
  workerId: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<boolean> {
  const pool = getControlPlanePool();

  const result = await pool.query(
    `UPDATE orchestrator_jobs
     SET lease_expires_at = NOW() + ($1 || ' seconds')::INTERVAL,
         updated_at = NOW()
     WHERE id = $2
       AND leased_by = $3
       AND status IN ('leased', 'running')`,
    [String(leaseSeconds), jobId, workerId],
  );

  await pool.query(
    `INSERT INTO orchestrator_workers (worker_id, worker_kind, heartbeat_at, lease_owner)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (worker_id)
     DO UPDATE SET heartbeat_at = NOW(), lease_owner = $3`,
    [workerId, "phase-worker", jobId],
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Transition a claimed job to running before asking Docker to create its
 * container. `worker_starting` closes the otherwise unavoidable create-window:
 * a reset can see that Docker work is being started and wait for the dispatcher
 * to either register or remove that container.
 */
export async function markJobRunning(
  jobId: string,
  workerId: string,
): Promise<boolean> {
  const pool = getControlPlanePool();
  const result = await pool.query(
    `UPDATE orchestrator_jobs
     SET status = 'running', worker_starting = TRUE, updated_at = NOW()
     WHERE id = $1 AND leased_by = $2 AND status = 'leased'`,
    [jobId, workerId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Mark a job completed and record a successful attempt. */
export async function completeJob(
  jobId: string,
  workerId: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const pool = getControlPlanePool();

  await pool.query(
    `UPDATE orchestrator_jobs
     SET status = 'completed',
         leased_by = NULL,
         lease_expires_at = NULL,
         worker_container_id = NULL,
         worker_starting = FALSE,
         last_error = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [jobId],
  );

  await pool.query(
    `INSERT INTO orchestrator_job_attempts
       (job_id, worker_id, started_at, ended_at, success, meta)
     VALUES ($1, $2, NOW(), NOW(), TRUE, $3)`,
    [jobId, workerId, meta ? JSON.stringify(meta) : null],
  );
}

/** AI batch submission has finished, but OpenAI is still processing externally. */
export async function markJobAwaitingExternal(
  jobId: string,
  workerId: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const pool = getControlPlanePool();
  await pool.query(
    `UPDATE orchestrator_jobs
     SET status = 'awaiting_external', leased_by = NULL, lease_expires_at = NULL,
         worker_container_id = NULL, worker_starting = FALSE,
         updated_at = NOW()
     WHERE id = $1 AND leased_by = $2`,
    [jobId, workerId],
  );
  await pool.query(
    `INSERT INTO orchestrator_job_attempts
       (job_id, worker_id, started_at, ended_at, success, meta)
     VALUES ($1, $2, NOW(), NOW(), TRUE, $3)`,
    [jobId, workerId, meta ? JSON.stringify(meta) : null],
  );
}

export async function setWorkerContainer(
  jobId: string,
  workerId: string,
  containerId: string,
): Promise<void> {
  await getControlPlanePool().query(
    `UPDATE orchestrator_jobs
     SET worker_container_id = $1, worker_starting = FALSE, updated_at = NOW()
     WHERE id = $2
       AND (leased_by = $3 OR status = 'cancelled')`,
    [containerId, jobId, workerId],
  );
}

export async function listAwaitingExternalAiJobs(): Promise<
  ControlJobRecord[]
> {
  const result: QueryResult<JobRow> = await getControlPlanePool().query(
    `SELECT * FROM orchestrator_jobs
     WHERE phase = 'ai' AND status = 'awaiting_external'
     ORDER BY created_at ASC`,
  );
  return result.rows.map(mapRow);
}

/**
 * Record a failed attempt. If attempts remain under max_attempts and the failure is
 * retryable, the job is requeued with exponential backoff; otherwise it moves to
 * 'dead_letter' for manual/janitor inspection.
 */
export async function failJob(
  jobId: string,
  workerId: string,
  errorMessage: string,
  retryable = true,
): Promise<void> {
  const pool = getControlPlanePool();

  const jobResult: QueryResult<JobRow> = await pool.query(
    `SELECT * FROM orchestrator_jobs WHERE id = $1`,
    [jobId],
  );
  const job = jobResult.rows[0];
  if (!job) return;

  const canRetry = retryable && job.attempts < job.max_attempts;
  const backoffSeconds = Math.min(
    BASE_BACKOFF_SECONDS * 2 ** Math.max(0, job.attempts - 1),
    MAX_BACKOFF_SECONDS,
  );

  if (canRetry) {
    await pool.query(
      `UPDATE orchestrator_jobs
       SET status = 'queued',
           leased_by = NULL,
           lease_expires_at = NULL,
           worker_container_id = NULL,
           worker_starting = FALSE,
           available_at = NOW() + ($1 || ' seconds')::INTERVAL,
           last_error = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [String(backoffSeconds), errorMessage, jobId],
    );
  } else {
    await pool.query(
      `UPDATE orchestrator_jobs
       SET status = 'dead_letter',
           worker_container_id = NULL,
           worker_starting = FALSE,
           last_error = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [errorMessage, jobId],
    );
  }

  await pool.query(
    `INSERT INTO orchestrator_job_attempts
       (job_id, worker_id, started_at, ended_at, success, error_message)
     VALUES ($1, $2, NOW(), NOW(), FALSE, $3)`,
    [jobId, workerId, errorMessage],
  );
}

/**
 * Crash recovery: reclaim jobs whose lease expired without a heartbeat (worker
 * presumed dead). Requeues jobs that still have attempts remaining, otherwise moves
 * them to 'dead_letter'. Intended to be called periodically by a janitor sweep.
 */
export async function requeueExpiredLeases(): Promise<number> {
  const pool = getControlPlanePool();

  const result = await pool.query(
    `UPDATE orchestrator_jobs
     SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'queued' END,
         leased_by = CASE WHEN attempts >= max_attempts THEN leased_by ELSE NULL END,
         lease_expires_at = CASE WHEN attempts >= max_attempts THEN lease_expires_at ELSE NULL END,
         worker_container_id = NULL,
         worker_starting = FALSE,
         available_at = CASE WHEN attempts >= max_attempts THEN available_at ELSE NOW() END,
         last_error = 'Requeued: lease expired (worker presumed dead)',
         updated_at = NOW()
     WHERE status IN ('leased', 'running')
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < NOW()
     RETURNING id`,
  );

  return result.rowCount ?? 0;
}

/** A singleton dispatcher can reclaim leases left by its previous container. */
export async function requeueDispatcherOrphans(): Promise<number> {
  const result = await getControlPlanePool().query(
    `UPDATE orchestrator_jobs
     SET status = 'queued', leased_by = NULL, lease_expires_at = NULL,
         worker_container_id = NULL,
         worker_starting = FALSE,
         last_error = 'Requeued after dispatcher restart', updated_at = NOW()
     WHERE status IN ('leased', 'running')`,
  );
  return result.rowCount ?? 0;
}

/** Request cancellation for every active job belonging to the supplied rows. */
export async function cancelJobsForFiles(
  fileIds: string[],
  reason = "Cancelled by operator",
): Promise<number> {
  if (fileIds.length === 0) return 0;
  const result = await getControlPlanePool().query(
    `UPDATE orchestrator_jobs
     SET status = 'cancelled', leased_by = NULL, lease_expires_at = NULL,
         last_error = $1, updated_at = NOW()
     WHERE payload->>'fileId' = ANY($2)
       AND status IN ('queued', 'leased', 'running', 'awaiting_external')`,
    [reason, fileIds],
  );
  return result.rowCount ?? 0;
}

/** True while a cancelled job is creating or still has a worker container to terminate. */
export async function countPendingCancellation(
  fileIds: string[],
): Promise<number> {
  if (fileIds.length === 0) return 0;
  const result = await getControlPlanePool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM orchestrator_jobs
     WHERE payload->>'fileId' = ANY($1)
       AND status = 'cancelled'
       AND (worker_container_id IS NOT NULL OR worker_starting = TRUE)`,
    [fileIds],
  );
  return Number(result.rows[0]?.count || "0");
}

export async function acknowledgeCancelledJob(jobId: string): Promise<void> {
  await getControlPlanePool().query(
    `UPDATE orchestrator_jobs
     SET worker_container_id = NULL, worker_starting = FALSE, updated_at = NOW()
     WHERE id = $1 AND status = 'cancelled'`,
    [jobId],
  );
}

export async function getJob(jobId: string): Promise<ControlJobRecord | null> {
  const pool = getControlPlanePool();
  const result: QueryResult<JobRow> = await pool.query(
    `SELECT * FROM orchestrator_jobs WHERE id = $1`,
    [jobId],
  );
  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]);
}

/** True when a durable job still owns (or is queued to own) a phase for a row. */
export async function hasActiveJobForFilePhase(
  fileId: string,
  phase: ControlPhase,
): Promise<boolean> {
  const result = await getControlPlanePool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM orchestrator_jobs
       WHERE phase = $1
         AND payload->>'fileId' = $2
         AND status IN ('queued', 'leased', 'running', 'awaiting_external')
     ) AS exists`,
    [phase, fileId],
  );
  return result.rows[0]?.exists ?? false;
}

export async function recordPhaseMetric(input: {
  jobId?: string | null;
  caseKey: string;
  requestKey?: string | null;
  phase: ControlPhase;
  outcome: "completed" | "failed";
  durationMs: number;
  queuedMs?: number;
  attempts?: number;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const pool = getControlPlanePool();
  await pool.query(
    `INSERT INTO orchestrator_phase_metrics
       (job_id, case_key, request_key, phase, outcome, duration_ms, queued_ms, attempts, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.jobId ?? null,
      input.caseKey,
      input.requestKey ?? null,
      input.phase,
      input.outcome,
      input.durationMs,
      input.queuedMs ?? 0,
      input.attempts ?? 1,
      input.meta ? JSON.stringify(input.meta) : null,
    ],
  );
}
