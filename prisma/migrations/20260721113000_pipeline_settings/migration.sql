CREATE TABLE IF NOT EXISTS "pipeline_settings" (
  "id" TEXT NOT NULL,
  "ai_max_tokens_per_batch" INTEGER NOT NULL DEFAULT 2000000,
  "ai_max_concurrent_batches" INTEGER NOT NULL DEFAULT 4,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pipeline_settings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "pipeline_settings" ("id") VALUES ('global')
ON CONFLICT ("id") DO NOTHING;
