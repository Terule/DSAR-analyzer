-- Step 6 of docs/pipeline-refactor.md: one table for AI runs. The Files AI runs
-- (files, attachments and mail screening, table `files_ai_batch_runs`) move into
-- `ai_batch_runs`, told apart by `kind` ('email' for the email audit, 'files' for
-- the rest). `coordinator_id` is the processed row that owns the run, as
-- `file_id` was. The old table is left in place, unused, and dropped later.
ALTER TABLE "ai_batch_runs" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'email';
ALTER TABLE "ai_batch_runs" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "ai_batch_runs_kind_status_idx" ON "ai_batch_runs"("kind", "status");

INSERT INTO "ai_batch_runs" (
    "id", "coordinator_id", "openai_batch_id", "status", "request_count",
    "estimated_tokens", "error", "created_at", "submitted_at", "completed_at",
    "attempt", "kind"
)
SELECT
    f."id", f."file_id", f."openai_batch_id", f."status", f."request_count",
    f."estimated_tokens", f."error", f."created_at", f."submitted_at",
    f."completed_at", f."attempt", 'files'
FROM "files_ai_batch_runs" f
WHERE NOT EXISTS (SELECT 1 FROM "ai_batch_runs" a WHERE a."id" = f."id");

-- The verdicts point at the unified table now.
ALTER TABLE "files_ai_verdicts" DROP CONSTRAINT "files_ai_verdicts_batch_run_id_fkey";
ALTER TABLE "files_ai_verdicts" ADD CONSTRAINT "files_ai_verdicts_batch_run_id_fkey" FOREIGN KEY ("batch_run_id") REFERENCES "ai_batch_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
