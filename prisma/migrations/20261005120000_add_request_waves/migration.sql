ALTER TABLE "processed_files" ADD COLUMN "wave" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "processed_files_case_request_id_wave_idx" ON "processed_files"("case_request_id", "wave");

ALTER TABLE "case_requests"
ADD COLUMN "wave" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "wave_scope" TEXT,
ADD COLUMN "render_base" INTEGER,
ADD COLUMN "warning_base" INTEGER;
