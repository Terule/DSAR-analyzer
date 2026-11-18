-- OpenAI is no longer used: the stored API key and the provider choice go away.
ALTER TABLE "pipeline_settings" DROP COLUMN "openai_api_key_encrypted",
DROP COLUMN "ai_provider";
