-- Render progress is measured against selected AI emails for the case-level
-- render coordinator. The fields are additive and default safely for existing
-- cases.
ALTER TABLE "processed_files"
  ADD COLUMN IF NOT EXISTS "pdf_total" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "pdf_processed" INTEGER NOT NULL DEFAULT 0;
