/**
 * Bedrock settings for DSAR screening. Models and region are fixed on purpose:
 * DSAR data may only go to EU inference profiles, and never to Sonnet.
 */
export const BEDROCK_REGION = process.env.AWS_REGION || "eu-central-1";

/** Batch (S3 + service role). Bedrock Batch does not support Haiku 5.5. */
export const BATCH_MODEL = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
/** Synchronous Converse. */
export const CONVERSE_MODEL = "eu.anthropic.claude-haiku-5-5";

/** More than this many records in a run go to Batch; this many or fewer to Converse. */
export const BATCH_THRESHOLD = 100;
/** Parallel Converse calls (env BEDROCK_CONVERSE_CONCURRENCY, 1-64, default 8). */
export function converseConcurrency(): number {
  const value = Math.floor(Number(process.env.BEDROCK_CONVERSE_CONCURRENCY));
  return Number.isFinite(value) && value >= 1 ? Math.min(value, 64) : 8;
}
/** Output budget; the decision JSON is small but `reason` can reach 240 characters. */
export const MIN_OUTPUT_TOKENS = 300;

/** Id prefixes: they tell a later poll which backend owns a run (and keep ids unique). */
export const BEDROCK_BATCH_PREFIX = "bedrock-batch:";
export const BEDROCK_CONVERSE_PREFIX = "bedrock-converse:";

const ALLOWED_MODELS = [BATCH_MODEL, CONVERSE_MODEL];

/** Refuses any model that is not on the allowlist or not an `eu.` inference profile. */
export function assertAllowedModel(modelId: string): void {
  if (!modelId.startsWith("eu.") || !ALLOWED_MODELS.includes(modelId)) {
    throw new Error(`Bedrock model ${modelId} is not allowed for DSAR data.`);
  }
}

export function batchSettings(): { bucket: string; roleArn: string } {
  const bucket = process.env.BEDROCK_BATCH_BUCKET;
  const roleArn = process.env.BEDROCK_BATCH_ROLE_ARN;
  if (!bucket || !roleArn) {
    throw new Error(
      "Bedrock Batch needs BEDROCK_BATCH_BUCKET and BEDROCK_BATCH_ROLE_ARN.",
    );
  }
  return { bucket, roleArn };
}

/** Defaults for the second-review filter; both are editable in System settings. */
export const REREVIEW_DEFAULT_MIN_P_KEEP = 8;
export const REREVIEW_DEFAULT_SAMPLE_PERCENT = 2;
