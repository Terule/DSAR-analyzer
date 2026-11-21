-- Cleanup after steps 6 and 7 of docs/pipeline-refactor.md: `items` is the only
-- record of an email decision and of the AI queue, so the mirror columns of
-- `emails` and the old Files AI runs table (copied into `ai_batch_runs`) go.
DROP INDEX IF EXISTS "emails_ai_batch_run_id_idx";
DROP INDEX IF EXISTS "emails_rereview_status_idx";
ALTER TABLE "emails" DROP CONSTRAINT IF EXISTS "emails_ai_batch_run_id_fkey";
ALTER TABLE "emails"
  DROP COLUMN "ai_decision",
  DROP COLUMN "ai_reason",
  DROP COLUMN "ai_batch_run_id",
  DROP COLUMN "ai_p_keep",
  DROP COLUMN "rereview_status",
  DROP COLUMN "rereview_queued_at",
  DROP COLUMN "rereview_started_at",
  DROP COLUMN "rereview_coordinator_id";
DROP TABLE IF EXISTS "files_ai_batch_runs";
