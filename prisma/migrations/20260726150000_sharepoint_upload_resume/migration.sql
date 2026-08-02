ALTER TABLE "processed_files"
  ADD COLUMN IF NOT EXISTS "upload_heartbeat_at" BIGINT;

ALTER TABLE "processed_files"
  ALTER COLUMN "upload_status" SET DEFAULT 'idle';

UPDATE "processed_files"
SET "upload_status" = 'idle'
WHERE "upload_status" = 'pending';
