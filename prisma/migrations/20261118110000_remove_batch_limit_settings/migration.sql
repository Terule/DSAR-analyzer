-- Batch size and parallelism came from OpenAI account limits; Bedrock jobs are
-- sized by BEDROCK_BATCH_MAX_RECORDS / BEDROCK_BATCH_MAX_JOBS (environment).
ALTER TABLE "pipeline_settings" DROP COLUMN "ai_max_tokens_per_batch",
DROP COLUMN "ai_max_concurrent_batches";
