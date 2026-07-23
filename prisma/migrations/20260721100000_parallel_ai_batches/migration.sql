CREATE TABLE IF NOT EXISTS "ai_batch_runs" (
  "id" TEXT NOT NULL,
  "coordinator_id" TEXT NOT NULL,
  "openai_batch_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'claiming',
  "request_count" INTEGER NOT NULL DEFAULT 0,
  "estimated_tokens" INTEGER NOT NULL DEFAULT 0,
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submitted_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "ai_batch_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_batch_runs_openai_batch_id_key"
  ON "ai_batch_runs"("openai_batch_id");
CREATE INDEX IF NOT EXISTS "ai_batch_runs_coordinator_id_status_idx"
  ON "ai_batch_runs"("coordinator_id", "status");

ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "ai_batch_run_id" TEXT;
CREATE INDEX IF NOT EXISTS "emails_ai_batch_run_id_idx"
  ON "emails"("ai_batch_run_id");

ALTER TABLE "ai_batch_runs"
  ADD CONSTRAINT "ai_batch_runs_coordinator_id_fkey"
  FOREIGN KEY ("coordinator_id") REFERENCES "processed_files"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "emails"
  ADD CONSTRAINT "emails_ai_batch_run_id_fkey"
  FOREIGN KEY ("ai_batch_run_id") REFERENCES "ai_batch_runs"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
