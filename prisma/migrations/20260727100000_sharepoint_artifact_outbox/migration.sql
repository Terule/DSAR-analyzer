CREATE TABLE IF NOT EXISTS "sharepoint_upload_artifacts" (
  "id" TEXT NOT NULL,
  "source_file_id" TEXT NOT NULL,
  "request_key" TEXT NOT NULL,
  "local_path" TEXT NOT NULL,
  "relative_path" TEXT NOT NULL,
  "file_size_bytes" BIGINT NOT NULL,
  "modified_at" BIGINT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "error_message" TEXT,
  "heartbeat_at" BIGINT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sharepoint_upload_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sharepoint_upload_artifacts_local_path_key" UNIQUE ("local_path"),
  CONSTRAINT "sharepoint_upload_artifacts_source_file_id_fkey"
    FOREIGN KEY ("source_file_id") REFERENCES "processed_files"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "sharepoint_upload_artifacts_status_heartbeat_at_idx"
  ON "sharepoint_upload_artifacts"("status", "heartbeat_at");
CREATE INDEX IF NOT EXISTS "sharepoint_upload_artifacts_source_file_id_status_idx"
  ON "sharepoint_upload_artifacts"("source_file_id", "status");
