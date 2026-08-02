CREATE TABLE "managed_cases" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "subject_name" TEXT NOT NULL,
  "subject_email" TEXT NOT NULL,
  "subject_personal_email" TEXT,
  "subject_aliases" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "managed_cases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "managed_cases_name_key" ON "managed_cases"("name");

CREATE TABLE "case_requests" (
  "id" TEXT NOT NULL,
  "case_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "staging_path" TEXT NOT NULL,
  "deliverable_path" TEXT NOT NULL,
  "pst_count" INTEGER NOT NULL DEFAULT 0,
  "pst_size_bytes" BIGINT NOT NULL DEFAULT 0,
  "files_count" INTEGER NOT NULL DEFAULT 0,
  "files_size_bytes" BIGINT NOT NULL DEFAULT 0,
  "deliverable_files" INTEGER NOT NULL DEFAULT 0,
  "deliverable_size_bytes" BIGINT NOT NULL DEFAULT 0,
  "total_emails" INTEGER NOT NULL DEFAULT 0,
  "emails_exported" INTEGER NOT NULL DEFAULT 0,
  "files_exported" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "case_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "case_requests_case_id_name_key" ON "case_requests"("case_id", "name");
CREATE INDEX "case_requests_status_created_at_idx" ON "case_requests"("status", "created_at");
ALTER TABLE "case_requests" ADD CONSTRAINT "case_requests_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "managed_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "processed_files" ADD COLUMN "case_request_id" TEXT;
CREATE INDEX "processed_files_case_request_id_idx" ON "processed_files"("case_request_id");
ALTER TABLE "processed_files" ADD CONSTRAINT "processed_files_case_request_id_fkey" FOREIGN KEY ("case_request_id") REFERENCES "case_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pipeline_settings" ADD COLUMN "staging_root" TEXT;
ALTER TABLE "pipeline_settings" ADD COLUMN "deliverables_root" TEXT;
ALTER TABLE "pipeline_settings" ADD COLUMN "openai_api_key_encrypted" TEXT;
ALTER TABLE "pipeline_settings" ADD COLUMN "azure_tenant_id_encrypted" TEXT;
ALTER TABLE "pipeline_settings" ADD COLUMN "azure_client_id_encrypted" TEXT;
ALTER TABLE "pipeline_settings" ADD COLUMN "azure_client_secret_encrypted" TEXT;
