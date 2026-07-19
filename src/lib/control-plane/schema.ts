import { getControlPlanePool } from "@/lib/control-plane/postgres";

const CONTROL_PLANE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS orchestrator_jobs (
  id UUID PRIMARY KEY,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  leased_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE orchestrator_jobs
  ADD COLUMN IF NOT EXISTS worker_container_id TEXT,
  ADD COLUMN IF NOT EXISTS worker_log_path TEXT,
  ADD COLUMN IF NOT EXISTS worker_starting BOOLEAN NOT NULL DEFAULT FALSE;

DROP INDEX IF EXISTS ux_orchestrator_jobs_dedupe;
CREATE UNIQUE INDEX ux_orchestrator_jobs_dedupe
  ON orchestrator_jobs (phase, dedupe_key)
  WHERE status IN ('queued', 'leased', 'running', 'awaiting_external');

CREATE INDEX IF NOT EXISTS idx_orchestrator_jobs_status_available
  ON orchestrator_jobs (status, available_at);

CREATE TABLE IF NOT EXISTS orchestrator_job_attempts (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES orchestrator_jobs(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  success BOOLEAN,
  error_message TEXT,
  meta JSONB
);

CREATE INDEX IF NOT EXISTS idx_orchestrator_job_attempts_job_id
  ON orchestrator_job_attempts (job_id, started_at DESC);

CREATE TABLE IF NOT EXISTS orchestrator_workers (
  worker_id TEXT PRIMARY KEY,
  worker_kind TEXT NOT NULL,
  hostname TEXT,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  meta JSONB
);

CREATE TABLE IF NOT EXISTS orchestrator_artifacts (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID REFERENCES orchestrator_jobs(id) ON DELETE SET NULL,
  case_key TEXT NOT NULL,
  request_key TEXT,
  phase TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  checksum_sha256 TEXT,
  bytes BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orchestrator_artifacts_case_request
  ON orchestrator_artifacts (case_key, request_key, phase);

CREATE TABLE IF NOT EXISTS orchestrator_phase_metrics (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID REFERENCES orchestrator_jobs(id) ON DELETE SET NULL,
  case_key TEXT NOT NULL,
  request_key TEXT,
  phase TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  queued_ms INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 1,
  meta JSONB,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orchestrator_phase_metrics_case_phase
  ON orchestrator_phase_metrics (case_key, request_key, phase, recorded_at DESC);

CREATE TABLE IF NOT EXISTS orchestrator_files_batch_results (
  job_id UUID PRIMARY KEY REFERENCES orchestrator_jobs(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  processed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  duplicates_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orchestrator_files_batch_results_file
  ON orchestrator_files_batch_results (file_id);
`;

export async function ensureControlPlaneSchema(): Promise<void> {
  const pool = getControlPlanePool();
  await pool.query(CONTROL_PLANE_SCHEMA_SQL);
}
