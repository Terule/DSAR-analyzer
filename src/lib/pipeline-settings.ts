import { prisma } from "./prisma";

export const DEFAULT_AI_BATCH_SETTINGS = {
  maxTokensPerBatch: 2_000_000,
  maxConcurrentBatches: 4,
} as const;

export const AI_BATCH_SETTINGS_LIMITS = {
  minTokensPerBatch: 250_000,
  maxTokensPerBatch: 4_000_000,
  minConcurrentBatches: 1,
  maxConcurrentBatches: 12,
  maxQueuedTokens: 20_000_000,
} as const;

export interface AiBatchSettings {
  maxTokensPerBatch: number;
  maxConcurrentBatches: number;
}

export function validateAiBatchSettings(
  input: AiBatchSettings,
): AiBatchSettings {
  const maxTokensPerBatch = Math.floor(input.maxTokensPerBatch);
  const maxConcurrentBatches = Math.floor(input.maxConcurrentBatches);
  const limits = AI_BATCH_SETTINGS_LIMITS;
  if (
    !Number.isFinite(maxTokensPerBatch) ||
    maxTokensPerBatch < limits.minTokensPerBatch ||
    maxTokensPerBatch > limits.maxTokensPerBatch
  ) {
    throw new Error(
      `Batch tokens must be between ${limits.minTokensPerBatch} and ${limits.maxTokensPerBatch}.`,
    );
  }
  if (
    !Number.isFinite(maxConcurrentBatches) ||
    maxConcurrentBatches < limits.minConcurrentBatches ||
    maxConcurrentBatches > limits.maxConcurrentBatches
  ) {
    throw new Error(
      `Parallel batches must be between ${limits.minConcurrentBatches} and ${limits.maxConcurrentBatches}.`,
    );
  }
  if (maxTokensPerBatch * maxConcurrentBatches > limits.maxQueuedTokens) {
    throw new Error(
      `Configured queued work must not exceed ${limits.maxQueuedTokens} tokens.`,
    );
  }
  return { maxTokensPerBatch, maxConcurrentBatches };
}

export async function getAiBatchSettings(): Promise<AiBatchSettings> {
  const row = await prisma.pipelineSettings.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      ai_max_tokens_per_batch: DEFAULT_AI_BATCH_SETTINGS.maxTokensPerBatch,
      ai_max_concurrent_batches: DEFAULT_AI_BATCH_SETTINGS.maxConcurrentBatches,
    },
    update: {},
  });
  return {
    maxTokensPerBatch: row.ai_max_tokens_per_batch,
    maxConcurrentBatches: row.ai_max_concurrent_batches,
  };
}

export async function updateAiBatchSettings(
  input: AiBatchSettings,
): Promise<AiBatchSettings> {
  const settings = validateAiBatchSettings(input);
  const row = await prisma.pipelineSettings.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      ai_max_tokens_per_batch: settings.maxTokensPerBatch,
      ai_max_concurrent_batches: settings.maxConcurrentBatches,
    },
    update: {
      ai_max_tokens_per_batch: settings.maxTokensPerBatch,
      ai_max_concurrent_batches: settings.maxConcurrentBatches,
    },
  });
  return {
    maxTokensPerBatch: row.ai_max_tokens_per_batch,
    maxConcurrentBatches: row.ai_max_concurrent_batches,
  };
}
