ALTER TABLE "files_ai_verdicts" ADD COLUMN "p_keep" INTEGER,
ADD COLUMN "rereview_status" TEXT,
ADD COLUMN "rereview_queued_at" TIMESTAMP(3),
ADD COLUMN "rereview_started_at" TIMESTAMP(3),
ADD COLUMN "first_reason" TEXT,
ADD COLUMN "reviewed_by_model" TEXT;

CREATE INDEX "files_ai_verdicts_rereview_status_idx" ON "files_ai_verdicts"("rereview_status");
