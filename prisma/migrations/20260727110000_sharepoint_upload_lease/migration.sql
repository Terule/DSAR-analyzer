ALTER TABLE "pipeline_settings"
  ADD COLUMN IF NOT EXISTS "sharepoint_upload_lease_owner" TEXT,
  ADD COLUMN IF NOT EXISTS "sharepoint_upload_lease_until" BIGINT;
