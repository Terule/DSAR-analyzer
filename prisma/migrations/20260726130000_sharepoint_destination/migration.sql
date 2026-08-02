ALTER TABLE "pipeline_settings"
  ADD COLUMN IF NOT EXISTS "sharepoint_site_url" TEXT,
  ADD COLUMN IF NOT EXISTS "sharepoint_folder_id" TEXT,
  ADD COLUMN IF NOT EXISTS "sharepoint_folder_path" TEXT;
