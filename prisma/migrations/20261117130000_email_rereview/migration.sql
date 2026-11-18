ALTER TABLE "emails" ADD COLUMN "ai_p_keep" INTEGER,
ADD COLUMN "rereview_status" TEXT,
ADD COLUMN "rereview_queued_at" TIMESTAMP(3),
ADD COLUMN "rereview_started_at" TIMESTAMP(3),
ADD COLUMN "rereview_coordinator_id" TEXT;

CREATE INDEX "emails_rereview_status_idx" ON "emails"("rereview_status");
