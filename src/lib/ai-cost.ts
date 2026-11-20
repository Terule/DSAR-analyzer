/**
 * Estimated Amazon Bedrock cost of a request. The pipeline does not record the
 * tokens the service billed, only the input size it estimated before each run,
 * so this is an estimate: input tokens plus a small output per record, at the
 * Claude Haiku 4.5 Batch rates (half of on-demand). The 2nd analysis by
 * Haiku 5.5 (a few records) and email-body screening are not counted.
 */
import { prisma } from "./prisma";

/** US$ per million tokens: Haiku 4.5 on-demand is 1.00 in / 5.00 out, Batch is half. */
export const BATCH_INPUT_USD_PER_MILLION = 0.5;
export const BATCH_OUTPUT_USD_PER_MILLION = 2.5;
/** The decision JSON is short; `reason` is capped near 240 characters. */
export const OUTPUT_TOKENS_PER_RECORD = 120;

export interface AiUsage {
  inputTokens: number;
  records: number;
  costUsd: number;
}

export function estimateCost(inputTokens: number, records: number): number {
  return (
    (inputTokens * BATCH_INPUT_USD_PER_MILLION +
      records * OUTPUT_TOKENS_PER_RECORD * BATCH_OUTPUT_USD_PER_MILLION) /
    1_000_000
  );
}

export function usageOf(inputTokens: number, records: number): AiUsage {
  return { inputTokens, records, costUsd: estimateCost(inputTokens, records) };
}

/** Estimated usage per request id, from the runs of the email audit and of Files. */
export async function aiUsageByRequest(
  requestIds: string[],
): Promise<Map<string, AiUsage>> {
  const totals = new Map<string, { tokens: number; records: number }>();
  const add = (requestId: string | null, tokens: number, records: number) => {
    if (!requestId) return;
    const entry = totals.get(requestId) ?? { tokens: 0, records: 0 };
    entry.tokens += tokens;
    entry.records += records;
    totals.set(requestId, entry);
  };
  const runs = await prisma.aiBatchRun.findMany({
    where: { coordinator: { case_request_id: { in: requestIds } } },
    select: {
      estimated_tokens: true,
      request_count: true,
      coordinator: { select: { case_request_id: true } },
    },
  });
  for (const run of runs) {
    add(
      run.coordinator.case_request_id,
      run.estimated_tokens,
      run.request_count,
    );
  }
  return new Map(
    [...totals].map(([id, value]) => [
      id,
      usageOf(value.tokens, value.records),
    ]),
  );
}
