ALTER TABLE "processed_files"
  ADD COLUMN "files_progress_total" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "files_progress_handled" INTEGER NOT NULL DEFAULT 0;
