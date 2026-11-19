CREATE TABLE "items" (
    "id" TEXT NOT NULL,
    "case_request_id" TEXT,
    "file_id" TEXT,
    "parent_id" TEXT,
    "kind" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "decision_rule" TEXT,
    "reason" TEXT,
    "decided_by" TEXT,
    "cascade" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "item_events" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "decision_rule" TEXT,
    "reason" TEXT,
    "decided_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "items_case_request_id_state_idx" ON "items"("case_request_id", "state");
CREATE INDEX "items_file_id_idx" ON "items"("file_id");
CREATE INDEX "item_events_item_id_idx" ON "item_events"("item_id");

ALTER TABLE "items" ADD CONSTRAINT "items_case_request_id_fkey" FOREIGN KEY ("case_request_id") REFERENCES "case_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "item_events" ADD CONSTRAINT "item_events_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
