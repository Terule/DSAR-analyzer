-- CreateTable
CREATE TABLE "files_ai_batch_runs" (
    "id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "openai_batch_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "estimated_tokens" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "files_ai_batch_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files_ai_verdicts" (
    "id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "rel_path" TEXT NOT NULL,
    "verdict" TEXT,
    "reason" TEXT,
    "sampled" BOOLEAN NOT NULL DEFAULT false,
    "batch_run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "files_ai_verdicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "files_ai_batch_runs_openai_batch_id_key" ON "files_ai_batch_runs"("openai_batch_id");

-- CreateIndex
CREATE INDEX "files_ai_batch_runs_file_id_status_idx" ON "files_ai_batch_runs"("file_id", "status");

-- CreateIndex
CREATE INDEX "files_ai_verdicts_file_id_verdict_idx" ON "files_ai_verdicts"("file_id", "verdict");

-- AddForeignKey
ALTER TABLE "files_ai_batch_runs" ADD CONSTRAINT "files_ai_batch_runs_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "processed_files"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "files_ai_verdicts" ADD CONSTRAINT "files_ai_verdicts_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "processed_files"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "files_ai_verdicts" ADD CONSTRAINT "files_ai_verdicts_batch_run_id_fkey" FOREIGN KEY ("batch_run_id") REFERENCES "files_ai_batch_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

