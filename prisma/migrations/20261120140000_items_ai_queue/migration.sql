-- Step 7 of docs/pipeline-refactor.md: the AI work queue of emails moves from
-- `emails` to `items`. An email item that is still `pending` is waiting for the
-- AI; the Batch claim, the confidence and the second-review lease live on it.
-- Additive: the old columns on `emails` are left in place (and no longer used)
-- until a later migration drops them.
ALTER TABLE "items" ADD COLUMN "ai_batch_run_id" TEXT;
ALTER TABLE "items" ADD COLUMN "ai_p_keep" INTEGER;
ALTER TABLE "items" ADD COLUMN "rereview_status" TEXT;
ALTER TABLE "items" ADD COLUMN "rereview_queued_at" TIMESTAMP(3);
ALTER TABLE "items" ADD COLUMN "rereview_started_at" TIMESTAMP(3);
ALTER TABLE "items" ADD COLUMN "rereview_coordinator_id" TEXT;

CREATE INDEX "items_ai_batch_run_id_idx" ON "items"("ai_batch_run_id");
CREATE INDEX "items_rereview_status_idx" ON "items"("rereview_status");

ALTER TABLE "items" ADD CONSTRAINT "items_ai_batch_run_id_fkey" FOREIGN KEY ("ai_batch_run_id") REFERENCES "ai_batch_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Emails still waiting for the AI have no item yet (an email item was only
-- written once it was decided, in cases that ran before). Give them a pending one.
INSERT INTO "items" (
    "id", "case_request_id", "file_id", "parent_id", "kind", "origin",
    "state", "created_at", "updated_at"
)
SELECT
    e."email_hash",
    p."case_request_id",
    e."file_id",
    e."parent_email_hash",
    'email',
    CASE WHEN e."is_attachment" <> 0 THEN 'attachment' ELSE 'pst' END,
    'pending',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "emails" e
LEFT JOIN "processed_files" p ON p."id" = e."file_id"
WHERE e."is_duplicate" = 0
  AND e."ai_decision" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "items" i WHERE i."id" = e."email_hash");

-- Carry the queue state of every email over to its item.
UPDATE "items" i
SET "ai_batch_run_id" = e."ai_batch_run_id",
    "ai_p_keep" = e."ai_p_keep",
    "rereview_status" = e."rereview_status",
    "rereview_queued_at" = e."rereview_queued_at",
    "rereview_started_at" = e."rereview_started_at",
    "rereview_coordinator_id" = e."rereview_coordinator_id"
FROM "emails" e
WHERE i."id" = e."email_hash"
  AND i."kind" = 'email'
  AND (
    e."ai_batch_run_id" IS NOT NULL
    OR e."ai_p_keep" IS NOT NULL
    OR e."rereview_status" IS NOT NULL
  );

-- A history event for the pending items created above.
INSERT INTO "item_events" ("id", "item_id", "state", "created_at")
SELECT gen_random_uuid()::text, i."id", 'pending', CURRENT_TIMESTAMP
FROM "items" i
WHERE i."kind" = 'email'
  AND i."state" = 'pending'
  AND NOT EXISTS (SELECT 1 FROM "item_events" v WHERE v."item_id" = i."id");
