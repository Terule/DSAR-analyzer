ALTER TABLE "managed_cases"
  ADD COLUMN "case_type" TEXT NOT NULL DEFAULT 'employee',
  ADD COLUMN "onetrust_request_id" TEXT,
  ADD COLUMN "onetrust_status" TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN "onetrust_error" TEXT;

ALTER TABLE "managed_cases"
  ADD CONSTRAINT "managed_cases_case_type_check" CHECK ("case_type" IN ('employee', 'client'));

UPDATE "managed_cases"
SET "case_type" = 'client'
WHERE "name" = 'JO' AND "status" = 'active';

ALTER TABLE "pipeline_settings"
  ADD COLUMN "onetrust_tenant_url" TEXT,
  ADD COLUMN "onetrust_template_id" TEXT,
  ADD COLUMN "onetrust_language" TEXT,
  ADD COLUMN "onetrust_request_type" TEXT,
  ADD COLUMN "onetrust_subject_type" TEXT,
  ADD COLUMN "onetrust_system_label" TEXT,
  ADD COLUMN "onetrust_client_id_encrypted" TEXT,
  ADD COLUMN "onetrust_client_secret_encrypted" TEXT;

CREATE TABLE "onetrust_upload_artifacts" (
  "id" TEXT NOT NULL,
  "case_id" TEXT NOT NULL,
  "local_path" TEXT NOT NULL,
  "relative_path" TEXT NOT NULL,
  "attachment_name" TEXT NOT NULL,
  "file_size_bytes" BIGINT NOT NULL,
  "modified_at" BIGINT NOT NULL,
  "remote_file_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "error_message" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "onetrust_upload_artifacts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "onetrust_upload_artifacts_local_path_key" ON "onetrust_upload_artifacts"("local_path");
CREATE INDEX "onetrust_upload_artifacts_case_id_status_idx" ON "onetrust_upload_artifacts"("case_id", "status");
ALTER TABLE "onetrust_upload_artifacts" ADD CONSTRAINT "onetrust_upload_artifacts_case_id_fkey"
  FOREIGN KEY ("case_id") REFERENCES "managed_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
